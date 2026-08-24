/* eslint-env mocha */
'use strict';

var assert = require('assert');
var s7addr = require('../nodes/lib/s7-address.js');
// nodes7 官方地址解析器（交叉验证：本驱动生成的地址必须能被它接受，且语义一致）
var nodes7Parser = require('@st-one-io/nodes7/src/addressParser/nodes7.js');

describe('s7-address 地址解析', function () {

  // ===== 合法形态（表驱动）=====
  // [regType, registerAddress, dataType, 期望 nodes7Addr, 期望字节偏移, 期望区域, 期望 DB 号, 期望 isBit, 期望位偏移, nodes7 解析后的 datatype]
  var validCases = [
    // --- DB 区 ---
    ['DB', 'DB1.DBW0', 'INT16', 'DB1,INT0', 0, 'DB', 1, false, null, 'INT'],
    ['DB', 'DB1.DBW0', 'UINT16', 'DB1,WORD0', 0, 'DB', 1, false, null, 'WORD'],
    ['DB', 'DB2.DBD4', 'INT32', 'DB2,DINT4', 4, 'DB', 2, false, null, 'DINT'],
    ['DB', 'DB2.DBD4', 'UINT32', 'DB2,DWORD4', 4, 'DB', 2, false, null, 'DWORD'],
    ['DB', 'DB2.DBD4', 'FLOAT', 'DB2,REAL4', 4, 'DB', 2, false, null, 'REAL'],
    ['DB', 'DB1.DBX0.0', 'BOOL', 'DB1,X0.0', 0, 'DB', 1, true, 0, 'X'],
    ['DB', 'DB10.DBX3.7', 'BOOL', 'DB10,X3.7', 3, 'DB', 10, true, 7, 'X'],
    ['DB', 'db100.dbw20', 'INT16', 'DB100,INT20', 20, 'DB', 100, false, null, 'INT'],  // 大小写不敏感
    // --- M 区 ---
    ['M', 'MW10', 'INT16', 'MI10', 10, 'M', null, false, null, 'INT'],   // ⚠️ 有符号 → I 后缀（透传 MW 会被 nodes7 按无符号解码）
    ['M', 'MW10', 'UINT16', 'MW10', 10, 'M', null, false, null, 'WORD'],
    ['M', 'MD10', 'INT32', 'MDI10', 10, 'M', null, false, null, 'DINT'],
    ['M', 'MD10', 'UINT32', 'MD10', 10, 'M', null, false, null, 'DWORD'],
    ['M', 'MD10', 'FLOAT', 'MR10', 10, 'M', null, false, null, 'REAL'],  // ⚠️ 浮点 → R 后缀
    ['M', 'M0.1', 'BOOL', 'M0.1', 0, 'M', null, true, 1, 'X'],
    ['M', 'MX0.1', 'BOOL', 'M0.1', 0, 'M', null, true, 1, 'X'],          // TIA 的 MX 写法归一化为 nodes7 位格式
    ['M', 'mw20', 'uint16', 'MW20', 20, 'M', null, false, null, 'WORD'], // 大小写不敏感
    // --- I 区 ---
    ['I', 'IW0', 'INT16', 'II0', 0, 'I', null, false, null, 'INT'],
    ['I', 'IW0', 'UINT16', 'IW0', 0, 'I', null, false, null, 'WORD'],
    ['I', 'ID0', 'INT32', 'IDI0', 0, 'I', null, false, null, 'DINT'],
    ['I', 'ID0', 'UINT32', 'ID0', 0, 'I', null, false, null, 'DWORD'],
    ['I', 'ID0', 'FLOAT', 'IR0', 0, 'I', null, false, null, 'REAL'],
    ['I', 'I0.0', 'BOOL', 'I0.0', 0, 'I', null, true, 0, 'X'],
    // --- Q 区 ---
    ['Q', 'QW0', 'INT16', 'QI0', 0, 'Q', null, false, null, 'INT'],
    ['Q', 'QW0', 'UINT16', 'QW0', 0, 'Q', null, false, null, 'WORD'],
    ['Q', 'QD0', 'INT32', 'QDI0', 0, 'Q', null, false, null, 'DINT'],
    ['Q', 'QD0', 'UINT32', 'QD0', 0, 'Q', null, false, null, 'DWORD'],
    ['Q', 'QD0', 'FLOAT', 'QR0', 0, 'Q', null, false, null, 'REAL'],
    ['Q', 'Q0.0', 'BOOL', 'Q0.0', 0, 'Q', null, true, 0, 'X'],
    // --- dataType 别名归一化 ---
    ['DB', 'DB1.DBW0', 'INT', 'DB1,INT0', 0, 'DB', 1, false, null, 'INT'],
    ['DB', 'DB1.DBD4', 'REAL', 'DB1,REAL4', 4, 'DB', 1, false, null, 'REAL'],
    ['M', 'M0.1', 'BIT', 'M0.1', 0, 'M', null, true, 1, 'X'],
    ['M', 'MD10', 'FLOAT32', 'MR10', 10, 'M', null, false, null, 'REAL']
  ];

  validCases.forEach(function (c) {
    var rt = c[0], addr = c[1], dt = c[2], expectAddr = c[3], expectOff = c[4], expectArea = c[5],
        expectDb = c[6], expectIsBit = c[7], expectBit = c[8], expectN7Type = c[9];
    it(rt + ' ' + addr + ' (' + dt + ') → ' + expectAddr, function () {
      var r = s7addr.parseTagAddress(rt, addr, dt);
      assert.strictEqual(r.ok, true, '应解析成功: ' + (r.error || ''));
      assert.strictEqual(r.nodes7Addr, expectAddr);
      assert.strictEqual(r.byteOffset, expectOff);
      assert.strictEqual(r.area, expectArea);
      assert.strictEqual(r.dbNumber, expectDb);
      assert.strictEqual(r.isBit, expectIsBit);
      assert.strictEqual(r.bitOffset, expectBit);

      // 交叉验证：生成的 nodes7 地址必须能被官方 addressParser 接受，且语义一致
      var n7 = nodes7Parser.parse(expectAddr);
      assert.strictEqual(n7.offset, expectOff, 'nodes7 字节偏移一致');
      assert.strictEqual(n7.datatype, expectN7Type, 'nodes7 数据类型一致');
      if (expectDb !== null) assert.strictEqual(n7.dbNumber, expectDb, 'nodes7 DB 号一致');
      if (expectIsBit) assert.strictEqual(n7.bitOffset, expectBit, 'nodes7 位偏移一致');
    });
  });

  // ===== 非法形态（表驱动）=====
  // [regType, registerAddress, dataType, 错误信息应包含的子串]
  var invalidCases = [
    // DOUBLE 拒绝（明确中文报错）
    ['DB', 'DB1.DBD0', 'DOUBLE', '暂不支持 DOUBLE'],
    ['M', 'MD10', 'LREAL', '暂不支持 DOUBLE'],
    ['I', 'ID0', 'FLOAT64', '暂不支持 DOUBLE'],
    // 区域前缀与 regType 不符
    ['M', 'DB1.DBW0', 'INT16', '不符'],
    ['DB', 'MW10', 'INT16', '不符'],
    ['I', 'QW0', 'INT16', '不符'],
    ['Q', 'IW0', 'INT16', '不符'],
    // 地址后缀与数据类型位宽不符
    ['DB', 'DB1.DBW0', 'FLOAT', '不匹配'],
    ['DB', 'DB1.DBD4', 'INT16', '不匹配'],
    ['DB', 'DB1.DBX0.0', 'INT16', '不匹配'],
    ['M', 'MW10', 'INT32', '不匹配'],
    ['M', 'MD10', 'INT16', '不匹配'],
    ['M', 'M0.1', 'INT16', '不匹配'],
    // 位地址形态错误
    ['DB', 'DB1.DBX0', 'BOOL', '位号'],
    ['DB', 'DB1.DBX0.8', 'BOOL', '0-7'],
    ['M', 'MW10.1', 'INT16', '位号'],
    ['M', 'M10', 'INT16', '缺少宽度后缀'],
    // DB 号越界
    ['DB', 'DB0.DBW0', 'INT16', '≥ 1'],
    // 格式非法
    ['DB', 'hello', 'INT16', '格式非法'],
    ['M', 'MW', 'INT16', '格式非法'],
    ['DB', '', 'INT16', '地址为空'],
    ['DB', null, 'INT16', '地址为空'],
    // 未知 regType / dataType
    ['T', 'T5', 'INT16', '未知的寄存器区域'],
    ['DB', 'DB1.DBW0', 'BLOB', '未知的数据类型'],
    // 字节寻址 v1 不支持（给明确指引）
    ['DB', 'DB1.DBB0', 'UINT16', 'DBB'],
    ['M', 'MB10', 'UINT16', '字节寻址']
  ];

  invalidCases.forEach(function (c) {
    var rt = c[0], addr = c[1], dt = c[2], expectMsg = c[3];
    it(rt + ' ' + addr + ' (' + dt + ') 应拒绝: ' + expectMsg, function () {
      var r = s7addr.parseTagAddress(rt, addr, dt);
      assert.strictEqual(r.ok, false, '应解析失败');
      assert.ok(r.error.indexOf(expectMsg) >= 0, '错误信息 "' + r.error + '" 应包含 "' + expectMsg + '"');
    });
  });

  it('DOUBLE 拒绝文案符合契约（S7 驱动 v1 暂不支持 DOUBLE（LREAL），请改用 FLOAT）', function () {
    var r = s7addr.parseTagAddress('DB', 'DB1.DBD0', 'DOUBLE');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'S7 驱动 v1 暂不支持 DOUBLE（LREAL），请改用 FLOAT');
  });
});
