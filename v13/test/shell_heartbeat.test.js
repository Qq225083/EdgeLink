/**
 * shell_heartbeat.test.js — sf-monitor「心跳+批量上报」V13 壳的输出语义测试
 *
 * 对应重构方案 §3.1 硬门槛：lib 单测不够，壳层的 send 槽位/status/日志必须逐分支断言。
 * 方法：vm 沙箱加载壳源码（与 Node-RED function 沙箱同形态），fake global/node/env，
 *       本地 mock 后端记录请求，驱动一次完整心跳周期后断言副作用。
 *
 * 注意（已踩坑修复）：
 *   - vm realm 内创建的对象与宿主原型不同，deepStrictEqual 会误报 → 一律 JSON 序列化比较；
 *   - 断言失败会跳过 server.close() 导致进程悬挂 → 所有用例 try/finally 兜底关闭。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const SHELL = fs.readFileSync(path.join(__dirname, '../shells/heartbeat_sf_monitor.js'), 'utf8');
const core = require('../lib');

/** fake Node-RED function global context（内存版） */
function makeCtx(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    get: (k) => (m.has(k) ? m.get(k) : undefined),
    set: (k, v) => m.set(k, v),
    _map: m,
  };
}

/** fake node：记录 send/status/warn/error 调用 */
function makeNode() {
  return {
    id: 'test-node',
    sends: [], statuses: [], warns: [], errors: [],
    send(...args) { this.sends.push(args.length === 1 ? args[0] : args); },
    status(s) { this.statuses.push(s); },
    warn(m) { this.warns.push(String(m)); },
    error(m) { this.errors.push(String(m)); },
  };
}

/** mock 后端：记录请求，按路由规则响应 */
function startMockBackend(routeFn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = routeFn(req, calls) || { code: 200, data: {} };
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.payload !== undefined ? out.payload : out));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
    setTimeout(resolve, 500); // 兜底，绝不让用例挂在关闭上
  });
}

/** 在 vm 沙箱中执行壳（与 Node-RED function 一样包成函数体） */
function runShell(ctxInitial, port, node) {
  const ctx = makeCtx({
    edgeCore: core,
    edge_backendHost: '127.0.0.1',
    edge_backendPort: port,
    edge_apiKey: 'test-api-key',
    edge_jwt: 'test-jwt',
    edge_nodeId: 66,
    edge_hostPcIp: '192.168.0.179:1880',
    edge_configReady: true,
    edge_debug: false,
    edge_devices: [{ id: 1, deviceName: 'PLC-A', tags: [1, 2] }],
    edge_commStatus: { 1: { consecutiveFails: 0, lastSuccessTime: Date.now() } },
    process,
    userDir: fs.mkdtempSync(path.join(os.tmpdir(), 'v13-shell-')),
    fs, path,
    ...ctxInitial,
  });
  const sandbox = {
    global: ctx, node, msg: {}, env: { get: () => undefined },
    setTimeout, clearTimeout, JSON, Date, Math, console,
  };
  vm.createContext(sandbox);
  vm.runInContext('(function () {\n' + SHELL + '\n})()', sandbox, { timeout: 5000 });
  return ctx;
}

test('正常心跳：HB 200 → MQTT 心跳从输出1发出、输出2为 null、绿灯 HB 200、请求参数与旧版一致', async () => {
  const node = makeNode();
  const { server, calls, port } = await startMockBackend((req) => {
    if (req.url.startsWith('/monitor/heartbeat')) return { payload: { code: 200, data: { node_id: 66, disabled: false } } };
    return { payload: { code: 200, data: {} } };
  });
  try {
    runShell({}, port, node);
    await new Promise((r) => setTimeout(r, 500));

    // 心跳请求：方法/路径参数/header/body 与旧版逐字节等价
    const hb = calls.find((c) => c.url.startsWith('/monitor/heartbeat'));
    assert.ok(hb, '应发出 /monitor/heartbeat');
    assert.strictEqual(hb.method, 'POST');
    assert.strictEqual(hb.body, '{}');
    assert.strictEqual(hb.headers['x-api-key'], 'test-api-key');
    assert.strictEqual(hb.headers['authorization'], 'Bearer test-jwt');
    assert.match(hb.url, /host_pc_ip=192\.168\.0\.179%3A1880/);
    assert.match(hb.url, /running_flows=5/);
    assert.match(hb.url, /pg_success_count=\d+&pg_fail_count=\d+&spool_bytes=\d+/);

    // 设备在线上报 + PG 统计
    assert.ok(calls.some((c) => c.url.startsWith('/monitor/device-comm')), '应逐设备上报 device-comm');
    assert.ok(calls.some((c) => c.url.startsWith('/monitor/pg-write')), '应上报 pg-write');

    // 输出槽位：[mqttMsg, null]（无 reauth）
    assert.strictEqual(node.sends.length, 1);
    const out = node.sends[0];
    assert.ok(Array.isArray(out) && out.length === 2, '必须是二输出数组');
    assert.strictEqual(out[1], null, '无 401 时输出2 为 null');
    assert.strictEqual(out[0].topic, 'edgelink/heartbeat/66');
    const payload = JSON.parse(out[0].payload);
    assert.strictEqual(payload.node_id, 66);
    assert.strictEqual(payload.status, 'online');
    assert.strictEqual(payload.device_count, 1);

    // 状态灯：绿 HB 200
    assert.ok(node.statuses.some((s) => s.fill === 'green' && s.text === 'HB 200'));
  } finally {
    await closeServer(server);
  }
});

test('401 分支：输出2 发 reauth、清 jwt、configReady 置 false', async () => {
  const node = makeNode();
  const { server, port } = await startMockBackend((req) => {
    if (req.url.startsWith('/monitor/heartbeat')) return { status: 401, payload: { msg: 'unauthorized' } };
    return { payload: { code: 200, data: {} } };
  });
  try {
    const ctx = runShell({}, port, node);
    await new Promise((r) => setTimeout(r, 500));

    const out = node.sends[0];
    assert.strictEqual(
      JSON.stringify(out[1]),
      JSON.stringify({ payload: { action: 'reauth' } }),
      '401 必须从输出2 发 reauth'
    );
    assert.strictEqual(ctx.get('edge_jwt'), '');
    assert.strictEqual(ctx.get('edge_configReady'), false);
    assert.strictEqual(ctx.get('edge_reauthInProgress'), true);
  } finally {
    await closeServer(server);
  }
});

test('kill switch：心跳响应 disabled=true → 进入停用态、清配置、写缓存标记', async () => {
  const node = makeNode();
  const { server, port } = await startMockBackend((req) => {
    if (req.url.startsWith('/monitor/heartbeat')) return { payload: { code: 200, data: { node_id: 66, disabled: true } } };
    return { payload: { code: 200, data: {} } };
  });
  try {
    const ctx = runShell({}, port, node);
    await new Promise((r) => setTimeout(r, 500));

    assert.strictEqual(ctx.get('edge_nodeDisabled'), true);
    assert.strictEqual(JSON.stringify(ctx.get('edge_devices')), '[]');
    assert.strictEqual(ctx.get('edge_configReady'), false);
    const cacheFile = path.join(ctx.get('userDir'), 'edge_config_cache.json');
    assert.ok(fs.existsSync(cacheFile), '停用标记必须落盘');
    assert.strictEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).disabled, true);
    assert.ok(node.warns.some((w) => w.includes('已被后端停用')));
  } finally {
    await closeServer(server);
  }
});

test('configReady=false 短路：灰灯 wait config，不发任何 HTTP', async () => {
  const node = makeNode();
  const { server, calls, port } = await startMockBackend(() => ({ payload: { code: 200, data: {} } }));
  try {
    runShell({ edge_configReady: false }, port, node);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(calls.length, 0, '未就绪时零网络调用');
    assert.ok(node.statuses.some((s) => s.fill === 'grey' && s.text === 'wait config'));
  } finally {
    await closeServer(server);
  }
});

test('后端宕机（连接拒绝）：单次收尾、不崩、不重复上报', async () => {
  const node = makeNode();
  const ctx = makeCtx({
    edgeCore: core, edge_backendHost: '127.0.0.1', edge_backendPort: 19997,
    edge_apiKey: 'k', edge_jwt: 'j', edge_nodeId: 66, edge_hostPcIp: '10.0.0.1:1880',
    edge_configReady: true, edge_debug: false, edge_devices: [], process,
    userDir: fs.mkdtempSync(path.join(os.tmpdir(), 'v13-shell-')), fs, path,
  });
  const sandbox = { global: ctx, node, msg: {}, env: { get: () => undefined }, setTimeout, clearTimeout, JSON, Date, Math, console };
  vm.createContext(sandbox);
  vm.runInContext('(function () {\n' + SHELL + '\n})()', sandbox, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(node.sends.length, 1, '失败路径也必须完成一次 send（[mqttMsg, null]）');
  assert.strictEqual(node.errors.length, 0);
});
