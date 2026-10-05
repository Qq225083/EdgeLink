/**
 * shell_config_init.test.js — sf-config-manager Step1「IP检测+登录准备」V13 壳的分支验收
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const SHELL = fs.readFileSync(path.join(__dirname, '../shells/config_init_step1.js'), 'utf8');
const core = require('../lib');

function makeCtx(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { get: (k) => (m.has(k) ? m.get(k) : undefined), set: (k, v) => m.set(k, v), _map: m };
}

function makeNode() {
  return {
    id: 'cm-test', sends: [], statuses: [], warns: [], errors: [],
    send(...args) { this.sends.push(args.length === 1 ? args[0] : args); },
    status(s) { this.statuses.push(s); },
    warn(m) { this.warns.push(String(m)); },
    error(m) { this.errors.push(String(m)); },
  };
}

function mockBackend(routeFn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    const out = routeFn(req) || { code: 200, data: {} };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

function runShell(ctxInit, node, msg) {
  const ctx = makeCtx(Object.assign({
    edgeCore: core,
    edge_debug: false,
    edge_hostPcIp: '192.168.0.179:1880',
    edge_bootstrapKey: 'pc-001',
    edge_bootstrapSecret: 'sec',
    userDir: fs.mkdtempSync(path.join(os.tmpdir(), 'v13-cm-')),
  }, ctxInit));
  const sandbox = {
    global: ctx, node, msg: msg || {}, env: { get: () => undefined },
    setTimeout, clearTimeout, JSON, Date, Math, console,
  };
  vm.createContext(sandbox);
  const ret = vm.runInContext('(function () {\n' + SHELL + '\n})()', sandbox, { timeout: 5000 });
  return { ctx, ret };
}

test('首启：bootstrap 成功 → 凭据落 store，异步发出 login msg', async () => {
  const { server, port } = await mockBackend(() => ({
    code: 200, data: { apiKey: 'k9', backendUser: 'u1', backendPass: 'p1', mqtt: { host: 'mqtt.local' } },
  }));
  try {
    const node = makeNode();
    const { ctx } = runShell({ edge_backendHost: '127.0.0.1', edge_backendPort: port }, node, {});
    await new Promise((r) => setTimeout(r, 400));

    assert.strictEqual(ctx.get('edge_apiKey'), 'k9');
    assert.strictEqual(ctx.get('edge_backendUser'), 'u1');
    assert.strictEqual(ctx.get('edge_mqttConfig').host, 'mqtt.local');
    // login msg 经 node.send 异步发出
    assert.strictEqual(node.sends.length, 1);
    const m = node.sends[0];
    assert.strictEqual(m.url, 'http://127.0.0.1:' + port + '/login');
    assert.strictEqual(m.payload, 'username=u1&password=p1');
    // 首启初始化：startTime 有值、状态键已补默认
    assert.ok(ctx.get('edge_startTime'));
    assert.deepStrictEqual(ctx.get('edge_pg_queue'), []);
    // 壳层没直接碰网络以外的 node 副作用
    assert.strictEqual(node.errors.length, 0);
  } finally {
    await closeServer(server);
  }
});

test('停用态复查已启用 → 恢复并继续登录流程', async () => {
  const { server, port } = await mockBackend(() => ({ code: 200, data: { apiKey: 'k9' } }));
  try {
    const node = makeNode();
    const { ctx } = runShell({
      edge_backendHost: '127.0.0.1', edge_backendPort: port,
      edge_nodeDisabled: true,
      edge_apiKey: 'k', edge_backendUser: 'u', edge_backendPass: 'p',
      edge_jwt: 'old-jwt',
    }, node, {});
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(ctx.get('edge_nodeDisabled'), false);
    const cacheFile = path.join(ctx.get('userDir'), 'edge_config_cache.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).disabled, false);
    assert.strictEqual(node.sends.length, 1, '恢复后应发出 login msg');
  } finally {
    await closeServer(server);
  }
});

test('停用态复查仍未启用 → [null,null] + 红灯，保持停止', async () => {
  const { server, port } = await mockBackend(() => ({ code: 500, msg: '该节点已被停用' }));
  try {
    const node = makeNode();
    const { ctx } = runShell({
      edge_backendHost: '127.0.0.1', edge_backendPort: port,
      edge_nodeDisabled: true,
    }, node, {});
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(ctx.get('edge_nodeDisabled'), true);
    assert.strictEqual(JSON.stringify(node.sends[0]), JSON.stringify([null, null]));
    assert.ok(node.statuses.some((s) => s.fill === 'red' && s.text === 'DISABLED by server'));
    assert.strictEqual(ctx.get('edge_config_manager_lock'), null, '锁必须释放');
  } finally {
    await closeServer(server);
  }
});

test('缺凭据：node.error + 释放锁 + 不发登录', async () => {
  const node = makeNode();
  const { ctx } = runShell({ edge_jwt: 'has-jwt', edge_apiKey: '', edge_backendUser: '', edge_backendPass: '' }, node, {});
  assert.strictEqual(node.errors.length, 1);
  assert.match(node.errors[0], /缺少必需配置/);
  assert.strictEqual(ctx.get('edge_config_manager_lock'), null);
  assert.strictEqual(node.sends.length, 0);
});

test('锁占用（非 reauth）：直接返回 null，零副作用', () => {
  const node = makeNode();
  runShell({ edge_config_manager_lock: { ts: Date.now(), nodeId: 'other' }, edge_jwt: 'x' }, node, {});
  assert.strictEqual(node.sends.length, 0);
  assert.strictEqual(node.errors.length, 0);
});

test('reauth：清 jwt/configReady，置 reauthInProgress，同步返回 login msg', () => {
  const node = makeNode();
  const { ctx, ret } = runShell({
    edge_jwt: 'expired',
    edge_apiKey: 'k', edge_backendUser: 'u', edge_backendPass: 'p',
    edge_backendHost: '10.0.0.9', edge_backendPort: 9099,
  }, node, { payload: { action: 'reauth' } });
  assert.strictEqual(ctx.get('edge_jwt'), '');
  assert.strictEqual(ctx.get('edge_configReady'), false);
  assert.strictEqual(ctx.get('edge_reauthInProgress'), true);
  // 同步路径：login msg 作为返回值返回
  assert.ok(ret && ret.url === 'http://10.0.0.9:9099/login');
  assert.strictEqual(ret.payload, 'username=u&password=p');
});
