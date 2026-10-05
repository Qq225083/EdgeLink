/**
 * split_data_processor.js — 数据管道子流程画布级拆分
 * 删除 sf-data-processor 内 316 行的单体 function，接入 8 个小 function + 1 个 switch，
 * 并重接子流程输入/输出。执行前自动备份 flows.json。
 * 用法：node v13/tools/split_data_processor.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FLOWS = 'D:/nodered/data/flows.json';
const SHELLS = path.join(__dirname, '../shells/dp');
const SF_ID = '460782f9f254b482';
const OLD_FN = '67942f3272f4ef55';
const DEBUG1 = '2ad518f49b8130fb';  // Output1: MQTT
const DEBUG2 = '8b8e7d1da5129a06';  // Output2: PG

const read = (f) => fs.readFileSync(path.join(SHELLS, f), 'utf8');

const NEW_NODES = [
  { id: 'dp_01_entry',     name: '①入口·防重入',   file: 'dp_01_entry_guard.js',      outputs: 1, x: 140,  y: 180, wires: [['dp_switch']] },
  { id: 'dp_02_failstate', name: '②失败·通断状态', file: 'dp_02_fail_state.js',       outputs: 1, x: 510,  y: 100, wires: [['dp_03_failasm']] },
  { id: 'dp_03_failasm',   name: '③失败·告警+BAD', file: 'dp_03_fail_assemble.js',    outputs: 1, x: 740,  y: 100, wires: [[DEBUG1]] },
  { id: 'dp_04_okstate',   name: '④成功·通断恢复', file: 'dp_04_ok_state.js',         outputs: 1, x: 510,  y: 260, wires: [['dp_05_xform']] },
  { id: 'dp_05_xform',     name: '⑤变换+死区过滤', file: 'dp_05_transform_filter.js', outputs: 1, x: 740,  y: 260, wires: [['dp_06_calc']] },
  { id: 'dp_06_calc',      name: '⑥计算点求值',    file: 'dp_06_calc_tags.js',        outputs: 1, x: 960,  y: 260, wires: [['dp_07_merge']] },
  { id: 'dp_07_merge',     name: '⑦lastGood合并',  file: 'dp_07_merge_writeback.js',  outputs: 1, x: 1180, y: 260, wires: [['dp_08_asm']] },
  { id: 'dp_08_asm',       name: '⑧输出组装',      file: 'dp_08_assemble.js',         outputs: 2, x: 1400, y: 260, wires: [[DEBUG1], [DEBUG2]] },
];

const SWITCH_NODE = {
  id: 'dp_switch', type: 'switch', name: 'success?', z: SF_ID,
  property: 'payload.success', propertyType: 'msg',
  rules: [{ t: 'true' }, { t: 'false' }],
  checkall: 'true', repair: false, outputs: 2,
  x: 320, y: 180, wires: [['dp_02_failstate'], ['dp_04_okstate']],
};

const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const sf = flows.find((n) => n.id === SF_ID);
if (!sf) { console.error('子流程未找到'); process.exit(1); }
if (!flows.find((n) => n.id === OLD_FN)) { console.error('旧单体 function 不存在（可能已拆分过？），中止'); process.exit(1); }

// 备份
const bak = FLOWS + '.bak-splitdp-' + Date.now();
fs.copyFileSync(FLOWS, bak);
console.log('备份 →', bak);

// 1) 移除旧单体 function
const kept = flows.filter((n) => n.id !== OLD_FN);

// 2) 追加新节点
NEW_NODES.forEach((n) => {
  kept.push({
    id: n.id, type: 'function', name: n.name, z: SF_ID,
    func: read(n.file), outputs: n.outputs,
    noerr: 0, initialize: '', finalize: '', libs: [],
    x: n.x, y: n.y, wires: n.wires,
  });
});
kept.push(SWITCH_NODE);

// 3) 重接子流程输入/输出
sf.in = [{ wires: [{ id: 'dp_01_entry' }] }];
sf.out = [
  { wires: [{ id: 'dp_03_failasm', port: 0 }, { id: 'dp_08_asm', port: 0 }] },
  { wires: [{ id: 'dp_08_asm', port: 1 }] },
];

fs.writeFileSync(FLOWS, JSON.stringify(kept, null, 4));
console.log('拆分完成：sf-data-processor = 入口 → switch → 失败(②③) / 成功(④⑤⑥⑦⑧)');
console.log('新节点 ×9，旧单体 function 已移除');
