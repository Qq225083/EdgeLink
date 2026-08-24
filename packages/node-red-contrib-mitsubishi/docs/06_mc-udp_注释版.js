/**
 * ===========================================================================
 * mc-udp.js — MC Protocol over UDP 会话管理层 v1.4.4
 * ===========================================================================
 *
 * 【为什么需要 UDP 支持】
 *   1. 部分老旧 PLC 或串口服务器只开放 UDP 端口
 *   2. SLMP 协议原生支持 UDP 传输（MC 帧在 UDP/TCP 上完全相同）
 *   3. UDP 无连接开销，适合高频采集场景（但需接受丢包风险）
 *
 * 【UDP vs TCP 在本实现中的差异】
 *   - TCP：需要缓冲累积 + 长度分帧（流式协议的固有需求）
 *   - UDP：一个数据报 = 一帧，天然分帧，不需要缓冲累积
 *   - 帧内容完全一致（build3EFrame/build4EFrame 对 TCP/UDP 通用）
 *
 * 【会话模型设计】
 *   每个 poolKey 一个共享 dgram socket：
 *   - socket 在所有使用同一连接的节点间共享
 *   - 请求严格串行化（单在途 inFlight）：UDP 无连接状态，
 *     必须由应用层保证"发送请求→等待响应→处理→再发下一个"的串行顺序
 *   - 排队机制：当有请求在途时，新请求入队（上限 50），
 *     当前请求完成后自动唤醒队首
 *
 * 【ICMP 错误处理】
 *   UDP 发送到不可达端口时，操作系统会返回 ICMP Port Unreachable。
 *   Node.js dgram 将此暴露为 socket 'error' 事件。
 *   本实现将 ICMP 错误仅失败当前在途请求（_finish 回调），
 *   保留 socket 供后续请求使用。
 *
 * 【迟到包处理】
 *   UDP 可能在超时后收到前一次请求的响应（延迟包）。
 *   _finish 回调在触发后立即置 null，后续到达的包找不到回调 → 静默丢弃。
 *
 * 【空闲回收】
 *   10 分钟无活动的会话自动销毁（ensureCleanTimer）。
 *
 * 【测试覆盖】
 *   mitsubishi-read_spec.js: UDP 3E 解码/4E 序列号回显/丢包重试
 *   mitsubishi-write_spec.js: UDP 写/位写/RMW
 */

var dgram = require('dgram');

/**
 * 全局 UDP 会话表
 * key = poolKey（同 TCP 连接池的 key 格式）
 * entry = { socket, users, lastUsed, inFlight, queue, _finish }
 *
 * inFlight: 当前是否有请求在途（串行化锁）
 * _finish: 当前在途请求的回调（收到响应或超时时调用）
 * users: 引用计数（{ nodeId: true }），用于 close 时判断是否销毁
 */
var SESSIONS = {};
var MAX_QUEUE = 50;
var IDLE_MS = 600000;  // 10 分钟空闲自动销毁
var _cleanTimer = null;

/**
 * 确保清理定时器运行（懒初始化）
 * 每 5 分钟扫描一次，销毁超过 10 分钟无活动的会话
 */
function ensureCleanTimer() {
  if (_cleanTimer) return;
  _cleanTimer = setInterval(function () {
    var now = Date.now();
    Object.keys(SESSIONS).forEach(function (k) {
      var e = SESSIONS[k];
      if (!e || e.inFlight) return;  // 有请求在途的会话不回收
      if (now - e.lastUsed > IDLE_MS) destroySession(k);
    });
  }, 300000);
  if (_cleanTimer.unref) _cleanTimer.unref();  // 不阻止 Node.js 进程退出
}

/**
 * 创建新 UDP 会话
 *
 * socket 监听：
 * - 'error': ICMP 错误 → 失败当前在途请求 → 保留 socket
 * - 'message': 正常响应 → 交给当前在途请求的回调
 *
 * 【重要】message 监听器生命周期管理：
 *   sock.on('message', ...) 是持久监听（不自动移除）。
 *   _finish 置 null 后，后续到达的包找不到回调 → 静默丢弃（迟到包）。
 *   不能在收到响应后 removeListener，因为下一个排队的请求
 *   还没有设置新的 _finish——在 acquire 到 release 之间的窗口期
 *   到达的包会被静默丢弃（可接受，概率极低）。
 */
function createSession(key) {
  var sock = dgram.createSocket('udp4');
  var e = {
    socket: sock,
    users: {},
    lastUsed: Date.now(),
    inFlight: false,
    queue: [],
    _finish: null  // 当前在途请求的回调
  };
  sock.on('error', function (err) {
    var f = e._finish;
    e._finish = null;
    if (f) { try { f(err); } catch (_) {} }
  });
  sock.on('message', function (buf) {
    var f = e._finish;
    e._finish = null;
    if (f) { try { f(null, buf); } catch (_) {} }
  });
  SESSIONS[key] = e;
  return e;
}

/**
 * 销毁 UDP 会话
 * 关闭 socket、失败所有排队请求、通知当前在途请求
 */
function destroySession(key) {
  var e = SESSIONS[key];
  if (!e) return;
  delete SESSIONS[key];
  var f = e._finish;
  e._finish = null;
  if (f) { try { f(new Error('UDP session destroyed')); } catch (_) {} }
  var q = e.queue || [];
  e.queue = [];
  q.forEach(function (w) { try { w.cb(new Error('UDP session destroyed')); } catch (_) {} });
  try { e.socket.close(); } catch (_) {}
}

/**
 * 获取 UDP 会话（串行化入口）
 *
 * 【调用时机】
 *   每次读取/写入轮次开始时调用。传入 node.id 用于引用计数。
 *
 * 【行为】
 *   - 无在途请求 → 立即返回（设置 inFlight=true）
 *   - 有在途请求 → 入队等待（上限 50，超限立即拒绝）
 *   - 排队超时在 release() 中处理
 *
 * @param {Object} node - Node-RED 节点实例
 * @param {string} key - poolKey
 * @param {number} timeout - 排队超时 ms
 * @param {Function} cb - callback(err, entry)
 */
function acquire(node, key, timeout, cb) {
  ensureCleanTimer();
  var e = SESSIONS[key] || createSession(key);
  e.lastUsed = Date.now();
  e.users = e.users || {};
  e.users[node.id] = true;
  if (e.inFlight) {
    if (e.queue.length >= MAX_QUEUE) {
      cb(new Error('UDP queue full (' + MAX_QUEUE + ')'));
      return;
    }
    e.queue.push({ cb: cb, enqueueTime: Date.now(), timeout: timeout || 3000 });
    return;
  }
  e.inFlight = true;
  cb(null, e);
}

/**
 * 归还 UDP 会话（释放 inFlight 锁，唤醒排队者）
 *
 * 【幂等性】
 *   可能被调用两次（_closed 中止点 + releaseNode 强制放行），
 *   第二次调用时 queue 为空，inFlight=false + lastUsed 刷新 → 安全无副作用。
 */
function release(key) {
  var e = SESSIONS[key];
  if (!e) return;
  e.lastUsed = Date.now();
  while (e.queue.length > 0) {
    var w = e.queue.shift();
    // 排队超时：跳过并通知
    if (Date.now() - w.enqueueTime > (w.timeout || 3000)) {
      try { w.cb(new Error('UDP queue timeout')); } catch (_) {}
      continue;
    }
    // 立即唤醒（inFlight 保持 true，交接给唤醒者）
    try { w.cb(null, e); } catch (_) {}
    return;
  }
  e.inFlight = false;
}

/**
 * UDP 单请求-响应（须在 acquire 成功后调用）
 *
 * 【超时机制】
 *   独立的 setTimeout 定时器（不依赖 socket.setTimeout）。
 *   超时时调用 cb(Error('udp timeout'))。
 *   正常响应或错误到达时 clearTimeout。
 *
 * 【发送失败处理】
 *   socket.send 的回调中如果 sendErr 非空 → 发送失败 →
 *   立即失败当前请求（不重试，由上层 attemptGroup 的重试循环处理）
 *
 * @param {string} key - session key
 * @param {Buffer} frame - 要发送的 MC 帧
 * @param {number} port - 目标端口
 * @param {string} host - 目标 IP
 * @param {number} timeoutMs - 超时 ms
 * @param {Function} cb - callback(err, buf)
 */
function request(key, frame, port, host, timeoutMs, cb) {
  var e = SESSIONS[key];
  if (!e) { cb(new Error('UDP session lost')); return; }
  var done = false;
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    e._finish = null;
    cb(new Error('udp timeout'));
  }, timeoutMs);
  // 设置本次请求的回调（socket 'message'/'error' 事件触发）
  e._finish = function (err, buf) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(err, buf);
  };
  try {
    e.socket.send(frame, port, host, function (sendErr) {
      if (sendErr) {
        var f = e._finish;
        e._finish = null;
        if (f) f(sendErr);
      }
    });
  } catch (ex) {
    var f2 = e._finish;
    e._finish = null;
    if (f2) f2(ex);
  }
}

/**
 * 节点关闭时释放其持有的 UDP 会话引用
 *
 * 【调用时机】
 *   Node-RED redeploy 时，mitsubishi-read/write 的 close 事件触发。
 *
 * 【行为】
 *   - 从所有会话的 users 中移除该节点
 *   - 如果节点持有 inFlight 锁 → 强制 release 放行（回调已被 _closed 拦截）
 *   - 如果没有其他节点使用该会话 → 销毁
 *
 *   release() 的二次调用场景说明：
 *   业务层回调（已被 _closed 拦截的采集链）中止点会调 release()，
 *   releaseNode 也可能因为节点持有 inFlight 锁而调 release()。
 *   两次 release() 调用：第一次归还并唤醒排队者，
 *   第二次 queue 为空 → 仅设置 inFlight=false 并刷新 lastUsed → 安全。
 */
function releaseNode(nodeId) {
  Object.keys(SESSIONS).forEach(function (key) {
    var e = SESSIONS[key];
    if (e && e.users && e.users[nodeId]) {
      delete e.users[nodeId];
      if (e.inFlight) release(key);  // 强制放行
      if (Object.keys(e.users).length === 0) destroySession(key);
    }
  });
}

module.exports = {
  acquire: acquire,
  release: release,
  request: request,
  releaseNode: releaseNode,
  _sessions: SESSIONS  // 仅测试用
};
