/* eslint-env mocha */
'use strict';

var helper = require('node-red-node-test-helper');
var assert = require('assert');
var events = require('events');
var util = require('util');
var net = require('net');
var proxyquire = require('proxyquire');

var mb = require('../nodes/modbus-protocol');

// ==================== serialport stub（不依赖真实串口）====================
var fakeState = {
  ports: [],          // 所有构造过的 FakeSerialPort（断言构造参数用）
  openError: null,    // 设置后 open() 一律失败
  responder: null     // function(reqBuf, port)，用 port.emitData(chunk) 回应
};

function FakeSerialPort(opts) {
  events.EventEmitter.call(this);
  this.opts = opts;
  this.isOpen = false;
  this.writes = [];   // 所有写出的请求帧
  fakeState.ports.push(this);
}
util.inherits(FakeSerialPort, events.EventEmitter);
FakeSerialPort.prototype.open = function (cb) {
  var self = this;
  setImmediate(function () {
    if (fakeState.openError) {
      var e = fakeState.openError;
      self.emit('error', e);   // 真实 serialport open 失败也会发 error（考验 SerialSock 防护）
      cb(e);
      return;
    }
    self.isOpen = true;
    self.emit('open');
    cb(null);
  });
};
FakeSerialPort.prototype.write = function (buf, cb) {
  var self = this;
  var b = Buffer.from(buf);
  this.writes.push(b);
  setImmediate(function () {
    if (cb) cb(null);
    if (fakeState.responder) fakeState.responder(b, self);
  });
  return true;
};
FakeSerialPort.prototype.emitData = function (chunk) {
  var self = this;
  setImmediate(function () { self.emit('data', chunk); });
};
FakeSerialPort.prototype.close = function (cb) {
  var self = this;
  setImmediate(function () {
    self.isOpen = false;
    self.emit('close');
    if (cb) cb(null);
  });
};

// 逐层 proxyquire：serialport → modbus-serial → modbus-pool → 读写节点
var mserial = proxyquire('../nodes/modbus-serial.js', {
  serialport: { SerialPort: FakeSerialPort, '@noCallThru': true }
});
var pool = proxyquire('../nodes/modbus-pool.js', { './modbus-serial': mserial });
var mbReadNode = proxyquire('../nodes/modbus-read.js', { './modbus-pool': pool, './modbus-serial': mserial });
var mbWriteNode = proxyquire('../nodes/modbus-write.js', { './modbus-pool': pool, './modbus-serial': mserial });
var mbConfigNode = require('../nodes/modbus-config.js');

// ===== 测试辅助：构造带 CRC 的 RTU 帧（CRC 正确性由已知向量用例独立保证）=====
function rtuFrame(body) {
  var crc = mb.crc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF])]);
}
function rtuReadRegsResponse(unitId, fc, words) {
  var data = Buffer.alloc(words.length * 2);
  words.forEach(function (w, i) { data.writeUInt16BE(w & 0xFFFF, i * 2); });
  return rtuFrame(Buffer.concat([Buffer.from([unitId, fc, data.length]), data]));
}
// 默认 RTU 从站：按请求功能码回正确帧
function defaultResponder(req, port) {
  var unitId = req[0], fc = req[1];
  var addr = req.readUInt16BE(2), qty = req.readUInt16BE(4);
  if (fc === 3 || fc === 4) {
    var words = [];
    for (var i = 0; i < qty; i++) words.push(0x1000 + addr + i);
    port.emitData(rtuReadRegsResponse(unitId, fc, words));
  } else if (fc === 1 || fc === 2) {
    var bc = Math.ceil(qty / 8);
    port.emitData(rtuFrame(Buffer.concat([Buffer.from([unitId, fc, bc]), Buffer.alloc(bc, 0x01)])));
  } else if (fc === 16) {
    port.emitData(rtuFrame(Buffer.from([unitId, 16, req[2], req[3], req[4], req[5]])));
  } else if (fc === 5 || fc === 6) {
    port.emitData(rtuFrame(req.slice(0, 6)));  // 回显地址+值
  }
}

describe('modbus-rtu', function () {
  afterEach(function (done) {
    helper.unload().then(function () {
      fakeState.ports = [];
      fakeState.openError = null;
      fakeState.responder = null;
      done();
    }).catch(done);
  });

  // ==================== 协议层 ====================
  describe('crc16（已知向量）', function () {
    it("'123456789' → 0x4B37（CRC-16/MODBUS 标准校验值）", function () {
      assert.strictEqual(mb.crc16(Buffer.from('123456789', 'ascii')), 0x4B37);
    });

    it('空输入 → 0xFFFF（初始值）', function () {
      assert.strictEqual(mb.crc16(Buffer.alloc(0)), 0xFFFF);
    });

    it('经典请求帧 01 03 00 00 00 0A → CRC 0xCDC5（低字节在前 C5 CD）', function () {
      var r = mb.buildRtuFrame(1, 3, 0, 10);
      assert.deepStrictEqual(r.buf, Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0A, 0xC5, 0xCD]));
    });

    it('checkRtuCrc 接受好帧、拒绝坏帧', function () {
      var good = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0A, 0xC5, 0xCD]);
      var bad = Buffer.from(good); bad[7] ^= 0xFF;
      assert.strictEqual(mb.checkRtuCrc(good), true);
      assert.strictEqual(mb.checkRtuCrc(bad), false);
      assert.strictEqual(mb.checkRtuCrc(Buffer.from([0x01])), false);
    });
  });

  describe('buildRtuFrame / buildRtuWriteFrame', function () {
    it('RTU 读帧无 MBAP 头：[unit][fc][addr][qty][crc]，txnId=0', function () {
      var r = mb.buildRtuFrame(2, 4, 100, 3);
      assert.strictEqual(r.buf.length, 8);
      assert.strictEqual(r.buf[0], 2);
      assert.strictEqual(r.buf[1], 4);
      assert.strictEqual(r.buf.readUInt16BE(2), 100);
      assert.strictEqual(r.buf.readUInt16BE(4), 3);
      assert.strictEqual(mb.checkRtuCrc(r.buf), true);
      assert.strictEqual(r.txnId, 0);
    });

    it('FC06 写单寄存器帧（已知向量 01 06 00 64 00 2A 49 CA）', function () {
      var r = mb.buildRtuWriteFrame(1, 6, 100, [42]);
      assert.deepStrictEqual(r.buf, Buffer.from([0x01, 0x06, 0x00, 0x64, 0x00, 0x2A, 0x49, 0xCA]));
      assert.strictEqual(r.txnId, 0);
    });

    it('FC16 写多寄存器帧（已知向量 …33 D9）', function () {
      var r = mb.buildRtuWriteFrame(1, 16, 200, [0x1111, 0x2222]);
      assert.deepStrictEqual(r.buf,
        Buffer.from([0x01, 0x10, 0x00, 0xC8, 0x00, 0x02, 0x04, 0x11, 0x11, 0x22, 0x22, 0x33, 0xD9]));
    });

    it('FC05 写线圈帧（0xFF00=ON）', function () {
      var r = mb.buildRtuWriteFrame(2, 5, 3, [0xFF00]);
      assert.strictEqual(r.buf.length, 8);
      assert.strictEqual(r.buf[1], 5);
      assert.strictEqual(r.buf.readUInt16BE(2), 3);
      assert.strictEqual(r.buf.readUInt16BE(4), 0xFF00);
      assert.strictEqual(mb.checkRtuCrc(r.buf), true);
    });
  });

  describe('rtuExpectedResponseLen', function () {
    it('按功能码算期望响应长度', function () {
      assert.strictEqual(mb.rtuExpectedResponseLen(3, 2), 9);   // 3+2*2+2
      assert.strictEqual(mb.rtuExpectedResponseLen(4, 1), 7);   // 3+1*2+2
      assert.strictEqual(mb.rtuExpectedResponseLen(1, 10), 7);  // 3+ceil(10/8)+2
      assert.strictEqual(mb.rtuExpectedResponseLen(2, 1), 6);   // 3+1+2
      assert.strictEqual(mb.rtuExpectedResponseLen(5, 0), 8);   // 回显
      assert.strictEqual(mb.rtuExpectedResponseLen(6, 0), 8);
      assert.strictEqual(mb.rtuExpectedResponseLen(16, 0), 8);
    });
  });

  describe('parseRtuResponse', function () {
    it('解析保持寄存器响应（含已知 CRC 81 07）', function () {
      var buf = Buffer.from([0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78, 0x81, 0x07]);
      var res = mb.parseRtuResponse(buf, 10, 'holding', 2, 1);
      assert.strictEqual(res.err, undefined);
      assert.strictEqual(res[10], 0x1234);
      assert.strictEqual(res[11], 0x5678);
    });

    it('解析线圈响应（已知 CRC D1 8F）', function () {
      var buf = Buffer.from([0x01, 0x01, 0x01, 0x0A, 0xD1, 0x8F]);
      var res = mb.parseRtuResponse(buf, 0, 'coil', 8, 1);
      assert.strictEqual(res[0], 0);
      assert.strictEqual(res[1], 1);
      assert.strictEqual(res[3], 1);
      assert.strictEqual(res[4], 0);
    });

    it('解析异常帧（01 83 02 C0 F1 → exCode 2）', function () {
      var buf = Buffer.from([0x01, 0x83, 0x02, 0xC0, 0xF1]);
      var res = mb.parseRtuResponse(buf, 0, 'holding', 1, 1);
      assert.strictEqual(res.exCode, 2);
      assert.ok(res.exText.indexOf('Illegal data address') >= 0);
    });

    it('CRC 错 → err（坏帧不得当好数据）', function () {
      var buf = Buffer.from([0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78, 0x81, 0x08]);
      var res = mb.parseRtuResponse(buf, 10, 'holding', 2, 1);
      assert.ok(res.err && res.err.indexOf('CRC') >= 0, '应报 CRC 错: ' + res.err);
    });

    it('截断帧 → err', function () {
      var buf = Buffer.from([0x01, 0x03, 0x04, 0x12, 0x34, 0x56]);
      var res = mb.parseRtuResponse(buf, 10, 'holding', 2, 1);
      assert.ok(res.err, '截断帧应报错');
    });

    it('Unit ID 不匹配 → err', function () {
      var buf = Buffer.from([0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78, 0x81, 0x07]);
      var res = mb.parseRtuResponse(buf, 10, 'holding', 2, 2);
      assert.strictEqual(res.err, 'Unit ID mismatch');
    });

    it('功能码不匹配 → err（防止把 FC1 响应当 FC3 解析）', function () {
      var buf = rtuFrame(Buffer.from([0x01, 0x01, 0x01, 0x0A]));
      var res = mb.parseRtuResponse(buf, 0, 'holding', 8, 1);
      assert.ok(res.err && res.err.indexOf('Function code mismatch') >= 0);
    });
  });

  describe('parseRtuWriteResponse', function () {
    it('接受 FC06 正确回显', function () {
      var buf = Buffer.from([0x01, 0x06, 0x00, 0x64, 0x00, 0x2A, 0x49, 0xCA]);
      var res = mb.parseRtuWriteResponse(buf, 6, 100, [42], 1);
      assert.strictEqual(res.ok, true);
    });

    it('拒绝值回显不一致', function () {
      var buf = rtuFrame(Buffer.from([0x01, 0x06, 0x00, 0x64, 0x00, 0x2B]));
      var res = mb.parseRtuWriteResponse(buf, 6, 100, [42], 1);
      assert.ok(res.err.indexOf('Value echo mismatch') >= 0);
    });

    it('接受 FC16 正确回显（地址+数量）', function () {
      var buf = rtuFrame(Buffer.from([0x01, 0x10, 0x00, 0xC8, 0x00, 0x02]));
      var res = mb.parseRtuWriteResponse(buf, 16, 200, [0x1111, 0x2222], 1);
      assert.strictEqual(res.ok, true);
    });

    it('解析写异常帧', function () {
      var buf = rtuFrame(Buffer.from([0x01, 0x86, 0x02]));
      var res = mb.parseRtuWriteResponse(buf, 6, 100, [42], 1);
      assert.strictEqual(res.exCode, 2);
    });

    it('CRC 错 → err', function () {
      var buf = rtuFrame(Buffer.from([0x01, 0x06, 0x00, 0x64, 0x00, 0x2A]));
      buf[buf.length - 1] ^= 0xFF;
      var res = mb.parseRtuWriteResponse(buf, 6, 100, [42], 1);
      assert.ok(res.err && res.err.indexOf('CRC') >= 0);
    });
  });

  // ==================== 串口配置归一化 ====================
  describe('modbus-serial normalizeSerialConfig / serialPoolKey', function () {
    it('默认值 9600/8/N/1；无 serialPort → null（走 TCP）', function () {
      assert.deepStrictEqual(mserial.normalizeSerialConfig({ serialPort: 'COM3' }),
        { path: 'COM3', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 });
      assert.strictEqual(mserial.normalizeSerialConfig({}), null);
      assert.strictEqual(mserial.normalizeSerialConfig({ serialPort: '  ' }), null);
      assert.strictEqual(mserial.normalizeSerialConfig(null), null);
    });

    it('非法参数回退默认值', function () {
      var cfg = mserial.normalizeSerialConfig({ serialPort: 'COM1', baudRate: 'abc', dataBits: 9, parity: 'weird', stopBits: 3 });
      assert.strictEqual(cfg.baudRate, 9600);
      assert.strictEqual(cfg.dataBits, 8);
      assert.strictEqual(cfg.parity, 'none');
      assert.strictEqual(cfg.stopBits, 1);
    });

    it('serialPoolKey 参数化：rtu:COM3:9600:8N1', function () {
      assert.strictEqual(mserial.serialPoolKey(mserial.normalizeSerialConfig({ serialPort: 'COM3' })), 'rtu:COM3:9600:8N1');
      assert.strictEqual(mserial.serialPoolKey(mserial.normalizeSerialConfig({ serialPort: 'COM1', baudRate: 19200, parity: 'even', stopBits: 2 })), 'rtu:COM1:19200:8E2');
    });

    it('serialport 未安装时 isAvailable=false，connect 报中文错误', function (done) {
      var missing = proxyquire('../nodes/modbus-serial.js', { serialport: { '@noCallThru': true } });
      assert.strictEqual(missing.isAvailable(), false);
      var sock = missing.createSocket(missing.normalizeSerialConfig({ serialPort: 'COM3' }));
      sock.connect(function () { done(new Error('不应成功')); }, function (e) {
        assert.ok(e.message.indexOf('未安装 serialport') >= 0, '应为中文错误: ' + e.message);
        done();
      });
    });
  });

  // ==================== 连接池 RTU ====================
  describe('modbus-pool RTU', function () {
    var _usedKeys;
    beforeEach(function () { _usedKeys = []; });
    afterEach(function () {
      for (var i = 0; i < _usedKeys.length; i++) {
        try { pool.destroyConnection(_usedKeys[i]); } catch (_) {}
      }
    });
    function track(cfg) {
      var k = pool.serialPoolKey(cfg);
      if (_usedKeys.indexOf(k) < 0) _usedKeys.push(k);
      return k;
    }

    it('RTU 连接入池并按 rtu: 键复用', function (done) {
      var n = { id: 'rtuA' };
      var cfg = { serialPort: 'COM3' };
      track(mserial.normalizeSerialConfig(cfg));
      pool.getSerialConnection(n, cfg, 2000, function (err, sock1) {
        assert.ifError(err);
        assert.ok(sock1, '应返回 socket 形态对象');
        assert.strictEqual(fakeState.ports.length, 1);
        assert.strictEqual(fakeState.ports[0].opts.path, 'COM3');
        assert.strictEqual(fakeState.ports[0].opts.baudRate, 9600);
        assert.strictEqual(fakeState.ports[0].opts.dataBits, 8);
        assert.strictEqual(fakeState.ports[0].opts.parity, 'none');
        assert.strictEqual(fakeState.ports[0].opts.stopBits, 1);
        pool.releaseSerialConnection(n, cfg);
        pool.getSerialConnection(n, cfg, 2000, function (err2, sock2) {
          assert.ifError(err2);
          assert.strictEqual(sock1, sock2, '应复用同一串口连接');
          assert.strictEqual(fakeState.ports.length, 1, '不应重复打开串口');
          pool.releaseSerialConnection(n, cfg);
          var entry = pool.peekSerialEntry(cfg);
          assert.ok(entry, '释放后条目仍在池中');
          assert.strictEqual(entry.inUse, false);
          done();
        });
      });
    });

    it('串口独占：同一串口不同参数 → 拒绝', function (done) {
      var n = { id: 'rtuB' };
      var cfg1 = { serialPort: 'COM4', baudRate: 9600 };
      var cfg2 = { serialPort: 'COM4', baudRate: 19200 };
      track(mserial.normalizeSerialConfig(cfg1));
      track(mserial.normalizeSerialConfig(cfg2));
      pool.getSerialConnection(n, cfg1, 2000, function (err) {
        assert.ifError(err);
        pool.releaseSerialConnection(n, cfg1);
        pool.getSerialConnection(n, cfg2, 2000, function (err2) {
          assert.ok(err2, '不同参数应被拒绝');
          assert.ok(err2.message.indexOf('占用') >= 0, '应为占用错误: ' + err2.message);
          done();
        });
      });
    });

    it('串口运行期 error 事件 → 连接销毁出池（与 TCP 同一重建逻辑）', function (done) {
      var n = { id: 'rtuC' };
      var cfg = { serialPort: 'COM5' };
      track(mserial.normalizeSerialConfig(cfg));
      pool.getSerialConnection(n, cfg, 2000, function (err, sock) {
        assert.ifError(err);
        pool.releaseSerialConnection(n, cfg);
        assert.ok(pool.peekSerialEntry(cfg), '事件前条目应在池中');
        fakeState.ports[0].emit('error', new Error('device unplugged'));
        assert.strictEqual(pool.peekSerialEntry(cfg), undefined, 'error 后条目应销毁');
        done();
      });
    });

    it('open 失败 → 报错并进入退避', function (done) {
      var n = { id: 'rtuD' };
      var cfg = { serialPort: 'COM6' };
      track(mserial.normalizeSerialConfig(cfg));
      fakeState.openError = new Error('Access denied');
      pool.getSerialConnection(n, cfg, 1000, function (err) {
        assert.ok(err, 'open 失败应报错');
        assert.ok(err.message.indexOf('Access denied') >= 0);
        pool.getSerialConnection(n, cfg, 1000, function (err2) {
          assert.ok(err2, '退避期内应直接失败');
          assert.ok(err2.message.indexOf('backoff') >= 0, '应为 backoff 错误: ' + err2.message);
          fakeState.openError = null;
          done();
        });
      });
    });
  });

  // ==================== 读节点 RTU ====================
  describe('modbus-read node RTU', function () {
    function rtuFlow(serialCfgFields) {
      var cfg = { id: 'rtc', type: 'modbus-config', name: 'RTU-Cfg', host: '127.0.0.1', port: 1, unitId: 1, timeout: 800, maxRetries: 0, retryInterval: 30 };
      if (serialCfgFields) {
        for (var k in serialCfgFields) cfg[k] = serialCfgFields[k];
      }
      return [
        cfg,
        { id: 'rtr', type: 'modbus-read', name: 'RTU Read', modbus: 'rtc', wires: [['rth']] },
        { id: 'rth', type: 'helper' }
      ];
    }

    it('成功路径：RTU 收帧 + 契约形状与 TCP 完全一致', function (done) {
      helper.settings({ mbSimulationMode: false });
      fakeState.responder = defaultResponder;
      var flow = rtuFlow({ serialPort: 'COM10', baudRate: 9600 });
      helper.load([mbConfigNode, mbReadNode], flow, function () {
        var helperNode = helper.getNode('rth');
        var readNode = helper.getNode('rtr');
        helperNode.on('input', function (msg) {
          try {
            var p = msg.payload;
            // 契约形状与 TCP 完全一致
            assert.deepStrictEqual(Object.keys(p).sort(),
              ['success', 'deviceId', 'deviceName', 'data', 'error', 'driverType', 'plcIp', 'plcPort', 'roundTimeMs'].sort());
            assert.strictEqual(p.success, true, JSON.stringify(p));
            assert.strictEqual(p.deviceId, 60);
            assert.strictEqual(p.deviceName, 'RTU-PLC');
            assert.strictEqual(p.error, null);
            assert.strictEqual(p.driverType, 'driver-modbus-tcp');
            assert.strictEqual(typeof p.roundTimeMs, 'number');

            // data 条目形状与 TCP 一致
            var t1 = p.data['t1'];
            assert.deepStrictEqual(Object.keys(t1).sort(),
              ['rawValue', 'rawWord', 'engValue', 'quality', 'ts', 'regType'].sort());
            assert.strictEqual(t1.rawValue, 0x100A);  // 0x1000 + addr(10)
            assert.strictEqual(t1.quality, 0);
            assert.strictEqual(t1.regType, 'holding');
            assert.strictEqual(p.data['c1'].rawValue, 1);  // 响应位全 1
            assert.strictEqual(p.data['c1'].quality, 0);

            // 线上走的确实是 RTU 帧（无 MBAP，8 字节带 CRC）
            assert.strictEqual(fakeState.ports.length, 1);
            assert.strictEqual(fakeState.ports[0].opts.path, 'COM10');
            var w0 = fakeState.ports[0].writes[0];
            var w1 = fakeState.ports[0].writes[1];
            assert.strictEqual(w0.length, 8);
            assert.strictEqual(w0[0], 1);   // unitId
            assert.strictEqual(w0[1], 3);   // FC03（holding）
            assert.strictEqual(mb.checkRtuCrc(w0), true);
            assert.strictEqual(w1[1], 1);   // FC01（coil）
            assert.strictEqual(mb.checkRtuCrc(w1), true);

            // RTU 连接已入池（rtu: 参数化键）
            assert.ok(pool.peekSerialEntry({ serialPort: 'COM10' }), 'RTU 连接应入池');
            done();
          } catch (e) { done(e); }
        });
        readNode.receive({
          payload: { id: 60, deviceName: 'RTU-PLC' },
          tags: [
            { id: 't1', regType: 'holding', addr: 10, dataType: 'INT16' },
            { id: 'c1', regType: 'coil', addr: 0, dataType: 'BOOL' }
          ]
        });
      });
    });

    it('失败路径：CRC 错帧 → success:false + quality:2 占位（与 TCP 失败形状一致）', function (done) {
      helper.settings({ mbSimulationMode: false });
      fakeState.responder = function (req, port) {
        var unitId = req[0], fc = req[1], addr = req.readUInt16BE(2), qty = req.readUInt16BE(4);
        var words = [];
        for (var i = 0; i < qty; i++) words.push(0x1000 + addr + i);
        var frame = rtuReadRegsResponse(unitId, fc, words);
        frame[frame.length - 1] ^= 0xFF;  // 破坏 CRC
        port.emitData(frame);
      };
      var flow = rtuFlow({ serialPort: 'COM11' });
      helper.load([mbConfigNode, mbReadNode], flow, function () {
        var helperNode = helper.getNode('rth');
        var readNode = helper.getNode('rtr');
        helperNode.on('input', function (msg) {
          try {
            var p = msg.payload;
            assert.strictEqual(p.success, false);
            assert.ok(p.error && p.error.indexOf('CRC') >= 0, '错误应含 CRC: ' + p.error);
            assert.strictEqual(p.data['t1'].rawValue, null);
            assert.strictEqual(p.data['t1'].quality, 2, '失败点位 quality 占位（与 TCP 相同）');
            assert.strictEqual(p.driverType, 'driver-modbus-tcp');
            done();
          } catch (e) { done(e); }
        });
        readNode.receive({
          payload: { id: 61 },
          tags: [{ id: 't1', regType: 'holding', addr: 10, dataType: 'INT16' }]
        });
      });
    });

    it('截断帧：帧间静默超时收尾 → 计入失败（不按固定字节数死等）', function (done) {
      helper.settings({ mbSimulationMode: false });
      fakeState.responder = function (req, port) {
        var frame = rtuReadRegsResponse(req[0], req[1], [0x1234]);
        port.emitData(frame.slice(0, 4));  // 只发前 4 字节（完整应 7 字节）
      };
      var flow = rtuFlow({ serialPort: 'COM12' });
      helper.load([mbConfigNode, mbReadNode], flow, function () {
        var helperNode = helper.getNode('rth');
        var readNode = helper.getNode('rtr');
        helperNode.on('input', function (msg) {
          try {
            var p = msg.payload;
            assert.strictEqual(p.success, false);
            assert.ok(p.error && p.error.indexOf('[RTU]') >= 0, '错误应含 [RTU]: ' + p.error);
            assert.strictEqual(p.data['t1'].quality, 2);
            done();
          } catch (e) { done(e); }
        });
        readNode.receive({
          payload: { id: 62 },
          tags: [{ id: 't1', regType: 'holding', addr: 10, dataType: 'INT16' }]
        });
      });
    });

    it('整帧超时：无响应 → 销毁重连（与 TCP 相同重建逻辑）后失败', function (done) {
      helper.settings({ mbSimulationMode: false });
      fakeState.responder = null;  // 不应答
      var flow = rtuFlow({ serialPort: 'COM13' });
      helper.load([mbConfigNode, mbReadNode], flow, function () {
        var helperNode = helper.getNode('rth');
        var readNode = helper.getNode('rtr');
        helperNode.on('input', function (msg) {
          try {
            var p = msg.payload;
            assert.strictEqual(p.success, false);
            assert.ok(p.error, '应有错误信息');
            assert.ok(fakeState.ports.length >= 2, '超时后应重建连接（新开串口），实际: ' + fakeState.ports.length);
            done();
          } catch (e) { done(e); }
        });
        readNode.receive({
          payload: { id: 63 },
          tags: [{ id: 't1', regType: 'holding', addr: 10, dataType: 'INT16' }]
        });
      });
    });

    it('RTU unitId 越界（0）→ 立即失败且不动串口', function (done) {
      helper.settings({ mbSimulationMode: false });
      fakeState.responder = defaultResponder;
      var flow = rtuFlow({ serialPort: 'COM14' });
      helper.load([mbConfigNode, mbReadNode], flow, function () {
        var helperNode = helper.getNode('rth');
        var readNode = helper.getNode('rtr');
        helperNode.on('input', function (msg) {
          try {
            var p = msg.payload;
            assert.strictEqual(p.success, false);
            assert.ok(p.error.indexOf('1-247') >= 0, '应为 unitId 范围错误: ' + p.error);
            assert.strictEqual(fakeState.ports.length, 0, '不应打开串口');
            done();
          } catch (e) { done(e); }
        });
        readNode.receive({
          payload: { id: 64, protocolParams: { unitId: 0 } },
          tags: [{ id: 't1', regType: 'holding', addr: 10, dataType: 'INT16' }]
        });
      });
    });

    it('传输选择：protocolParams.serialPort → RTU（配置节点无串口也生效）', function (done) {
      helper.settings({ mbSimulationMode: false });
      fakeState.responder = defaultResponder;
      var flow = rtuFlow(null);  // 配置节点不带 serialPort，host 指向无监听端口（走 TCP 必失败）
      helper.load([mbConfigNode, mbReadNode], flow, function () {
        var helperNode = helper.getNode('rth');
        var readNode = helper.getNode('rtr');
        helperNode.on('input', function (msg) {
          try {
            var p = msg.payload;
            assert.strictEqual(p.success, true, '应走 RTU 成功: ' + JSON.stringify(p));
            assert.strictEqual(fakeState.ports.length, 1);
            assert.strictEqual(fakeState.ports[0].opts.path, 'COM15');
            assert.strictEqual(fakeState.ports[0].opts.baudRate, 19200);
            assert.strictEqual(fakeState.ports[0].opts.parity, 'even');
            assert.strictEqual(p.data['t1'].rawValue, 0x100A);
            done();
          } catch (e) { done(e); }
        });
        readNode.receive({
          payload: {
            id: 65,
            protocolParams: { serialPort: 'COM15', baudRate: 19200, parity: 'even', stopBits: 2, unitId: 1 }
          },
          tags: [{ id: 't1', regType: 'holding', addr: 10, dataType: 'INT16' }]
        });
      });
    });

    it('传输选择：不带 serialPort → TCP（现有行为不变）', function (done) {
      helper.settings({ mbSimulationMode: false });
      var server = net.createServer(function (socket) {
        socket.on('data', function (chunk) {
          if (chunk.length < 12) return;
          var fc = chunk[7];
          var qty = chunk.readUInt16BE(10);
          var pdu = Buffer.concat([Buffer.from([fc, qty * 2]), Buffer.alloc(qty * 2)]);
          var hdr = Buffer.alloc(7);
          chunk.copy(hdr, 0, 0, 6);
          hdr.writeUInt16BE(pdu.length + 1, 4);
          hdr[6] = chunk[6];
          socket.write(Buffer.concat([hdr, pdu]));
        });
      });
      server.listen(0, '127.0.0.1', function () {
        var port = server.address().port;
        var flow = [
          { id: 'rtc', type: 'modbus-config', name: 'TCP-Cfg', host: '127.0.0.1', port: port, unitId: 1, timeout: 800, maxRetries: 0 },
          { id: 'rtr', type: 'modbus-read', name: 'TCP Read', modbus: 'rtc', wires: [['rth']] },
          { id: 'rth', type: 'helper' }
        ];
        helper.load([mbConfigNode, mbReadNode], flow, function () {
          var helperNode = helper.getNode('rth');
          var readNode = helper.getNode('rtr');
          helperNode.on('input', function (msg) {
            try {
              assert.strictEqual(msg.payload.success, true, 'TCP 应成功: ' + JSON.stringify(msg.payload));
              assert.strictEqual(fakeState.ports.length, 0, '不应触碰串口');
              server.close();
              done();
            } catch (e) { server.close(); done(e); }
          });
          readNode.receive({
            payload: { id: 66 },
            tags: [{ id: 't1', regType: 'holding', addr: 0, dataType: 'INT16' }]
          });
        });
      });
    });
  });

  // ==================== 写节点 RTU ====================
  describe('modbus-write node RTU', function () {
    function rtuWriteFlow() {
      return [
        { id: 'wtc', type: 'modbus-config', name: 'RTU-WCfg', host: '127.0.0.1', port: 1, unitId: 1, timeout: 800 },
        { id: 'wtw', type: 'modbus-write', name: 'RTU Write', modbus: 'wtc', wires: [['wth']] },
        { id: 'wth', type: 'helper' }
      ];
    }

    it('FC06 RTU 写入成功（请求帧为已知向量 01 06 00 64 00 2A 49 CA）', function (done) {
      helper.settings({ mbSimulationMode: false });
      fakeState.responder = defaultResponder;
      helper.load([mbConfigNode, mbWriteNode], rtuWriteFlow(), function () {
        var helperNode = helper.getNode('wth');
        var writeNode = helper.getNode('wtw');
        helperNode.on('input', function (msg) {
          try {
            var p = msg.payload;
            assert.strictEqual(p.success, true, JSON.stringify(p));
            assert.strictEqual(p.write.fc, 6);
            assert.strictEqual(p.write.addr, 100);
            assert.strictEqual(p.write.value, 42);
            assert.strictEqual(p.error, null);
            var w = fakeState.ports[0].writes[0];
            assert.deepStrictEqual(w, Buffer.from([0x01, 0x06, 0x00, 0x64, 0x00, 0x2A, 0x49, 0xCA]));
            done();
          } catch (e) { done(e); }
        });
        writeNode.receive({ payload: { serialPort: 'COM20', regType: 'holding', addr: 100, value: 42, dataType: 'INT16', id: 70 } });
      });
    });

    it('FC16 RTU 写多寄存器成功（FLOAT32 原子写）', function (done) {
      helper.settings({ mbSimulationMode: false });
      fakeState.responder = defaultResponder;
      helper.load([mbConfigNode, mbWriteNode], rtuWriteFlow(), function () {
        var helperNode = helper.getNode('wth');
        var writeNode = helper.getNode('wtw');
        helperNode.on('input', function (msg) {
          try {
            var p = msg.payload;
            assert.strictEqual(p.success, true, JSON.stringify(p));
            assert.strictEqual(p.write.fc, 16);
            var w = fakeState.ports[0].writes[0];
            assert.strictEqual(w[1], 16);
            assert.strictEqual(w.readUInt16BE(2), 200);  // addr
            assert.strictEqual(w.readUInt16BE(4), 2);    // quantity
            assert.strictEqual(w[6], 4);                 // byteCount
            assert.strictEqual(mb.checkRtuCrc(w), true);
            done();
          } catch (e) { done(e); }
        });
        writeNode.receive({ payload: { serialPort: 'COM21', regType: 'holding', addr: 200, value: 1.5, dataType: 'FLOAT32', id: 71 } });
      });
    });

    it('RTU 写异常响应 → success:false + 异常码', function (done) {
      helper.settings({ mbSimulationMode: false });
      fakeState.responder = function (req, port) {
        port.emitData(rtuFrame(Buffer.from([req[0], req[1] | 0x80, 0x02])));
      };
      helper.load([mbConfigNode, mbWriteNode], rtuWriteFlow(), function () {
        var helperNode = helper.getNode('wth');
        var writeNode = helper.getNode('wtw');
        helperNode.on('input', function (msg) {
          try {
            var p = msg.payload;
            assert.strictEqual(p.success, false);
            assert.ok(p.error.indexOf('0x2') >= 0, '错误应含异常码: ' + p.error);
            assert.ok(p.error.indexOf('Illegal data address') >= 0);
            done();
          } catch (e) { done(e); }
        });
        writeNode.receive({ payload: { serialPort: 'COM22', regType: 'holding', addr: 100, value: 42, id: 72 } });
      });
    });

    it('RTU 写响应 CRC 错 → success:false（写失败不重试）', function (done) {
      helper.settings({ mbSimulationMode: false });
      fakeState.responder = function (req, port) {
        var frame = rtuFrame(req.slice(0, 6));
        frame[frame.length - 2] ^= 0xFF;
        port.emitData(frame);
      };
      helper.load([mbConfigNode, mbWriteNode], rtuWriteFlow(), function () {
        var helperNode = helper.getNode('wth');
        var writeNode = helper.getNode('wtw');
        helperNode.on('input', function (msg) {
          try {
            var p = msg.payload;
            assert.strictEqual(p.success, false);
            assert.ok(p.error.indexOf('CRC') >= 0, '应为 CRC 错: ' + p.error);
            assert.strictEqual(fakeState.ports[0].writes.length, 1, '写失败不应重发');
            done();
          } catch (e) { done(e); }
        });
        writeNode.receive({ payload: { serialPort: 'COM23', regType: 'holding', addr: 100, value: 42, id: 73 } });
      });
    });
  });
});
