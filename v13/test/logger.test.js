'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const logger = require('../lib/logger');

function capture() {
  const lines = [];
  logger.setSink((level, scope, msg) => lines.push(level + '|' + scope + '|' + msg));
  return lines;
}

test('warn/info 永远输出，debug 默认关闭', () => {
  const lines = capture();
  logger.setDebug(false);
  logger.debug('CM', 'hidden');
  logger.info('CM', 'shown-info');
  logger.warn('CM', 'shown-warn');
  assert.deepStrictEqual(lines, ['info|CM|shown-info', 'warn|CM|shown-warn']);
});

test('全局 debug 开关打开后 debug 输出', () => {
  const lines = capture();
  logger.setDebug(true);
  logger.debug('CM', 'visible');
  assert.deepStrictEqual(lines, ['debug|CM|visible']);
  logger.setDebug(false);
});

test('per-module 开关：只开指定域', () => {
  const lines = capture();
  logger.setDebug(false);
  logger.setModuleFlag('Monitor', true);
  logger.debug('CM', 'still-hidden');
  logger.debug('Monitor', 'module-visible');
  assert.deepStrictEqual(lines, ['debug|Monitor|module-visible']);
  logger.setModuleFlag('Monitor', false);
});

test('sink 抛错不影响业务（静默吞掉）', () => {
  logger.setSink(() => { throw new Error('sink boom'); });
  logger.warn('CM', 'must not throw');
  logger.setSink(null);
});
