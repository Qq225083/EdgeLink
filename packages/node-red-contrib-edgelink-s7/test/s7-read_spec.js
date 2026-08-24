/* eslint-env mocha */
'use strict';

var helper = require('node-red-node-test-helper');
var assert = require('assert');
var events = require('events');
var util = require('util');
var proxyquire = require('proxyquire');

// ===== @st-one-io/nodes7 stub（不依赖真实 PLC）=====
var stubState = {
  connectError: null,   // 设置后 connect() 一律拒绝
  readHandler: null,    // function(items /*tagId 数组*/, translate) → {tagId: value} | Promise；throw/reject 表示该组读取失败
  endpoints: []         // 所有构造过的 FakeS7Endpoint（断言构造参数用）
};

function FakeS7Endpoint(opts) {
  events.EventEmitter.call(this);
  this.opts = opts;
  this._connected = false;
  stubState.endpoints.push(this);
}
util.inherits(FakeS7Endpoint, events.EventEmitter);
Object.defineProperty(FakeS7Endpoint.prototype, 'isConnected', {
  get: function () { return this._connected; }
});
FakeS7Endpoint.prototype.connect = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    setImmediate(function () {
      if (stubState.connectError) { reject(stubState.connectError); return; }
      self._connected = true;
      self.emit('connect');
      resolve();
    });
  });
};
FakeS7Endpoint.prototype.disconnect = function () {
  var self = this;
  return new Promise(function (resolve) {
    setImmediate(function () {
      var was = self._connected;
      self._connected = false;
      if (was) self.emit('disconnect');
      resolve();
    });
  });
};

function FakeS7ItemGroup(endpoint) {
  this._endpoint = endpoint;
  this._items = [];
  this._translate = function (t) { return t; };
}
FakeS7ItemGroup.prototype.setTranslationCB = function (fn) { this._translate = fn; };
FakeS7ItemGroup.prototype.addItems = function (tags) {
  var arr = Array.isArray(tags) ? tags : [tags];
  this._items = this._items.concat(arr);
};
FakeS7ItemGroup.prototype.removeItems = function () { this._items = []; };
FakeS7ItemGroup.prototype.destroy = function () {};
FakeS7ItemGroup.prototype.readAllItems = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    if (!self._endpoint.isConnected) { reject(new Error('Not connected')); return; }
    var handler = stubState.readHandler || function (items) {
      var out = {};
      items.forEach(function (id) { out[id] = 1234; });
      return out;
    };
    // handler 可返回 Promise（轮次闸测试挂起读取）
    Promise.resolve()
      .then(function () { return handler(self._items.slice(), self._translate); })
      .then(resolve, reject);
  });
};

var nodes7Stub = { S7Endpoint: FakeS7Endpoint, S7ItemGroup: FakeS7ItemGroup };

var s7ReadNode = proxyquire('../nodes/s7-read.js', { '@st-one-io/nodes7': nodes7Stub });
var s7ConfigNode = require('../nodes/s7-config.js');
var pool = require('../nodes/lib/s7-pool.js');

describe('s7-read node', function () {
  afterEach(function (done) {
    helper.unload().then(function () {
      stubState.connectError = null;
      stubState.readHandler = null;
      stubState.endpoints = [];
      pool._clearForTest();  // 清退避/连接残留，防跨用例串扰
      done();
    }).catch(done);
  });

  function buildFlow(host) {
    return [
      { id: 'sc1', type: 's7-config', name: 'S7-Cfg', host: host, port: 102, rack: 0, slot: 1 },
      { id: 'sr1', type: 's7-read', name: 'S7 Read', s7: 'sc1', wires: [['sh1']] },
      { id: 'sh1', type: 'helper' }
    ];
  }

  it('should load with defaults', function (done) {
    helper.load([s7ConfigNode, s7ReadNode], buildFlow('192.168.1.10'), function () {
      var n1 = helper.getNode('sr1');
      assert.ok(n1);
      assert.strictEqual(n1.name, 'S7 Read');
      var c1 = helper.getNode('sc1');
      assert.strictEqual(c1.port, 102);
      assert.strictEqual(c1.rack, 0);
      assert.strictEqual(c1.slot, 1);
      done();
    });
  });

  it('成功路径：契约字段 + data 形状 + BOOL 归一化 0/1 + rack/slot 来自 protocolParams', function (done) {
    var flow = buildFlow('10.0.0.11');
    helper.load([s7ConfigNode, s7ReadNode], flow, function () {
      var helperNode = helper.getNode('sh1');
      var readNode = helper.getNode('sr1');

      var seenReads = [];
      stubState.readHandler = function (items, translate) {
        // 记录翻译结果，最终在输出断言里统一校验（避免 handler 内断言干扰读取链）
        var translated = {};
        items.forEach(function (id) { translated[id] = translate(id); });
        seenReads.push({ items: items, translated: translated });
        return { '59': -123, '60': true, '61': 23.5 };
      };

      helperNode.on('input', function (msg) {
        try {
          var p = msg.payload;
          assert.strictEqual(p.success, true, JSON.stringify(p));
          assert.strictEqual(p.deviceId, 30);
          assert.strictEqual(p.deviceName, 'S7-PLC');
          assert.strictEqual(p.error, null);
          assert.strictEqual(p.driverType, 'driver-s7');
          assert.strictEqual(p.plcIp, '10.0.0.11');
          assert.strictEqual(p.plcPort, 102);
          assert.strictEqual(typeof p.roundTimeMs, 'number');

          var d = p.data;
          assert.deepStrictEqual(Object.keys(d).sort(), ['59', '60', '61']);
          assert.strictEqual(d['59'].rawValue, -123, 'INT16 负数应原样（有符号解码）');
          assert.strictEqual(d['59'].quality, 0);
          assert.strictEqual(d['59'].regType, 'DB');
          assert.ok(/^\d{4}-\d{2}-\d{2}T.*Z$/.test(d['59'].ts), 'ts 应为 ISO 字符串');
          assert.strictEqual(d['60'].rawValue, 1, 'BOOL true 应归一化为 1');
          assert.strictEqual(d['60'].quality, 0);
          assert.strictEqual(d['61'].rawValue, 23.5, 'FLOAT 应原样');
          assert.strictEqual(d['61'].regType, 'M');

          // 端到端验证地址翻译（TIA → nodes7）：三个点位应合为一批
          assert.strictEqual(seenReads.length, 1, '点位应一次批量读取');
          assert.deepStrictEqual(seenReads[0].items.slice().sort(), ['59', '60', '61']);
          assert.strictEqual(seenReads[0].translated['59'], 'DB1,INT0');
          assert.strictEqual(seenReads[0].translated['60'], 'DB1,X0.0');
          assert.strictEqual(seenReads[0].translated['61'], 'MR10');

          // rack/slot 应从 protocolParams 进入 endpoint 构造参数（覆盖 cfg 默认值）
          assert.strictEqual(stubState.endpoints.length, 1);
          assert.strictEqual(stubState.endpoints[0].opts.host, '10.0.0.11');
          assert.strictEqual(stubState.endpoints[0].opts.port, 102);
          assert.strictEqual(stubState.endpoints[0].opts.rack, 2);
          assert.strictEqual(stubState.endpoints[0].opts.slot, 3);
          done();
        } catch (e) { done(e); }
      });

      readNode.receive({
        payload: {
          id: 30, deviceName: 'S7-PLC',
          plcIp: '10.0.0.11', plcPort: 102,
          protocolParams: { rack: 2, slot: 3 },
          tags: [
            { id: 59, addr: 999, regAddr: 'DB1.DBW0', regType: 'DB', dataType: 'INT16', name: '温度' },
            { id: 60, regAddr: 'DB1.DBX0.0', regType: 'DB', dataType: 'BOOL', name: '运行' },
            { id: 61, regAddr: 'MD10', regType: 'M', dataType: 'FLOAT', name: '压力' }
          ]
        }
      });
    });
  });

  it('连接失败（ECONNREFUSED）：success:false + data:{} + node.error(msg) 可被 catch 捕获', function (done) {
    var flow = buildFlow('10.0.0.12');
    helper.load([s7ConfigNode, s7ReadNode], flow, function () {
      var helperNode = helper.getNode('sh1');
      var readNode = helper.getNode('sr1');

      var errSpy = [];
      readNode.error = function (text, msg) { errSpy.push({ text: text, msg: msg }); };

      var connErr = new Error('connect ECONNREFUSED 10.0.0.12:102');
      connErr.code = 'ECONNREFUSED';
      stubState.connectError = connErr;

      helperNode.on('input', function (msg) {
        try {
          var p = msg.payload;
          assert.strictEqual(p.success, false);
          assert.deepStrictEqual(p.data, {});
          assert.ok(p.error.indexOf('ECONNREFUSED') >= 0, 'error 应含 ECONNREFUSED: ' + p.error);
          assert.strictEqual(p.driverType, 'driver-s7');
          assert.strictEqual(p.deviceId, 31);
          assert.strictEqual(typeof p.roundTimeMs, 'number');
          // node.error 必须带 msg（catch 节点可捕获）
          assert.strictEqual(errSpy.length, 1, 'node.error 应被调用一次');
          assert.strictEqual(errSpy[0].msg, msg, 'node.error 应携带 msg');
          done();
        } catch (e) { done(e); }
      });

      readNode.receive({
        payload: {
          id: 31, deviceName: 'S7-Down',
          plcIp: '10.0.0.12', plcPort: 102,
          protocolParams: { rack: 0, slot: 1 },
          tags: [{ id: 59, regAddr: 'DB1.DBW0', regType: 'DB', dataType: 'INT16' }]
        }
      });
    });
  });

  it('per-PLC 轮次闸：同 PLC 上一轮未结束时新一轮直接失败', function (done) {
    var flow = buildFlow('10.0.0.13');
    helper.load([s7ConfigNode, s7ReadNode], flow, function () {
      var helperNode = helper.getNode('sh1');
      var readNode = helper.getNode('sr1');

      var releaseRead = null;
      stubState.readHandler = function (items) {
        return new Promise(function (resolve) {
          releaseRead = function () {
            var out = {};
            items.forEach(function (id) { out[id] = 42; });
            resolve(out);
          };
        });
      };

      var msgs = [];
      helperNode.on('input', function (msg) {
        msgs.push(msg);
        if (msgs.length === 1) {
          // 第一条到的应是轮次闸拒绝（第二轮），此时释放第一轮读取
          try {
            var p = msgs[0].payload;
            assert.strictEqual(p.success, false);
            assert.strictEqual(p.error, 'Round in progress (previous scan not finished)');
            assert.deepStrictEqual(p.data, {});
            assert.strictEqual(p.deviceId, 33, '第二轮（id=33）应被轮次闸拒绝');
          } catch (e) { done(e); return; }
          // round1 的 readHandler 是异步启动的，等它真正挂起后再释放
          var waitRelease = setInterval(function () {
            if (releaseRead) {
              clearInterval(waitRelease);
              releaseRead();
            }
          }, 10);
          return;
        }
        if (msgs.length === 2) {
          try {
            var p2 = msgs[1].payload;
            assert.strictEqual(p2.success, true, '第一轮应正常完成');
            assert.strictEqual(p2.deviceId, 32);
            assert.strictEqual(p2.data['59'].rawValue, 42);
            done();
          } catch (e) { done(e); }
        }
      });

      var baseTags = [{ id: 59, regAddr: 'DB1.DBW0', regType: 'DB', dataType: 'INT16' }];
      // 第一轮：读取被挂起（持有轮次闸）
      readNode.receive({
        payload: { id: 32, deviceName: 'S7-Slow', plcIp: '10.0.0.13', plcPort: 102, tags: baseTags }
      });
      // 第二轮：同 PLC，应立即被轮次闸拒绝
      readNode.receive({
        payload: { id: 33, deviceName: 'S7-Slow', plcIp: '10.0.0.13', plcPort: 102, tags: baseTags }
      });
    });
  });

  it('全非法地址：No valid tags (all addresses invalid) + node.error(msg)', function (done) {
    var flow = buildFlow('10.0.0.14');
    helper.load([s7ConfigNode, s7ReadNode], flow, function () {
      var helperNode = helper.getNode('sh1');
      var readNode = helper.getNode('sr1');

      var errSpy = [];
      readNode.error = function (text, msg) { errSpy.push({ text: text, msg: msg }); };

      helperNode.on('input', function (msg) {
        try {
          var p = msg.payload;
          assert.strictEqual(p.success, false);
          assert.strictEqual(p.error, 'No valid tags (all addresses invalid)');
          assert.deepStrictEqual(p.data, {});
          assert.strictEqual(p.driverType, 'driver-s7');
          assert.strictEqual(errSpy.length, 1);
          assert.strictEqual(errSpy[0].msg, msg);
          done();
        } catch (e) { done(e); }
      });

      readNode.receive({
        payload: {
          id: 34, plcIp: '10.0.0.14', plcPort: 102,
          tags: [
            { id: 1, regAddr: 'garbage', regType: 'DB', dataType: 'INT16' },
            { id: 2, regAddr: 'DB1.DBW0', regType: 'M', dataType: 'INT16' }  // 区域与 regType 不符
          ]
        }
      });
    });
  });

  it('单点位失败不炸整轮：坏点 quality=1 占位，好点正常输出', function (done) {
    var flow = buildFlow('10.0.0.15');
    helper.load([s7ConfigNode, s7ReadNode], flow, function () {
      var helperNode = helper.getNode('sh1');
      var readNode = helper.getNode('sr1');

      // b1 所在批量读失败；逐点单读兜底时 b1 单独仍失败（模拟 PLC 侧该地址越界）
      stubState.readHandler = function (items) {
        if (items.indexOf('b1') >= 0) throw new Error('Error returned from request: "Address out of range"');
        return { 'g1': 777 };
      };

      var errSpy = [];
      readNode.error = function (text, msg) { errSpy.push({ text: text, msg: msg }); };

      helperNode.on('input', function (msg) {
        try {
          var p = msg.payload;
          assert.strictEqual(p.success, false, '有坏点 → success:false');
          assert.ok(p.error, '应有错误信息');
          var d = p.data;
          assert.strictEqual(d['g1'].rawValue, 777, '好点应正常读到值');
          assert.strictEqual(d['g1'].quality, 0);
          assert.strictEqual(d['b1'].rawValue, null, '坏点 rawValue 应为 null');
          assert.strictEqual(d['b1'].quality, 1, '坏点 quality 应为 1（BAD）');
          assert.strictEqual(d['b1'].regType, 'DB');
          assert.strictEqual(errSpy.length, 1, '失败应 node.error(msg)');
          assert.strictEqual(errSpy[0].msg, msg);
          done();
        } catch (e) { done(e); }
      });

      readNode.receive({
        payload: {
          id: 35, deviceName: 'S7-Mixed', plcIp: '10.0.0.15', plcPort: 102,
          timeout: 1000, maxRetries: 0, retryInterval: 30,
          tags: [
            { id: 'g1', regAddr: 'DB1.DBW0', regType: 'DB', dataType: 'INT16' },
            { id: 'b1', regAddr: 'DB1.DBW2', regType: 'DB', dataType: 'INT16' }
          ]
        }
      });
    });
  });

  it('DOUBLE 点位被剔除（warn），其余点位正常采集', function (done) {
    var flow = buildFlow('10.0.0.16');
    helper.load([s7ConfigNode, s7ReadNode], flow, function () {
      var helperNode = helper.getNode('sh1');
      var readNode = helper.getNode('sr1');

      var warnSpy = [];
      readNode.warn = function (text) { warnSpy.push(text); };

      helperNode.on('input', function (msg) {
        try {
          var p = msg.payload;
          assert.strictEqual(p.success, true);
          assert.strictEqual(p.data['ok1'].rawValue, 1234);
          assert.strictEqual(p.data['ok1'].quality, 0);
          assert.strictEqual(p.data['d1'], undefined, 'DOUBLE 点位应被剔除，不出现在 data 中');
          assert.ok(warnSpy.join(' ').indexOf('暂不支持 DOUBLE') >= 0, '剔除应记 warn: ' + warnSpy.join(' | '));
          done();
        } catch (e) { done(e); }
      });

      readNode.receive({
        payload: {
          id: 36, plcIp: '10.0.0.16', plcPort: 102,
          tags: [
            { id: 'd1', regAddr: 'DB1.DBD0', regType: 'DB', dataType: 'DOUBLE' },
            { id: 'ok1', regAddr: 'DB1.DBW4', regType: 'DB', dataType: 'INT16' }
          ]
        }
      });
    });
  });
});
