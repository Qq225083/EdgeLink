'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { requestJson } = require('../lib/httpClient');

/** 启一个临时 HTTP 服务器，handler 由用例提供，返回 { server, port }。 */
function withServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('GET 成功：2xx + JSON 解析', async () => {
  const { server, port } = await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, data: { token: 'abc' } }));
  });
  const r = await requestJson({ host: '127.0.0.1', port, path: '/login' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.token, 'abc');
  assert.strictEqual(r.error, null);
  server.close();
});

test('POST body 原样透传', async () => {
  const { server, port } = await withServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, echo: b }));
    });
  });
  const r = await requestJson({
    host: '127.0.0.1', port, path: '/monitor/heartbeat?a=1', method: 'POST', body: '{}',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.json.method, 'POST');
  assert.strictEqual(r.json.echo, '{}');
  server.close();
});

test('非 2xx：ok=false 但 status 保留（业务分支用）', async () => {
  const { server, port } = await withServer((req, res) => {
    res.writeHead(401).end('{"msg":"unauthorized"}');
  });
  const r = await requestJson({ host: '127.0.0.1', port, path: '/' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401);
  server.close();
});

test('响应非 JSON：ok=false、json=null、text 保留原文', async () => {
  const { server, port } = await withServer((req, res) => {
    res.writeHead(200).end('<html>bad gateway</html>');
  });
  const r = await requestJson({ host: '127.0.0.1', port, path: '/' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.json, null);
  assert.match(r.text, /bad gateway/);
  server.close();
});

test('连接拒绝：error 路径，Promise 不 reject', async () => {
  // 找一个几乎不可能被占用的端口
  const r = await requestJson({ host: '127.0.0.1', port: 19998, path: '/', timeout: 1000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, null);
  assert.ok(r.error);
});

test('超时：error=timeout，且 destroy 后不会二次 settle', async () => {
  const { server, port } = await withServer(() => { /* 永不响应 */ });
  const start = Date.now();
  const r = await requestJson({ host: '127.0.0.1', port, path: '/', timeout: 300 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'timeout');
  assert.ok(Date.now() - start < 2000, '应在超时后立即返回');
  server.close();
});

test('超时后服务器才响应：仍只按 timeout 结算一次', async () => {
  const { server, port } = await withServer((req, res) => {
    setTimeout(() => { res.writeHead(200).end('{"code":200}'); }, 600);
  });
  const r = await requestJson({ host: '127.0.0.1', port, path: '/', timeout: 100 });
  assert.strictEqual(r.error, 'timeout');
  await new Promise((r2) => setTimeout(r2, 800));  // 等迟到的响应，验证无二次 resolve 抛错
  server.close();
});
