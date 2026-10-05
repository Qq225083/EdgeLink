/**
 * patch_sf_monitor.js — 把 v13/shells/heartbeat_sf_monitor.js 写入 D:\nodered\data\flows.json
 * 中 sf-monitor 子流程的「心跳 + 批量上报」function（替换 .func，其余字段不动）。
 * 用法：node v13/tools/patch_sf_monitor.js [--verify-only]
 */
'use strict';
const fs = require('fs');

const FLOWS = 'D:/nodered/data/flows.json';
const SHELL = __dirname + '/../shells/heartbeat_sf_monitor.js';
const TARGET = { z: 'sf-monitor', type: 'function', name: '心跳 + 批量上报' };

const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const hits = flows.filter((n) => n.z === TARGET.z && n.type === TARGET.type && n.name === TARGET.name);
if (hits.length !== 1) {
  console.error('目标节点匹配数=' + hits.length + '（应为1），中止');
  process.exit(1);
}

const shellSrc = fs.readFileSync(SHELL, 'utf8');
const verifyOnly = process.argv.includes('--verify-only');

if (verifyOnly) {
  console.log('当前 func 行数:', hits[0].func.split('\n').length);
  console.log('已是 V13 壳:', hits[0].func.includes('edgeCore'));
  process.exit(0);
}

hits[0].func = shellSrc;
fs.writeFileSync(FLOWS, JSON.stringify(flows, null, 4));
console.log('已写入 flows.json：sf-monitor / 心跳 + 批量上报 →', shellSrc.split('\n').length, '行（原 252 行）');
