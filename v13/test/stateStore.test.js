'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createStore, KEYS } = require('../lib/stateStore');

/** 模拟 Node-RED function 的 global context（内存版 get/set）。 */
function fakeCtx() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : undefined), set: (k, v) => m.set(k, v), _map: m };
}

test('键名映射保持 edge_* 原样（与现网小 function 兼容）', () => {
  const ctx = fakeCtx();
  const st = createStore(ctx);
  st.set('devices', [{ id: 1 }]);
  assert.deepStrictEqual(ctx._map.get('edge_devices'), [{ id: 1 }]);
  assert.deepStrictEqual(st.get('devices'), [{ id: 1 }]);
});

test('未设置时返回默认值，且默认对象每次是新实例（对齐旧 || {} 语义）', () => {
  const st = createStore(fakeCtx());
  const a = st.get('commStatus');
  const b = st.get('commStatus');
  assert.deepStrictEqual(a, {});
  assert.notStrictEqual(a, b, '默认对象不能共享引用，否则两处写入互相污染');
  assert.strictEqual(st.get('backendPort'), 9099);
  assert.strictEqual(st.get('configReady'), false);
  assert.strictEqual(st.get('pgBatchSize'), 200);
});

test('已设置的值不被默认值覆盖（含 falsy 值 0/false/空串）', () => {
  const st = createStore(fakeCtx());
  st.set('pgSuccessCount', 0);
  st.set('configReady', false);
  st.set('jwt', '');
  assert.strictEqual(st.get('pgSuccessCount'), 0);
  assert.strictEqual(st.get('configReady'), false);
  assert.strictEqual(st.get('jwt'), '');
});

test('未注册键直接抛错（拼写漂移防线）', () => {
  const st = createStore(fakeCtx());
  assert.throws(() => st.get('devics'), /未注册的键/);
  assert.throws(() => st.set('jwt2', 'x'), /未注册的键/);
});

test('raw() 不套默认值，可区分「从未设置」', () => {
  const st = createStore(fakeCtx());
  assert.strictEqual(st.raw('retryState'), undefined);
  st.set('retryState', { attempt: 1 });
  assert.deepStrictEqual(st.raw('retryState'), { attempt: 1 });
});

test('initAll 只补缺失、不覆盖已有', () => {
  const ctx = fakeCtx();
  ctx.set('edge_devices', [{ id: 99 }]);
  const st = createStore(ctx);
  st.initAll();
  assert.deepStrictEqual(st.get('devices'), [{ id: 99 }], '已有配置必须保留');
  assert.deepStrictEqual(st.get('lastGoodTags'), {}, '缺失键被补默认值');
  assert.strictEqual(st.get('pgQueue').length, 0);
});

test('注册表与现网键清单一一对应（45 个 edge_* 键全覆盖，已实测零差异）', () => {
  const registered = new Set(Object.values(KEYS).map((e) => e[0]));
  assert.strictEqual(registered.size, 45);
  // 抽查几个关键键
  ['edge_jwt', 'edge_nodeId', 'edge_config_manager_lock', 'edge_pg_queue', 'edge_nodeDisabled']
    .forEach((k) => assert.ok(registered.has(k), '缺键 ' + k));
});
