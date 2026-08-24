/* eslint-env mocha */
'use strict';
/**
 * 万点压力回归（v1.4.4）：10,000 连续 INT16 点位 × 3 轮（UDP 模拟 PLC）
 * 验证：960 字聚类帧数、轮次耗时、全点位解码、内存有界
 */
var helper = require('node-red-node-test-helper');
var assert = require('assert');
var dgram = require('dgram');
var mcReadNode = require('../nodes/mitsubishi-read.js');
var mcConfigNode = require('../nodes/mitsubishi-config.js');

function startPlc(port, cb) {
  var server = dgram.createSocket('udp4');
  server.on('message', function (buf, rinfo) {
    var startAddr = buf[15] | (buf[16] << 8) | (buf[17] << 16);
    var points = buf.readUInt16LE(19);
    var resp = Buffer.alloc(11 + points * 2);
    resp[0] = 0xD0; resp[1] = 0x00;
    resp[2] = buf[2]; resp[3] = buf[3]; resp[4] = buf[4]; resp[5] = buf[5]; resp[6] = buf[6];
    resp.writeUInt16LE(2 + points * 2, 7);
    resp.writeUInt16LE(0, 9);
    for (var w = 0; w < points; w++) resp.writeUInt16LE((startAddr + w) & 0xFFFF, 11 + w * 2);
    server.send(resp, rinfo.port, rinfo.address);
  });
  server.bind(port, '127.0.0.1', function () { cb(server); });
}

describe('10k stress (UDP, 960-word grouping)', function () {
  this.timeout(60000);
  afterEach(function (done) { helper.unload().then(function () { done(); }).catch(done); });

  it('10,000 contiguous INT16 tags × 3 rounds: full decode, bounded memory', function (done) {
    var PORT = 15525;
    var tags = [];
    for (var i = 0; i < 10000; i++) tags.push({ id: 't' + i, regType: 'D', addr: i, dataType: 'INT16' });
    startPlc(PORT, function (server) {
      var flow = [
        { id: 'nc', type: 'mitsubishi-config', name: 'PLC-10K', host: '127.0.0.1', port: PORT, frame: '3E', protocol: 'udp', timeout: 2000, maxRetries: 1, retryInterval: 50 },
        { id: 'nr', type: 'mitsubishi-read', name: 'MC 10K', plc: 'nc', wires: [['nh']] },
        { id: 'nh', type: 'helper' }
      ];
      helper.load([mcConfigNode, mcReadNode], flow, function () {
        var helperNode = helper.getNode('nh');
        var readNode = helper.getNode('nr');
        var rounds = 0, times = [];
        var mem0 = process.memoryUsage().heapUsed / 1048576;
        helperNode.on('input', function (msg) {
          rounds++;
          times.push(msg.payload.roundTimeMs);
          var n = Object.keys(msg.payload.data).length;
          if (rounds === 1) {
            try {
              assert.strictEqual(msg.payload.success, true, 'round1 success, err=' + msg.payload.error);
              assert.strictEqual(n, 10000, '全点位（含 addr=0 的 t0）');
              assert.strictEqual(msg.payload.data.t0.rawValue, 0);
              assert.strictEqual(msg.payload.data.t9999.rawValue, 9999);
            } catch (e) { server.close(); return done(e); }
          }
          if (rounds < 3) {
            setImmediate(function () { readNode.receive({ payload: { id: 1 }, tags: tags }); });
            return;
          }
          var mem1 = process.memoryUsage().heapUsed / 1048576;
          console.log('    [10k] times=' + times.join('/') + 'ms, heap ' + mem0.toFixed(1) + '→' + mem1.toFixed(1) + 'MB');
          try {
            assert.ok(mem1 - mem0 < 200, '内存增长应有界（<200MB），实际 ' + (mem1 - mem0).toFixed(1) + 'MB');
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });
        readNode.receive({ payload: { id: 1 }, tags: tags });
      });
    });
  });
});
