/* eslint-env mocha */
'use strict';

var helper = require('node-red-node-test-helper');
var assert = require('assert');
var changeFilterNode = require('../nodes/change-filter.js');

function startFlow(cfg, cb) {
  var flow = [
    Object.assign({ id: 'n1', type: 'change-filter', wires: [['h1']] }, cfg),
    { id: 'h1', type: 'helper' }
  ];
  helper.load(changeFilterNode, flow, cb);
}

var FRAME1 = [
  { equipment_id: 'b040', col3: 100, col4: 200, timestamp: 't1' },
  { equipment_id: 'b041', col3: 150, col4: 250, timestamp: 't1' }
];

describe('change-filter node', function () {
  afterEach(function (done) {
    helper.unload().then(function () { done(); }).catch(done);
  });

  it('首次 pass_through：全量输出，_is_new=true，_changed_fields 为全部参与比较字段', function (done) {
    startFlow({ keyField: 'equipment_id' }, function () {
      helper.getNode('h1').on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.length, 2);
          var r = msg.payload[0];
          assert.strictEqual(r._is_new, true);
          assert.deepStrictEqual(r._changed_fields.slice().sort(), ['col3', 'col4']);
          assert.deepStrictEqual(r._old_values, {});
          assert.strictEqual(r._changed, undefined); // changed_only 模式不附 _changed
          assert.strictEqual(r.col3, 100);
          // 新记录：_changes 为全字段新值
          assert.deepStrictEqual(r._changes, { col3: 100, col4: 200 });
          done();
        } catch (e) { done(e); }
      });
      helper.getNode('n1').receive({ payload: FRAME1 });
    });
  });

  it('第二帧：仅变化项输出，附 _changed_fields / _old_values，排除字段不参与', function (done) {
    startFlow({ keyField: 'equipment_id' }, function () {
      var n1 = helper.getNode('n1');
      var count = 0;
      helper.getNode('h1').on('input', function (msg) {
        count++;
        if (count === 1) {
          n1.receive({ payload: [
            { equipment_id: 'b040', col3: 105, col4: 200, timestamp: 't2' },
            { equipment_id: 'b041', col3: 150, col4: 250, timestamp: 't2' }
          ] });
          return;
        }
        try {
          assert.strictEqual(msg.payload.length, 1);
          var r = msg.payload[0];
          assert.strictEqual(r.equipment_id, 'b040');
          assert.strictEqual(r.col3, 105);
          assert.strictEqual(r._is_new, false);
          assert.deepStrictEqual(r._changed_fields, ['col3']); // timestamp 被排除
          assert.deepStrictEqual(r._old_values, { col3: 100 });
          assert.deepStrictEqual(r._changes, { col3: 105 });
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ payload: FRAME1 });
    });
  });

  it('仅排除字段变化：输出空数组', function (done) {    startFlow({ keyField: 'equipment_id' }, function () {
      var n1 = helper.getNode('n1');
      var count = 0;
      helper.getNode('h1').on('input', function (msg) {
        count++;
        if (count === 1) {
          n1.receive({ payload: [
            { equipment_id: 'b040', col3: 100, col4: 200, timestamp: 't2' },
            { equipment_id: 'b041', col3: 150, col4: 250, timestamp: 't2' }
          ] });
          return;
        }
        try {
          assert.deepStrictEqual(msg.payload, []);
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ payload: FRAME1 });
    });
  });

  it('first_pass=drop：首帧不输出仅建基准，第二帧有变化才输出', function (done) {
    startFlow({ keyField: 'equipment_id', firstPass: 'drop' }, function () {
      var n1 = helper.getNode('n1');
      var received = [];
      helper.getNode('h1').on('input', function (msg) { received.push(msg.payload); });
      n1.receive({ payload: FRAME1 });
      setTimeout(function () {
        try {
          assert.strictEqual(received.length, 0, '首帧不应输出');
          n1.receive({ payload: [
            { equipment_id: 'b040', col3: 101, col4: 200, timestamp: 't2' },
            { equipment_id: 'b041', col3: 150, col4: 250, timestamp: 't2' }
          ] });
          setTimeout(function () {
            try {
              assert.strictEqual(received.length, 1);
              assert.strictEqual(received[0].length, 1);
              assert.strictEqual(received[0][0].equipment_id, 'b040');
              done();
            } catch (e) { done(e); }
          }, 50);
        } catch (e) { done(e); }
      }, 100);
    });
  });

  it('all_with_flag：输出全量并附 _changed 标记', function (done) {
    startFlow({ keyField: 'equipment_id', outputMode: 'all_with_flag' }, function () {
      var n1 = helper.getNode('n1');
      var count = 0;
      helper.getNode('h1').on('input', function (msg) {
        count++;
        if (count === 1) {
          n1.receive({ payload: [
            { equipment_id: 'b040', col3: 105, col4: 200, timestamp: 't2' },
            { equipment_id: 'b041', col3: 150, col4: 250, timestamp: 't2' }
          ] });
          return;
        }
        try {
          assert.strictEqual(msg.payload.length, 2);
          assert.strictEqual(msg.payload[0]._changed, true);
          assert.strictEqual(msg.payload[1]._changed, false);
          assert.deepStrictEqual(msg.payload[1]._changed_fields, []);
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ payload: FRAME1 });
    });
  });

  it('非数组输入：报错（catch 可捕获）且不发送', function (done) {
    var flow = [
      { id: 'n1', type: 'change-filter', wires: [['h1']] },
      { id: 'h1', type: 'helper' },
      { id: 'c1', type: 'catch', scope: ['n1'], wires: [['ch1']] },
      { id: 'ch1', type: 'helper' }
    ];
    helper.load(changeFilterNode, flow, function () {
      var sent = 0;
      helper.getNode('h1').on('input', function () { sent++; });
      helper.getNode('ch1').on('input', function (msg) {
        try {
          assert.ok(/必须是对象数组/.test(msg.error.message), '错误信息应说明输入类型: ' + msg.error.message);
          setTimeout(function () {
            try { assert.strictEqual(sent, 0); done(); } catch (e) { done(e); }
          }, 50);
        } catch (e) { done(e); }
      });
      helper.getNode('n1').receive({ payload: 'not-an-array' });
    });
  });

  it('缺少唯一键字段的记录跳过并 warn，其余正常', function (done) {
    startFlow({ keyField: 'equipment_id' }, function () {
      var n1 = helper.getNode('n1');
      var warns = [];
      n1.warn = function (m) { warns.push(m); };
      helper.getNode('h1').on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.length, 1);
          assert.strictEqual(msg.payload[0].equipment_id, 'b040');
          assert.strictEqual(warns.length, 1);
          assert.ok(/缺少唯一键字段/.test(warns[0]));
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ payload: [
        { equipment_id: 'b040', col3: 1 },
        { col3: 2 } // 无 equipment_id
      ] });
    });
  });

  it('新设备上线：_is_new=true 全量字段；设备离线：不报错只对比存在的记录', function (done) {
    startFlow({ keyField: 'equipment_id' }, function () {
      var n1 = helper.getNode('n1');
      var count = 0;
      helper.getNode('h1').on('input', function (msg) {
        count++;
        try {
          if (count === 1) {
            n1.receive({ payload: [
              { equipment_id: 'b040', col3: 100, timestamp: 't2' },
              { equipment_id: 'b041', col3: 150, timestamp: 't2' } // 新设备
            ] });
          } else if (count === 2) {
            assert.strictEqual(msg.payload.length, 1);
            assert.strictEqual(msg.payload[0].equipment_id, 'b041');
            assert.strictEqual(msg.payload[0]._is_new, true);
            // 第三轮 b040 离线，只发 b041 且无变化
            n1.receive({ payload: [{ equipment_id: 'b041', col3: 150, timestamp: 't3' }] });
          } else if (count === 3) {
            assert.deepStrictEqual(msg.payload, []);
            done();
          }
        } catch (e) { done(e); }
      });
      n1.receive({ payload: [{ equipment_id: 'b040', col3: 100, timestamp: 't1' }] });
    });
  });

  it('设备顺序变化不影响匹配（按唯一键，不按索引）', function (done) {
    startFlow({ keyField: 'equipment_id' }, function () {
      var n1 = helper.getNode('n1');
      var count = 0;
      helper.getNode('h1').on('input', function (msg) {
        count++;
        if (count === 1) {
          n1.receive({ payload: [
            { equipment_id: 'b041', col3: 150, col4: 250, timestamp: 't2' },
            { equipment_id: 'b040', col3: 100, col4: 200, timestamp: 't2' }
          ] });
          return;
        }
        try {
          assert.deepStrictEqual(msg.payload, []);
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ payload: FRAME1 });
    });
  });

  it('深比较：对象字段内容相同不算变化，内容不同算变化', function (done) {
    startFlow({ keyField: 'id' }, function () {
      var n1 = helper.getNode('n1');
      var count = 0;
      helper.getNode('h1').on('input', function (msg) {
        count++;
        try {
          if (count === 1) {
            n1.receive({ payload: [{ id: 'a', meta: { x: 1, y: [1, 2] } }] });
          } else if (count === 2) {
            assert.deepStrictEqual(msg.payload, []); // 内容相同 → 无变化
            n1.receive({ payload: [{ id: 'a', meta: { x: 2, y: [1, 2] } }] });
          } else if (count === 3) {
            assert.strictEqual(msg.payload.length, 1);
            assert.deepStrictEqual(msg.payload[0]._changed_fields, ['meta']);
            assert.deepStrictEqual(msg.payload[0]._old_values, { meta: { x: 1, y: [1, 2] } });
            done();
          }
        } catch (e) { done(e); }
      });
      n1.receive({ payload: [{ id: 'a', meta: { x: 1, y: [1, 2] } }] });
    });
  });

  it('死区阈值：|Δ| < 阈值不报，|Δ| ≥ 阈值才报', function (done) {
    startFlow({ keyField: 'id', threshold: 0.5 }, function () {
      var n1 = helper.getNode('n1');
      var count = 0;
      helper.getNode('h1').on('input', function (msg) {
        count++;
        try {
          if (count === 1) {
            n1.receive({ payload: [{ id: 'a', v: 100.4 }] }); // Δ=0.4 死区内
          } else if (count === 2) {
            assert.deepStrictEqual(msg.payload, []);
            n1.receive({ payload: [{ id: 'a', v: 101.0 }] }); // 对基准 100.4，Δ=0.6 超死区
          } else if (count === 3) {
            assert.strictEqual(msg.payload.length, 1);
            assert.deepStrictEqual(msg.payload[0]._old_values, { v: 100.4 });
            done();
          }
        } catch (e) { done(e); }
      });
      n1.receive({ payload: [{ id: 'a', v: 100.0 }] });
    });
  });

  it('字段类型变化（number → string）视为变化', function (done) {
    startFlow({ keyField: 'id' }, function () {
      var n1 = helper.getNode('n1');
      var count = 0;
      helper.getNode('h1').on('input', function (msg) {
        count++;
        if (count === 1) {
          n1.receive({ payload: [{ id: 'a', v: '100' }] });
          return;
        }
        try {
          assert.strictEqual(msg.payload.length, 1);
          assert.deepStrictEqual(msg.payload[0]._changed_fields, ['v']);
          assert.deepStrictEqual(msg.payload[0]._old_values, { v: 100 });
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ payload: [{ id: 'a', v: 100 }] });
    });
  });

  it('字段新增与删除都算变化，删除字段附旧值', function (done) {
    startFlow({ keyField: 'id' }, function () {
      var n1 = helper.getNode('n1');
      var count = 0;
      helper.getNode('h1').on('input', function (msg) {
        count++;
        if (count === 1) {
          n1.receive({ payload: [{ id: 'a', x: 1, z: 3 }] });
          return;
        }
        try {
          var r = msg.payload[0];
          assert.deepStrictEqual(r._changed_fields.slice().sort(), ['y', 'z']);
          assert.deepStrictEqual(r._old_values, { y: 2 });
          // _changes：删除字段值为 null（y），新增字段为新值（z），x 未变不出现
          assert.deepStrictEqual(r._changes, { z: 3, y: null });
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ payload: [{ id: 'a', x: 1, y: 2 }] });
    });
  });

  it('超时清理：超过 timeoutSec 未出现的设备基准被移除，再现时按新记录处理', function (done) {
    startFlow({ keyField: 'id', timeoutSec: 0.2 }, function () {
      var n1 = helper.getNode('n1');
      var count = 0;
      helper.getNode('h1').on('input', function (msg) {
        count++;
        if (count === 1) {
          setTimeout(function () {
            n1.receive({ payload: [{ id: 'a', v: 1 }] }); // 相同值，但基准已过期
          }, 300);
          return;
        }
        try {
          assert.strictEqual(msg.payload.length, 1);
          assert.strictEqual(msg.payload[0]._is_new, true);
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ payload: [{ id: 'a', v: 1 }] });
    });
  });
});
