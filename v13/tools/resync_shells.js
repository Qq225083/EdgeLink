/**
 * resync_shells.js — 拆分后壳源码有更新时，把 v13/shells/{dp,mon,cm}/*.js 重新写入 flows.json 对应节点
 * （split 工具只负责结构，本工具负责内容同步；幂等，可反复执行）
 * 用法：node v13/tools/resync_shells.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FLOWS = 'D:/nodered/data/flows.json';
const MAP = {
  // dp
  dp_01_entry: 'dp/dp_01_entry_guard.js',
  dp_02_failstate: 'dp/dp_02_fail_state.js',
  dp_03_failasm: 'dp/dp_03_fail_assemble.js',
  dp_04_okstate: 'dp/dp_04_ok_state.js',
  dp_05_xform: 'dp/dp_05_transform_filter.js',
  dp_06_calc: 'dp/dp_06_calc_tags.js',
  dp_07_merge: 'dp/dp_07_merge_writeback.js',
  dp_08_asm: 'dp/dp_08_assemble.js',
  // mon
  mon_01_state: 'mon/mon_01_state.js',
  mon_02_mqtt: 'mon/mon_02_mqtt.js',
  mon_03_hb: 'mon/mon_03_heartbeat.js',
  mon_04_dev: 'mon/mon_04_devonline.js',
  mon_05_comm: 'mon/mon_05_comm.js',
  mon_06_pg: 'mon/mon_06_pgstats.js',
  // cm
  cm_01_lockip: 'cm/cm_01_lock_ip.js',
  cm_02_boot: 'cm/cm_02_bootstrap.js',
  cm_03_jwt: 'cm/cm_03_jwt_cache.js',
  cm_04_nodeid: 'cm/cm_04_nodeid.js',
  cm_05_fetch: 'cm/cm_05_fetch_tags.js',
  cm_06_asm: 'cm/cm_06_assemble.js',
  cm_07_retry: 'cm/cm_07_retry.js',
};

const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
let updated = 0;
Object.keys(MAP).forEach((id) => {
  const node = flows.find((n) => n.id === id);
  if (!node) return;   // 该子流程还没拆分，跳过
  const src = fs.readFileSync(path.join(__dirname, '../shells', MAP[id]), 'utf8');
  if (node.func !== src) { node.func = src; updated++; }
});
fs.writeFileSync(FLOWS, JSON.stringify(flows, null, 4));
console.log('壳内容已同步，更新节点数:', updated);
