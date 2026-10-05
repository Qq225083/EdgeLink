'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { shouldReport } = require('../lib/reportFilter');

const NOW = Date.now();

test('无上次值（首报）一律上报', () => {
  assert.strictEqual(shouldReport({ prev: null, eng: 1, deadband: 100, nowMs: NOW }), true);
});

test('变化触发（triggerKind=2）：差值 < 0.0001 跳过，否则上报', () => {
  const prev = { eng_value: 10, ts: new Date(NOW - 60000).toISOString() };
  assert.strictEqual(shouldReport({ prev, eng: 10.00001, triggerKind: 2, nowMs: NOW }), false);
  assert.strictEqual(shouldReport({ prev, eng: 10.001, triggerKind: 2, nowMs: NOW }), true);
});

test('数值死区：死区内且未到强制周期 → 跳过', () => {
  const prev = { eng_value: 100, ts: new Date(NOW - 1000).toISOString() };
  assert.strictEqual(
    shouldReport({ prev, eng: 100.5, deadband: 1, forceIntervalMs: 5000, nowMs: NOW }),
    false
  );
});

test('数值死区：死区内但超过强制周期 → 上报（兜底刷新）', () => {
  const prev = { eng_value: 100, ts: new Date(NOW - 6000).toISOString() };
  assert.strictEqual(
    shouldReport({ prev, eng: 100.5, deadband: 1, forceIntervalMs: 5000, nowMs: NOW }),
    true
  );
});

test('数值死区：超出死区 → 上报', () => {
  const prev = { eng_value: 100, ts: new Date(NOW - 1000).toISOString() };
  assert.strictEqual(
    shouldReport({ prev, eng: 102, deadband: 1, forceIntervalMs: 5000, nowMs: NOW }),
    true
  );
});

test('deadband=0：死区不生效', () => {
  const prev = { eng_value: 100, ts: new Date(NOW - 1000).toISOString() };
  assert.strictEqual(shouldReport({ prev, eng: 100.0001, deadband: 0, nowMs: NOW }), true);
});

test('prev.ts 缺失/异常不崩（按 0 处理）', () => {
  const prev = { eng_value: 100, ts: null };
  assert.strictEqual(shouldReport({ prev, eng: 100, deadband: 1, forceIntervalMs: 5000, nowMs: NOW }), true);
});
