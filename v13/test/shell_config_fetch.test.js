/**
 * shell_config_fetch.test.js — sf-config-manager Step2「JWT解析+nodeId+点位发现」V13 壳分支验收
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const SHELL = fs.readFileSync(path.join(__dirname, '../shells/config_fetch_step2.js'), 'utf8');
const core = require('../lib');

function makeCtx(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { get: (k) => (m.has(k) ? m.get(k) : undefined), set: (k, v) => m.set(k, v), _map: m };
}

function makeNode() {
  return {
    id: 'cm2-test', sends: [], statuses: [], warns: [], errors: [],
    send(...args) { this.sends.push(args.length === 1 ? args[0] : args); },
    status(s) { this.statuses.push(s); },
    warn(m) { this.warns.push(String(m)); },
    error(m) { this.errors.push(String(m)); },
  };
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

/** timers：传 'real' 用真实 setTimeout；传数组则捕获调度（不执行） */
function runShell(ctxInit, node, msg, timers) {
  const ctx = makeCtx(Object.assign({
    edgeCore: core,
    edge_debug: false,
    edge_apiKey: 'test-key',
    edge_hostPcIp: '192.168.0.179:1880',
    edge_enabledStatus: '0',
    edge_backendUser: 'u',
    edge_backendPass: 'p',
    userDir: fs.mkdtempSync(path.join(os.tmpdir(), 'v13-cm2-')),
    process,
  }, ctxInit));
  const captureTimers = Array.isArray(timers) ? timers : null;
  const sandbox = {
    global: ctx, node, msg, env: { get: () => undefined },
    setTimeout: captureTimers ? ((fn, ms) => { captureTimers.push({ fn, ms }); }) : setTimeout,
    clearTimeout, JSON, Date, Math, console,
  };
  vm.createContext(sandbox);
  const ret = vm.runInContext('(function () {\n' + SHELL + '\n})()', sandbox, { timeout: 5000 });
  return { ctx, ret };
}

const JWT_MSG = { payload: JSON.stringify({ data: { token: 'jwt-abc' } }) };

const TAG_PAGE1 = [
  { id: 101, deviceId: 7, deviceName: 'A机', hostPcIp: '192.168.0.179:1880', plcIp: '10.0.0.1', plcPort: 5007,
    registerType: 'D', registerAddress: '100', tagName: '温度', status: '0', comType: 'MC_Protocol' },
  { id: 102, deviceId: 7, deviceName: 'A机', hostPcIp: '192.168.0.179:1880',
    registerType: 'X', registerAddress: '1F', plcSeries: 'Q', tagName: '开关', status: '0', comType: 'MC_Protocol' },
];
const TAG_PAGE2 = [
  { id: 200, deviceId: 7, deviceName: 'A机', hostPcIp: '192.168.0.179:1880', tagName: '均值', calcOp: 'avg', calcSourceIds: '[101,102]', status: '0' },
];

function mockFullBackend() {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/monitor/heartbeat')) {
      res.end(JSON.stringify({ code: 200, data: { node_id: 66 } }));
    } else if (req.url.includes('pageNum=1')) {
      res.end(JSON.stringify({ code: 200, rows: TAG_PAGE1, hasNext: true, snapshotVersion: 3 }));
    } else {
      res.end(JSON.stringify({ code: 200, rows: TAG_PAGE2, hasNext: false, snapshotVersion: 3 }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

test('完整成功路径：心跳反查 nodeId → 两页拉取 → 分组 → 缓存落盘 → [configMsg, mqttMsg]', async () => {
  const { server, calls, port } = await mockFullBackend();
  try {
    const node = makeNode();
    const { ctx } = runShell({ edge_backendHost: '127.0.0.1', edge_backendPort: port }, node, JWT_MSG);
    await new Promise((r) => setTimeout(r, 600));

    // 请求链：heartbeat + 两页 snapshot
    assert.ok(calls.some((u) => u.startsWith('/monitor/heartbeat')));
    assert.strictEqual(calls.filter((u) => u.includes('snapshot/list')).length, 2, '分页两页');
    assert.ok(calls.find((u) => u.includes('snapshot')).includes('pageSize=5000'), 'camelCase 分页参数');

    // 输出槽位：[configMsg, mqttMsg]
    assert.strictEqual(node.sends.length, 1);
    const [configMsg, mqttMsg] = node.sends[0];
    assert.strictEqual(configMsg.payload.nodeId, 66);
    assert.strictEqual(configMsg.payload.jwt, 'jwt-abc');
    assert.strictEqual(configMsg.payload.devices.length, 1);
    const dev = configMsg.payload.devices[0];
    assert.strictEqual(dev.tags.length, 2);
    assert.strictEqual(dev.tags[1].addr, 31, 'X1F Q系列 hex → 31');
    assert.strictEqual(dev.calcTags.length, 1, '计算点分流');
    assert.deepStrictEqual(dev.calcTags[0].sourceIds, [101, 102]);
    assert.strictEqual(mqttMsg.topic, 'edgelink/nodes/66/status');
    assert.strictEqual(mqttMsg.retain, true);
    assert.strictEqual(JSON.parse(mqttMsg.payload).device_count, 1);

    // 状态与缓存
    assert.strictEqual(ctx.get('edge_configReady'), true);
    assert.strictEqual(ctx.get('edge_configVersion'), 3);
    assert.strictEqual(ctx.get('edge_config_manager_lock'), null, '完成后释放锁');
    const cache = JSON.parse(fs.readFileSync(path.join(ctx.get('userDir'), 'edge_config_cache.json'), 'utf8'));
    assert.strictEqual(cache.devices.length, 1);
    assert.ok(cache.ts > 0);
  } finally {
    await closeServer(server);
  }
});

test('JWT 解析失败：不重查 nodeId，直接调度登录重试（10s）并释放锁', async () => {
  const node = makeNode();
  const timers = [];
  const { ret, ctx } = runShell({ edge_backendHost: '127.0.0.1', edge_backendPort: 19999 }, node, { payload: 'not-json{{{' }, timers);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(ret, null);
  assert.strictEqual(ctx.get('edge_config_manager_lock'), null);
  assert.strictEqual(timers.length, 1, '应调度一次登录重试');
  assert.strictEqual(timers[0].ms, 10000, '首次重试延迟 10s');
  assert.strictEqual(node.sends.length, 0);
});

test('nodeId 反查返回 0：放弃本轮，[null,null] 收尾', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, data: {} }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const node = makeNode();
    const { ctx } = runShell({ edge_backendHost: '127.0.0.1', edge_backendPort: port }, node, JWT_MSG);
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(JSON.stringify(node.sends[0]), JSON.stringify([null, null]));
    assert.strictEqual(ctx.get('edge_configReady'), false);
    assert.strictEqual(ctx.get('edge_config_manager_lock'), null);
  } finally {
    await closeServer(server);
  }
});

test('缓存带停用标记：即便 JWT 正常也置停用态', async () => {
  const { server, port } = await mockFullBackend();
  try {
    const node = makeNode();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-cm2-dis-'));
    fs.writeFileSync(path.join(dir, 'edge_config_cache.json'), JSON.stringify({ disabled: true }));
    const { ctx } = runShell({ edge_backendHost: '127.0.0.1', edge_backendPort: port, userDir: dir }, node, JWT_MSG);
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(ctx.get('edge_nodeDisabled'), true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.get('edge_devices'))), []);
    assert.strictEqual(ctx.get('edge_configReady'), false);
  } finally {
    await closeServer(server);
  }
});

test('防重入 gate：5s 内重复触发直接返回，零请求零发送', async () => {
  const { server, calls, port } = await mockFullBackend();
  try {
    const node = makeNode();
    const { ret } = runShell({
      edge_backendHost: '127.0.0.1', edge_backendPort: port,
      edge_retryState: { attempt: 1, lastAttempt: Date.now() },
    }, node, JWT_MSG);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(ret, undefined);
    assert.strictEqual(calls.length, 0, 'gate 拦截时不发任何请求');
    assert.strictEqual(node.sends.length, 0);
  } finally {
    await closeServer(server);
  }
});
