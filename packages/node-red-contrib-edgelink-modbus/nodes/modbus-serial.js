/**
 * modbus-serial — Modbus RTU 串口传输适配层
 *
 * serialport 为可选依赖：TCP-only 环境未安装时本模块仍可正常加载，
 * 仅在真正发起 RTU 连接（createSocket().connect()）时报中文错误。
 *
 * SerialSock 把 serialport 包装成与 net.Socket 相近的形态
 * （write / on('data') / once('timeout'|'error'|'close') / setTimeout / destroy / destroyed），
 * 供 modbus-pool 与读写节点复用现有 TCP 交互模式：
 *   - setTimeout(ms)：闲置超时（对齐 net.Socket 语义，收到数据即重置计时）
 *   - 串口错误/断开 → 'error'/'close' 事件 → 连接池走与 TCP 相同的销毁重建逻辑
 */
'use strict';
var events = require('events');
var util = require('util');

var SerialPort = null;
try {
  SerialPort = require('serialport').SerialPort;
} catch (e) {
  SerialPort = null;  // TCP-only 环境未安装 serialport
}

var MISSING_ERR = '未安装 serialport，无法使用 Modbus RTU 串口通讯（请在驱动包目录执行 npm install serialport）';

function isAvailable() { return !!SerialPort; }

var PARITY_CHAR = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' };

// ===== 串口参数归一化（无 serialPort/path → 返回 null，表示走 TCP）=====
function normalizeSerialConfig(raw) {
  raw = raw || {};
  var path = raw.serialPort != null ? String(raw.serialPort).trim()
           : (raw.path != null ? String(raw.path).trim() : '');
  if (!path) return null;
  var baud = parseInt(raw.baudRate, 10);
  if (isNaN(baud) || baud < 300 || baud > 1000000) baud = 9600;
  var dataBits = parseInt(raw.dataBits, 10);
  if ([5, 6, 7, 8].indexOf(dataBits) < 0) dataBits = 8;
  var parity = String(raw.parity || 'none').toLowerCase();
  if (!PARITY_CHAR[parity]) parity = 'none';
  var stopBits = parseInt(raw.stopBits, 10);
  if ([1, 2].indexOf(stopBits) < 0) stopBits = 1;
  return { path: path, baudRate: baud, dataBits: dataBits, parity: parity, stopBits: stopBits };
}

// ===== 池键：rtu:COM3:9600:8N1（参数化，同参复用、异参独占拦截）=====
function serialPoolKey(cfg) {
  return 'rtu:' + cfg.path + ':' + cfg.baudRate + ':' + cfg.dataBits + (PARITY_CHAR[cfg.parity] || 'N') + cfg.stopBits;
}

// ===== SerialSock：serialport → net.Socket 形态适配 =====
function SerialSock(cfg) {
  events.EventEmitter.call(this);
  this.serialCfg = cfg;
  this.destroyed = false;
  this._port = null;
  this._tmoMs = 0;
  this._tmoTimer = null;
  this._closeEmitted = false;
}
util.inherits(SerialSock, events.EventEmitter);

SerialSock.prototype._armTimeout = function () {
  var self = this;
  if (self._tmoTimer) { clearTimeout(self._tmoTimer); self._tmoTimer = null; }
  if (self._tmoMs > 0 && !self.destroyed) {
    self._tmoTimer = setTimeout(function () { self.emit('timeout'); }, self._tmoMs);
    if (self._tmoTimer.unref) self._tmoTimer.unref();
  }
};

SerialSock.prototype.setTimeout = function (ms) {
  this._tmoMs = ms || 0;
  this._armTimeout();
};

SerialSock.prototype.setKeepAlive = function () {};  // 串口无此概念，对齐 net.Socket 接口

SerialSock.prototype._emitClose = function () {
  if (this._closeEmitted) return;
  this._closeEmitted = true;
  this.emit('close');
};

SerialSock.prototype.connect = function (onOk, onErr) {
  var self = this;
  if (!SerialPort) {
    setImmediate(function () { onErr(new Error(MISSING_ERR)); });
    return;
  }
  var port;
  try {
    port = new SerialPort({
      path: this.serialCfg.path,
      baudRate: this.serialCfg.baudRate,
      dataBits: this.serialCfg.dataBits,
      parity: this.serialCfg.parity,
      stopBits: this.serialCfg.stopBits,
      autoOpen: false
    });
  } catch (e) {
    setImmediate(function () { onErr(e); });
    return;
  }
  this._port = port;

  port.on('data', function (chunk) {
    self._armTimeout();  // 有数据活动 → 闲置计时重置（对齐 net.Socket setTimeout 语义）
    self.emit('data', chunk);
  });
  port.on('error', function (e) {
    // open 阶段的错误经 open 回调上报；运行期错误冒泡给池（无监听时不得崩进程）
    if (self.listenerCount('error') > 0) self.emit('error', e);
  });
  port.on('close', function () {
    self.destroyed = true;
    if (self._tmoTimer) { clearTimeout(self._tmoTimer); self._tmoTimer = null; }
    self._emitClose();
  });

  var settled = false;
  port.open(function (e) {
    if (settled) return;
    settled = true;
    if (e) { self.destroyed = true; onErr(e); return; }
    onOk(self);
  });
};

SerialSock.prototype.write = function (buf, cb) {
  if (!this._port || this.destroyed) {
    var e = new Error('serial port not open');
    if (cb) { cb(e); return true; }
    throw e;
  }
  return this._port.write(buf, cb);
};

SerialSock.prototype.destroy = function () {
  if (this.destroyed) return;
  this.destroyed = true;
  if (this._tmoTimer) { clearTimeout(this._tmoTimer); this._tmoTimer = null; }
  var port = this._port;
  this._port = null;
  if (port && port.isOpen) {
    try { port.close(function () {}); } catch (_) {}
  }
  var self = this;
  setImmediate(function () { self._emitClose(); });
};

function createSocket(serialCfg) {
  return new SerialSock(serialCfg);
}

module.exports = {
  isAvailable: isAvailable,
  MISSING_ERR: MISSING_ERR,
  normalizeSerialConfig: normalizeSerialConfig,
  serialPoolKey: serialPoolKey,
  createSocket: createSocket
};
