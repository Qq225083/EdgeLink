/**
 * modbus-pool — Modbus 长连接池（modbus-read / modbus-write 共享，TCP + RTU 同池）
 *
 * v1.5.0: RTU（串口）入池 — getSerialConnection/releaseSerialConnection/detachSerialNode/
 *         peekSerialEntry/serialPoolKey；池键 rtu:COM3:9600:8N1；同一物理串口不同参数
 *         的连接视为占用冲突直接拒绝（串口独占）。TCP 公开 API 签名与语义不变。
 * v1.4.0: 从 modbus-read.js 抽为独立模块，并修复两个生产级缺陷：
 *   1. ownerId 属主追踪 — 节点在轮询/写入中途被关闭时，close 直接销毁其持有的
 *      在途连接；旧版仅摘除 users，共享连接会 inUse 永久卡死（队列堵死需重启）
 *   2. 队列发放的连接补登 users 引用计数 — 旧版排队获得连接的节点未登记，
 *      close 清理失真（该销毁不销毁 / 误销毁）
 * 另加两道防线：
 *   - releaseConnection 属主校验 — 过期/迷途回调不得释放他人持有的连接
 *   - destroyConnection socket 指纹 — 过期 socket 事件不得误杀重建后的新连接
 */
'use strict';
var net = require('net');
var mserial = require('./modbus-serial');

var CONN_POOL = {};
var MAX_QUEUE = 50;
var MAX_BACKOFF_MS = 10000;
var _activeNodeCount = 0;
var _cleanTimer = null;

function ensureCleanTimer() {
  if (_cleanTimer) return;
  _cleanTimer = setInterval(function () {
    var now = Date.now();
    var keys = Object.keys(CONN_POOL);
    for (var i = 0; i < keys.length; i++) {
      var entry = CONN_POOL[keys[i]];
      if (!entry || entry.inUse || entry.connecting) continue;
      if (entry.socket && (now - entry.lastUsed > 600000)) {
        var q = entry.queue || [];
        entry.queue = [];
        for (var qi = 0; qi < q.length; qi++) {
          try { q[qi].callback(new Error('Connection idle timeout')); } catch (_) {}
        }
        try { entry.socket.destroy(); } catch (_) {}
        delete CONN_POOL[keys[i]];
      }
    }
  }, 300000);
  if (_cleanTimer.unref) _cleanTimer.unref();
}

function poolKey(host, port) {
  return host + ':' + port;
}

function peekEntry(host, port) {
  return CONN_POOL[poolKey(host, port)];
}

// ===== TCP 连接器：net.Socket + connect（语义与 v1.4.0 逐行一致）=====
function _tcpConnector(host, port) {
  return function (timeout, onOk, onErr) {
    var client = new net.Socket();
    client.setTimeout(timeout);
    client.setKeepAlive(true, 30000);
    function errOnce(e) { onErr(e); }
    client.once('error', errOnce);
    client.connect(port, host, function () {
      client.removeListener('error', errOnce);
      onOk(client);
    });
    return client;
  };
}

// ===== RTU 连接器：SerialSock（socket 形态适配 serialport，见 modbus-serial.js）=====
function _serialConnector(serialCfg) {
  return function (timeout, onOk, onErr) {
    var sock = mserial.createSocket(serialCfg);
    sock.setTimeout(timeout);
    var settled = false;
    sock.connect(
      function () { if (settled) return; settled = true; onOk(sock); },
      function (e) { if (settled) return; settled = true; onErr(e); }
    );
    return sock;
  };
}

// ===== 取连接（TCP/RTU 共用）：退避 → 复用 → 排队 → 新建 =====
function _acquire(node, key, connector, timeout, callback, entryExtra) {
  var entry = CONN_POOL[key];

  // 退避期：连接刚失败时避免立即重连风暴
  if (entry && entry.backoffMs && entry.lastErrorTime) {
    var sinceErr = Date.now() - entry.lastErrorTime;
    if (sinceErr < entry.backoffMs) {
      callback(new Error('connect backoff (' + (entry.backoffMs - sinceErr) + 'ms)'));
      return;
    }
  }

  // 复用空闲连接
  if (entry && entry.socket && !entry.socket.destroyed && !entry.inUse && !entry.connecting) {
    entry.inUse = true;
    entry.ownerId = node.id;
    entry.lastUsed = Date.now();
    entry.users = entry.users || {};
    entry.users[node.id] = true;
    entry.socket.setTimeout(timeout);
    callback(null, entry.socket);
    return;
  }

  // 连接正忙或正在建立 → 排队（登记 nodeId，发放时补 users/ownerId）
  if (entry && (entry.inUse || entry.connecting)) {
    entry.queue = entry.queue || [];
    if (entry.queue.length >= MAX_QUEUE) {
      callback(new Error('Queue full (' + MAX_QUEUE + ') — device too slow'));
      return;
    }
    entry.queue.push({ nodeId: node.id, callback: callback, timeout: timeout, enqueueTime: Date.now() });
    return;
  }

  // 新建连接
  if (!entry) {
    entry = CONN_POOL[key] = {
      socket: null,
      inUse: false,
      ownerId: null,
      lastUsed: 0,
      queue: [],
      connecting: true,
      backoffMs: 0,
      lastErrorTime: 0,
      users: {}
    };
    if (entryExtra) {
      for (var ek in entryExtra) entry[ek] = entryExtra[ek];
    }
  } else {
    entry.connecting = true;
  }

  var fired = false;  // 🔧 防重入：connectTimer 与 error 事件可能双触发
  function onConnectError(e) {
    if (fired) return;
    fired = true;
    clearTimeout(connectTimer);
    try { client.destroy(); } catch (_) {}
    entry.connecting = false;
    entry.socket = null;
    entry.inUse = false;
    entry.ownerId = null;
    entry.lastErrorTime = Date.now();
    var base = 300;
    entry.backoffMs = Math.max(base, Math.min((entry.backoffMs || base) * 2, MAX_BACKOFF_MS));
    var q = entry.queue || [];
    entry.queue = [];
    for (var qi = 0; qi < q.length; qi++) {
      try { q[qi].callback(e); } catch (_) {}
    }
    callback(e);
  }

  var client = connector(timeout, function onConnected(sock) {
    if (fired) { try { sock.destroy(); } catch (_) {} return; }  // 超时后才连上：直接丢弃
    fired = true;
    clearTimeout(connectTimer);

    entry.socket = sock;
    entry.inUse = true;
    entry.ownerId = node.id;
    entry.connecting = false;
    entry.lastUsed = Date.now();
    entry.backoffMs = 0;
    entry.lastErrorTime = 0;
    entry.users = entry.users || {};
    entry.users[node.id] = true;

    // 🔧 socket 指纹：过期 socket 事件不得误杀重建后的新连接
    sock.once('end', function () { destroyConnection(key, undefined, sock); });
    sock.once('close', function () { destroyConnection(key, undefined, sock); });
    sock.once('error', function () { destroyConnection(key, undefined, sock); });

    callback(null, sock);
  }, onConnectError);
  entry.socket = client;  // 立即登记：connecting 期间被 destroyConnection 也能销毁，防孤儿 socket

  var connectTimer = setTimeout(function () {
    try { client.destroy(); } catch (_) {}
    onConnectError(new Error('connect timeout'));
  }, timeout);
}

function getConnection(node, host, port, timeout, callback) {
  _acquire(node, poolKey(host, port), _tcpConnector(host, port), timeout, callback);
}

// ===== RTU 取连接：串口独占（同一物理串口不同参数 → 直接拒绝）=====
function getSerialConnection(node, serialCfg, timeout, callback) {
  var cfg = mserial.normalizeSerialConfig(serialCfg);
  if (!cfg) {
    callback(new Error('RTU 配置缺少 serialPort（串口名）'));
    return;
  }
  var key = mserial.serialPoolKey(cfg);
  var keys = Object.keys(CONN_POOL);
  for (var i = 0; i < keys.length; i++) {
    var e = CONN_POOL[keys[i]];
    if (e && e.serial && e.serial.path === cfg.path && keys[i] !== key) {
      callback(new Error('串口 ' + cfg.path + ' 已被占用（连接 ' + keys[i] + '），同一串口同时仅允许一个连接'));
      return;
    }
  }
  _acquire(node, key, _serialConnector(cfg), timeout, callback, { serial: cfg });
}

function peekSerialEntry(serialCfg) {
  var cfg = mserial.normalizeSerialConfig(serialCfg);
  return cfg ? CONN_POOL[mserial.serialPoolKey(cfg)] : undefined;
}

function _release(node, key) {
  var entry = CONN_POOL[key];
  if (!entry) return;
  // 🔧 属主校验：过期/迷途回调不得释放他人持有的连接
  if (entry.ownerId && entry.ownerId !== node.id) return;
  if (entry.queue && entry.queue.length > 0) {
    var now = Date.now();
    while (entry.queue.length > 0) {
      var next = entry.queue.shift();
      if (now - next.enqueueTime > next.timeout) {
        try { next.callback(new Error('Queue timeout')); } catch (_) {}
        continue;
      }
      entry.lastUsed = Date.now();
      if (entry.socket && !entry.socket.destroyed) {
        entry.inUse = true;
        entry.ownerId = next.nodeId;              // 🔧 队列发放也登记属主
        entry.users = entry.users || {};
        entry.users[next.nodeId] = true;          // 🔧 队列发放也登记引用计数
        entry.socket.setTimeout(next.timeout);
        try { next.callback(null, entry.socket); } catch (_) {}
        return;
      }
      try { next.callback(new Error('Connection lost')); } catch (_) {}
    }
  }
  entry.inUse = false;
  entry.ownerId = null;
  entry.lastUsed = Date.now();
}

function releaseConnection(node, host, port) {
  _release(node, poolKey(host, port));
}

function releaseSerialConnection(node, serialCfg) {
  var cfg = mserial.normalizeSerialConfig(serialCfg);
  if (cfg) _release(node, mserial.serialPoolKey(cfg));
}

function destroyConnection(host, port, sock) {
  // 兼容两种调用：destroyConnection(key) 或 destroyConnection(host, port[, sock])
  // RTU 用法：destroyConnection(serialPoolKey, undefined, sock)（key 本身即完整键）
  var key = (typeof port === 'undefined') ? host : poolKey(host, port);
  var entry = CONN_POOL[key];
  if (!entry || entry._destroyed) return;
  entry._destroyed = true;  // 🔧 防重入：socket.destroy() 可能同步触发 close 事件再次进入
  // 🔧 socket 指纹校验：仅当目标就是池里当前 socket 时才销毁（防过期事件误杀新连接）
  if (sock && entry.socket && entry.socket !== sock) return;
  if (entry.socket && !entry.socket.destroyed) {
    try { entry.socket.destroy(); } catch (_) {}
  }
  var q = entry.queue || [];
  entry.queue = [];
  delete CONN_POOL[key];
  for (var qi = 0; qi < q.length; qi++) {
    try { q[qi].callback(new Error('Connection destroyed')); } catch (_) {}
  }
}

// 🔧 节点关闭后的兜底清理：释放所有权（若在持有）并摘除 users 标记
// 用于 _closed 早退路径：连接可能已被 nodeClosed 销毁（no-op），也可能刚被
// 队列发放/重连成功给这个已死节点（释放并摘标记，防死节点 id 残留）
function _detach(node, key) {
  _release(node, key);
  var entry = CONN_POOL[key];
  if (entry && entry.users) delete entry.users[node.id];
}

function detachNode(node, host, port) {
  _detach(node, poolKey(host, port));
}

function detachSerialNode(node, serialCfg) {
  var cfg = mserial.normalizeSerialConfig(serialCfg);
  if (cfg) _detach(node, mserial.serialPoolKey(cfg));
}

// 节点创建：计数 + 启动清理定时器
function nodeOpened() {
  _activeNodeCount++;
  ensureCleanTimer();
}

// 节点关闭：摘 users；在途属主关闭 → 直接销毁连接（防 inUse 永久卡死）；
// 最后一个使用者离开 → 销毁空闲连接
function nodeClosed(node) {
  var keys = Object.keys(CONN_POOL);
  for (var i = 0; i < keys.length; i++) {
    var entry = CONN_POOL[keys[i]];
    if (!entry) continue;
    if (entry.users && entry.users[node.id]) delete entry.users[node.id];
    // 🔧 清理队列中属于本节点的待处理条目（防死节点回调残留占坑）
    if (entry.queue && entry.queue.length > 0) {
      entry.queue = entry.queue.filter(function (q) { return q.nodeId !== node.id; });
    }
    if (entry.ownerId === node.id) {
      destroyConnection(keys[i]);
    } else if (entry.users && Object.keys(entry.users).length === 0) {
      destroyConnection(keys[i]);
    }
  }
  _activeNodeCount--;
  if (_activeNodeCount <= 0 && _cleanTimer) {
    clearInterval(_cleanTimer);
    _cleanTimer = null;
  }
}

module.exports = {
  poolKey: poolKey,
  serialPoolKey: mserial.serialPoolKey,
  peekEntry: peekEntry,
  peekSerialEntry: peekSerialEntry,
  getConnection: getConnection,
  getSerialConnection: getSerialConnection,
  releaseConnection: releaseConnection,
  releaseSerialConnection: releaseSerialConnection,
  destroyConnection: destroyConnection,
  detachNode: detachNode,
  detachSerialNode: detachSerialNode,
  nodeOpened: nodeOpened,
  nodeClosed: nodeClosed
};
