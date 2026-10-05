/**
 * export_flows.js — 把 D 盘 live flows.json 导出到 v13/flows/flows.json（V13 工作区快照）
 * 用法：node v13/tools/export_flows.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = 'D:/nodered/data/flows.json';
const DST = path.join(__dirname, '../flows/flows.json');

fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.copyFileSync(SRC, DST);

const flows = JSON.parse(fs.readFileSync(DST, 'utf8'));
const v13Count = flows.filter((n) => n.type === 'function' && (n.func || '').includes('edgeCore')).length;
console.log('已导出 →', DST);
console.log('节点总数:', flows.length, '| V13 壳 function:', v13Count);
console.log('源文件 mtime:', fs.statSync(SRC).mtime.toISOString());
