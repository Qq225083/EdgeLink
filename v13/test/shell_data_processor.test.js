/**
 * shell_data_processor.test.js — sf-data-processor「数据管道处理」V13 壳的分支验收
 * vm 沙箱加载壳源码，fake global/node，逐分支断言 send 槽位 / status / 状态写回。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const SHELL = fs.readFileSync(path.join(__dirname, '../shells/data_processor_sf.js'), 'utf8');
const core = require('../lib');

function makeCtx(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { get: (k) => (m.has(k) ? m.get(k) : undefined), set: (k, v) => m.set(k, v), _map: m };
}

function makeNode() {
  return {
    id: 'dp-test', sends: [], statuses: [], warns: [], errors: [],
    send(...args) { this.sends.push(args.length === 1 ? args[0] : args); },
    status(s) { this.statuses.push(s); },
    warn(m) { this.warns.push(String(m)); },
    error(m) { this.errors.push(String(m)); },
  };
}

/** 基础现场：设备 7，点位 101（linear ×2）/ 102（死区5），计算点 200=avg(101,102) */
function baseCtx(nowMs, over) {
  return makeCtx(Object.assign({
    edgeCore: core,
    edge_debug: false,
    edge_nodeId: 66,
    edge_hostPcIp: '192.168.0.179:1880',
    edge_devices: [{
      id: 7, deviceName: 'PLC-A', triggerKind: 1,
      calcTags: [{ id: 200, name: '均值', calcOp: 'avg', sourceIds: [101, 102] }],
    }],
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
    edge_historyData: {},
    edge_commStatus: {},
    edge_commPending: [],
    edge_lastBadSend: {},
    edge_lastCalc: {},
    edge_proc_guard: {},
  }, over));
}

function runShell(ctx, node, payload) {
  const sandbox = {
    global: ctx, node, msg: { payload }, env: { get: () => undefined },
    setTimeout, clearTimeout, JSON, Date, Math, console,
  };
  vm.createContext(sandbox);
  vm.runInContext('(function () {\n' + SHELL + '\n})()', sandbox, { timeout: 5000 });
}

const okPayload = {
  success: true, deviceId: 7, deviceName: 'PLC-A',
  data: { 101: { rawValue: 20, quality: 0 }, 102: { rawValue: 50.5, quality: 0 } },
};

test('成功路径：变换/死区/计算点/合并/双输出槽位全对齐', () => {
  const nowMs = Date.now();
  const ctx = baseCtx(nowMs);
  const node = makeNode();
  runShell(ctx, node, okPayload);

  assert.strictEqual(node.sends.length, 1);
  const out = node.sends[0];
  assert.ok(Array.isArray(out) && out.length === 2, '二输出数组');

  // 输出1：MQTT 数据（101 上报 + 102 死区跳过 + 计算点 avg=45）
  const mqtt = JSON.parse(out[0].payload);
  assert.strictEqual(out[0].topic, 'edgelink/data/66/7');
  assert.strictEqual(mqtt.value_count, 2, '101 + 计算点，102 被死区跳过');
  const t101 = mqtt.values.find((v) => v.tag_id === 101);
  assert.strictEqual(t101.eng_value, 40, 'linear: 20*2+0=40');
  assert.strictEqual(t101.quality, 'GOOD');
  const calc = mqtt.values.find((v) => v.tag_id === 200);
  assert.strictEqual(calc.eng_value, 45, 'avg(40, lastGood50)=45');
  assert.strictEqual(calc.register_type, 'CALC');

  // 输出2：PG 记录同数
  assert.strictEqual(out[1].payload.pgRecords.length, 2);

  // lastGood 合并：101 刷新 GOOD，102 未上报被标 UNCERTAIN
  const lg = JSON.parse(JSON.stringify(ctx.get('edge_lastGoodTags')['7']));
  assert.strictEqual(lg.find((v) => v.tag_id === 101).quality, 'GOOD');
  assert.strictEqual(lg.find((v) => v.tag_id === 102).quality, 'UNCERTAIN');

  // 历史缓存写入
  assert.strictEqual(ctx.get('edge_historyData')['7']['101'].length, 1);
  // commStatus 成功复位
  assert.strictEqual(ctx.get('edge_commStatus')['7'].lastState, 'online');
  // guard 释放
  assert.deepStrictEqual(JSON.stringify(ctx.get('edge_proc_guard')), '{}');
});

test('首次失败：离线事件 + PLC_OFFLINE 告警 + lastGood BAD 重发（数组扇出到输出1）', () => {
  const ctx = baseCtx(Date.now());
  const node = makeNode();
  runShell(ctx, node, { success: false, deviceId: 7, deviceName: 'PLC-A', error: 'timeout' });

  const out = node.sends[0];
  const arr = out[0];
  assert.ok(Array.isArray(arr), '输出1 是多消息数组');
  assert.strictEqual(arr.length, 2, '告警 + BAD 重发');
  assert.strictEqual(arr[0].topic, 'edgelink/alarm/plc_offline/7');
  assert.strictEqual(JSON.parse(arr[0].payload).alert_type, 'PLC_OFFLINE');
  assert.strictEqual(arr[1].topic, 'edgelink/data/66/7');
  assert.strictEqual(JSON.parse(arr[1].payload).quality, 'BAD');
  assert.strictEqual(out[1], null, '输出2 恒 null');

  assert.strictEqual(ctx.get('edge_commStatus')['7'].lastState, 'offline');
  assert.strictEqual(ctx.get('edge_commPending').length, 1);
  assert.strictEqual(ctx.get('edge_recentAlerts').length, 1);
  assert.ok(node.statuses.some((s) => s.fill === 'red' && s.text === 'PLC-A OFFLINE'));
});

test('连续失败（已 offline）：不再发告警/事件，BAD 重发被 30s 节流', () => {
  const nowMs = Date.now();
  const ctx = baseCtx(nowMs, {
    edge_commStatus: { 7: { consecutiveFails: 1, lastState: 'offline', lastFailTime: nowMs - 1000 } },
    edge_lastBadSend: { 7: nowMs - 5000 },
  });
  const node = makeNode();
  runShell(ctx, node, { success: false, deviceId: 7, deviceName: 'PLC-A', error: 'timeout' });

  const out = node.sends[0];
  assert.strictEqual(out[0], null, '无新事件无 BAD 重发时输出1 为 null');
  assert.strictEqual(ctx.get('edge_commPending').length, 0, '持续失败不重复入队');
  assert.strictEqual(ctx.get('edge_commStatus')['7'].consecutiveFails, 2);
});

test('离线→恢复：commPending 记恢复事件', () => {
  const ctx = baseCtx(Date.now(), {
    edge_commStatus: { 7: { consecutiveFails: 3, lastState: 'offline' } },
  });
  const node = makeNode();
  runShell(ctx, node, okPayload);
  const pending = JSON.parse(JSON.stringify(ctx.get('edge_commPending')));
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].success, true);
});

test('缺读点位 → UNCERTAIN 占位且不计入 validCount', () => {
  const ctx = baseCtx(Date.now());
  const node = makeNode();
  runShell(ctx, node, { success: true, deviceId: 7, deviceName: 'PLC-A', data: { 101: { rawValue: 20, quality: 0 } } });

  const mqtt = JSON.parse(node.sends[0][0].payload);
  const t102 = mqtt.values.find((v) => v.tag_id === 102);
  assert.strictEqual(t102.quality, 'UNCERTAIN');
  assert.strictEqual(t102.eng_value, null);
  // 计算点：102 回退 lastGood=50 → avg(40,50)=45
  assert.strictEqual(mqtt.values.find((v) => v.tag_id === 200).eng_value, 45);
});

test('procGuard 锁定：直接丢弃不发送', () => {
  const ctx = baseCtx(Date.now(), { edge_proc_guard: { 7: { ts: Date.now() } } });
  const node = makeNode();
  runShell(ctx, node, okPayload);
  assert.strictEqual(node.sends.length, 0);
});

test('procGuard 过期锁（>30s）：强制释放后正常处理', () => {
  const ctx = baseCtx(Date.now(), { edge_proc_guard: { 7: { ts: Date.now() - 31000 } } });
  const node = makeNode();
  runShell(ctx, node, okPayload);
  assert.strictEqual(node.sends.length, 1);
});

test('msg.payload 为空：发送 [null, null]', () => {
  const ctx = baseCtx(Date.now());
  const node = makeNode();
  runShell(ctx, node, null);
  assert.strictEqual(JSON.stringify(node.sends[0]), JSON.stringify([null, null]));
});
