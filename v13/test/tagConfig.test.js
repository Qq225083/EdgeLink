/**
 * tagConfig.test.js — MC 地址解析表驱动测试矩阵 + 分组/合并/清理
 *
 * 这是全系统唯一「错了不立刻崩、但会长期错数据」的规则，矩阵即合同。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseTagAddress, mergeProtocolParams, groupByDevice, cleanupStaleState } = require('../lib/tagConfig');

// ===== MC 地址解析矩阵：regType × 地址 × 系列 → 期望值 =====
// 规则：W/B 一律 hex；X/Y 在非 FX 系列 hex、FX/iQ-F 系列 octal（含 8/9 非法）；其余十进制；非法 → -1
const ADDRESS_MATRIX = [
  // [regType, addrStr, plcSeries, expected, 说明]
  ['D', '100', 'Q', 100, 'D 区十进制'],
  ['D', '0', 'Q', 0, '0 地址合法'],
  ['D', 'ABC', 'Q', -1, '纯字母非法 → -1（不许静默读 0）'],
  ['D', '', 'Q', -1, '空地址 → -1'],
  ['D', '12a5', 'Q', 125, 'D 区剥掉所有非数字字符（现网行为：12a5→125，非前缀截取）'],
  ['W', '1A', 'Q', 26, 'W 区 hex'],
  ['W', 'FF', 'L', 255, 'W 区 hex 与系列无关'],
  ['B', '10', 'Q', 16, 'B 区 hex（不是十进制 10！）'],
  ['X', '1F', 'Q', 31, 'Q 系列 X 为 hex'],
  ['Y', 'A0', 'iQ-R', 160, 'iQ-R Y 为 hex'],
  ['X', '17', 'FX3U', 15, 'FX 系列 X 为八进制 17→15'],
  ['Y', '20', 'FX2N', 16, 'FX 系列 Y 为八进制 20→16'],
  ['X', '17', 'iQ-F', 15, 'iQ-F 同 FX 八进制'],
  ['X', '18', 'FX3U', -1, '八进制含 8 非法 → -1'],
  ['Y', '19', 'FX3U', -1, '八进制含 9 非法 → -1'],
  ['X', '1F', 'FX3U', 1, 'FX 八进制地址含字母：字母被剥除后按八进制解析（现网行为，记录在案）'],
  ['D', '100', 'fx3u', 100, '系列名大小写不敏感'],
  ['X', '10', 'QJ71', 16, 'Q 系衍生型号 X 为 hex'],
  ['M', '100', 'Q', 100, 'M 区十进制'],
  ['D', null, 'Q', -1, 'null 地址 → -1'],
  ['D', undefined, 'Q', -1, 'undefined 地址 → -1'],
];

test('MC 地址解析矩阵（' + ADDRESS_MATRIX.length + ' 条）', () => {
  ADDRESS_MATRIX.forEach(([rt, addr, series, expected, note]) => {
    assert.strictEqual(
      parseTagAddress(rt, addr, series), expected,
      `[${note}] ${rt}${addr} @ ${series} 应为 ${expected}`
    );
  });
});

test('mergeProtocolParams：平铺铺底 → 设备级覆盖 → 点位级覆盖', () => {
  const pp = mergeProtocolParams({
    mcFrame: '3E', stationNo: 0,
    protocolParams1: JSON.stringify({ stationNo: 2, protocol: 'tcp' }),
    protocolParams: { stationNo: 5 },
  });
  assert.strictEqual(pp.mcFrame, '3E');
  assert.strictEqual(pp.protocol, 'tcp', '设备级新增字段');
  assert.strictEqual(pp.stationNo, 5, '点位级覆盖设备级');
});

test('mergeProtocolParams：损坏 JSON 不崩；现网行为——单 try 包裹，设备级损坏会连累点位级不合并（记录在案）', () => {
  const pp = mergeProtocolParams({ protocolParams1: '{bad', protocolParams: '{"ok":1}' });
  assert.strictEqual(pp.ok, undefined, '设备级 JSON 损坏时点位级被跳过（现网单 try 语义）');
  assert.strictEqual(pp.plcSeries, 'Q', '默认系列 Q');
});

test('groupByDevice：分组 + 本机过滤 + 启用过滤 + MC 无效地址跳过 + calc 分流', () => {
  const rows = [
    { id: 1, deviceId: 7, deviceName: 'A机', hostPcIp: 'pc1:1880', plcIp: '10.0.0.1', plcPort: 5007, registerType: 'D', registerAddress: '100', tagName: '温度', status: '0' },
    { id: 2, deviceId: 7, registerType: 'X', registerAddress: '1F', plcSeries: 'Q', tagName: '开关', status: '0' },
    { id: 3, deviceId: 7, tagName: '均值', calcOp: 'avg', calcSourceIds: '[1,2]', status: '0' },
    { id: 4, deviceId: 8, deviceName: '别家机器', hostPcIp: 'pc2:1880', registerType: 'D', registerAddress: '0', status: '0' },
    { id: 5, deviceId: 9, deviceName: '停用设备', hostPcIp: 'pc1:1880', registerType: 'D', registerAddress: '0', status: '1' },
    { id: 6, deviceId: 10, deviceName: '全废地址', hostPcIp: 'pc1:1880', registerType: 'D', registerAddress: 'ABC', status: '0' },
  ];
  const { devices, tagConfigs, skipped } = groupByDevice(rows, { myHostPcIp: 'pc1:1880', enabledStatus: '0' });

  assert.strictEqual(devices.length, 1, '只剩本机启用且有有效地址的设备 7');
  const dev = devices[0];
  assert.strictEqual(dev.tags.length, 2);
  assert.strictEqual(dev.tags[0].addr, 100);
  assert.strictEqual(dev.tags[1].addr, 31, 'X1F Q系列 hex → 31');
  assert.strictEqual(dev.calcTags.length, 1, '计算点分流到 calcTags');
  assert.deepStrictEqual(dev.calcTags[0].sourceIds, [1, 2]);
  assert.strictEqual(dev.timeout, 3000);
  assert.strictEqual(dev.maxRetries, 2);
  assert.strictEqual(tagConfigs[7].length, 2);
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].reason, 'no_valid_registers');
});

test('cleanupStaleState：移除失效设备/点位的残留状态', () => {
  const maps = {
    historyData: { 7: { 101: [{ ts: 'x' }] }, 8: { 1: [] } },
    lastGoodTags: { 7: [{ tag_id: 101 }, { tag_id: 999 }], 8: [{ tag_id: 1 }] },
    commStatus: { 7: { lastState: 'online' }, 8: { lastState: 'offline' } },
    commPending: [{ deviceId: 7 }, { deviceId: 8 }],
  };
  const out = cleanupStaleState({ 7: true }, { 101: true }, maps);
  assert.ok(out.historyData['7'] && !out.historyData['8']);
  assert.deepStrictEqual(out.lastGoodTags['7'], [{ tag_id: 101 }], '失效点位被清');
  assert.ok(!out.lastGoodTags['8']);
  assert.ok(!out.commStatus['8']);
  assert.strictEqual(out.commPending.length, 1);
});
