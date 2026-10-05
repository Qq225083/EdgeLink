'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeQuality, applyTransform } = require('../lib/transform');

test('质量码归一：数字 0/1/其他 → GOOD/BAD/UNCERTAIN，字符串原样，缺省 GOOD', () => {
  assert.strictEqual(normalizeQuality(0), 'GOOD');
  assert.strictEqual(normalizeQuality(1), 'BAD');
  assert.strictEqual(normalizeQuality(2), 'UNCERTAIN');
  assert.strictEqual(normalizeQuality('BAD'), 'BAD');
  assert.strictEqual(normalizeQuality(undefined), 'GOOD');
});

test('linear：y=a·x+b', () => {
  const r = applyTransform(10, 'GOOD', { tform: 'linear', slope: 2, offset: 5 });
  assert.strictEqual(r.eng, 25);
  assert.strictEqual(r.quality, 'GOOD');
});

test('linear：slope=0 合法（不能用 || 兜底吃掉）', () => {
  const r = applyTransform(10, 'GOOD', { tform: 'linear', slope: 0, offset: 5 });
  assert.strictEqual(r.eng, 5);
});

test('linear：兼容旧字段名 transformSlopeA/transformOffsetB，缺省 1/0', () => {
  const r = applyTransform(10, 'GOOD', { tform: 'linear', transformSlopeA: 3 });
  assert.strictEqual(r.eng, 30);
  const d = applyTransform(10, 'GOOD', { tform: 'linear' });
  assert.strictEqual(d.eng, 10);
});

test('slope_offset：量程映射', () => {
  const r = applyTransform(50, 'GOOD', {
    tform: 'slope_offset', rawValueMin: 0, rawValueMax: 100, engValueMin: 0, engValueMax: 200,
  });
  assert.strictEqual(r.eng, 100);
});

test('slope_offset：参数缺失或 rawMin===rawMax → 原值 + UNCERTAIN', () => {
  const r1 = applyTransform(50, 'GOOD', { tform: 'slope_offset', rawValueMin: 0 });
  assert.strictEqual(r1.eng, 50);
  assert.strictEqual(r1.quality, 'UNCERTAIN');
  const r2 = applyTransform(50, 'GOOD', { tform: 'slope_offset', rawValueMin: 10, rawValueMax: 10, engValueMin: 0, engValueMax: 1 });
  assert.strictEqual(r2.eng, 50);
  assert.strictEqual(r2.quality, 'UNCERTAIN');
});

test('none/未配置变换：原值通过 + toFixed(2) 舍入', () => {
  const r = applyTransform(3.14159, 'GOOD', { tform: 'none' });
  assert.strictEqual(r.eng, 3.14);
  const r2 = applyTransform(7, 'GOOD', {});
  assert.strictEqual(r2.eng, 7);
});
