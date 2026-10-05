/**
 * split_sf_config.js — sf-config-manager 子流程画布级拆分
 * 删除「IP检测+登录准备」「JWT解析+nodeId+点位发现」两个单体 function，
 * 接入 7 个小 function（保留 http request / debug 节点），重接输入/输出。
 * 用法：node v13/tools/split_sf_config.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FLOWS = 'D:/nodered/data/flows.json';
const SHELLS = path.join(__dirname, '../shells/cm');
const SF_ID = 'ef13b883a5871c8a';
const OLD_FNS = ['2c152e40b4141864', '65c1544c88d3546d'];  // step1 / step2
const HTTP_LOGIN = 'be4727a74008ff80';                    // POST /login（保留）

const read = (f) => fs.readFileSync(path.join(SHELLS, f), 'utf8');

const NEW_NODES = [
  { id: 'cm_01_lockip', name: '①锁+IP检测',     file: 'cm_01_lock_ip.js',    outputs: 1, x: 160,  y: 180, wires: [['cm_02_boot']] },
  { id: 'cm_02_boot',   name: '②复查/bootstrap', file: 'cm_02_bootstrap.js',  outputs: 1, x: 380,  y: 180, wires: [[HTTP_LOGIN]] },
  { id: 'cm_03_jwt',    name: '③JWT解析+缓存',   file: 'cm_03_jwt_cache.js',  outputs: 2, x: 880,  y: 180, wires: [['cm_04_nodeid'], ['cm_07_retry']] },
  { id: 'cm_04_nodeid', name: '④nodeId反查',     file: 'cm_04_nodeid.js',     outputs: 1, x: 1110, y: 120, wires: [['cm_05_fetch']] },
  { id: 'cm_05_fetch',  name: '⑤分页拉取点位',   file: 'cm_05_fetch_tags.js', outputs: 1, x: 1330, y: 120, wires: [['cm_06_asm']] },
  { id: 'cm_06_asm',    name: '⑥分组+输出组装',  file: 'cm_06_assemble.js',   outputs: 2, x: 1560, y: 120, wires: [[], []] },
  { id: 'cm_07_retry',  name: '⑦登录重试调度',   file: 'cm_07_retry.js',      outputs: 2, x: 1110, y: 260, wires: [['cm_04_nodeid'], ['cm_07_retry']] },
];

const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const sf = flows.find((n) => n.id === SF_ID);
if (!sf) { console.error('子流程未找到'); process.exit(1); }
const missing = OLD_FNS.filter((id) => !flows.find((n) => n.id === id));
if (missing.length) { console.error('旧单体 function 不存在（可能已拆分过？）: ' + missing, '，中止'); process.exit(1); }

const bak = FLOWS + '.bak-splitcm-' + Date.now();
fs.copyFileSync(FLOWS, bak);
console.log('备份 →', bak);

const kept = flows.filter((n) => !OLD_FNS.includes(n.id));
NEW_NODES.forEach((n) => {
  kept.push({
    id: n.id, type: 'function', name: n.name, z: SF_ID,
    func: read(n.file), outputs: n.outputs,
    noerr: 0, initialize: '', finalize: '', libs: [],
    x: n.x, y: n.y, wires: n.wires,
  });
});

sf.in = [{ wires: [{ id: 'cm_01_lockip' }] }];
sf.out = [
  { wires: [{ id: 'cm_06_asm', port: 0 }] },
  { wires: [{ id: 'cm_06_asm', port: 1 }] },
];

fs.writeFileSync(FLOWS, JSON.stringify(kept, null, 4));
console.log('拆分完成：sf-config-manager = 锁/IP → bootstrap → http登录 → JWT → nodeId → 分页 → 组装；重试自循环⑦');
console.log('新节点 ×7，旧单体 function ×2 已移除，http request 节点保留');
