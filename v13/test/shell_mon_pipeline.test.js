/**
 * shell_mon_pipeline.test.js — sf-monitor 拆分链路的集成测试
 * 逐节点跑 ①~⑥（共享 ctx + mock 后端），断言请求链与 reauth 语义。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const core = require('../lib');
const DIR = path.join(__dirname, '../shells/mon');
const S = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const NODES = {
  state: S('mon_01_state.js'), mqtt: S('mon_02_mqtt.js'), hb: S('mon_03_heartbeat.js'),
  dev: S('mon_04_devonline.js'), comm: S('mon_05_comm.js'), pg: S('mon_06_pgstats.js'),
};

function makeCtx(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { get: (k) => (m.has(k) ? m.get(k) : undefined), set: (k, v) => m.set(k, v), _map: m };
}
function makeNode(name) {
  return {
    id: name, name, sends: [], statuses: [], warns: [], errors: [],
    send(...a) { this.sends.push(a.length === 1 ? a[0] : a); },
    status(s) { this.statuses.push(s); },
    warn(m) { this.warns.push(String(m)); },
    error(m) { this.errors.push(String(m)); },
  };
}
function runNode(src, ctx, msg, name) {
  const node = makeNode(name);
  const sandbox = { global: ctx, node, msg, env: { get: () => undefined }, setTimeout, clearTimeout, JSON, Date, Math, console };
  vm.createContext(sandbox);
  const ret = vm.runInContext('(function () {\n' + src + '\n})()', sandbox, { timeout: 5000 });
  return { ret, node };
}
function mockBackend(routeFn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = routeFn(req) || { status: 200, payload: { code: 200, data: {} } };
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}
function closeServer(s) {
  return new Promise((resolve) => { if (s.closeAllConnections) s.closeAllConnections(); s.close(() => resolve()); setTimeout(resolve, 500); });
}

function baseCtx(port, over) {
  return makeCtx(Object.assign({
    edgeCore: core, edge_debug: false, edge_apiKey: 'k', edge_jwt: 'j',
    edge_nodeId: 66, edge_hostPcIp: '192.168.0.179:1880',
    edge_backendHost: '127.0.0.1', edge_backendPort: port,
    edge_configReady: true,
    edge_devices: [{ id: 1, deviceName: 'PLC-A', tags: [1] }],
    edge_commStatus: { 1: { consecutiveFails: 0, lastSuccessTime: Date.now() } },
    edge_commPending: [],
    userDir: fs.mkdtempSync(path.join(os.tmpdir(), 'v13-mon-')),
    process, fs, path,
  }, over));
}

/** 跑完整监控链路 ①→②③→④→⑤→⑥，返回各节点结果 */
async function runChain(ctx) {
  const msg = {};
  let r = runNode(NODES.state, ctx, msg, 'state');
  if (!r.ret) return { short: true, nodes: [r.node] };
  const nodes = [r.node];
  const mqttR = runNode(NODES.mqtt, ctx, msg, 'mqtt'); nodes.push(mqttR.node);
  const hbR = runNode(NODES.hb, ctx, msg, 'hb'); nodes.push(hbR.node);
  const devR = runNode(NODES.dev, ctx, msg, 'dev'); nodes.push(devR.node);
  const commR = runNode(NODES.comm, ctx, msg, 'comm'); nodes.push(commR.node);
  const pgR = runNode(NODES.pg, ctx, msg, 'pg'); nodes.push(pgR.node);
  await new Promise((r2) => setTimeout(r2, 600));
  return { nodes, mqttOut: mqttR.ret, hbNode: hbR.node, commNode: commR.node, pgNode: pgR.node };
}

test('正常周期：MQTT 心跳组装 + HTTP 心跳 + 逐台在线 + PG 统计，无 reauth', async () => {
  const { server, calls, port } = await mockBackend((req) => {
    if (req.url.startsWith('/monitor/heartbeat')) return { status: 200, payload: { code: 200, data: { node_id: 66, disabled: false } } };
    return { status: 200, payload: { code: 200, data: {} } };
  });
  try {
    const ctx = baseCtx(port);
    const { mqttOut, hbNode } = await runChain(ctx);

    // ② MQTT 心跳消息形状
    assert.strictEqual(mqttOut.topic, 'edgelink/heartbeat/66');
    assert.strictEqual(JSON.parse(mqttOut.payload).device_count, 1);
    // ③ HTTP 心跳参数
    const hb = calls.find((c) => c.url.startsWith('/monitor/heartbeat'));
    assert.match(hb.url, /pg_success_count=\d+/);
    assert.match(hb.url, /spool_bytes=\d+/);
    assert.strictEqual(hb.headers['x-api-key'], 'k');
    // ④⑤⑥ 请求都发出
    assert.ok(calls.some((c) => c.url.includes('/monitor/device-comm')));
    assert.ok(calls.some((c) => c.url.includes('/monitor/pg-write')));
    // 无 reauth
    assert.ok(!hbNode.sends.some((s) => s[1]));
    // 状态灯
    assert.ok(hbNode.statuses.some((s) => s.fill === 'green' && s.text === 'HB 200'));
  } finally {
    await closeServer(server);
  }
});

test('401 周期：心跳 401 → reauth 直发且本周期去重（pg 也 401 不重复发）', async () => {
  const { server, port } = await mockBackend(() => ({ status: 401, payload: { msg: 'x' } }));
  try {
    const ctx = baseCtx(port, { edge_commPending: [{ deviceId: 1, success: false, error: 'e', ts: 't' }] });
    const { hbNode, commNode, pgNode } = await runChain(ctx);
    const reauths = [...hbNode.sends, ...commNode.sends, ...pgNode.sends]
      .flatMap((s) => Array.isArray(s) ? s : [s])
      .filter((m) => m && m.payload && m.payload.action === 'reauth');
    assert.strictEqual(reauths.length, 1, '本周期 reauth 只发一次');
    assert.strictEqual(ctx.get('edge_jwt'), '');
    assert.strictEqual(ctx.get('edge_reauthInProgress'), true);
  } finally {
    await closeServer(server);
  }
});

test('kill switch：心跳响应 disabled=true → 停用态 + 缓存落盘', async () => {
  const { server, port } = await mockBackend((req) => {
    if (req.url.startsWith('/monitor/heartbeat')) return { status: 200, payload: { code: 200, data: { node_id: 66, disabled: true } } };
    return { status: 200, payload: { code: 200, data: {} } };
  });
  try {
    const ctx = baseCtx(port);
    await runChain(ctx);
    assert.strictEqual(ctx.get('edge_nodeDisabled'), true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ctx.get('userDir'), 'edge_config_cache.json'), 'utf8')).disabled, true);
  } finally {
    await closeServer(server);
  }
});

test('未就绪：①灰灯短路，后续零请求', async () => {
  const { server, calls, port } = await mockBackend(() => ({ status: 200, payload: { code: 200, data: {} } }));
  try {
    const ctx = baseCtx(port, { edge_configReady: false });
    const r = runNode(NODES.state, ctx, {}, 'state');
    assert.strictEqual(r.ret, null);
    assert.ok(r.node.statuses.some((s) => s.fill === 'grey' && s.text === 'wait config'));
    await new Promise((r2) => setTimeout(r2, 200));
    assert.strictEqual(calls.length, 0);
  } finally {
    await closeServer(server);
  }
});
