/* eslint-env mocha */
'use strict';

var helper = require('node-red-node-test-helper');
var assert = require('assert');
var mcReadNode = require('../nodes/mitsubishi-read.js');
var mcConfigNode = require('../nodes/mitsubishi-config.js');

describe('mitsubishi-read node', function () {
  afterEach(function (done) {
    helper.unload().then(function () { done(); }).catch(done);
  });

  it('should load with defaults', function (done) {
    var flow = [
      { id: 'nc1', type: 'mitsubishi-config', name: 'PLC-1', host: '192.168.1.10', port: 5007, frame: '3E' },
      { id: 'nr1', type: 'mitsubishi-read', name: 'MC Read', plc: 'nc1', wires: [['nh1']] },
      { id: 'nh1', type: 'helper' }
    ];

    helper.load([mcConfigNode, mcReadNode], flow, function () {
      var n1 = helper.getNode('nr1');
      assert.ok(n1);
      assert.strictEqual(n1.name, 'MC Read');
      done();
    });
  });

  it('should output simulated data when mcSimulationMode is true', function (done) {
    helper.settings({ mcSimulationMode: true });

    var flow = [
      { id: 'nc2', type: 'mitsubishi-config', name: 'PLC-1', host: '192.168.1.10', port: 5007, frame: '3E' },
      {
        id: 'nr2', type: 'mitsubishi-read', name: 'MC Read', plc: 'nc2',
        tags: JSON.stringify([{ id: '温度', regType: 'D', addr: 100, dataType: 'INT16', slope: 0.1, offset: 0 }]),
        wires: [['nh2']]
      },
      { id: 'nh2', type: 'helper' }
    ];

    helper.load([mcConfigNode, mcReadNode], flow, function () {
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
          done();
        } catch (e) { done(e); }
      });

      readNode.receive({ payload: { id: 5678, deviceName: 'TestPLC' } });
    });
  });

  it('should fallback deviceName to PLC config name', function (done) {
    helper.settings({ mcSimulationMode: true });

    var flow = [
      { id: 'nc3', type: 'mitsubishi-config', name: 'PLC-Config-Name', host: '192.168.1.10', port: 5007, frame: '3E' },
      {
        id: 'nr3', type: 'mitsubishi-read', name: 'MC Read', plc: 'nc3',
        tags: JSON.stringify([{ id: '压力', regType: 'D', addr: 200, dataType: 'INT16' }]),
        wires: [['nh3']]
      },
      { id: 'nh3', type: 'helper' }
    ];

    helper.load([mcConfigNode, mcReadNode], flow, function () {
      var helperNode = helper.getNode('nh3');
      var readNode = helper.getNode('nr3');

      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.deviceName, 'PLC-Config-Name');
          assert.strictEqual(msg.payload.data['压力'].quality, 0);
          done();
        } catch (e) { done(e); }
      });

      readNode.receive({ payload: { id: 9999 } });
    });
  });

  it('request-level timeout fires cleanly (slow-drip/stuck peer, no TypeError)', function (done) {
    helper.settings({});
    var net = require('net');
    var PORT = 15531;
    var uncaught = [];
    function onUncaught(e) { uncaught.push(e); }
    process.on('uncaughtException', onUncaught);
    // mock PLC：接受连接但永不响应 → 触发请求级兜底定时器
    var server = net.createServer(function (socket) { socket.on('data', function () {}); });
    server.listen(PORT, '127.0.0.1', function () {
      var flow = [
        { id: 'nct', type: 'mitsubishi-config', name: 'PLC-STUCK', host: '127.0.0.1', port: PORT, frame: '3E', timeout: 300, maxRetries: 1, retryInterval: 50 },
        { id: 'nrt', type: 'mitsubishi-read', name: 'MC Read Timeout', plc: 'nct', wires: [['nht']] },
        { id: 'nht', type: 'helper' }
      ];
      helper.load([mcConfigNode, mcReadNode], flow, function () {
        var helperNode = helper.getNode('nht');
        var readNode = helper.getNode('nrt');
        helperNode.on('input', function (msg) {
          try {
            process.removeListener('uncaughtException', onUncaught);
            assert.strictEqual(uncaught.length, 0, '请求级超时路径不得有 uncaught（_tmoHandler 裸调用回归）');
            assert.strictEqual(msg.payload.success, false);
            assert.ok(msg.payload.error, '应有错误信息');
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });
        readNode.receive({ payload: { id: 40 }, tags: [{ id: 't1', regType: 'D', addr: 100, dataType: 'INT16' }] });
      });
    });
  });

  // ===== 🔧 v1.4.4: UDP 端到端（dgram 模拟 PLC）=====
  function startUdpPlc(opts, onReady) {
    var dgram = require('dgram');
    var server = dgram.createSocket('udp4');
    var answered = 0;
    server.on('message', function (buf, rinfo) {
      answered++;
      if (opts.dropFirst && answered === 1) return;  // 丢首包验证重试
      var is4E = buf[0] === 0x54;
      var addrOff = is4E ? 19 : 15;
      var startAddr = buf[addrOff] | (buf[addrOff + 1] << 8) | (buf[addrOff + 2] << 16);
      var points = buf.readUInt16LE(is4E ? 23 : 19);
      var hdrLen = is4E ? 15 : 11;
      var resp = Buffer.alloc(hdrLen + points * 2);
      if (is4E) {
        resp[0] = 0xD4; resp[1] = 0x00;
        resp[2] = buf[2]; resp[3] = buf[3];   // 序列号回显
        resp[4] = 0; resp[5] = 0;             // 固定值
        resp[6] = buf[6]; resp[7] = buf[7]; resp[8] = buf[8]; resp[9] = buf[9]; resp[10] = buf[10];
        resp.writeUInt16LE(2 + points * 2, 11);
        resp.writeUInt16LE(0, 13);            // 结束码 @13
      } else {
        resp[0] = 0xD0; resp[1] = 0x00;
        resp[2] = buf[2]; resp[3] = buf[3]; resp[4] = buf[4]; resp[5] = buf[5]; resp[6] = buf[6];
        resp.writeUInt16LE(2 + points * 2, 7);
        resp.writeUInt16LE(0, 9);             // 结束码 @9
      }
      // 数据填充：D100=200, D101:D102=INT32 70000, D200:D201=FLOAT32 23.5
      var dataOff = hdrLen;
      for (var w = 0; w < points; w++) {
        var addr = startAddr + w;
        var val = 0;
        if (addr === 100) val = 200;
        else if (addr === 101) val = 0x1170;   // 70000 低字
        else if (addr === 102) val = 0x0001;   // 70000 高字
        else if (addr === 200) val = 0x0000;   // 23.5 低字
        else if (addr === 201) val = 0x41BC;   // 23.5 高字
        resp.writeUInt16LE(val & 0xFFFF, dataOff + w * 2);
      }
      server.send(resp, rinfo.port, rinfo.address);
    });
    server.bind(opts.port, '127.0.0.1', function () { onReady(server); });
  }

  it('UDP 3E: should read and decode INT16/INT32/FLOAT32 via UDP transport', function (done) {
    helper.settings({});
    var PORT = 15511;
    startUdpPlc({ port: PORT }, function (server) {
      var flow = [
        { id: 'ncu1', type: 'mitsubishi-config', name: 'PLC-UDP', host: '127.0.0.1', port: PORT, frame: '3E', protocol: 'udp', timeout: 1000, retryInterval: 50 },
        { id: 'nru1', type: 'mitsubishi-read', name: 'MC UDP Read', plc: 'ncu1', wires: [['nhu1']] },
        { id: 'nhu1', type: 'helper' }
      ];
      helper.load([mcConfigNode, mcReadNode], flow, function () {
        var helperNode = helper.getNode('nhu1');
        var readNode = helper.getNode('nru1');
        helperNode.on('input', function (msg) {
          try {
            assert.strictEqual(msg.payload.success, true, 'success: ' + JSON.stringify(msg.payload));
            var d = msg.payload.data;
            assert.strictEqual(d.t1.rawValue, 200, 'INT16');
            assert.strictEqual(d.t2.rawValue, 70000, 'INT32 解码值（证明 rawValue=decoded 修复）');
            assert.strictEqual(d.t2.rawWord, 0x1170, 'rawWord 保留首字原始值');
            assert.strictEqual(d.t3.rawValue, 23.5, 'FLOAT32 解码值');
            assert.strictEqual(d.t1.quality, 0);
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });
        readNode.receive({
          payload: { id: 30, deviceName: 'UDP-Test' },
          tags: [
            { id: 't1', regType: 'D', addr: 100, dataType: 'INT16' },
            { id: 't2', regType: 'D', addr: 101, dataType: 'INT32' },
            { id: 't3', regType: 'D', addr: 200, dataType: 'FLOAT32' }
          ]
        });
      });
    });
  });

  it('UDP 4E: should read with serial echo check via UDP transport', function (done) {
    helper.settings({});
    var PORT = 15512;
    startUdpPlc({ port: PORT }, function (server) {
      var flow = [
        { id: 'ncu2', type: 'mitsubishi-config', name: 'PLC-UDP-4E', host: '127.0.0.1', port: PORT, frame: '4E', protocol: 'udp', timeout: 1000, retryInterval: 50 },
        { id: 'nru2', type: 'mitsubishi-read', name: 'MC UDP 4E', plc: 'ncu2', wires: [['nhu2']] },
        { id: 'nhu2', type: 'helper' }
      ];
      helper.load([mcConfigNode, mcReadNode], flow, function () {
        var helperNode = helper.getNode('nhu2');
        var readNode = helper.getNode('nru2');
        helperNode.on('input', function (msg) {
          try {
            assert.strictEqual(msg.payload.success, true, 'success: ' + JSON.stringify(msg.payload));
            assert.strictEqual(msg.payload.data.t1.rawValue, 200);
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });
        readNode.receive({ payload: { id: 31 }, tags: [{ id: 't1', regType: 'D', addr: 100, dataType: 'INT16' }] });
      });
    });
  });

  it('UDP retry: should succeed after first packet dropped', function (done) {
    helper.settings({});
    var PORT = 15513;
    startUdpPlc({ port: PORT, dropFirst: true }, function (server) {
      var flow = [
        { id: 'ncu3', type: 'mitsubishi-config', name: 'PLC-UDP-DROP', host: '127.0.0.1', port: PORT, frame: '3E', protocol: 'udp', timeout: 300, maxRetries: 2, retryInterval: 50 },
        { id: 'nru3', type: 'mitsubishi-read', name: 'MC UDP Retry', plc: 'ncu3', wires: [['nhu3']] },
        { id: 'nhu3', type: 'helper' }
      ];
      helper.load([mcConfigNode, mcReadNode], flow, function () {
        var helperNode = helper.getNode('nhu3');
        var readNode = helper.getNode('nru3');
        helperNode.on('input', function (msg) {
          try {
            assert.strictEqual(msg.payload.success, true, '丢首包后应重试成功');
            assert.strictEqual(msg.payload.data.t1.rawValue, 200);
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });
        readNode.receive({ payload: { id: 32 }, tags: [{ id: 't1', regType: 'D', addr: 100, dataType: 'INT16' }] });
      });
    });
  });

});
