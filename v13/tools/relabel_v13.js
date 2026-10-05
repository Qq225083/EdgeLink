/**
 * relabel_v13.js — V13 版本身份标识（纯展示层，不动逻辑）
 *   1. tab 标签：EdgeLink v12 采集 → EdgeLink v13 采集
 *   2. tab info 与流程内版本注释同步更新
 *   3. 4 个子流程 info 标注「V13 壳 · lib=edgeCore」
 * 用法：node v13/tools/relabel_v13.js
 */
'use strict';
const fs = require('fs');

const FLOWS = 'D:/nodered/data/flows.json';
const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));

const tab = flows.find((n) => n.id === '2609f416db83bdd1');
if (!tab) { console.error('主 tab 未找到'); process.exit(1); }

// 1. tab 标签 + info
tab.label = 'EdgeLink v13 采集';
tab.info = (tab.info || '').replace(/v12(\.\d+)?/g, 'v13')
  + '\n\nv13: 4 个巨型 function 已重构为薄壳（lib=edgeCore，v13/lib），行为与 v12 等价。';

// 2. 流程内版本注释 comment
flows.filter((n) => n.type === 'comment' && /v12/.test(n.name || '')).forEach((c) => {
  c.name = c.name.replace(/EdgeLink v12(\.\d+)?[^\n]*/, 'EdgeLink v13 | 3npm + 4subflow(V13壳) | 2026-08-29');
  c.info = (c.info || '').replace(/v12(\.\d+)?/g, 'v13');
});

// 3. 子流程 info 标注
const SUBFLOW_MARK = 'V13 壳 · lib=edgeCore';
flows.filter((n) => n.type === 'subflow').forEach((sf) => {
  if (!(sf.info || '').includes(SUBFLOW_MARK)) {
    sf.info = ((sf.info || '') + '\n' + SUBFLOW_MARK).trim();
  }
});

fs.writeFileSync(FLOWS, JSON.stringify(flows, null, 4));
console.log('标识已更新：tab →', tab.label);
console.log('子流程标注 ×', flows.filter((n) => n.type === 'subflow').length);
