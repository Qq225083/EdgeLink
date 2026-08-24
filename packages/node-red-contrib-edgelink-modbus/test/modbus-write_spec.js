/* eslint-env mocha */
'use strict';

var helper = require('node-red-node-test-helper');
var assert = require('assert');
var net = require('net');
var mbWriteNode = require('../nodes/modbus-write.js');
var mbConfigNode = require('../nodes/modbus-config.js');

// 迷你 Modbus TCP 从站：FC05/06 原样回显，FC16 回显地址+数量；
// addr === 666 返回异常 0x02（Illegal data address）
function startSlave(cb) {
  var received = [];
  var server = net.createServer(function (sock) {
    var buf = Buffer.alloc(0);
    sock.on('error', function () {});
    sock.on('data', function (chunk) {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 9) {
        var len = buf.readUInt16BE(4);
        var frameLen = 6 + len;
        if (buf.length < frameLen) break;
        var frame = buf.slice(0, frameLen);
        buf = buf.slice(frameLen);
        var fc = frame[7];
        var addr = frame.readUInt16BE(8);
        if (addr === 666) {
          var ex = Buffer.concat([frame.slice(0, 5), Buffer.from([3, frame[6], fc | 0x80, 0x02])]);
          sock.write(ex);
          continue;
        }
        if (fc === 5 || fc === 6) {
          received.push({ fc: fc, addr: addr, value: frame.readUInt16BE(10) });
          sock.write(frame);  // 回显
        } else if (fc === 16) {
          var qty = frame.readUInt16BE(10);
          var words = [];
          for (var i = 0; i < qty; i++) words.push(frame.readUInt16BE(13 + i * 2));
          received.push({ fc: fc, addr: addr, qty: qty, words: words });
          var resp = Buffer.alloc(12);
          frame.copy(resp, 0, 0, 6);
          resp.writeUInt16BE(6, 4);
          resp[6] = frame[6];
          resp[7] = 16;
          resp.writeUInt16BE(addr, 8);
          resp.writeUInt16BE(qty, 10);
          sock.write(resp);
        }
      }
    });
  });
  server.listen(0, '127.0.0.1', function () {
    cb(server, server.address().port, received);
  });
}

describe('modbus-write node', function () {
  var server, port, received;

  beforeEach(function (done) {
    startSlave(function (s, p, r) {
      server = s; port = p; received = r;
      done();
    });
  });

  afterEach(function (done) {
    helper.settings({ mbSimulationMode: false });
    helper.unload().then(function () {
      server.close(function () { done(); });
    }).catch(done);
  });

  function flow() {
    return [
      { id: 'nc1', type: 'modbus-config', name: 'Modbus-1', host: '127.0.0.1', port: port, unitId: 1, timeout: 2000 },
      { id: 'nw1', type: 'modbus-write', name: 'Modbus Write', modbus: 'nc1', wires: [['nh1']] },
      { id: 'nh1', type: 'helper' }
    ];
  }

  it('writes INT16 via FC06 (object payload)', function (done) {
    helper.settings({ mbSimulationMode: false });
    helper.load([mbConfigNode, mbWriteNode], flow(), function () {
      var helperNode = helper.getNode('nh1');
      var writeNode = helper.getNode('nw1');
      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, true, 'error: ' + msg.payload.error);
          assert.strictEqual(msg.payload.write.fc, 6);
          assert.strictEqual(msg.payload.write.addr, 100);
          assert.strictEqual(msg.payload.driverType, 'driver-modbus-tcp');
          assert.strictEqual(received.length, 1);
          assert.strictEqual(received[0].fc, 6);
          assert.strictEqual(received[0].addr, 100);
          assert.strictEqual(received[0].value, 42);
          done();
        } catch (e) { done(e); }
      });
      writeNode.receive({ payload: { addr: 100, value: 42, dataType: 'INT16' } });
    });
  });

  it('writes coil via FC05 (true → 0xFF00)', function (done) {
    helper.settings({ mbSimulationMode: false });
    helper.load([mbConfigNode, mbWriteNode], flow(), function () {
      var helperNode = helper.getNode('nh1');
      var writeNode = helper.getNode('nw1');
      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, true, 'error: ' + msg.payload.error);
          assert.strictEqual(msg.payload.write.fc, 5);
          assert.strictEqual(received[0].fc, 5);
          assert.strictEqual(received[0].value, 0xFF00);
          done();
        } catch (e) { done(e); }
      });
      writeNode.receive({ payload: { regType: 'coil', addr: 3, value: true } });
    });
  });

  it('writes FLOAT32 via FC16 (2 registers, atomic)', function (done) {
    helper.settings({ mbSimulationMode: false });
    helper.load([mbConfigNode, mbWriteNode], flow(), function () {
      var helperNode = helper.getNode('nh1');
      var writeNode = helper.getNode('nw1');
      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, true, 'error: ' + msg.payload.error);
          assert.strictEqual(msg.payload.write.fc, 16);
          assert.strictEqual(received[0].fc, 16);
          assert.strictEqual(received[0].qty, 2);
          // 服务端按 ABCD 解码回 FLOAT32
          var b = Buffer.alloc(4);
          b.writeUInt16BE(received[0].words[0], 0);
          b.writeUInt16BE(received[0].words[1], 2);
          assert.ok(Math.abs(b.readFloatBE(0) - 3.14) < 0.001, 'FLOAT32 编码值错误: ' + b.readFloatBE(0));
          done();
        } catch (e) { done(e); }
      });
      writeNode.receive({ payload: { addr: 200, value: 3.14, dataType: 'FLOAT32', byteOrder: 'ABCD' } });
    });
  });

  it('reports modbus exception as failure', function (done) {
    helper.settings({ mbSimulationMode: false });
    helper.load([mbConfigNode, mbWriteNode], flow(), function () {
      var helperNode = helper.getNode('nh1');
      var writeNode = helper.getNode('nw1');
      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, false);
          assert.ok(msg.payload.error.indexOf('Illegal data address') >= 0, 'error: ' + msg.payload.error);
          done();
        } catch (e) { done(e); }
      });
      writeNode.receive({ payload: { addr: 666, value: 1, dataType: 'INT16' } });
    });
  });

  it('rejects missing value / invalid addr without touching the wire', function (done) {
    helper.settings({ mbSimulationMode: false });
    helper.load([mbConfigNode, mbWriteNode], flow(), function () {
      var helperNode = helper.getNode('nh1');
      var writeNode = helper.getNode('nw1');
      var count = 0;
      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, false);
          count++;
          if (count === 2) {
            assert.strictEqual(received.length, 0, '非法请求不应发到设备');
            done();
          }
        } catch (e) { done(e); }
      });
      writeNode.receive({ payload: { addr: 100 } });                    // 缺 value
      writeNode.receive({ payload: { addr: 99999, value: 1 } });        // 地址越界
    });
  });

  it('rejects read-only regType', function (done) {
    helper.settings({ mbSimulationMode: false });
    helper.load([mbConfigNode, mbWriteNode], flow(), function () {
      var helperNode = helper.getNode('nh1');
      var writeNode = helper.getNode('nw1');
      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, false);
          assert.ok(msg.payload.error.indexOf('不可写') >= 0);
          assert.strictEqual(received.length, 0);
          done();
        } catch (e) { done(e); }
      });
      writeNode.receive({ payload: { regType: 'input', addr: 0, value: 1 } });
    });
  });

  it('writes via bare value with panel defaults', function (done) {
    helper.settings({ mbSimulationMode: false });
    var f = flow();
    f[1].addr = '55';
    f[1].dataType = 'UINT16';
    helper.load([mbConfigNode, mbWriteNode], f, function () {
      var helperNode = helper.getNode('nh1');
      var writeNode = helper.getNode('nw1');
      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, true, 'error: ' + msg.payload.error);
          assert.strictEqual(received[0].addr, 55);
          assert.strictEqual(received[0].value, 1234);
          done();
        } catch (e) { done(e); }
      });
      writeNode.receive({ payload: 1234 });
    });
  });

  it('succeeds without device when mbSimulationMode is true', function (done) {
    helper.settings({ mbSimulationMode: true });
    helper.load([mbConfigNode, mbWriteNode], flow(), function () {
      var helperNode = helper.getNode('nh1');
      var writeNode = helper.getNode('nw1');
      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, true);
          assert.strictEqual(received.length, 0, '模拟模式不应发到设备');
          done();
        } catch (e) { done(e); }
      });
      writeNode.receive({ payload: { addr: 1, value: 10, dataType: 'INT16' } });
    });
  });
});
