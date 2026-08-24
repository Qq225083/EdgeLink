/**
 * mc-udp — MC Protocol over UDP 会话管理（v1.4.4）
 *
 * UDP 无连接：每 poolKey 一个共享 dgram socket，请求串行化（单在途）；
 * 一个数据报 = 一帧（天然分帧，无需 TCP 的缓冲累积）；
 * ICMP 错误（如端口不可达）仅失败当前在途请求，socket 保留；
 * 超期迟到的响应包静默丢弃（_finish 已空）。
 * 关闭语义：releaseNode 释放节点持有的会话，防止重部署后泄漏。
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
    queue: [],
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
    e.queue.push({ cb: cb, enqueueTime: Date.now(), timeout: timeout || 3000 });
    return;
  }
  e.inFlight = true;
  cb(null, e);
}

/**
 * 归还会话（唤醒下一个排队者；排队超时丢弃）
 */
function release(key) {
  var e = SESSIONS[key];
  if (!e) return;
  e.lastUsed = Date.now();
  while (e.queue.length > 0) {
    var w = e.queue.shift();
    if (Date.now() - w.enqueueTime > (w.timeout || 3000)) {
      try { w.cb(new Error('UDP queue timeout')); } catch (_) {}
      continue;
    }
    try { w.cb(null, e); } catch (_) {}
    return;  // inFlight 保持 true（交接给唤醒者）
  }
  e.inFlight = false;
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
 * 节点关闭：释放其持有的会话引用；无其他使用者则销毁。
 * review#8: 节点关闭时若持有在途锁会调用一次 release() 放行；
 * 业务层回调（已被 _closed 拦截的采集链）中止点也会调 release()——
 * release() 对重入幂等（无队列时仅置 inFlight=false 并刷新 lastUsed），双次调用安全。
 */
function releaseNode(nodeId) {
  Object.keys(SESSIONS).forEach(function (key) {
    var e = SESSIONS[key];
    if (e && e.users && e.users[nodeId]) {
      delete e.users[nodeId];
      // 节点关闭时若持有在途锁，强制放行（回调已被 _closed 拦截，不会继续采集）
      if (e.inFlight) release(key);
      if (Object.keys(e.users).length === 0) destroySession(key);
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
