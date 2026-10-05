'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readCache, updateCache, setDisabled, writeConfig, cacheFile } = require('../lib/configCache');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v13-cache-'));
}

test('readCache：文件不存在返回 null', () => {
  assert.strictEqual(readCache(tmpDir()), null);
});

test('readCache：损坏文件返回 null 不抛错', () => {
  const dir = tmpDir();
  fs.writeFileSync(cacheFile(dir), '{broken json');
  assert.strictEqual(readCache(dir), null);
});

test('setDisabled：读-改-写合并，不丢已有字段', () => {
  const dir = tmpDir();
  writeConfig(dir, [{ id: 1 }], { 1: [] });
  setDisabled(dir, true);
  const c = readCache(dir);
  assert.strictEqual(c.disabled, true);
  assert.deepStrictEqual(c.devices, [{ id: 1 }], '原有配置字段必须保留');
  setDisabled(dir, false);
  assert.strictEqual(readCache(dir).disabled, false);
});

test('updateCache：函数式 patcher', () => {
  const dir = tmpDir();
  setDisabled(dir, true);
  updateCache(dir, (cur) => { cur.custom = 42; return cur; });
  assert.strictEqual(readCache(dir).custom, 42);
  assert.strictEqual(readCache(dir).disabled, true);
});

test('writeConfig：落盘形状与原版一致（devices/tagConfigs/ts，2 空格缩进）', () => {
  const dir = tmpDir();
  writeConfig(dir, [{ id: 1 }], {});
  const raw = fs.readFileSync(cacheFile(dir), 'utf8');
  assert.ok(raw.includes('\n  "devices"'), '保持 2 空格缩进格式');
  const c = JSON.parse(raw);
  assert.ok(c.ts > 0);
  assert.deepStrictEqual(c.tagConfigs, {});
});

test('并发语义：同步读写天然串行（同一事件循环内不会交错）', () => {
  const dir = tmpDir();
  for (let i = 0; i < 100; i++) updateCache(dir, { n: i });
  assert.strictEqual(readCache(dir).n, 99);
});
