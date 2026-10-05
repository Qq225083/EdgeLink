/* eslint-env mocha */
'use strict';

var helper = require('node-red-node-test-helper');
var assert = require('assert');
var changeToSqlNode = require('../nodes/change-to-sql.js');
var changeFilterNode = require('../nodes/change-filter.js');

function startFlow(cfg, cb) {
  var flow = [
    Object.assign({ id: 'n1', type: 'change-to-sql', wires: [['h1']] }, cfg),
    { id: 'h1', type: 'helper' }
  ];
  helper.load(changeToSqlNode, flow, cb);
}

var MAPPING = JSON.stringify({ '*': { col3: 1, col4: 2 } });

function diffRec(equipmentId, fields, values) {
  var rec = { equipment_id: equipmentId, _changed_fields: fields, _old_values: {}, _is_new: false };
  fields.forEach(function (f) { rec[f] = values[f]; });
  return rec;
}

describe('change-to-sql node', function () {
  afterEach(function (done) {
    helper.unload().then(function () { done(); }).catch(done);
  });

  it('按映射把 _changed_fields 展开为 INSERT SQL', function (done) {
    startFlow({ table: 'wedh.wed_scn1', valueColumn: 'number_value', fieldMapping: MAPPING }, function () {
      helper.getNode('h1').on('input', function (msg) {
        try {
          assert.ok(/^INSERT INTO wedh\.wed_scn1\(insert_time, tag_id, number_value\) VALUES /.test(msg.query),
            'SQL 前缀不符: ' + msg.query);
          assert.ok(msg.query.indexOf(', 1, 105)') !== -1, '应含 col3→tag 1 的行: ' + msg.query);
          assert.ok(msg.query.indexOf(', 2, 250)') !== -1, '应含 col4→tag 2 的行: ' + msg.query);
          assert.ok(/;\s*$/.test(msg.query));
          done();
        } catch (e) { done(e); }
      });
      helper.getNode('n1').receive({
        payload: [diffRec('b040', ['col3', 'col4'], { col3: 105, col4: 250 })]
      });
    });
  });

  it('设备专属映射覆盖 "*" 公共默认', function (done) {
    var mapping = JSON.stringify({ '*': { col3: 1 }, 'b040': { col3: 101 } });
    startFlow({ table: 't', fieldMapping: mapping }, function () {
      var rows = [];
      helper.getNode('h1').on('input', function (msg) {
        rows.push(msg.query);
        if (rows.length === 2) {
          try {
            assert.ok(rows[0].indexOf(', 101, 10)') !== -1, 'b040 应走专属映射 101: ' + rows[0]);
            assert.ok(rows[1].indexOf(', 1, 20)') !== -1, 'b041 应回落公共映射 1: ' + rows[1]);
            done();
          } catch (e) { done(e); }
          return;
        }
        helper.getNode('n1').receive({
          payload: [diffRec('b041', ['col3'], { col3: 20 })]
        });
      });
      helper.getNode('n1').receive({
        payload: [diffRec('b040', ['col3'], { col3: 10 })]
      });
    });
  });

  it('无映射字段与非数值字段跳过并 warn', function (done) {
    startFlow({ table: 't', fieldMapping: MAPPING }, function () {
      var n1 = helper.getNode('n1');
      var warns = [];
      n1.warn = function (m) { warns.push(m); };
      helper.getNode('h1').on('input', function (msg) {
        try {
          assert.ok(msg.query.indexOf(', 1, 10)') !== -1, '仅 col3 应写入: ' + msg.query);
          assert.ok(msg.query.indexOf('col9') === -1);
          assert.ok(warns.length === 1 && /col9/.test(warns[0]) && /无映射/.test(warns[0]), 'warn 应说明跳过原因: ' + warns);
          assert.ok(/非数值/.test(warns[0]), 'warn 应包含非数值提示: ' + warns);
          done();
        } catch (e) { done(e); }
      });
      n1.receive({
        payload: [diffRec('b040', ['col3', 'col4', 'col9'], { col3: 10, col4: 'abc', col9: 99 })]
      });
    });
  });

  it('无可写入行时不发送消息（空数组 / 字段全被跳过）', function (done) {
    startFlow({ table: 't', fieldMapping: MAPPING }, function () {
      var n1 = helper.getNode('n1');
      var sent = 0;
      helper.getNode('h1').on('input', function () { sent++; });
      n1.receive({ payload: [] });
      n1.receive({ payload: [diffRec('b040', ['col9'], { col9: 1 })] });
      setTimeout(function () {
        try { assert.strictEqual(sent, 0); done(); } catch (e) { done(e); }
      }, 100);
    });
  });

  it('配置非法（缺表名 / 映射 JSON 错误）：报错且不发送', function (done) {
    var flow = [
      { id: 'n1', type: 'change-to-sql', table: '', fieldMapping: '{bad json', wires: [['h1']] },
      { id: 'h1', type: 'helper' },
      { id: 'c1', type: 'catch', scope: ['n1'], wires: [['ch1']] },
      { id: 'ch1', type: 'helper' }
    ];
    helper.load(changeToSqlNode, flow, function () {
      var sent = 0;
      helper.getNode('h1').on('input', function () { sent++; });
      helper.getNode('ch1').on('input', function (msg) {
        try {
          assert.ok(/配置非法/.test(msg.error.message));
          setTimeout(function () {
            try { assert.strictEqual(sent, 0); done(); } catch (e) { done(e); }
          }, 50);
        } catch (e) { done(e); }
      });
      helper.getNode('n1').receive({
        payload: [diffRec('b040', ['col3'], { col3: 10 })]
      });
    });
  });

  it('表名含非法字符时拒绝处理', function (done) {
    var flow = [
      { id: 'n1', type: 'change-to-sql', table: 't; DROP TABLE x--', fieldMapping: MAPPING, wires: [['h1']] },
      { id: 'h1', type: 'helper' },
      { id: 'c1', type: 'catch', scope: ['n1'], wires: [['ch1']] },
      { id: 'ch1', type: 'helper' }
    ];
    helper.load(changeToSqlNode, flow, function () {
      helper.getNode('ch1').on('input', function (msg) {
        try {
          assert.ok(/配置非法/.test(msg.error.message));
          done();
        } catch (e) { done(e); }
      });
      helper.getNode('n1').receive({
        payload: [diffRec('b040', ['col3'], { col3: 10 })]
      });
    });
  });

  it('与 change-filter 串联：第二帧只把变化字段写入 SQL（端到端回归）', function (done) {
    var flow = [
      { id: 'f1', type: 'change-filter', keyField: 'equipment_id', wires: [['n1']] },
      { id: 'n1', type: 'change-to-sql', table: 'wedh.wed_scn1', valueColumn: 'number_value', fieldMapping: MAPPING, wires: [['h1']] },
      { id: 'h1', type: 'helper' }
    ];
    helper.load([changeFilterNode, changeToSqlNode], flow, function () {
      var queries = [];
      helper.getNode('h1').on('input', function (msg) {
        queries.push(msg.query);
        if (queries.length === 1) {
          // 首帧：新记录全字段写入
          try {
            assert.ok(queries[0].indexOf(', 1, 100)') !== -1 && queries[0].indexOf(', 2, 200)') !== -1,
              '首帧应全量写入: ' + queries[0]);
          } catch (e) { done(e); return; }
          helper.getNode('f1').receive({
            payload: [{ equipment_id: 'b040', col3: 105, col4: 200, timestamp: 't2' }]
          });
          return;
        }
        try {
          assert.ok(queries[1].indexOf(', 1, 105)') !== -1, '第二帧应写入变化的 col3: ' + queries[1]);
          assert.ok(queries[1].indexOf(', 2,') === -1, '第二帧不应写入未变化的 col4: ' + queries[1]);
          done();
        } catch (e) { done(e); }
      });
      helper.getNode('f1').receive({
        payload: [{ equipment_id: 'b040', col3: 100, col4: 200, timestamp: 't1' }]
      });
    });
  });

  it('rows 模式：输出 payload.rows + tableName（对接 edgelink-pg-store），无 msg.query', function (done) {
    startFlow({ table: 'wedh.wed_scn1', valueColumn: 'number_value', fieldMapping: MAPPING, outputFormat: 'rows' }, function () {
      helper.getNode('h1').on('input', function (msg) {
        try {
          assert.strictEqual(msg.tableName, 'wedh.wed_scn1');
          assert.strictEqual(msg.query, undefined, 'rows 模式不应产生 msg.query');
          assert.ok(Array.isArray(msg.payload.rows));
          assert.strictEqual(msg.payload.rows.length, 2);
          var r0 = msg.payload.rows[0];
          assert.deepStrictEqual(Object.keys(r0).sort(), ['insert_time', 'number_value', 'tag_id']);
          assert.strictEqual(r0.tag_id, 1);
          assert.strictEqual(r0.number_value, 105);
          assert.ok(typeof r0.insert_time === 'string');
          done();
        } catch (e) { done(e); }
      });
      helper.getNode('n1').receive({
        payload: [diffRec('b040', ['col3', 'col4'], { col3: 105, col4: 250 })]
      });
    });
  });

  it('rows 模式：无可写入行时不发送（不会产出空 rows 导致 pg-store 忽略）', function (done) {
    startFlow({ table: 't', fieldMapping: MAPPING, outputFormat: 'rows' }, function () {
      var sent = 0;
      helper.getNode('h1').on('input', function () { sent++; });
      var n1 = helper.getNode('n1');
      n1.receive({ payload: [] });
      n1.receive({ payload: [diffRec('b040', ['col9'], { col9: 1 })] });
      setTimeout(function () {
        try { assert.strictEqual(sent, 0); done(); } catch (e) { done(e); }
      }, 100);
    });
  });

  it('rows 模式与 change-filter 串联：第二帧只携带变化字段的行（端到端）', function (done) {
    var flow = [
      { id: 'f1', type: 'change-filter', keyField: 'equipment_id', wires: [['n1']] },
      { id: 'n1', type: 'change-to-sql', table: 'wedh.wed_scn1', valueColumn: 'number_value', fieldMapping: MAPPING, outputFormat: 'rows', wires: [['h1']] },
      { id: 'h1', type: 'helper' }
    ];
    helper.load([changeFilterNode, changeToSqlNode], flow, function () {
      var batches = [];
      helper.getNode('h1').on('input', function (msg) {
        batches.push(msg.payload.rows);
        if (batches.length === 1) {
          try {
            assert.strictEqual(batches[0].length, 2, '首帧应全量两行');
          } catch (e) { done(e); return; }
          helper.getNode('f1').receive({
            payload: [{ equipment_id: 'b040', col3: 105, col4: 200, timestamp: 't2' }]
          });
          return;
        }
        try {
          assert.strictEqual(batches[1].length, 1, '第二帧只应有变化的一行');
          assert.strictEqual(batches[1][0].tag_id, 1);
          assert.strictEqual(batches[1][0].number_value, 105);
          assert.strictEqual(msg.tableName, 'wedh.wed_scn1');
          done();
        } catch (e) { done(e); }
      });
      helper.getNode('f1').receive({
        payload: [{ equipment_id: 'b040', col3: 100, col4: 200, timestamp: 't1' }]
      });
    });
  });
});
