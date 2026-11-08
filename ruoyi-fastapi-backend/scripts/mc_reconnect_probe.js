'use strict';

const assert = require('assert');
const net = require('net');
const path = require('path');

const PKG = 'node-red-contrib-mcprotocol';
const PKG_VERSION = '1.2.1';
const PKG_ROOT = path.join('D:/nodered/data/node_modules', PKG);
const pkg = require(path.join(PKG_ROOT, 'package.json'));
const connectionPool = require(path.join(PKG_ROOT, 'connection_pool.js'));

assert.strictEqual(pkg.version, PKG_VERSION, `需要 ${PKG}@${PKG_VERSION}，实际为 ${pkg.version}`);

const HOST = '127.0.0.1';
const PROBE_HEARTBEAT_MS = 50;
const RECOVERY_LIMIT_MS = 30000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(port = 0) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return { server, sockets, port: server.address().port };
}

async function stopServer(mock) {
  if (!mock) return;
  for (const socket of mock.sockets) socket.destroy();
  if (!mock.server.listening) return;
  await new Promise((resolve) => mock.server.close(resolve));
}

function createConnection(port) {
  const connection = connectionPool.get(port, HOST, { logLevel: 'NONE', timeout: 200 });
  assert.strictEqual(connection.getAutoConnect(), false, '1.2.1 默认 autoConnect 应仍为 false');
  return connection;
}

function watchConnection(connection) {
  const state = { opens: 0, closes: 0, connected: false };
  connection.on('open', () => { state.opens++; state.connected = true; });
  connection.on('close', () => { state.closes++; state.connected = false; });
  connection.on('error', () => { state.connected = false; });
  return state;
}

function startHeartbeat(connection) {
  return setInterval(() => connection.connect(), PROBE_HEARTBEAT_MS);
}

async function waitFor(predicate, description, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`等待超时：${description}`);
}

async function cleanup(connection, mock, heartbeat) {
  clearInterval(heartbeat);
  if (connection) connection.disconnect();
  await stopServer(mock);
}

async function scenarioNodeRedFirst() {
  let mock = await startServer();
  const port = mock.port;
  await stopServer(mock);
  mock = null;
  let connection;
  let heartbeat;
  try {
    connection = createConnection(port);
    const state = watchConnection(connection);
    heartbeat = startHeartbeat(connection);
    await delay(120);
    assert.strictEqual(state.connected, false);
    assert.strictEqual(state.opens, 0, 'PLC 未启动时不应有成功连接');

    const started = Date.now();
    mock = await startServer(port);
    await waitFor(() => state.connected && state.opens === 1, '先 NR 后 PLC 恢复');
    const elapsed = Date.now() - started;
    assert(elapsed < RECOVERY_LIMIT_MS);
    console.log(`[OK] 先 NR 后 PLC：PLC 上线后 ${elapsed}ms 恢复（阈值 ${RECOVERY_LIMIT_MS}ms）`);
  } finally {
    await cleanup(connection, mock, heartbeat);
  }
}

async function scenarioPlcFirst() {
  let mock = await startServer();
  let connection;
  try {
    const started = Date.now();
    connection = createConnection(mock.port);
    const state = watchConnection(connection);
    await waitFor(() => state.connected && state.opens === 1, '先 PLC 后 NR 初始连接');
    const elapsed = Date.now() - started;
    assert(elapsed < RECOVERY_LIMIT_MS);
    console.log(`[OK] 先 PLC 后 NR：初始连接 ${elapsed}ms 建立，无需等待心跳`);
  } finally {
    await cleanup(connection, mock, undefined);
  }
}

async function scenarioPlcRestart() {
  let mock = await startServer();
  const port = mock.port;
  let connection;
  let heartbeat;
  try {
    connection = createConnection(port);
    const state = watchConnection(connection);
    await waitFor(() => state.connected && state.opens === 1, '运行中断线前初始连接');
    heartbeat = startHeartbeat(connection);

    await stopServer(mock);
    mock = null;
    await waitFor(() => !state.connected && state.closes >= 1, '运行中断线被识别');
    await delay(120);

    const started = Date.now();
    mock = await startServer(port);
    await waitFor(() => state.connected && state.opens >= 2, 'PLC 重启后恢复');
    const elapsed = Date.now() - started;
    assert(elapsed < RECOVERY_LIMIT_MS);
    console.log(`[OK] 运行中重启 PLC：恢复服务后 ${elapsed}ms 重连（阈值 ${RECOVERY_LIMIT_MS}ms）`);
  } finally {
    await cleanup(connection, mock, heartbeat);
  }
}

async function main() {
  console.log(`MC connect 恢复探针（${PKG}@${PKG_VERSION}，TCP mock，心跳 ${PROBE_HEARTBEAT_MS}ms 加速）`);
  await scenarioNodeRedFirst();
  await scenarioPlcFirst();
  await scenarioPlcRestart();
  console.log('三种连接顺序全部通过，未出现 uncaughtException。');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
