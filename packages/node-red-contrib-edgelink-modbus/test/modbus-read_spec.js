/* eslint-env mocha */
'use strict';

var helper = require('node-red-node-test-helper');
var assert = require('assert');
var mbReadNode = require('../nodes/modbus-read.js');
var mbConfigNode = require('../nodes/modbus-config.js');

describe('modbus-read node', function () {
  afterEach(function (done) {
    helper.unload().then(function () { done(); }).catch(done);
  });

  it('CR/DISCRETE 点位应发 FC01/FC02（Day6 回归：此前静默降级 FC03）', function (done) {
    var net = require('net');
    var PORT = 16531;
    var seenFCs = [];
    var sockets = [];
    function cleanup() { sockets.forEach(function (s) { try { s.destroy(); } catch (_) {} }); }
    var server = net.createServer(function (socket) {
      sockets.push(socket);
      socket.on('data', function (chunk) {
        // MBAP: txn(2) proto(2) len(2) unit(1) + PDU: fc(1) addr(2) qty(2)
        if (chunk.length < 12) return;
        var fc = chunk[7];
        var addr = chunk.readUInt16BE(8);
        var qty = chunk.readUInt16BE(10);
        seenFCs.push(fc);
        // 按 FC 构造响应
        var pdu;
        if (fc === 1 || fc === 2) {
          // 位响应：byteCount=ceil(qty/8)，数据全 0
          var bc = Math.ceil(qty / 8);
          pdu = Buffer.concat([Buffer.from([fc, bc]), Buffer.alloc(bc)]);
        } else {
          // 寄存器响应：byteCount=qty*2，数据全 0
          pdu = Buffer.concat([Buffer.from([fc, qty * 2]), Buffer.alloc(qty * 2)]);
        }
        var hdr = Buffer.alloc(7);
        chunk.copy(hdr, 0, 0, 6);
        hdr.writeUInt16BE(pdu.length + 1, 4);
        hdr[6] = chunk[6];
        socket.write(Buffer.concat([hdr, pdu]));
      });
    });
    server.listen(PORT, '127.0.0.1', function () {
      var flow = [
        { id: 'mbc', type: 'modbus-config', name: 'MB', host: '127.0.0.1', port: PORT, timeout: 800, maxRetries: 0, retryInterval: 50 },
        { id: 'mbr', type: 'modbus-read', name: 'R', modbus: 'mbc', wires: [['mbh']] },
        { id: 'mbh', type: 'helper' }
      ];
      helper.load([mbConfigNode, mbReadNode], flow, function () {
        var helperNode = helper.getNode('mbh');
        var readNode = helper.getNode('mbr');
        helperNode.on('input', function (msg) {
          try {
            assert.ok(seenFCs.indexOf(1) >= 0, 'CR 应发 FC01，实际: ' + seenFCs.join(','));
            assert.ok(seenFCs.indexOf(2) >= 0, 'DISCRETE 应发 FC02，实际: ' + seenFCs.join(','));
            assert.ok(seenFCs.indexOf(3) >= 0, 'HR 应发 FC03，实际: ' + seenFCs.join(','));
            cleanup(); server.close(); done();
          } catch (e) { cleanup(); server.close(); done(e); }
        });
        readNode.receive({
          payload: { id: 1 },
          tags: [
            { id: 'c1', regType: 'CR', addr: 10, dataType: 'BIT' },
            { id: 'd1', regType: 'DISCRETE', addr: 20, dataType: 'BIT' },
            { id: 'h1', regType: 'HR', addr: 100, dataType: 'INT16' }
          ]
        });
      });
    });
  });

  it('should load with defaults', function (done) {
    var flow = [
      { id: 'nc1', type: 'modbus-config', name: 'Modbus-1', host: '192.168.1.10', port: 502, unitId: 1 },
      { id: 'nr1', type: 'modbus-read', name: 'Modbus Read', modbus: 'nc1', wires: [['nh1']] },
      { id: 'nh1', type: 'helper' }
    ];

    helper.load([mbConfigNode, mbReadNode], flow, function () {
      var n1 = helper.getNode('nr1');
      assert.ok(n1);
      assert.strictEqual(n1.name, 'Modbus Read');
      done();
    });
  });

  it('should output simulated data when mbSimulationMode is true', function (done) {
    helper.settings({ mbSimulationMode: true });

    var flow = [
      { id: 'nc2', type: 'modbus-config', name: 'Modbus-1', host: '192.168.1.10', port: 502, unitId: 1 },
      {
        id: 'nr2', type: 'modbus-read', name: 'Modbus Read', modbus: 'nc2',
        tags: JSON.stringify([{ id: '温度', regType: 'holding', addr: 0, dataType: 'INT16', slope: 0.1, offset: 0 }]),
        wires: [['nh2']]
      },
      { id: 'nh2', type: 'helper' }
    ];

    helper.load([mbConfigNode, mbReadNode], flow, function () {
      var helperNode = helper.getNode('nh2');
      var readNode = helper.getNode('nr2');

      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, true);
          assert.strictEqual(msg.payload.deviceId, 5678);
          assert.strictEqual(msg.payload.deviceName, 'TestPLC');
          assert.ok(msg.payload.data['温度']);
          assert.strictEqual(typeof msg.payload.data['温度'].rawValue, 'number');
          assert.strictEqual(typeof msg.payload.data['温度'].engValue, 'number');
          assert.strictEqual(msg.payload.data['温度'].quality, 0);
          assert.ok(msg.payload.data['温度'].ts);
          assert.strictEqual(msg.payload.driverType, 'driver-modbus-tcp');
          done();
        } catch (e) { done(e); }
      });

      readNode.receive({ payload: { id: 5678, deviceName: 'TestPLC' } });
    });
  });

  it('should fallback deviceName to modbus config name', function (done) {
    helper.settings({ mbSimulationMode: true });

    var flow = [
      { id: 'nc3', type: 'modbus-config', name: 'MB-Config-Name', host: '192.168.1.10', port: 502, unitId: 1 },
      {
        id: 'nr3', type: 'modbus-read', name: 'Modbus Read', modbus: 'nc3',
        tags: JSON.stringify([{ id: '压力', regType: 'holding', addr: 10, dataType: 'INT16' }]),
        wires: [['nh3']]
      },
      { id: 'nh3', type: 'helper' }
    ];

    helper.load([mbConfigNode, mbReadNode], flow, function () {
      var helperNode = helper.getNode('nh3');
      var readNode = helper.getNode('nr3');

      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.deviceName, 'MB-Config-Name');
          assert.strictEqual(msg.payload.data['压力'].quality, 0);
          done();
        } catch (e) { done(e); }
      });

      readNode.receive({ payload: { id: 9999 } });
    });
  });
});
