/**
 * patch_sf_config_step2.js — 把 v13/shells/config_fetch_step2.js 写入 flows.json
 * 中 sf-config-manager 子流程的「JWT解析 + nodeId + 点位发现」function。
 * 用法：node v13/tools/patch_sf_config_step2.js [--verify-only]
 */
'use strict';
const fs = require('fs');

const FLOWS = 'D:/nodered/data/flows.json';
const SHELL = __dirname + '/../shells/config_fetch_step2.js';
const TARGET = { z: 'ef13b883a5871c8a', type: 'function', name: 'JWT解析 + nodeId + 点位发现' };

const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const hits = flows.filter((n) => n.z === TARGET.z && n.type === TARGET.type && n.name === TARGET.name);
if (hits.length !== 1) {
  console.error('目标节点匹配数=' + hits.length + '（应为1），中止');
  process.exit(1);
}

const shellSrc = fs.readFileSync(SHELL, 'utf8');
if (process.argv.includes('--verify-only')) {
  console.log('当前 func 行数:', hits[0].func.split('\n').length);
  console.log('已是 V13 壳:', hits[0].func.includes('edgeCore'));
  process.exit(0);
}

hits[0].func = shellSrc;
fs.writeFileSync(FLOWS, JSON.stringify(flows, null, 4));
console.log('已写入 flows.json：sf-config-manager / JWT解析+nodeId+点位发现 →', shellSrc.split('\n').length, '行（原 535 行）');
