/**
 * mc-udp — MC Protocol over UDP 会话管理（v1.7.5）
 *
 * UDP 无连接：每 poolKey 一个共享 dgram socket，请求串行化（单在途）；
 * 一个数据报 = 一帧（天然分帧，无需 TCP 的缓冲累积）；
 * ICMP 错误（如端口不可达）仅失败当前在途请求，socket 保留；
 * 超期迟到的响应包静默丢弃（_finish 已空）。
 * 关闭语义：releaseNode 仅释放【该节点自己】持有的锁或排队项——v1.7.4 引入 owner 字段，
 * 修复 review P0-3：此前排队节点也在 users 里，关闭排队节点会误调 release() 把他人在途锁
 * 提前交接，导致两个请求共用同一 _finish、应答串线。
 * v1.7.5 复审：release(key, nodeId) owner 校验（陈旧 release 为 no-op）；
 * 超时/发送失败/owner 持锁关闭 → 销毁会话——迟到应答死在旧 socket 里，绝不进入重试。
 */
var dgram = require('dgram');

var SESSIONS = {};   // key → entry { socket, users, lastUsed, inFlight, queue, _finish }
var MAX_QUEUE = 50;
var IDLE_MS = 600000;
var _cleanTimer = null;

function ensureCleanTimer() {
  if (_cleanTimer) return;
  _cleanTimer = setInterval(function () {
    var now = Date.now();
    Object.keys(SESSIONS).forEach(function (k) {
      var e = SESSIONS[k];
      if (!e || e.inFlight) return;
      if (now - e.lastUsed > IDLE_MS) destroySession(k);
    });
  }, 300000);
  if (_cleanTimer.unref) _cleanTimer.unref();
}

function createSession(key) {
  var sock = dgram.createSocket('udp4');
  var e = {
    socket: sock,
    users: {},
    lastUsed: Date.now(),
    inFlight: false,
    owner: null,          // v1.7.4: 当前持锁节点 id（只有 owner 有权归还/被强制放行）
    queue: [],            // 排队项 { nodeId, cb, enqueueTime, timeout }
    _finish: null
  };
  // 常驻 error 监听（防 uncaught）：ICMP 错误仅失败当前在途请求
  sock.on('error', function (err) {
    var f = e._finish;
    e._finish = null;
    if (f) { try { f(err); } catch (_) {} }
  });
  // 常驻 message 监听：交给当前在途请求；无在途则丢弃（迟到包）
  sock.on('message', function (buf) {
    var f = e._finish;
    e._finish = null;
    if (f) { try { f(null, buf); } catch (_) {} }
  });
  SESSIONS[key] = e;
  return e;
}

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
 * 获取会话（串行化：同 key 单在途，其余排队）
 * cb(err, entry)
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
    e.queue.push({ nodeId: node.id, cb: cb, enqueueTime: Date.now(), timeout: timeout || 3000 });
    return;
  }
  e.inFlight = true;
  e.owner = node.id;
  cb(null, e);
}

/**
 * 归还会话（唤醒下一个排队者；排队超时丢弃）
 */
function release(key, nodeId) {
  var e = SESSIONS[key];
  if (!e) return;
  // 🔧 v1.7.5 复审 P0：owner 校验——已关闭节点的旧定时器/回调若再调 release，
  // 不得把当前 owner 的锁交接出去（此前会把 B 的锁提前交给 C，重建串线）
  if (nodeId !== undefined && e.owner !== nodeId) return;
  e.lastUsed = Date.now();
  while (e.queue.length > 0) {
    var w = e.queue.shift();
    if (Date.now() - w.enqueueTime > (w.timeout || 3000)) {
      try { w.cb(new Error('UDP queue timeout')); } catch (_) {}
      continue;
    }
    e.owner = w.nodeId;   // 锁连同 owner 一起交接
    try { w.cb(null, e); } catch (_) {}
    return;  // inFlight 保持 true（交接给唤醒者）
  }
  e.inFlight = false;
  e.owner = null;
}

/**
 * 单请求-响应（须在 acquire 成功后调用；同 entry 单在途）
 * timeoutMs 内未收到响应 → cb(Error('udp timeout'))
 */
function request(key, frame, port, host, timeoutMs, cb) {
  var e = SESSIONS[key];
  if (!e) { cb(new Error('UDP session lost')); return; }
  var done = false;
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    e._finish = null;
    // 🔧 v1.7.5 复审 P0/P1：超时即销毁会话——旧请求的迟到应答若落在复用的同 socket 上，
    // 会被下一次重试新装的 _finish 错收（3E/ascii_q 无序列号可甄别）。销毁后旧 socket
    // 上的迟到包随之消失，重试走 acquire 自动获得全新会话。
    destroySession(key);
    cb(new Error('udp timeout'));
  }, timeoutMs);
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
        destroySession(key);   // 发送失败同样销毁，杜绝陈旧应答
        if (f) f(sendErr);
      }
    });
  } catch (ex) {
    var f2 = e._finish;
    e._finish = null;
    destroySession(key);
    if (f2) f2(ex);
  }
}

/**
 * 节点关闭：释放其持有的会话引用；无其他使用者则销毁。
 * v1.7.4: owner/ticket 语义——关闭排队节点只摘自己的排队项，绝不动他人在途锁；
 * 仅当关闭者就是 owner 时，先清 _finish（迟到应答丢弃）再 release() 交接。
 */
function releaseNode(nodeId) {
  Object.keys(SESSIONS).forEach(function (key) {
    var e = SESSIONS[key];
    if (!(e && e.users && e.users[nodeId])) return;
    delete e.users[nodeId];
    // v1.7.4 P0-3 修复：先摘掉自己尚未授予的排队项（不再经由 release() 唤醒它，
    // 避免关闭一个排队节点反而把他人正在等待应答的在途锁提前交接出去）
    for (var i = e.queue.length - 1; i >= 0; i--) {
      if (e.queue[i].nodeId === nodeId) {
        var w = e.queue.splice(i, 1)[0];
        try { w.cb(new Error('UDP node closed while queued')); } catch (_) {}
      }
    }
    if (Object.keys(e.users).length === 0) {
      destroySession(key);   // 无人使用：连在途一起销毁（_finish 收到错误回调）
      return;
    }
    // 🔧 v1.7.5 复审 P0：owner 持锁关闭时不能简单交接——旧请求的迟到应答会落在
    // 同 socket 上，被新 owner 重装的 _finish 错收（3E/ascii_q 无序列号可甄别）。
    // 直接销毁会话：排队者收到错误回调本轮失败，下一轮 acquire 获得全新 socket。
    if (e.inFlight && e.owner === nodeId) {
      destroySession(key);
      return;
    }
  });
}

module.exports = {
  acquire: acquire,
  release: release,
  request: request,
  releaseNode: releaseNode,
  _sessions: SESSIONS  // 测试用
};
