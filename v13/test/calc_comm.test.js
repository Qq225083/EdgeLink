'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { evalCalcTags } = require('../lib/calcTags');
const { onFail, onSuccess, shouldSendBad } = require('../lib/commState');

const NOW = Date.now();
const NOWISO = new Date(NOW).toISOString();

function base(over) {
  return Object.assign({
    tagValues: [], prevGood: [], lastCalc: {}, triggerKind: 1,
    nowMs: NOW, now: NOWISO, nodeId: 66, devId: 7, devName: 'PLC-A', hostPcIp: '10.0.0.1:1880',
  }, over);
}

test('calc sum/avg/min/max', () => {
  const tv = [{ tag_id: 1, eng_value: 10, quality: 'GOOD' }, { tag_id: 2, eng_value: 20, quality: 'GOOD' }];
  const mk = (op) => evalCalcTags([{ id: 100, name: 'c', calcOp: op, sourceIds: [1, 2] }], base({ tagValues: tv })).values[0];
  assert.strictEqual(mk('sum').eng_value, 30);
  assert.strictEqual(mk('avg').eng_value, 15);
  assert.strictEqual(mk('min').eng_value, 10);
  assert.strictEqual(mk('max').eng_value, 20);
  assert.strictEqual(mk('').eng_value, 30, '缺省按 sum');
});

test('来源优先本轮采集值，缺则回退 lastGood', () => {
  const out = evalCalcTags(
    [{ id: 100, name: 'c', calcOp: 'sum', sourceIds: [1, 2] }],
    base({
      tagValues: [{ tag_id: 1, eng_value: 10, quality: 'GOOD' }],
      prevGood: [{ tag_id: 2, eng_value: 5, quality: 'GOOD' }],
    })
  );
  assert.strictEqual(out.values[0].eng_value, 15);
  assert.strictEqual(out.values[0].quality, 'GOOD');
});

test('所有来源从未有值 → 跳过不产出', () => {
  const out = evalCalcTags([{ id: 100, name: 'c', calcOp: 'sum', sourceIds: [1, 2] }], base({}));
  assert.strictEqual(out.values.length, 0);
  assert.strictEqual(out.pgRecords.length, 0);
});

test('来源质量非 GOOD 或来源数不足 → UNCERTAIN', () => {
  const stale = evalCalcTags(
    [{ id: 100, name: 'c', calcOp: 'sum', sourceIds: [1, 2] }],
    base({
      tagValues: [{ tag_id: 1, eng_value: 10, quality: 'GOOD' }],
      prevGood: [{ tag_id: 2, eng_value: 5, quality: 'UNCERTAIN' }],
    })
  );
  assert.strictEqual(stale.values[0].quality, 'UNCERTAIN');
  const partial = evalCalcTags(
    [{ id: 100, name: 'c', calcOp: 'sum', sourceIds: [1, 2] }],
    base({ tagValues: [{ tag_id: 1, eng_value: 10, quality: 'GOOD' }] })
  );
  assert.strictEqual(partial.values[0].quality, 'UNCERTAIN', '只有一个来源有值 → UNCERTAIN');
});

test('变化触发（triggerKind=2）：计算值未变 → 跳过且不更新 lastCalc', () => {
  const lastCalc = { 100: 50, '100_ts': NOW - 1000 };
  const out = evalCalcTags(
    [{ id: 100, name: 'c', calcOp: 'sum', sourceIds: [1] }],
    base({ tagValues: [{ tag_id: 1, eng_value: 50, quality: 'GOOD' }], lastCalc, triggerKind: 2 })
  );
  assert.strictEqual(out.values.length, 0);
  assert.strictEqual(out.skipped, 1);
  assert.strictEqual(out.lastCalc['100_ts'], NOW - 1000, '被过滤的点不更新 lastCalc');
});

test('死区：差值在死区内且未到强制周期 → 跳过；超周期 → 上报并更新 lastCalc', () => {
  const ct = { id: 100, name: 'c', calcOp: 'sum', sourceIds: [1], deadband: 5, reportForceIntervalMs: 5000 };
  const inDeadband = evalCalcTags([ct], base({
    tagValues: [{ tag_id: 1, eng_value: 12, quality: 'GOOD' }],
    lastCalc: { 100: 10, '100_ts': NOW - 1000 },
  }));
  assert.strictEqual(inDeadband.values.length, 0);
  const forced = evalCalcTags([ct], base({
    tagValues: [{ tag_id: 1, eng_value: 12, quality: 'GOOD' }],
    lastCalc: { 100: 10, '100_ts': NOW - 6000 },
  }));
  assert.strictEqual(forced.values.length, 1);
  assert.strictEqual(forced.lastCalc[100], 12);
  assert.strictEqual(forced.lastCalc['100_ts'], NOW);
});

test('产出形状：tag_address/register_type=CALC，pg 记录同形', () => {
  const out = evalCalcTags([{ id: 100, name: 'c', calcOp: 'sum', sourceIds: [1] }], base({
    tagValues: [{ tag_id: 1, eng_value: 8, quality: 'GOOD' }],
  }));
  const v = out.values[0];
  assert.strictEqual(v.tag_address, 'CALC');
  assert.strictEqual(v.register_type, 'CALC');
  assert.strictEqual(out.pgRecords[0].node_id, 66);
  assert.strictEqual(out.pgRecords[0].tag_id, 100);
});

test('commState.onFail：首次失败产生离线事件，持续失败不重复', () => {
  const first = onFail({ consecutiveFails: 0, lastState: 'online' }, NOW);
  assert.strictEqual(first.becameOffline, true);
  assert.strictEqual(first.status.consecutiveFails, 1);
  assert.strictEqual(first.status.lastState, 'offline');
  const second = onFail(first.status, NOW + 1000);
  assert.strictEqual(second.becameOffline, false);
  assert.strictEqual(second.status.consecutiveFails, 2);
});

test('commState.onSuccess：offline→online 产生恢复事件，online→online 不产生', () => {
  assert.strictEqual(onSuccess({ lastState: 'offline' }, NOW).recovered, true);
  assert.strictEqual(onSuccess({ lastState: 'online' }, NOW).recovered, false);
  assert.strictEqual(onSuccess({ lastState: 'offline' }, NOW).status.consecutiveFails, 0);
});

test('commState.shouldSendBad：30s 节流', () => {
  assert.strictEqual(shouldSendBad(undefined, NOW), true);
  assert.strictEqual(shouldSendBad(NOW - 10000, NOW), false);
  assert.strictEqual(shouldSendBad(NOW - 31000, NOW), true);
});
