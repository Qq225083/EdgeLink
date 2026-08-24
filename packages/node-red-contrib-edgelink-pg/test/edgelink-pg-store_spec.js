/* eslint-env mocha */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var helper = require('node-red-node-test-helper');
var proxyquire = require('proxyquire');

// spool 落盘定向到临时目录，避免测试在仓库里留下 edgelink_pg_spool/
var testUserDir = path.join(os.tmpdir(), 'edgelink-pg-test-userdir');

// Build a stub pg module whose behavior can be changed per test
var queryLog = [];
var currentQueryHandler = null;

var stubClient = {
  query: function (sql, values, cb) {
    if (typeof values === 'function') { cb = values; values = undefined; }
    queryLog.push({ sql: sql, values: values });
    if (currentQueryHandler) {
      currentQueryHandler(sql, values, cb);
    } else {
      cb(null, { rowCount: 1 });
    }
  },
  release: function () {}
};

var stubPool = {
  connect: function (cb) {
    cb(null, stubClient);
  },
  on: function () {},
  end: function (cb) { if (cb) cb(); }
};

var stubPg = {
  Pool: function () { return stubPool; }
};

var pgConfigNode = require('../nodes/edgelink-pg-config.js');
var pgStoreNode = proxyquire('../nodes/edgelink-pg-store.js', { 'pg': stubPg });

describe('edgelink-pg-store', function () {
  beforeEach(function () {
    queryLog = [];
    currentQueryHandler = null;
  });

  before(function () {
    helper.settings({ userDir: testUserDir });
  });

  afterEach(function (done) {
    helper.unload().then(function () {
      try { fs.rmSync(testUserDir, { recursive: true, force: true }); } catch (e) {}
      try { fs.rmSync(path.join(__dirname, '..', 'edgelink_pg_spool'), { recursive: true, force: true }); } catch (e) {}
      done();
    }).catch(done);
  });

  it('should load with defaults', function (done) {
    var flow = [
      { id: 'pgc1', type: 'edgelink-pg-config', name: 'PG', host: '127.0.0.1', port: 5432, database: 'test', user: 'u', password: 'p' },
      { id: 'pgs1', type: 'edgelink-pg-store', name: 'PG Store', pgConfig: 'pgc1', wires: [['h1']] },
      { id: 'h1', type: 'helper' }
    ];
    helper.load([pgConfigNode, pgStoreNode], flow, function () {
      var n = helper.getNode('pgs1');
      assert.ok(n);
      assert.strictEqual(n.name, 'PG Store');
      done();
    });
  });

  it('should batch insert rows', function (done) {
    var flow = [
      { id: 'pgc2', type: 'edgelink-pg-config', name: 'PG', host: '127.0.0.1', port: 5432, database: 'test', user: 'u', password: 'p' },
      { id: 'pgs2', type: 'edgelink-pg-store', name: 'PG Store', pgConfig: 'pgc2', batchSize: 2, wires: [['h2']] },
      { id: 'h2', type: 'helper' }
    ];

    helper.load([pgConfigNode, pgStoreNode], flow, function () {
      var store = helper.getNode('pgs2');
      var h = helper.getNode('h2');

      h.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.event, 'flushed');
          assert.strictEqual(msg.payload.success, true);
          assert.strictEqual(msg.payload.inserted, 1);
          // Find INSERT SQL
          var insert = queryLog.find(function (q) { return q.sql && q.sql.indexOf('INSERT INTO') === 0; });
          assert.ok(insert);
          assert.ok(insert.sql.indexOf('sensor_data') >= 0);
          done();
        } catch (e) { done(e); }
      });

      store.receive({
        topic: 'sensor_data',
        payload: { rows: [{ sensor: 'temp', value: 25.5 }, { sensor: 'press', value: 1.2 }] }
      });
    });
  });

  it('should insert MC format', function (done) {
    var flow = [
      { id: 'pgc3', type: 'edgelink-pg-config', name: 'PG', host: '127.0.0.1', port: 5432, database: 'test', user: 'u', password: 'p' },
      { id: 'pgs3', type: 'edgelink-pg-store', name: 'PG Store', pgConfig: 'pgc3', tableName: 'plc_data', batchSize: 1, wires: [['h3']] },
      { id: 'h3', type: 'helper' }
    ];

    helper.load([pgConfigNode, pgStoreNode], flow, function () {
      var store = helper.getNode('pgs3');
      var h = helper.getNode('h3');

      h.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.event, 'flushed');
          assert.strictEqual(msg.payload.success, true);
          var insert = queryLog.find(function (q) { return q.sql && q.sql.indexOf('INSERT INTO plc_data') === 0; });
          assert.ok(insert);
          done();
        } catch (e) { done(e); }
      });

      store.receive({
        payload: {
          success: true,
          deviceId: 1001,
          data: {
            '温度': { rawValue: 2530, engValue: 253.0, quality: 0, ts: '2026-07-18T10:00:00.000Z', regType: 'D' }
          }
        }
      });
    });
  });

  it('should enqueue retry on connection error', function (done) {
    currentQueryHandler = function (sql, values, cb) {
      var err = new Error('connection refused');
      err.code = 'ECONNREFUSED';
      cb(err);
    };

    var flow = [
      { id: 'pgc4', type: 'edgelink-pg-config', name: 'PG', host: '127.0.0.1', port: 5432, database: 'test', user: 'u', password: 'p' },
      { id: 'pgs4', type: 'edgelink-pg-store', name: 'PG Store', pgConfig: 'pgc4', batchSize: 1, retryInterval: 100, wires: [['h4']] },
      { id: 'h4', type: 'helper' }
    ];

    helper.load([pgConfigNode, pgStoreNode], flow, function () {
      var store = helper.getNode('pgs4');
      var h = helper.getNode('h4');

      h.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.event, 'retry');
          assert.strictEqual(msg.payload.success, false);
          assert.ok(msg.payload.error.indexOf('ECONNREFUSED') >= 0 || msg.payload.error.indexOf('CONNECTION') >= 0);
          done();
        } catch (e) { done(e); }
      });

      store.receive({
        payload: { rows: [{ sensor: 'temp', value: 25.5 }] }
      });
    });
  });

  it('should respect retryBufferMax and spill old rows to disk spool (v1.6.2)', function (done) {
    // v1.6.2 行为变更：retryBuffer 溢出不再丢弃，落磁盘 spool（断库恢复后自动重放）
    currentQueryHandler = function (sql, values, cb) {
      var err = new Error('connection refused');
      err.code = 'ECONNREFUSED';
      cb(err);
    };

    var flow = [
      { id: 'pgc5', type: 'edgelink-pg-config', name: 'PG', host: '127.0.0.1', port: 5432, database: 'test', user: 'u', password: 'p' },
      { id: 'pgs5', type: 'edgelink-pg-store', name: 'PG Store', pgConfig: 'pgc5', batchSize: 1, retryInterval: 60000, retryBufferMax: 50, wires: [['h5']] },
      { id: 'h5', type: 'helper' }
    ];

    helper.load([pgConfigNode, pgStoreNode], flow, function () {
      var store = helper.getNode('pgs5');
      var h = helper.getNode('h5');
      var sawSpilled = false;

      h.on('input', function (msg) {
        if (msg.payload.event === 'spilled') {
          if (sawSpilled) return;
          sawSpilled = true;
          try {
            assert.strictEqual(msg.payload.success, false);
            assert.ok(msg.payload.rows >= 1);
            assert.strictEqual(msg.payload.failed, 0);  // 落盘成功则不算丢失
            assert.strictEqual(msg.payload.reason, 'retry_buffer_overflow');
            // 落盘验证：spool 文件应存在且含溢出批次
            var spoolFile = path.join(testUserDir, 'edgelink_pg_spool', 'spool-pgs5.jsonl');
            assert.ok(fs.existsSync(spoolFile), 'spool file should exist: ' + spoolFile);
            var content = fs.readFileSync(spoolFile, 'utf8');
            assert.ok(content.indexOf('retry_buffer_overflow') >= 0, 'spool should record overflow reason');
            done();
          } catch (e) { done(e); }
        }
      });

      var rows = [];
      for (var i = 0; i < 55; i++) {
        rows.push({ sensor: 'temp', value: i });
      }
      store.receive({ payload: { rows: rows } });
    });
  });

  it('should not mix rows across tables while a write is in flight', function (done) {
    // 回归测试(v1.6.0 串表修复)：写入在途时到达的不同表数据必须各自分段，
    // 不得混入同一 INSERT（旧逻辑会把 b1/a2 一起插进 tbl_a）
    var insertCbs = [];
    currentQueryHandler = function (sql, values, cb) {
      if (sql.indexOf('INSERT INTO') === 0) { insertCbs.push(cb); return; }  // 挂起 INSERT
      cb(null, { rowCount: 1 });
    };

    var flow = [
      { id: 'pgc6', type: 'edgelink-pg-config', name: 'PG', host: '127.0.0.1', port: 5432, database: 'test', user: 'u', password: 'p' },
      { id: 'pgs6', type: 'edgelink-pg-store', name: 'PG Store', pgConfig: 'pgc6', batchSize: 1, wires: [['h6']] },
      { id: 'h6', type: 'helper' }
    ];

    helper.load([pgConfigNode, pgStoreNode], flow, function () {
      var store = helper.getNode('pgs6');

      store.receive({ tableName: 'tbl_a', payload: { rows: [{ sensor: 'a1' }] } });  // 立即 flush，INSERT 挂起
      store.receive({ tableName: 'tbl_b', payload: { rows: [{ sensor: 'b1' }] } });  // 在途 → 独立分段
      store.receive({ tableName: 'tbl_a', payload: { rows: [{ sensor: 'a2' }] } });  // 在途 → 独立分段

      var guard = 0;
      while (insertCbs.length > 0 && guard++ < 10) { insertCbs.shift()(null, { rowCount: 1 }); }

      try {
        var inserts = queryLog.filter(function (q) { return q.sql.indexOf('INSERT INTO') === 0; });
        assert.strictEqual(inserts.length, 3);
        assert.strictEqual(inserts[0].sql.indexOf('INSERT INTO tbl_a'), 0);
        assert.deepStrictEqual(inserts[0].values, ['a1']);
        assert.strictEqual(inserts[1].sql.indexOf('INSERT INTO tbl_b'), 0);
        assert.deepStrictEqual(inserts[1].values, ['b1']);
        assert.strictEqual(inserts[2].sql.indexOf('INSERT INTO tbl_a'), 0);
        assert.deepStrictEqual(inserts[2].values, ['a2']);
        done();
      } catch (e) { done(e); }
    });
  });

  it('should spool deterministic errors instead of infinite retry', function (done) {
    // 回归测试(v1.6.0 错误分类白名单)：未知/确定性 SQL 错误(42601)不再进重试缓冲，直接落 spool
    currentQueryHandler = function (sql, values, cb) {
      if (sql.indexOf('INSERT INTO') === 0) {
        var err = new Error('syntax error in INSERT');
        err.code = '42601';
        cb(err);
        return;
      }
      cb(null, { rowCount: 1 });
    };

    var flow = [
      { id: 'pgc7', type: 'edgelink-pg-config', name: 'PG', host: '127.0.0.1', port: 5432, database: 'test', user: 'u', password: 'p' },
      { id: 'pgs7', type: 'edgelink-pg-store', name: 'PG Store', pgConfig: 'pgc7', batchSize: 1, retryInterval: 100, wires: [['h7']] },
      { id: 'h7', type: 'helper' }
    ];

    helper.load([pgConfigNode, pgStoreNode], flow, function () {
      var store = helper.getNode('pgs7');
      var h = helper.getNode('h7');

      h.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.event, 'error');   // 若被误判为 retry 则此断言失败
          assert.strictEqual(msg.payload.spooled, true);
          var spoolFile = path.join(testUserDir, 'edgelink_pg_spool', 'spool-pgs7.jsonl');
          assert.ok(fs.existsSync(spoolFile), 'spool file should exist');
          var lines = fs.readFileSync(spoolFile, 'utf8').trim().split('\n');
          assert.strictEqual(lines.length, 1);
          var rec = JSON.parse(lines[0]);
          assert.deepStrictEqual(rec.rows, [['x']]);
          done();
        } catch (e) { done(e); }
      });

      store.receive({ tableName: 'tbl_a', payload: { rows: [{ sensor: 'x' }] } });
    });
  });

  it('should build MC update conflict target with tag_id', function (done) {
    // 回归测试(v1.6.0)：MC 的 PK 是 (insert_time, device_id, tag_id)，
    // update 策略冲突目标必须完整匹配，否则 PG 必报 42P10
    var flow = [
      { id: 'pgc8', type: 'edgelink-pg-config', name: 'PG', host: '127.0.0.1', port: 5432, database: 'test', user: 'u', password: 'p' },
      { id: 'pgs8', type: 'edgelink-pg-store', name: 'PG Store', pgConfig: 'pgc8', tableName: 'plc_data', conflictStrategy: 'update', batchSize: 1, wires: [['h8']] },
      { id: 'h8', type: 'helper' }
    ];

    helper.load([pgConfigNode, pgStoreNode], flow, function () {
      var store = helper.getNode('pgs8');
      var h = helper.getNode('h8');

      h.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.event, 'flushed');
          var insert = queryLog.find(function (q) { return q.sql && q.sql.indexOf('INSERT INTO plc_data') === 0; });
          assert.ok(insert);
          assert.ok(insert.sql.indexOf('ON CONFLICT (insert_time, device_id, tag_id) DO UPDATE') >= 0, 'conflict target should include tag_id');
          assert.ok(insert.sql.indexOf('tag_id = EXCLUDED.tag_id') === -1, 'conflict target columns must not appear in SET');
          assert.ok(insert.sql.indexOf('raw_value = EXCLUDED.raw_value') >= 0);
          done();
        } catch (e) { done(e); }
      });

      store.receive({
        payload: {
          deviceId: 1001,
          data: {
            '温度': { rawValue: 2530, engValue: 253.0, quality: 0, ts: '2026-07-18T10:00:00.000Z', regType: 'D' }
          }
        }
      });
    });
  });

  it('should build batch update conflict target matching live table 4-col unique index', function (done) {
    // 回归测试(评审#6)：batch 格式 + 实表 edgelink.plc_data 唯一索引 4 列，
    // update 策略冲突目标必须 4 列齐全，否则 PG 必报 42P10
    var flow = [
      { id: 'pgc9', type: 'edgelink-pg-config', name: 'PG', host: '127.0.0.1', port: 5432, database: 'test', user: 'u', password: 'p' },
      { id: 'pgs9', type: 'edgelink-pg-store', name: 'PG Store', pgConfig: 'pgc9', tableName: 'plc_data', conflictStrategy: 'update', batchSize: 1, wires: [['h9']] },
      { id: 'h9', type: 'helper' }
    ];

    helper.load([pgConfigNode, pgStoreNode], flow, function () {
      var store = helper.getNode('pgs9');
      var h = helper.getNode('h9');

      h.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.event, 'flushed');
          var insert = queryLog.find(function (q) { return q.sql && q.sql.indexOf('INSERT INTO plc_data') === 0; });
          assert.ok(insert);
          assert.ok(insert.sql.indexOf('ON CONFLICT (insert_time, node_id, device_id, tag_id) DO UPDATE') >= 0, 'batch 冲突目标必须是实表 4 列唯一索引');
          done();
        } catch (e) { done(e); }
      });

      store.receive({
        tableName: 'plc_data',
        payload: { rows: [{ insert_time: '2026-08-03T10:00:00Z', node_id: 66, device_id: 30, tag_id: 56, raw_value: 1, eng_value: 1, quality: 0 }] }
      });
    });
  });
});
