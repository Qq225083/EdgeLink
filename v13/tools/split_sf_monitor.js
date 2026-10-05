/**
 * split_sf_monitor.js — sf-monitor 子流程画布级拆分
 * 删除「心跳 + 批量上报」单体 function，接入 6 个小 function，重接输入/输出。
 * 用法：node v13/tools/split_sf_monitor.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FLOWS = 'D:/nodered/data/flows.json';
const SHELLS = path.join(__dirname, '../shells/mon');
const SF_ID = 'sf-monitor';
const OLD_FN = 'sf-mon-fn-heartbeat';

const read = (f) => fs.readFileSync(path.join(SHELLS, f), 'utf8');

const NEW_NODES = [
  { id: 'mon_01_state', name: '①监控·取态',      file: 'mon_01_state.js',     outputs: 2, x: 140,  y: 170, wires: [['mon_02_mqtt'], ['mon_03_hb']] },
  { id: 'mon_02_mqtt',  name: '②MQTT心跳组装',   file: 'mon_02_mqtt.js',      outputs: 1, x: 400,  y: 90,  wires: [[]] },
  { id: 'mon_03_hb',    name: '③HTTP心跳',       file: 'mon_03_heartbeat.js', outputs: 2, x: 400,  y: 240, wires: [['mon_04_dev'], []] },
  { id: 'mon_04_dev',   name: '④逐台在线上报',   file: 'mon_04_devonline.js', outputs: 1, x: 650,  y: 240, wires: [['mon_05_comm']] },
  { id: 'mon_05_comm',  name: '⑤comm事件消费',   file: 'mon_05_comm.js',      outputs: 2, x: 900,  y: 240, wires: [['mon_06_pg'], []] },
  { id: 'mon_06_pg',    name: '⑥PG统计上报',     file: 'mon_06_pgstats.js',   outputs: 2, x: 1150, y: 240, wires: [[], []] },
];

const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const sf = flows.find((n) => n.id === SF_ID);
if (!sf) { console.error('子流程未找到'); process.exit(1); }
if (!flows.find((n) => n.id === OLD_FN)) { console.error('旧单体 function 不存在（可能已拆分过？），中止'); process.exit(1); }

const bak = FLOWS + '.bak-splitmon-' + Date.now();
fs.copyFileSync(FLOWS, bak);
console.log('备份 →', bak);

const kept = flows.filter((n) => n.id !== OLD_FN);
NEW_NODES.forEach((n) => {
  kept.push({
    id: n.id, type: 'function', name: n.name, z: SF_ID,
    func: read(n.file), outputs: n.outputs,
    noerr: 0, initialize: '', finalize: '', libs: [],
    x: n.x, y: n.y, wires: n.wires,
  });
});

sf.in = [{ wires: [{ id: 'mon_01_state' }] }];
sf.out = [
  { wires: [{ id: 'mon_02_mqtt', port: 0 }] },
  { wires: [{ id: 'mon_03_hb', port: 1 }, { id: 'mon_05_comm', port: 1 }, { id: 'mon_06_pg', port: 1 }] },
];

fs.writeFileSync(FLOWS, JSON.stringify(kept, null, 4));
console.log('拆分完成：sf-monitor = 取态 → MQTT组装 / HTTP心跳 → 逐台上报 → comm消费 → PG统计');
console.log('reauth 出口改为 ③⑤⑥ 各自检测 401、按周期去重后直发（替代原 pendingOps 合并发送）');
