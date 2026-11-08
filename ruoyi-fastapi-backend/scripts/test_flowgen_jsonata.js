'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const jsonata = require('D:/nodered/node_modules/jsonata');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const PYTHON = path.join(BACKEND_ROOT, '.venv', 'Scripts', 'python.exe');
const PYTHON_CODE = `
import json
from module_flowgen.drivers.mc import MC_DRIVER
from module_flowgen.service import flow_builders as fb
tags = [
    dict(id=1, device_id=101, tag_name='t1', register_type='D', register_address='100', data_type='INT16',
         unit='', eng_unit='', transform_type='none', transform_slope_a=1.0, transform_offset_b=0.0, bit_offset=None),
    dict(id=2, device_id=101, tag_name='t2', register_type='D', register_address='101', data_type='INT16',
         unit='', eng_unit='', transform_type='none', transform_slope_a=1.0, transform_offset_b=0.0, bit_offset=None),
]
print(json.dumps({
    'block': fb.block_assemble_expr(tags, MC_DRIVER.extract),
    'badBlock': fb.bad_block_assemble_expr(tags),
    'final': fb.final_assemble_expr(66, {'id': 101, 'device_name': 'MC测试', 'host_pc_ip': '10.0.0.1'}, False),
    'comm': fb.comm_expr(False),
}, ensure_ascii=False))
`;

function buildExpressions() {
  const output = execFileSync(PYTHON, ['-c', PYTHON_CODE], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    env: { ...process.env, APP_ENV: 'dev', PYTHONDONTWRITEBYTECODE: '1' },
  });
  return JSON.parse(output);
}

async function evaluate(expression, message) {
  return jsonata(expression).evaluate(message);
}

function assertContract(contract, expected, label) {
  for (const [field, value] of Object.entries(expected)) {
    assert.strictEqual(contract[field], value, `${label}.${field}: ${contract[field]} != ${value}`);
  }
}

async function main() {
  const expr = buildExpressions();

  const partialBlock = await evaluate(expr.block, { payload: { D100: 10 } });
  assert.deepStrictEqual(partialBlock.map((v) => v.quality), ['GOOD', 'UNCERTAIN']);
  assert.strictEqual(partialBlock[0].raw_value, 10);
  assert.strictEqual(partialBlock[1].raw_value, null);

  const partialContract = await evaluate(expr.final, { payload: partialBlock });
  assertContract(partialContract, {
    value_count: 2,
    good_count: 1,
    bad_count: 0,
    uncertain_count: 1,
    quality: 'GOOD',
  }, '缺 key');
  assert.strictEqual(await evaluate(expr.comm, { payload: partialContract }), 'true');
  console.log('[OK] 单点缺失：value_count=2 good=1 uncertain=1，UNCERTAIN 不判离线');

  const badBlock = await evaluate(expr.badBlock, { payload: {} });
  assert.deepStrictEqual(badBlock.map((v) => v.quality), ['BAD', 'BAD']);
  const badContract = await evaluate(expr.final, { payload: badBlock });
  assertContract(badContract, {
    value_count: 2,
    good_count: 0,
    bad_count: 2,
    uncertain_count: 0,
    quality: 'BAD',
  }, '单块失败');
  assert.strictEqual(await evaluate(expr.comm, { payload: badContract }), 'false');
  console.log('[OK] 单块失败：value_count=2 good=0 bad=2，comm=false');

  const emptyContract = await evaluate(expr.final, { payload: [] });
  assertContract(emptyContract, {
    value_count: 0,
    good_count: 0,
    bad_count: 0,
    uncertain_count: 0,
    quality: 'GOOD',
  }, '空数组');
  assert.strictEqual(await evaluate(expr.comm, { payload: emptyContract }), 'false');
  assert.strictEqual(await evaluate(expr.comm, { payload: null }), 'false');
  assert.strictEqual(await evaluate(expr.comm, { payload: partialContract, problem: true }), 'false');
  console.log('[OK] 空数组/null/problem：comm=false');

  const goodBlock = await evaluate(expr.block, { payload: { D100: 10, D101: 20 } });
  const goodContract = await evaluate(expr.final, { payload: goodBlock });
  assertContract(goodContract, {
    value_count: 2,
    good_count: 2,
    bad_count: 0,
    uncertain_count: 0,
    quality: 'GOOD',
  }, '正常');
  assert.strictEqual(await evaluate(expr.comm, { payload: goodContract }), 'true');
  console.log('[OK] 正常块：value_count=2 good=2，comm=true');
  console.log('全部 JSONata 语义注入用例通过。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
