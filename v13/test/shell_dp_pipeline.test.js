/**
 * shell_dp_pipeline.test.js — 数据管道画布级拆分的链路集成测试
 * 模拟接线顺序逐节点执行 8 个小壳（共享 global ctx），断言与旧单体等价的行为。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const core = require('../lib');
const DIR = path.join(__dirname, '../shells/dp');
const S = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const NODES = {
  entry: S('dp_01_entry_guard.js'),
  failState: S('dp_02_fail_state.js'),
  failAsm: S('dp_03_fail_assemble.js'),
  okState: S('dp_04_ok_state.js'),
  xform: S('dp_05_transform_filter.js'),
  calc: S('dp_06_calc_tags.js'),
  merge: S('dp_07_merge_writeback.js'),
  asm: S('dp_08_assemble.js'),
};

function makeCtx(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { get: (k) => (m.has(k) ? m.get(k) : undefined), set: (k, v) => m.set(k, v), _map: m };
}

function makeNode(name) {
  return {
    id: name, name, sends: [], statuses: [], warns: [], errors: [],
    send(...a) { this.sends.push(a.length === 1 ? a[0] : a); },
    status(s) { this.statuses.push(s); },
    warn(m) { this.warns.push(String(m)); },
    error(m) { this.errors.push(String(m)); },
  };
}

/** 在共享 ctx 的 vm 沙箱中跑单个节点壳；返回 { ret, node } */
function runNode(src, ctx, msg, name) {
  const node = makeNode(name);
  const sandbox = { global: ctx, node, msg, env: { get: () => undefined }, setTimeout, clearTimeout, JSON, Date, Math, console };
  vm.createContext(sandbox);
  const ret = vm.runInContext('(function () {\n' + src + '\n})()', sandbox, { timeout: 5000 });
  return { ret, node };
}

function baseCtx(nowMs, over) {
  return makeCtx(Object.assign({
    edgeCore: core, edge_debug: false, edge_nodeId: 66, edge_hostPcIp: '192.168.0.179:1880',
    edge_devices: [{ id: 7, deviceName: 'PLC-A', triggerKind: 1, calcTags: [{ id: 200, name: '均值', calcOp: 'avg', sourceIds: [101, 102] }] }],
    edge_tagConfigs: {
      7: [
        { id: 101, regAddr: 'D0', regType: 'D', name: '温度', tform: 'linear', slope: 2, offset: 0, deadband: 0 },
        { id: 102, regAddr: 'D1', regType: 'D', name: '压力', deadband: 5, reportForceIntervalMs: 5000 },
      ],
    },
    edge_lastGoodTags: {
      7: [
        { tag_id: 101, tag_address: 'D0', tag_name: '温度', raw_value: 10, eng_value: 20, unit: '', quality: 'GOOD', ts: new Date(nowMs - 60000).toISOString() },
        { tag_id: 102, tag_address: 'D1', tag_name: '压力', raw_value: 50, eng_value: 50, unit: '', quality: 'GOOD', ts: new Date(nowMs - 1000).toISOString() },
      ],
    },
    edge_historyData: {}, edge_commStatus: {}, edge_commPending: [],
    edge_lastBadSend: {}, edge_lastCalc: {}, edge_proc_guard: {}, edge_recentAlerts: [],
  }, over));
}

const OK_PAYLOAD = { success: true, deviceId: 7, deviceName: 'PLC-A', data: { 101: { rawValue: 20, quality: 0 }, 102: { rawValue: 50.5, quality: 0 } } };

/** 跑成功链路：entry → okState → xform → calc → merge → asm */
function runOkChain(ctx, payload) {
  const msg = { payload };
  let r = runNode(NODES.entry, ctx, msg, 'entry');
  if (!r.ret) return { dropped: true, nodes: [r.node] };
  const nodes = [r.node];
  for (const k of ['okState', 'xform', 'calc', 'merge', 'asm']) {
    r = runNode(NODES[k], ctx, msg, k);
    nodes.push(r.node);
  }
  return { dropped: false, nodes, final: nodes[nodes.length - 1] };
}

test('成功链路全通：数值与旧单体一致（101 变换×2、102 死区跳过、avg 计算点 45）', () => {
  const nowMs = Date.now();
  const ctx = baseCtx(nowMs);
  const { nodes, final } = runOkChain(ctx, OK_PAYLOAD);

  const send = final.sends[0];
  const mqtt = JSON.parse(send[0].payload);
  assert.strictEqual(send[0].topic, 'edgelink/data/66/7');
  assert.strictEqual(mqtt.value_count, 2);
  assert.strictEqual(mqtt.values.find((v) => v.tag_id === 101).eng_value, 40);
  assert.strictEqual(mqtt.values.find((v) => v.tag_id === 200).eng_value, 45);
  assert.strictEqual(send[1].payload.pgRecords.length, 2);

  // lastGood：101 新 GOOD，102 标 UNCERTAIN
  const lg = ctx.get('edge_lastGoodTags')['7'];
  assert.strictEqual(lg.find((v) => v.tag_id === 101).quality, 'GOOD');
  assert.strictEqual(lg.find((v) => v.tag_id === 102).quality, 'UNCERTAIN');
  // guard 已释放
  assert.deepStrictEqual(JSON.stringify(ctx.get('edge_proc_guard')), '{}');
  // 每个节点都亮了 status（可观测性）
  assert.ok(nodes.every((n) => n.statuses.length > 0), '每个节点都应有 status');
});

test('失败链路：告警 + BAD 重发逐条扇出，guard 释放', () => {
  const nowMs = Date.now();
  const ctx = baseCtx(nowMs);
  const msg = { payload: { success: false, deviceId: 7, deviceName: 'PLC-A', error: 'timeout' } };
  let r = runNode(NODES.entry, ctx, msg, 'entry');
  assert.ok(r.ret);
  r = runNode(NODES.failState, ctx, msg, 'failState');
  r = runNode(NODES.failAsm, ctx, msg, 'failAsm');
  const out = r.ret;
  assert.ok(Array.isArray(out) && Array.isArray(out[0]), '单口返回 [msgs数组]');
  assert.strictEqual(out[0].length, 2);
  assert.strictEqual(out[0][0].topic, 'edgelink/alarm/plc_offline/7');
  assert.strictEqual(JSON.parse(out[0][1].payload).quality, 'BAD');
  assert.strictEqual(ctx.get('edge_commStatus')['7'].lastState, 'offline');
  assert.deepStrictEqual(JSON.stringify(ctx.get('edge_proc_guard')), '{}');
});

test('连续失败：无新告警（仅跳变发事件）', () => {
  const nowMs = Date.now();
  const ctx = baseCtx(nowMs, { edge_commStatus: { 7: { consecutiveFails: 1, lastState: 'offline', lastFailTime: nowMs - 1000 } }, edge_lastBadSend: { 7: nowMs - 5000 } });
  const msg = { payload: { success: false, deviceId: 7, deviceName: 'PLC-A', error: 'timeout' } };
  let r = runNode(NODES.entry, ctx, msg, 'entry');
  r = runNode(NODES.failState, ctx, msg, 'failState');
  r = runNode(NODES.failAsm, ctx, msg, 'failAsm');
  assert.strictEqual(r.ret, null, '无告警无 BAD 时不发送');
  assert.strictEqual(ctx.get('edge_commPending').length, 0);
});

test('guard：锁定期间重复进入被丢弃', () => {
  const ctx = baseCtx(Date.now());
  runOkChain(ctx, OK_PAYLOAD);
  const second = runNode(NODES.entry, ctx, { payload: OK_PAYLOAD }, 'entry2');
  // 第一次已释放 guard，应能正常进入；再试锁定场景
  const ctx2 = baseCtx(Date.now(), { edge_proc_guard: { 7: { ts: Date.now() } } });
  const locked = runNode(NODES.entry, ctx2, { payload: OK_PAYLOAD }, 'entry3');
  assert.strictEqual(locked.ret, null);
  assert.ok(locked.node.statuses.some((s) => s.fill === 'yellow'));
});

test('离线→恢复链路：恢复事件入 commPending', () => {
  const nowMs = Date.now();
  const ctx = baseCtx(nowMs, { edge_commStatus: { 7: { consecutiveFails: 2, lastState: 'offline' } } });
  runOkChain(ctx, OK_PAYLOAD);
  const pending = JSON.parse(JSON.stringify(ctx.get('edge_commPending')));
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].success, true);
});
