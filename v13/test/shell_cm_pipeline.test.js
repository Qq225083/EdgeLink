/**
 * shell_cm_pipeline.test.js — sf-config-manager 拆分链路集成测试
 * 逐节点跑 ①~⑦（共享 ctx + mock 后端），验证配置拉取全链路。
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
const DIR = path.join(__dirname, '../shells/cm');
const S = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const NODES = {
  lockip: S('cm_01_lock_ip.js'), boot: S('cm_02_bootstrap.js'), jwt: S('cm_03_jwt_cache.js'),
  nodeid: S('cm_04_nodeid.js'), fetch: S('cm_05_fetch_tags.js'), asm: S('cm_06_assemble.js'),
  retry: S('cm_07_retry.js'),
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
function runNode(src, ctx, msg, name, timers) {
  const node = makeNode(name);
  const capture = Array.isArray(timers) ? timers : null;
  const sandbox = {
    global: ctx, node, msg, env: { get: () => undefined },
    setTimeout: capture ? ((fn, ms) => { capture.push({ fn, ms }); }) : setTimeout,
    clearTimeout, JSON, Date, Math, console,
  };
  vm.createContext(sandbox);
  const ret = vm.runInContext('(function () {\n' + src + '\n})()', sandbox, { timeout: 5000 });
  return { ret, node };
}
function closeServer(s) {
  return new Promise((resolve) => { if (s.closeAllConnections) s.closeAllConnections(); s.close(() => resolve()); setTimeout(resolve, 500); });
}

function mockBackend() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/login') {
        res.end(JSON.stringify({ code: 200, data: { token: 'jwt-new' } }));
      } else if (req.url.startsWith('/monitor/heartbeat')) {
        res.end(JSON.stringify({ code: 200, data: { node_id: 66 } }));
      } else if (req.url.includes('snapshot/list')) {
        res.end(JSON.stringify({
          code: 200, snapshotVersion: 5, hasNext: false,
          rows: [
            { id: 101, deviceId: 7, deviceName: 'A机', hostPcIp: '192.168.0.179:1880', plcIp: '10.0.0.1', plcPort: 5007, registerType: 'D', registerAddress: '100', tagName: '温度', status: '0', comType: 'MC_Protocol' },
            { id: 102, deviceId: 7, deviceName: 'A机', hostPcIp: '192.168.0.179:1880', registerType: 'X', registerAddress: '1F', plcSeries: 'Q', tagName: '开关', status: '0', comType: 'MC_Protocol' },
          ],
        }));
      } else if (req.url.startsWith('/plc/config/bootstrap')) {
        res.end(JSON.stringify({ code: 200, data: null }));
      } else {
        res.end(JSON.stringify({ code: 200, data: {} }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

function baseCtx(port, over) {
  return makeCtx(Object.assign({
    edgeCore: core, edge_debug: false,
    edge_apiKey: 'k', edge_backendUser: 'u', edge_backendPass: 'p',
    edge_backendHost: '127.0.0.1', edge_backendPort: port,
    edge_hostPcIp: '192.168.0.179:1880', edge_enabledStatus: '0',
    edge_bootstrapKey: 'pc-001', edge_bootstrapSecret: 'sec',
    userDir: fs.mkdtempSync(path.join(os.tmpdir(), 'v13-cm-')),
    process, fs, path,
  }, over));
}

test('全链路成功：①锁/IP → ②bootstrap兜底 → 登录 → ③JWT → ④nodeId → ⑤分页 → ⑥双输出', async () => {
  const { server, calls, port } = await mockBackend();
  try {
    const ctx = baseCtx(port, { edge_jwt: 'has-jwt' });  // 非首启（跳过 bootstrap 等待）
    const msg = {};
    // ①锁+IP
    let r = runNode(NODES.lockip, ctx, msg, 'lockip');
    assert.ok(r.ret, '①应放行');
    // ②（isRefresh 路径：同步返回 login msg）
    r = runNode(NODES.boot, ctx, msg, 'boot');
    const loginMsg = r.ret;
    assert.ok(loginMsg && loginMsg.url && loginMsg.url.endsWith('/login'));
    assert.strictEqual(loginMsg.payload, 'username=u&password=p');
    // （http request 节点）真实调 mock /login
    const loginResp = await core.httpClient.requestJson({
      host: '127.0.0.1', port, path: '/login', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: loginMsg.payload,
    });
    assert.strictEqual(loginResp.json.data.token, 'jwt-new');
    // ③JWT解析
    const jwtMsg = { payload: loginResp.text, _cm: msg._cm };
    r = runNode(NODES.jwt, ctx, jwtMsg, 'jwt');
    assert.ok(r.ret[0] && !r.ret[1], '③应走输出1');
    assert.strictEqual(ctx.get('edge_jwt'), 'jwt-new');
    // ④nodeId 反查（异步 send）
    const n4 = runNode(NODES.nodeid, ctx, jwtMsg, 'nodeid');
    await new Promise((r2) => setTimeout(r2, 300));
    assert.strictEqual(n4.node.sends.length, 1, '④应异步发出');
    assert.strictEqual(ctx.get('edge_nodeId'), 66);
    // ⑤分页拉取（异步 send）
    const n5 = runNode(NODES.fetch, ctx, jwtMsg, 'fetch');
    await new Promise((r2) => setTimeout(r2, 300));
    assert.strictEqual(n5.node.sends.length, 1);
    assert.strictEqual(jwtMsg._cm.records.length, 2);
    // ⑥分组+输出
    const n6 = runNode(NODES.asm, ctx, jwtMsg, 'asm');
    const out = n6.node.sends[0];
    assert.ok(Array.isArray(out) && out.length === 2);
    assert.strictEqual(out[0].payload.devices.length, 1);
    assert.strictEqual(out[0].payload.devices[0].tags[1].addr, 31, 'X1F Q系列 hex → 31');
    assert.strictEqual(out[1].topic, 'edgelink/nodes/66/status');
    assert.strictEqual(ctx.get('edge_configReady'), true);
    assert.strictEqual(ctx.get('edge_config_manager_lock'), null, '完成后释放锁');
    // 缓存落盘
    const cache = JSON.parse(fs.readFileSync(path.join(ctx.get('userDir'), 'edge_config_cache.json'), 'utf8'));
    assert.strictEqual(cache.devices.length, 1);
    // 请求链完整
    assert.ok(calls.some((c) => c.url === '/login'));
    assert.ok(calls.some((c) => c.url.startsWith('/monitor/heartbeat')));
    assert.ok(calls.some((c) => c.url.includes('snapshot/list')));
  } finally {
    await closeServer(server);
  }
});

test('JWT 解析失败 → 输出2 进重试调度（首次 10s）', async () => {
  const ctx = baseCtx(19999);
  const msg = { payload: 'garbage{{', _cm: { hostPcIp: '192.168.0.179:1880' } };
  const r3 = runNode(NODES.jwt, ctx, msg, 'jwt');
  assert.ok(!r3.ret[0] && r3.ret[1], '③应走输出2');
  assert.strictEqual(ctx.get('edge_config_manager_lock'), null);
  // ⑦重试调度（捕获 setTimeout）
  const timers = [];
  runNode(NODES.retry, ctx, r3.ret[1], 'retry', timers);
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 10000, '首次重试 10s');
});

test('防重入 gate：5s 内第二次到达 ③ 直接丢弃', async () => {
  const ctx = baseCtx(19999);
  const good = { payload: JSON.stringify({ data: { token: 't1' } }), _cm: { hostPcIp: 'x:1880' } };
  const first = runNode(NODES.jwt, ctx, good, 'jwt1');
  assert.ok(first.ret && first.ret[0], '第一次放行');
  const second = runNode(NODES.jwt, ctx, { payload: JSON.stringify({ data: { token: 't2' } }), _cm: { hostPcIp: 'x:1880' } }, 'jwt2');
  assert.strictEqual(second.ret, null, '5s 内第二次被 gate 拦截');
});

test('锁占用（非 reauth）：①直接返回 null', async () => {
  const ctx = baseCtx(19999, { edge_config_manager_lock: { ts: Date.now(), nodeId: 'other' } });
  const r = runNode(NODES.lockip, ctx, {}, 'lockip');
  assert.strictEqual(r.ret, null);
  assert.strictEqual(r.node.sends.length, 0);
});
