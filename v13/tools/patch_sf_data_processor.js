/**
 * patch_sf_data_processor.js — 把 v13/shells/data_processor_sf.js 写入 flows.json
 * 中 sf-data-processor 子流程的「数据管道处理」function。
 * 用法：node v13/tools/patch_sf_data_processor.js [--verify-only]
 */
'use strict';
const fs = require('fs');

const FLOWS = 'D:/nodered/data/flows.json';
const SHELL = __dirname + '/../shells/data_processor_sf.js';
const TARGET = { z: '460782f9f254b482', type: 'function', name: '数据管道处理' };

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
console.log('已写入 flows.json：sf-data-processor / 数据管道处理 →', shellSrc.split('\n').length, '行（原 403 行）');
