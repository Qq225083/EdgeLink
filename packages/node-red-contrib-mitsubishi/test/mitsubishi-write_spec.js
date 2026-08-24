/* eslint-env mocha */
'use strict';

var helper = require('node-red-node-test-helper');
var assert = require('assert');
var mcWriteNode = require('../nodes/mitsubishi-write.js');
var mcConfigNode = require('../nodes/mitsubishi-config.js');

describe('mitsubishi-write node', function () {
  afterEach(function (done) {
    helper.unload().then(function () { done(); }).catch(done);
  });

  it('should load with defaults', function (done) {
    var flow = [
      { id: 'nc1', type: 'mitsubishi-config', name: 'PLC-1', host: '192.168.1.10', port: 5007, frame: '3E' },
      { id: 'nw1', type: 'mitsubishi-write', name: 'MC Write', plc: 'nc1', wires: [['nh1']] },
      { id: 'nh1', type: 'helper' }
    ];

    helper.load([mcConfigNode, mcWriteNode], flow, function () {
      var n1 = helper.getNode('nw1');
      assert.ok(n1);
      assert.strictEqual(n1.name, 'MC Write');
      done();
    });
  });

  it('should output simulated data when mcSimulationMode is true', function (done) {
    helper.settings({ mcSimulationMode: true });

    var flow = [
      { id: 'nc2', type: 'mitsubishi-config', name: 'PLC-1', host: '192.168.1.10', port: 5007, frame: '3E' },
      {
        id: 'nw2', type: 'mitsubishi-write', name: 'MC Write', plc: 'nc2',
        wires: [['nh2']]
      },
      { id: 'nh2', type: 'helper' }
    ];

    helper.load([mcConfigNode, mcWriteNode], flow, function () {
      var helperNode = helper.getNode('nh2');
      var writeNode = helper.getNode('nw2');

      helperNode.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, true);
          assert.strictEqual(msg.payload.driverType, 'driver-mc-write-protocol');
          assert.ok(msg.payload.data['setpoint']);
          assert.strictEqual(msg.payload.data['setpoint'].value, 250);
          assert.strictEqual(msg.payload.data['setpoint'].quality, 0);
          assert.ok(msg.payload.data['setpoint'].ts);
          done();
        } catch (e) { done(e); }
      });

      writeNode.receive({
        payload: { id: 100, deviceName: 'TestPLC-Write' },
        tags: [
          { id: 'setpoint', regType: 'D', addr: 100, dataType: 'INT16', value: 250 }
        ]
      });
    });
  });

  it('should write to TCP mock PLC and verify frame format', function (done) {
    helper.settings({});
    var net = require('net');
    var PORT = 17511;

    var server = net.createServer(function (socket) {
      var buf = Buffer.alloc(0);
      socket.on('data', function (chunk) {
        buf = Buffer.concat([buf, chunk]);
        // 等待完整帧：23 字节 = 21 header + 2 data (1 word)
        if (buf.length >= 23) {
          // 校验 3E 写帧格式
          assert.strictEqual(buf[0], 0x50, 'subheader[0]');
          assert.strictEqual(buf[1], 0x00, 'subheader[1]');
          // 数据长 @7-8 P0-1: 1 字 = 12+2=14 (0x0E)
          assert.strictEqual(buf.readUInt16LE(7), 14, 'dataLen=12+2n');
          // 指令 0x1401 @11-12
          assert.strictEqual(buf[11], 0x01, 'cmd low');
          assert.strictEqual(buf[12], 0x14, 'cmd high');
          // 软元件代码 D @18
          assert.strictEqual(buf[18], 0xA8, 'device code D');
          // 点数 1 @19-20
          assert.strictEqual(buf.readUInt16LE(19), 1, 'points');
          // 数据值 0x03E8 (1000) @21-22
          var dataVal = buf.readUInt16LE(21);
          assert.strictEqual(dataVal, 1000, 'data value');

          // 回复成功写响应
          var resp = Buffer.from([
            0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00,
            0x02, 0x00, 0x00, 0x00
          ]);
          socket.write(resp);
        }
      });
    });

    server.listen(PORT, '127.0.0.1', function () {
      var flow = [
        { id: 'nc3', type: 'mitsubishi-config', name: 'PLC-TCP-W', host: '127.0.0.1', port: PORT, frame: '3E', timeout: 1000, retryInterval: 50 },
        { id: 'nw3', type: 'mitsubishi-write', name: 'MC Write TCP', plc: 'nc3', wires: [['nh3']] },
        { id: 'nh3', type: 'helper' }
      ];

      helper.load([mcConfigNode, mcWriteNode], flow, function () {
        var helperNode = helper.getNode('nh3');
        var writeNode = helper.getNode('nw3');

        helperNode.on('input', function (msg) {
          try {
            assert.strictEqual(msg.payload.success, true, 'success: ' + JSON.stringify(msg.payload));
            assert.strictEqual(msg.payload.data['speed_set'].value, 1000);
            assert.strictEqual(msg.payload.data['speed_set'].quality, 0);
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });

        writeNode.receive({
          payload: { id: 200, deviceName: 'TCP-Write-Test' },
          tags: [
            { id: 'speed_set', regType: 'D', addr: 100, dataType: 'INT16', value: 1000 }
          ]
        });
      });
    });
  });

  it('should report write-protect error from PLC', function (done) {
    helper.settings({});
    var net = require('net');
    var PORT = 17512;

    var server = net.createServer(function (socket) {
      socket.on('data', function () {
        // 回复写保护错误 0xC054
        var resp = Buffer.from([
          0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00,
          0x02, 0x00,
          0x54, 0xC0
        ]);
        socket.write(resp);
      });
    });

    server.listen(PORT, '127.0.0.1', function () {
      var flow = [
        { id: 'nc4', type: 'mitsubishi-config', name: 'PLC-WP', host: '127.0.0.1', port: PORT, frame: '3E', timeout: 1000, retryInterval: 50 },
        { id: 'nw4', type: 'mitsubishi-write', name: 'MC Write WP', plc: 'nc4', wires: [['nh4']] },
        { id: 'nh4', type: 'helper' }
      ];

      helper.load([mcConfigNode, mcWriteNode], flow, function () {
        var helperNode = helper.getNode('nh4');
        var writeNode = helper.getNode('nw4');

        helperNode.on('input', function (msg) {
          try {
            assert.strictEqual(msg.payload.success, false, 'should fail');
            assert.ok(msg.payload.error.indexOf('Write protect') >= 0, 'error: ' + msg.payload.error);
            assert.strictEqual(msg.payload.data['wp_test'].quality, 2);
            assert.strictEqual(msg.payload.data['wp_test'].value, null);
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });

        writeNode.receive({
          payload: { id: 300, deviceName: 'WP-Test' },
          tags: [
            { id: 'wp_test', regType: 'D', addr: 100, dataType: 'INT16', value: 999 }
          ]
        });
      });
    });
  });

  // ===== v1.5.1: 字内 BOOL RMW 测试（位设备已切原生位写，RMW 仅剩 D.3 场景）=====
  it('RMW: should write word-device BOOL via read-modify-write (D100.3)', function (done) {
    helper.settings({});
    var net = require('net');
    var PORT = 17516;

    var server = net.createServer(function (socket) {
      var buf = Buffer.alloc(0);
      var phase = 0;  // 0=等待读帧, 1=等待写帧
      socket.on('data', function (chunk) {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 21 && phase === 0) {
          // 校验 RMW 读帧的指令=0x0401（字内BOOL走RMW，位设备已切原生位写）
          // 读帧到达 → 校验是读指令 0x0401
          assert.strictEqual(buf[11], 0x01, 'read cmd low');
          assert.strictEqual(buf[12], 0x04, 'read cmd high');
          // 回复当前字值 M0=0x0003 (M0=1, M1=1)
          var readResp = Buffer.from([
            0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00,
            0x04, 0x00, 0x00, 0x00,
            0x03, 0x00
          ]);
          socket.write(readResp);
          buf = Buffer.alloc(0);
          phase = 1;
        } else if (buf.length >= 23 && phase === 1) {
          // 写帧到达 → 校验是写指令 0x1401
          assert.strictEqual(buf[11], 0x01, 'write cmd low');
          assert.strictEqual(buf[12], 0x14, 'write cmd high');
          // 校验写入值：D100 原值 0x0003，bitOffset=2 设为 1 → 0x0003 | 0x0004 = 0x0007
          var written = buf.readUInt16LE(21);
          assert.strictEqual(written, 7, 'RMW should set bit2 of D100, got ' + written);
          // 回复成功
          var writeResp = Buffer.from([
            0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00,
            0x02, 0x00, 0x00, 0x00
          ]);
          socket.write(writeResp);
        }
      });
    });

    server.on('error', function (e) { server.close(); if (e.code !== 'EADDRINUSE') throw e; });
    server.listen(PORT, '127.0.0.1', function () {
      var flow = [
        { id: 'nc5', type: 'mitsubishi-config', name: 'PLC-RMW', host: '127.0.0.1', port: PORT, frame: '3E', timeout: 1000, maxRetries: 1, retryInterval: 30 },
        { id: 'nw5', type: 'mitsubishi-write', name: 'MC RMW Write', plc: 'nc5', wires: [['nh5']] },
        { id: 'nh5', type: 'helper' }
      ];

      helper.load([mcConfigNode, mcWriteNode], flow, function () {
        var helperNode = helper.getNode('nh5');
        var writeNode = helper.getNode('nw5');

        helperNode.on('input', function (msg) {
          try {
            assert.strictEqual(msg.payload.success, true, 'success: ' + JSON.stringify(msg.payload));
            // D100.3 写入成功
            assert.strictEqual(msg.payload.data['flag_bit'].value, 1);
            assert.strictEqual(msg.payload.data['flag_bit'].quality, 0);
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });

        writeNode.receive({
          payload: { id: 400, deviceName: 'RMW-Test' },
          tags: [
            { id: 'flag_bit', regType: 'D', addr: 100, dataType: 'BOOL', bitOffset: 2, value: 1 }
          ]
        });
      });
    });
  });

  // ===== v1.5.1: 原生位写端到端（子指令 0x0001，无 RMW 竞态）=====
  it('native bit write: should use subcommand 0x0001 for M device (no RMW)', function (done) {
    helper.settings({});
    var net = require('net');
    var PORT = 17515;

    var server = net.createServer(function (socket) {
      var buf = Buffer.alloc(0);
      socket.on('data', function (chunk) {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 22) {
          // 校验子指令 0x0001 (位单位批量写)
          assert.strictEqual(buf[13], 0x01, 'subcmd low');
          assert.strictEqual(buf[14], 0x00, 'subcmd high → 0x0001 bit units');
          // 软元件代码 M=0x90
          assert.strictEqual(buf[18], 0x90, 'M device code');
          // 位数=2 (M10,M11)
          assert.strictEqual(buf.readUInt16LE(19), 2, 'bit count');
          // nibble-packed: M10=1(高)+M11=1(低) → 0x11
          assert.strictEqual(buf[21], 0x11, 'packed: M10=high nibble=1, M11=low nibble=1');
          // 回复成功
          var resp = Buffer.from([0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x02, 0x00, 0x00, 0x00]);
          socket.write(resp);
        }
      });
    });

    server.listen(PORT, '127.0.0.1', function () {
      var flow = [
        { id: 'nc6', type: 'mitsubishi-config', name: 'PLC-BIT-W', host: '127.0.0.1', port: PORT, frame: '3E', timeout: 1000, retryInterval: 30 },
        { id: 'nw6', type: 'mitsubishi-write', name: 'MC Bit Write', plc: 'nc6', wires: [['nh6']] },
        { id: 'nh6', type: 'helper' }
      ];

      helper.load([mcConfigNode, mcWriteNode], flow, function () {
        var helperNode = helper.getNode('nh6');
        var writeNode = helper.getNode('nw6');

        helperNode.on('input', function (msg) {
          try {
            assert.strictEqual(msg.payload.success, true, 'success: ' + JSON.stringify(msg.payload));
            assert.strictEqual(msg.payload.data['m10'].value, 1);
            assert.strictEqual(msg.payload.data['m10'].quality, 0);
            assert.strictEqual(msg.payload.data['m11'].value, 1);
            assert.strictEqual(msg.payload.data['m11'].quality, 0);
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });

        writeNode.receive({
          payload: { id: 500, deviceName: 'NativeBitTest' },
          tags: [
            { id: 'm10', regType: 'M', addr: 10, dataType: 'BOOL', value: 1 },
            { id: 'm11', regType: 'M', addr: 11, dataType: 'BOOL', value: 1 }
          ]
        });
      });
    });
  });

  // ===== v1.5.1: P0-2 bit 回归 — 间隙拆组，中间位不得被写 0 =====
  it('P0-2 bit regression: scattered M100+M105 → two frames, no mid-bit zero', function (done) {
    helper.settings({});
    var net = require('net');
    var PORT = 17517;
    var frameCount = 0;
    var results = [];

    var server = net.createServer(function (socket) {
      var buf = Buffer.alloc(0);
      socket.on('data', function (chunk) {
        buf = Buffer.concat([buf, chunk]);
        // 处理多帧（可能 TCP 合并到达）
        while (buf.length >= 22) {
          var bitCount = buf.readUInt16LE(19);
          var startAddr = buf[15] | (buf[16] << 8) | (buf[17] << 16);
          frameCount++;
          results.push({ startAddr: startAddr, bitCount: bitCount, dataByte: buf[21] });
          // 回复成功
          var resp = Buffer.from([0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x02, 0x00, 0x00, 0x00]);
          socket.write(resp);
          // 去掉已处理帧
          var hdrLen = 21 + Math.ceil(bitCount / 2);
          buf = buf.slice(hdrLen);
        }
      });
    });

    server.on('error', function (e) { server.close(); if (e.code !== 'EADDRINUSE') throw e; });
    server.listen(PORT, '127.0.0.1', function () {
      var flow = [
        { id: 'nc7', type: 'mitsubishi-config', name: 'PLC-GAP', host: '127.0.0.1', port: PORT, frame: '3E', timeout: 1000, retryInterval: 30 },
        { id: 'nw7', type: 'mitsubishi-write', name: 'MC Gap Test', plc: 'nc7', wires: [['nh7']] },
        { id: 'nh7', type: 'helper' }
      ];

      helper.load([mcConfigNode, mcWriteNode], flow, function () {
        var helperNode = helper.getNode('nh7');
        var writeNode = helper.getNode('nw7');

        helperNode.on('input', function (msg) {
          try {
            assert.strictEqual(msg.payload.success, true, 'success: ' + JSON.stringify(msg.payload));
            // 两帧，各 1 点
            assert.strictEqual(frameCount, 2, 'must produce 2 separate frames');
            assert.strictEqual(results.length, 2);
            // 每帧 bitCount 必须为 1（中间 M101-M104 不得被写）
            results.forEach(function (r) {
              assert.strictEqual(r.bitCount, 1, 'bitCount must be 1, M101-M104 must not be written');
            });
            // 帧 1 = M100=1，帧 2 = M105=1
            var framesByAddr = {};
            results.forEach(function (r) { framesByAddr[r.startAddr] = r; });
            assert.ok(framesByAddr[100], 'M100 frame missing');
            assert.ok(framesByAddr[105], 'M105 frame missing');
            assert.strictEqual(framesByAddr[100].dataByte, 0x10);  // M100=1 在偶 localIdx→高 nibble
            assert.strictEqual(framesByAddr[105].dataByte, 0x10);  // M105=1 在偶 localIdx→高 nibble
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });

        writeNode.receive({
          payload: { id: 600, deviceName: 'GapTest' },
          tags: [
            { id: 'm100', regType: 'M', addr: 100, dataType: 'BOOL', value: 1 },
            { id: 'm105', regType: 'M', addr: 105, dataType: 'BOOL', value: 1 }
          ]
        });
      });
    });
  });

  // ===== v1.6.0: SLMP ASCII Code 端到端测试（hex 编码，无 STX/ETX/checksum）=====
  it('ASCII mode: word write via SLMP hex encoding', function (done) {
    helper.settings({});
    var net = require('net');
    var PORT = 17519;

    var server = net.createServer(function (socket) {
      var buf = Buffer.alloc(0);
      socket.on('data', function (chunk) {
        buf = Buffer.concat([buf, chunk]);
        // SLMP ASCII: 21 字节 = 42 hex chars（无帧头帧尾）
        if (buf.length >= 42) {
          // 校验前两个 hex 字元 = "50"（3E 子标题）
          assert.strictEqual(buf.toString('ascii', 0, 2), '50', 'hex frame starts with 50');
          // 回复 SLMP ASCII 写响应
          var binResp = Buffer.from([0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x02, 0x00, 0x00, 0x00]);
          var asciiResp = require('../nodes/mc-protocol').toAsciiHex(binResp);
          socket.write(asciiResp);
          buf = Buffer.alloc(0);
        }
      });
    });

    server.on('error', function (e) { server.close(); if (e.code !== 'EADDRINUSE') throw e; });
    server.listen(PORT, '127.0.0.1', function () {
      var flow = [
        { id: 'nca1', type: 'mitsubishi-config', name: 'PLC-ASCII', host: '127.0.0.1', port: PORT, frame: '3E', ascii: true, timeout: 1000, retryInterval: 30 },
        { id: 'nwa1', type: 'mitsubishi-write', name: 'MC ASCII Write', plc: 'nca1', wires: [['nha1']] },
        { id: 'nha1', type: 'helper' }
      ];

      helper.load([mcConfigNode, mcWriteNode], flow, function () {
        var helperNode = helper.getNode('nha1');
        var writeNode = helper.getNode('nwa1');

        helperNode.on('input', function (msg) {
          try {
            assert.strictEqual(msg.payload.success, true, 'ASCII write success: ' + JSON.stringify(msg.payload));
            assert.strictEqual(msg.payload.data['v1'].value, 42);
            assert.strictEqual(msg.payload.data['v1'].quality, 0);
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });

        writeNode.receive({
          payload: { id: 700, deviceName: 'ASCIITest' },
          tags: [
            { id: 'v1', regType: 'D', addr: 100, dataType: 'INT16', value: 42 }
          ]
        });
      });
    });
  });

  // ===== v1.5.0: UDP 写端到端测试 =====
  function startUdpPlcWrite(opts, onReady) {
    var dgram = require('dgram');
    var server = dgram.createSocket('udp4');
    server.on('message', function (buf, rinfo) {
      var is4E = buf[0] === 0x54;
      var isWrite = is4E ? (buf[15] === 0x01 && buf[16] === 0x14) : (buf[11] === 0x01 && buf[12] === 0x14);
      var hdrLen = is4E ? 15 : 11;
      var resp = Buffer.alloc(hdrLen);
      if (is4E) {
        resp[0] = 0xD4; resp[1] = 0x00;
        resp[2] = buf[2]; resp[3] = buf[3];
        resp[4] = 0; resp[5] = 0;
        resp[6] = buf[6]; resp[7] = buf[7]; resp[8] = buf[8]; resp[9] = buf[9]; resp[10] = buf[10];
        resp.writeUInt16LE(2, 11);
        resp.writeUInt16LE(isWrite ? 0 : 0, 13);
      } else {
        resp[0] = 0xD0; resp[1] = 0x00;
        resp[2] = buf[2]; resp[3] = buf[3]; resp[4] = buf[4]; resp[5] = buf[5]; resp[6] = buf[6];
        resp.writeUInt16LE(2, 7);
        resp.writeUInt16LE(isWrite ? 0 : 0, 9);
      }
      server.send(resp, rinfo.port, rinfo.address);
    });
    server.bind(opts.port, '127.0.0.1', function () { onReady(server); });
  }

  it('UDP: should write INT16 via UDP transport', function (done) {
    helper.settings({});
    var PORT = 17514;
    startUdpPlcWrite({ port: PORT }, function (server) {
      var flow = [
        { id: 'ncu1', type: 'mitsubishi-config', name: 'PLC-UDP-W', host: '127.0.0.1', port: PORT, frame: '3E', protocol: 'udp', timeout: 1000, retryInterval: 50 },
        { id: 'nwu1', type: 'mitsubishi-write', name: 'MC UDP Write', plc: 'ncu1', wires: [['nhu1']] },
        { id: 'nhu1', type: 'helper' }
      ];

      helper.load([mcConfigNode, mcWriteNode], flow, function () {
        var helperNode = helper.getNode('nhu1');
        var writeNode = helper.getNode('nwu1');

        helperNode.on('input', function (msg) {
          try {
            assert.strictEqual(msg.payload.success, true, 'success: ' + JSON.stringify(msg.payload));
            assert.strictEqual(msg.payload.data['udp_val'].value, 500);
            assert.strictEqual(msg.payload.data['udp_val'].quality, 0);
            server.close(); done();
          } catch (e) { server.close(); done(e); }
        });

        writeNode.receive({
          payload: { id: 50, deviceName: 'UDP-Write-Test' },
          tags: [
            { id: 'udp_val', regType: 'D', addr: 100, dataType: 'INT16', value: 500 }
          ]
        });
      });
    });
  });

  describe('v1.6.0: value column & merge', function () {
    // 模拟模式开关泄漏会污染后续 spec 文件（helper settings 是进程级全局）
    afterEach(function () { helper.settings({}); });

  it('v1.6.0: static write from panel value column (no msg.tags)', function (done) {
    helper.settings({ mcSimulationMode: true });

    var flow = [
      { id: 'ncv1', type: 'mitsubishi-config', name: 'PLC-1', host: '192.168.1.10', port: 5007, frame: '3E' },
      {
        id: 'nwv1', type: 'mitsubishi-write', name: 'MC Write', plc: 'ncv1',
        tags: JSON.stringify([
          { id: 'setpoint', regType: 'D', addr: '100', dataType: 'INT16', value: '25' },
          { id: 'noval', regType: 'D', addr: '101', dataType: 'INT16', value: '' },
          { id: 'badval', regType: 'D', addr: '102', dataType: 'INT16', value: 'abc' }
        ]),
        wires: [['nhv1']]
      },
      { id: 'nhv1', type: 'helper' }
    ];

    helper.load([mcConfigNode, mcWriteNode], flow, function () {
      var h = helper.getNode('nhv1');
      h.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, true);
          // 面板默认值列（字符串 "25"）被收敛为数字 25 写入
          assert.strictEqual(msg.payload.data['setpoint'].value, 25);
          // 无默认值 / 非法值的行被跳过（拒写而不是静默写 0）
          assert.strictEqual(msg.payload.data['noval'], undefined);
          assert.strictEqual(msg.payload.data['badval'], undefined);
          done();
        } catch (e) { done(e); }
      });
      helper.getNode('nwv1').receive({ payload: { id: 100 } });
    });
  });

  it('v1.6.0: msg.tags merges with panel row by id (override & value fallback)', function (done) {
    helper.settings({ mcSimulationMode: true });

    var flow = [
      { id: 'ncv2', type: 'mitsubishi-config', name: 'PLC-1', host: '192.168.1.10', port: 5007, frame: '3E' },
      {
        id: 'nwv2', type: 'mitsubishi-write', name: 'MC Write', plc: 'ncv2',
        tags: JSON.stringify([
          { id: 'sp1', regType: 'D', addr: '100', dataType: 'INT16', value: '10' },
          { id: 'sp2', regType: 'D', addr: '200', dataType: 'INT16', value: '20' }
        ]),
        wires: [['nhv2']]
      },
      { id: 'nhv2', type: 'helper' }
    ];

    helper.load([mcConfigNode, mcWriteNode], flow, function () {
      var h = helper.getNode('nhv2');
      h.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, true);
          assert.strictEqual(msg.payload.data['sp1'].value, 99);   // msg.value 覆盖面板默认值
          assert.strictEqual(msg.payload.data['sp2'].value, 20);   // msg 未给 value → 回落面板默认
          done();
        } catch (e) { done(e); }
      });
      helper.getNode('nwv2').receive({
        payload: { id: 100 },
        tags: [{ id: 'sp1', value: 99 }, { id: 'sp2' }]
      });
    });
  });

  it('v1.6.0: msg-driven round skips unreferenced panel rows (side-effect safety)', function (done) {
    helper.settings({ mcSimulationMode: true });

    var flow = [
      { id: 'ncv3', type: 'mitsubishi-config', name: 'PLC-1', host: '192.168.1.10', port: 5007, frame: '3E' },
      {
        id: 'nwv3', type: 'mitsubishi-write', name: 'MC Write', plc: 'ncv3',
        tags: JSON.stringify([
          { id: 'sp3', regType: 'D', addr: '300', dataType: 'INT16', value: '777' }
        ]),
        wires: [['nhv3']]
      },
      { id: 'nhv3', type: 'helper' }
    ];

    helper.load([mcConfigNode, mcWriteNode], flow, function () {
      var h = helper.getNode('nhv3');
      h.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.success, true);
          assert.strictEqual(msg.payload.data['other'].value, 1);
          // 面板带默认值的行未被 msg 引用 → 本轮不执行（防静态值随动态轮次误写）
          assert.strictEqual(msg.payload.data['sp3'], undefined);
          done();
        } catch (e) { done(e); }
      });
      helper.getNode('nwv3').receive({
        payload: { id: 100 },
        tags: [{ id: 'other', regType: 'D', addr: 400, dataType: 'INT16', value: 1 }]
      });
    });
  });
  });
});
