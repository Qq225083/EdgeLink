'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { probeRetryGate, planRetry, resetRetry } = require('../lib/retryPolicy');

test('防重入：5s 内重复触发 skip', () => {
  const first = probeRetryGate(null, 10000);
  assert.strictEqual(first.skip, false);
  assert.strictEqual(first.state.attempt, 1);
  const second = probeRetryGate(first.state, 12000);
  assert.strictEqual(second.skip, true, '5s 内再来直接跳过');
  const third = probeRetryGate(first.state, 16000);
  assert.strictEqual(third.skip, false);
});

test('重试延迟序列：10s → 20s → 40s → 60s（封顶）', () => {
  let s = { attempt: 1, delay: undefined };
  const delays = [];
  for (let i = 0; i < 4; i++) {
    const p = planRetry(s);
    assert.strictEqual(p.exhausted, false);
    delays.push(p.delayMs);
    s = p.state;
  }
  assert.deepStrictEqual(delays, [10000, 20000, 40000, 60000]);
});

test('attempt≥5 → 120s 熔断暂停 + 暂停后重置', () => {
  const p = planRetry({ attempt: 5, delay: 60000 });
  assert.strictEqual(p.exhausted, true);
  assert.strictEqual(p.warnOnce, true, '仅第 5 次告警');
  assert.strictEqual(p.delayMs, 120000);
  assert.deepStrictEqual(p.resetAfter, { attempt: 0, delay: 10000 });
  const p2 = planRetry({ attempt: 6, delay: 120000 });
  assert.strictEqual(p2.warnOnce, false, '之后不再重复告警');
});

test('resetRetry：登录成功后回零', () => {
  assert.deepStrictEqual(resetRetry(), { attempt: 0, delay: 10000 });
});

test('现网 quirk 复刻：attempt 只增不减（成功不重置）时，后续重试都走 120s', () => {
  // 模拟现网：每次函数调用 probe+1，跑 5 次后 attempt=5，此后任何失败直接 exhausted
  let s = {};
  for (let i = 0; i < 5; i++) s = probeRetryGate(s, (i + 1) * 60000).state;
  const p = planRetry(s);
  assert.strictEqual(p.exhausted, true, 'attempt 累积到 5 后重试即熔断（现网 quirk，记录在案不修改）');
});
