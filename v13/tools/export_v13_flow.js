/**
 * export_v13_flow.js — 导出「自包含、可导入」的 V13 系统 flow
 *
 * 内容：EdgeLink v12 采集 tab + 4 个子流程（含内部节点）+ 其引用的全部配置节点。
 * 产出：v13/flows/edgelink_v13.flow.json —— 可在其他 Node-RED 实例直接「导入」。
 * 用法：node v13/tools/export_v13_flow.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = 'D:/nodered/data/flows.json';
const DST = path.join(__dirname, '../flows/edgelink_v13.flow.json');

const MAIN_TAB = '2609f416db83bdd1';   // EdgeLink v12 采集
const flows = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// 1) 主 tab + 子流程定义
const subflows = flows.filter((n) => n.type === 'subflow');
const subflowIds = new Set(subflows.map((s) => s.id));

// 2) 主 tab 内节点引用的子流程实例 → 实际用到的子流程
const mainNodes = flows.filter((n) => n.z === MAIN_TAB);
const usedSubflows = new Set();
mainNodes.forEach((n) => {
  if (String(n.type).startsWith('subflow:')) usedSubflows.add(n.type.slice(8));
});

// 3) 收编：主 tab + 用到的子流程 + 它们的内部节点
const scope = new Set([MAIN_TAB, ...usedSubflows]);
const picked = flows.filter((n) =>
  n.id === MAIN_TAB || usedSubflows.has(n.id) || (n.z && scope.has(n.z))
);
const pickedIds = new Set(picked.map((n) => n.id));

// 4) 配置节点（无 z 的全局 config：mqtt-broker / mitsubishi-config / MC连接 / pg配置 等）
//    规则：被收编节点引用的 config 才带上（config 节点出现在其他节点的属性值里）
const referencedIds = new Set();
const pickedStr = JSON.stringify(picked);
flows.forEach((n) => {
  if (n.z || pickedIds.has(n.id) || n.type === 'tab' || n.type === 'subflow') return;
  if (n.id && pickedStr.includes(n.id)) referencedIds.add(n.id);
});
const configNodes = flows.filter((n) => referencedIds.has(n.id));

const out = [...picked, ...configNodes];
fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.writeFileSync(DST, JSON.stringify(out, null, 4));

console.log('已导出 →', DST);
console.log('包含: 主tab×1 + 子流程×' + usedSubflows.size + ' + 节点×' + (picked.length - 1 - usedSubflows.size) + ' + 配置节点×' + configNodes.length);
console.log('配置节点:', configNodes.map((c) => c.type + '(' + (c.name || c.id) + ')').join(', ') || '无');
