'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const NODE_RED_ROOT = 'D:/nodered/node_modules';
const express = require(path.join(NODE_RED_ROOT, 'express'));
const bcrypt = require(path.join(NODE_RED_ROOT, 'bcryptjs'));
const RED = require(path.join(NODE_RED_ROOT, 'node-red'));

const ADMIN_TOKEN = 'edge-admin-token';

async function startNodeRed() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edgelink-nr-auth-'));
  fs.writeFileSync(path.join(userDir, 'flows.json'), '[]\n', 'utf8');
  const app = express();
  const server = http.createServer(app);
  const settings = {
    userDir,
    uiPort: 0,
    httpAdminRoot: '/',
    httpNodeRoot: false,
    flowFile: 'flows.json',
    flowFilePretty: true,
    credentialSecret: 'test-credential-secret',
    disableEditor: true,
    logging: { console: { level: 'off', metrics: false, audit: false } },
    adminAuth: {
      type: 'credentials',
      users: [{
        username: 'deploy',
        password: bcrypt.hashSync('deploy-password', 8),
        permissions: '*',
      }],
      tokens: [{
        token: ADMIN_TOKEN,
        user: 'deploy',
        scope: '*',
      }],
      sessionExpiryTime: 60,
    },
  };
  RED.init(server, settings);
  app.use(settings.httpAdminRoot, RED.httpAdmin);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await RED.start();
  return { server, userDir, base: `http://127.0.0.1:${server.address().port}` };
}

async function stopNodeRed(server, userDir) {
  try {
    await RED.stop();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}

async function main() {
  const { server, userDir, base } = await startNodeRed();
  try {
    const unauth = await fetch(`${base}/flows`, { headers: { 'Node-RED-API-Version': 'v2' } });
    assert.strictEqual(unauth.status, 401, '未认证 GET /flows 必须 401');

    const wrong = await fetch(`${base}/flows`, {
      headers: { Authorization: 'Bearer wrong-token', 'Node-RED-API-Version': 'v2' },
    });
    assert.strictEqual(wrong.status, 401, '错误 token 必须 401');

    const goodHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Node-RED-API-Version': 'v2' };
    const flows = await fetch(`${base}/flows`, { headers: goodHeaders });
    assert.strictEqual(flows.status, 200, '正确 token 的 GET /flows 应通过');
    const flowsBody = await flows.json();
    assert.ok(Array.isArray(flowsBody.flows) && flowsBody.flows.length === 0, 'GET /flows v2 应返回 flows 数组');

    const nodes = await fetch(`${base}/nodes`, { headers: goodHeaders });
    assert.strictEqual(nodes.status, 200, '正确 token 的 GET /nodes 应通过');

    const deploy = await fetch(`${base}/flows`, {
      method: 'POST',
      headers: {
        ...goodHeaders,
        'Content-Type': 'application/json',
        'Node-RED-Deployment-Type': 'full',
      },
      body: JSON.stringify({ flows: [] }),
    });
    assert.ok([200, 204].includes(deploy.status), `正确 token 的 POST /flows 应通过，实际 ${deploy.status}`);

    console.log('[OK] 未认证/错误 token 的 GET /flows 返回 401');
    console.log('[OK] 正确 token 的 GET /flows、GET /nodes、POST /flows 全部通过');
    console.log('隔离 Node-RED adminAuth 验证通过。');
  } finally {
    await stopNodeRed(server, userDir);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
