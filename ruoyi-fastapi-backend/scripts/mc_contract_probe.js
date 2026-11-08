'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PKG = 'node-red-contrib-mcprotocol';
const PKG_VERSION = '1.2.1';
const PKG_ROOT = path.join('D:/nodered/data/node_modules', PKG);
const EXPECTED_PATH = path.join(__dirname, 'mc_contract_probe.expected.json');
const pkg = require(path.join(PKG_ROOT, 'package.json'));
const MCProtocol = require(path.join(PKG_ROOT, 'mcprotocol/mcprotocol.js'));

assert.strictEqual(pkg.name, PKG);
assert.strictEqual(pkg.version, PKG_VERSION, `需要 ${PKG}@${PKG_VERSION}，实际为 ${pkg.version}`);

const CASES = [
  { address: 'M200' },
  { address: 'M200.0' },
  { address: 'M200.3' },
  { address: 'M200.0,4' },
  { address: 'M200.3,4' },
  { address: 'M200,4' },
  { address: 'M200,3' },
  { address: 'M203' },
  { address: 'M203,2' },
  { address: 'D100' },
  { address: 'D100.3' },
  { address: 'D100.3,4' },
  { address: 'DUINT100' },
  { address: 'DUINT100,2' },
  { address: 'DDINT100' },
  { address: 'DDWORD100' },
  { address: 'DFLOAT100' },
  { address: 'DREAL100' },
  { address: 'W1A' },
  { address: 'W1A,1' },
  { address: 'B1A' },
  { address: 'X1A' },
  { address: 'X10', requestedPlcType: 'FX', octalInputOutput: true },
  { address: 'X17', requestedPlcType: 'FX', octalInputOutput: true },
  { address: 'Y10', requestedPlcType: 'FX', octalInputOutput: true },
  { address: 'XF', requestedPlcType: 'FX', octalInputOutput: true },
  { address: 'X8', requestedPlcType: 'FX', octalInputOutput: true },
  { address: 'Y8', requestedPlcType: 'FX', octalInputOutput: true },
];

function formatDeviceAddress(deviceCode, notation, offset) {
  const formattedOffset = notation === 'Hexadecimal'
    ? Number(offset).toString(16).toUpperCase()
    : String(offset);
  return `${deviceCode}${formattedOffset}`;
}

function deriveOutputKeys(item) {
  const notation = item.deviceCodeSpec.notation;
  if (item.datatype === 'CHAR') {
    return [formatDeviceAddress(item.deviceCode, notation, item.offset)];
  }

  const keys = [];
  if (item.datatype === 'BIT' && item.deviceCodeSpec.type !== 'BIT') {
    let wordOffset = item.offset;
    let loopBit = 0;
    for (let i = 0; i < item.arrayLength; i++) {
      let bitNo = item.bitOffset + loopBit;
      if (bitNo === 16) wordOffset++;
      if (bitNo >= 16) bitNo -= 16;
      const wordKey = formatDeviceAddress(item.deviceCode, notation, wordOffset);
      keys.push(`${wordKey}.${Number(bitNo).toString(16).toUpperCase()}`);
      loopBit++;
      if (loopBit >= 16) loopBit = 0;
    }
    return keys;
  }

  let wordOffset = item.offset;
  for (let i = 0; i < item.arrayLength; i++) {
    keys.push(formatDeviceAddress(item.deviceCode, notation, wordOffset));
    wordOffset += item.dtypelen / 2;
  }
  return keys;
}

function runCase(testCase) {
  const requestedPlcType = testCase.requestedPlcType || 'Q';
  const mc = new MCProtocol();
  mc.setDebugLevel('NONE');
  mc.fakeTheConnection = true;
  mc.initiateConnection({
    name: 'contract-probe',
    host: '127.0.0.1',
    port: 5007,
    frame: '3E',
    plcType: requestedPlcType,
    octalInputOutput: Boolean(testCase.octalInputOutput),
  }, () => {});
  clearTimeout(mc.queueTimer);

  mc.addItemsNow(testCase.address, 'read');
  const item = mc.findItem(testCase.address);
  assert(item, `${testCase.address} 未能生成 PLCItem`);
  assert.strictEqual(item.initialised, true, `${testCase.address} 解析失败：${item.initError}`);

  return {
    address: testCase.address,
    requestedPlcType,
    effectivePlcType: mc.plcType,
    octalInputOutput: mc.octalInputOutput,
    deviceCode: item.deviceCode,
    deviceCodeType: item.deviceCodeSpec.type,
    notation: item.deviceCodeSpec.notation,
    datatype: item.datatype,
    offset: item.offset,
    bitOffset: item.bitOffset ?? null,
    remainder: item.remainder,
    requestOffset: item.requestOffset,
    arrayLength: item.arrayLength,
    dataTypeByteLength: item.dtypelen,
    wordLength: item.wordLength,
    bitNative: item.bitNative ?? null,
    outputKeys: deriveOutputKeys(item),
  };
}

function getCase(report, address) {
  const found = report.cases.filter((item) => item.address === address);
  assert.strictEqual(found.length, 1, `${address} 用例数量应为 1`);
  return found[0];
}

function assertRequiredContract(report) {
  for (const address of ['M200', 'M200.0', 'M200.3']) {
    assert.deepStrictEqual(getCase(report, address).outputKeys, ['M200'], `${address} 输出键错误`);
  }
  for (const address of ['M200.0,4', 'M200.3,4', 'M200,4']) {
    assert.deepStrictEqual(
      getCase(report, address).outputKeys,
      ['M200', 'M201', 'M202', 'M203'],
      `${address} 输出键错误`,
    );
  }
  assert.deepStrictEqual(getCase(report, 'M200,3').outputKeys, ['M200', 'M201', 'M202']);
  assert.deepStrictEqual(getCase(report, 'M203').outputKeys, ['M203']);
  assert.deepStrictEqual(getCase(report, 'M203,2').outputKeys, ['M203', 'M204']);
  assert.deepStrictEqual(getCase(report, 'D100.3').outputKeys, ['D100.3']);
  assert.deepStrictEqual(getCase(report, 'D100.3,4').outputKeys, ['D100.3', 'D100.4', 'D100.5', 'D100.6']);

  const uint = getCase(report, 'DUINT100');
  assert.strictEqual(uint.datatype, 'UINT');
  assert.strictEqual(uint.dataTypeByteLength, 2);
  assert.strictEqual(uint.wordLength, 1);
  assert.deepStrictEqual(getCase(report, 'DUINT100,2').outputKeys, ['D100', 'D101']);
  assert.strictEqual(getCase(report, 'DUINT100,2').wordLength, 2);
  assert.deepStrictEqual(getCase(report, 'W1A,1').outputKeys, ['W1A']);
  assert.strictEqual(getCase(report, 'X1A').offset, 26);
  assert.deepStrictEqual(getCase(report, 'X1A').outputKeys, ['X1A']);

  const real = getCase(report, 'DREAL100');
  assert.strictEqual(real.datatype, 'REAL');
  assert.strictEqual(real.dataTypeByteLength, 4);
  assert.strictEqual(real.wordLength, 2);

  for (const [address, offset] of [['X10', 16], ['X17', 23], ['Y10', 16], ['XF', 15], ['X8', 8], ['Y8', 8]]) {
    const fxCase = getCase(report, address);
    assert.strictEqual(fxCase.requestedPlcType, 'FX');
    assert.strictEqual(fxCase.effectivePlcType, 'Q');
    assert.strictEqual(fxCase.octalInputOutput, true);
    assert.strictEqual(fxCase.offset, offset, `${address} 被按八进制解析，与包实际行为不符`);
    assert.deepStrictEqual(fxCase.outputKeys, [address]);
  }
}

const actual = {
  package: PKG,
  version: pkg.version,
  frame: '3E',
  cases: CASES.map(runCase),
};
assertRequiredContract(actual);

if (process.argv.includes('--snapshot')) {
  console.log(JSON.stringify(actual, null, 2));
} else {
  const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  assert.deepStrictEqual(actual, expected, 'MC 实际契约与 mc_contract_probe.expected.json 不一致');
  for (const item of actual.cases) {
    console.log(
      `[OK] ${item.address} (${item.requestedPlcType}->${item.effectivePlcType}) `
      + `keys=${JSON.stringify(item.outputKeys)} offset=${item.offset} remainder=${item.remainder} `
      + `requestOffset=${item.requestOffset} wordLength=${item.wordLength} `
      + `datatype=${item.datatype} bitNative=${item.bitNative}`,
    );
  }
  console.log(`全部 ${actual.cases.length} 个 MC 契约用例通过（${PKG}@${PKG_VERSION}）。`);
}
