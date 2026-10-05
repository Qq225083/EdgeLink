'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { detectIp, normalizeHostPcIp, computeFingerprint, isVirtualIface } = require('../lib/netUtils');
const { fetchBootstrap } = require('../lib/bootstrap');

const fakeNets = {
  'vEthernet (WSL)': [{ family: 'IPv4', address: '172.22.0.1', internal: false }],
  Ethernet: [
    { family: 'IPv4', address: '169.254.10.10', internal: false },   // 链路本地，排除
    { family: 'IPv4', address: '172.16.5.5', internal: false },      // 企业内网（非 10/192.168）
  ],
  'WLAN': [{ family: 'IPv4', address: '192.168.0.179', internal: false }],
  'Loopback Pseudo': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
};

test('detectIp：虚拟网卡排除 + 链路本地排除 + 无 10 段时取 192.168 段', () => {
  assert.strictEqual(detectIp(fakeNets), '192.168.0.179');
});

test('detectIp：双网卡办公网优先——枚举顺序在前也不能抢（192.168 工业网 < 10 办公网）', () => {
  assert.strictEqual(detectIp({
    Ethernet: [{ family: 'IPv4', address: '192.168.1.10', internal: false }],  // 工业网卡，枚举在前
    WLAN: [{ family: 'IPv4', address: '10.81.8.34', internal: false }],        // 办公网卡
  }), '10.81.8.34');
});

test('detectIp：无 192.168/10 段时取第一个候选（172.16 企业内网不排除）', () => {
  assert.strictEqual(detectIp({
    Ethernet: [{ family: 'IPv4', address: '172.16.5.5', internal: false }],
    'vEthernet (Docker)': [{ family: 'IPv4', address: '10.5.0.1', internal: false }],
  }), '172.16.5.5');
});

test('detectIp：全无可候选 → 127.0.0.1', () => {
  assert.strictEqual(detectIp({}), '127.0.0.1');
});

test('isVirtualIface：关键字命中', () => {
  assert.ok(isVirtualIface('vEthernet (WSL)'));
  assert.ok(isVirtualIface('VMware Network Adapter VMnet8'));
  assert.ok(!isVirtualIface('Ethernet'));
});

test('normalizeHostPcIp：无端口追加、有端口不动、重复端口去重', () => {
  assert.strictEqual(normalizeHostPcIp('10.0.0.1', 1880), '10.0.0.1:1880');
  assert.strictEqual(normalizeHostPcIp('10.0.0.1:1881', 1880), '10.0.0.1:1881');
  assert.strictEqual(normalizeHostPcIp('10.0.0.1:1881:1880', 1880), '10.0.0.1:1881', '旧版 IP:port:port 规范化');
});

test('computeFingerprint：本机可算且稳定', () => {
  const a = computeFingerprint();
  const b = computeFingerprint();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.strictEqual(a, b);
});

function mockServer(routeFn) {
  const server = http.createServer((req, res) => {
    const out = routeFn(req) || { code: 200 };
    res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.payload));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('bootstrap：成功返回 config', async () => {
  const { server, port } = await mockServer((req) => {
    assert.match(req.url, /^\/plc\/config\/bootstrap\?host_pc_ip=10\.0\.0\.1%3A1880&secret_key=s/);
    return { payload: { code: 200, data: { apiKey: 'k1', backendUser: 'u', backendPass: 'p', mqtt: {} } } };
  });
  try {
    const r = await fetchBootstrap({ host: '127.0.0.1', port, hostPcIp: '10.0.0.1:1880', secretKey: 's' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.config.apiKey, 'k1');
    assert.strictEqual(r.disabled, false);
  } finally {
    server.close();
  }
});

test('bootstrap：msg 含「停用」→ disabled=true', async () => {
  const { server, port } = await mockServer(() => ({ payload: { code: 500, msg: '该节点已被停用' } }));
  try {
    const r = await fetchBootstrap({ host: '127.0.0.1', port, hostPcIp: 'x', secretKey: 's' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.disabled, true);
    assert.strictEqual(r.config, null);
  } finally {
    server.close();
  }
});

test('bootstrap：网络失败 → ok=false + error，不抛异常', async () => {
  const r = await fetchBootstrap({ host: '127.0.0.1', port: 19996, hostPcIp: 'x', secretKey: 's', timeout: 500 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});
