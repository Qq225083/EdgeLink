/**
 * mc-protocol — 三菱 MC Protocol 3E/4E 协议工具函数（v1.7.3）
 * v1.7.3: C059 错误码去重并更正为官方含义“命令/子命令指定错误”（删除错误的 Points out of range）
 * 与运行时解耦，便于单元测试
 * v1.5.1: 写帧 dataLen=12+2n 修正、原生位写（0x1401/0x0001：encodeBitWriteData/buildBitWriteFrame）、
 *         groupTagsContiguous 严格连续写分组（杜绝间隙填 0）、UINT16/INT32 越界钳制、
 *         addr=0 合法化、FX 八进制 8/9 拒绝、响应帧型严格校验、wordCount 函数级守卫
 * v1.4.4: 4E 帧规范重排（序列号+固定值进副标题，数据长 0x0C；响应 endCode@13/data@15）、
 *         X/Y 进制修正（FX=8 进制，Q/L/iQ-R=16 进制）、decodeTag 提取（32/64 位多字解码）、
 *         地址上限 0xFFFFFF、slope=0 合法化
 */

// ===== MC 软元件代码映射 =====
var MC_DEVICE_CODES = {
  'D': 0xA8, 'W': 0xB4, 'X': 0x9C, 'Y': 0x9D,
  'M': 0x90, 'L': 0x92, 'B': 0xA0, 'R': 0xAF
};
var BIT_DEVICES = { 'X': true, 'Y': true, 'M': true, 'L': true, 'B': true };
var WORD_32_TYPES = { 'INT32': true, 'UINT32': true, 'FLOAT32': true };
var WORD_64_TYPES = { 'DOUBLE': true, 'FLOAT64': true };

// 🔧 v1.4.4 修正进制规则：W/B 链接元件为 16 进制地址；
// X/Y 仅 FX(iQ-F) 系列为 8 进制，Q/L/iQ-R 均为 16 进制（旧注释"Q 系为 8 进制"有误）
function isFXSeries(plcSeries) {
  var s = String(plcSeries || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.indexOf('FX') === 0 || s.indexOf('IQF') === 0;
}
function isHexAddrDevice(regType, plcSeries) {
  if (regType === 'W' || regType === 'B') return true;
  if ((regType === 'X' || regType === 'Y') && !isFXSeries(plcSeries)) return true;
  return false;
}

// ===== MC 错误码映射 =====
var MC_ERROR_CODES = {
  0xC050: 'CPU busy', 0xC051: 'Device not supported', 0xC052: 'Address out of range',
  0xC053: 'Batch size out of range', 0xC054: 'Write protect error',
  0xC055: 'Remote operation error', 0xC056: 'File not found', 0xC057: 'File name error',
  0xC058: 'ASCII数据长与字符区不符', 0xC059: '命令/子命令指定错误', 0xC05B: 'CPU type mismatch', 0xC05C: 'Remote password error',
  0xC05F: 'CPU module error', 0xC061: 'Monitor timer timeout',
  0xC06F: 'ASCII code error', 0xC070: 'Frame length error',
  0xC0D0: 'PLC not running', 0x4004: '4E: Device not supported',
  0x401A: '4E: Address out of range', 0x4028: '4E: Points out of range'
};

function mcErrorText(code) {
  return MC_ERROR_CODES[code] || ('Unknown MC error 0x' + code.toString(16).toUpperCase());
}

function clampInt(v, def, min, max) {
  var n = parseInt(v, 10);
  if (isNaN(n)) n = def;
  return Math.max(min, Math.min(n, max));
}

function is32BitType(dt) {
  return !!WORD_32_TYPES[dt];
}

function is64BitType(dt) {
  return !!WORD_64_TYPES[dt];
}

/** 数据类型占用的字（寄存器）数：32 位=2 字，64 位=4 字，其余=1 字 */
function wordSpanOf(dt) {
  if (WORD_64_TYPES[dt]) return 4;
  if (WORD_32_TYPES[dt]) return 2;
  return 1;
}

function parseDeviceAddress(regType, rawAddr, plcSeries) {
  // 🔧 W/B 及非 FX 系列的 X/Y 为 16 进制地址（保留 A-F 字符再解析）
  // 🔧 修复：rawAddr 可能是数字 0（D0/M0/X0 是合法地址），不能用 || '' 兜底（0 是 falsy）
  var addrStr = (rawAddr === undefined || rawAddr === null) ? '' : String(rawAddr);
  var addr;
  if (isHexAddrDevice(regType, plcSeries)) {
    var hs = addrStr.replace(/[^0-9A-Fa-f]/g, '');
    if (!hs) return -1;
    addr = parseInt(hs, 16);
  } else {
    var s = addrStr.replace(/\D/g, '');
    if (!s) return -1;
    var radix = (regType === 'X' || regType === 'Y') ? 8 : 10;
    // 🔧 review#1: 八进制地址含 8/9 属非法（parseInt('18',8) 会静默截断为 1），直接拒绝
    if (radix === 8 && /[89]/.test(s)) return -1;
    addr = parseInt(s, radix);
  }
  // 🔧 v1.4.4: 3 字节软元件地址字段上限（0xFFFFFF），超限拒绝而非静默截断
  if (isNaN(addr) || addr < 0 || addr > 0xFFFFFF) return -1;
  return addr;
}

function formatDeviceAddress(regType, addr, plcSeries) {
  if (isHexAddrDevice(regType, plcSeries)) return regType + addr.toString(16).toUpperCase();
  if (regType === 'X' || regType === 'Y') return regType + addr.toString(8).toUpperCase();
  return regType + addr;
}

// ===== 帧构造 =====
function build3EFrame(startAddr, wordCount, stationNo, regType, networkNo) {
  // 🔧 review#6: 函数级上限守卫（业务层已按 960 字分组，防绕过调用溢出回绕）
  if (!(wordCount >= 1 && wordCount <= 960)) throw new Error('wordCount out of range (1-960): ' + wordCount);
  var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;
  var buf = Buffer.alloc(21);
  buf[0] = 0x50; buf[1] = 0x00;
  buf[2] = networkNo || 0; buf[3] = 0xFF; buf[4] = 0xFF; buf[5] = 0x03;
  buf[6] = stationNo || 0; buf[7] = 0x0C; buf[8] = 0x00;
  buf[9] = 0x10; buf[10] = 0x00;
  buf[11] = 0x01; buf[12] = 0x04; buf[13] = 0x00; buf[14] = 0x00;
  buf[15] = startAddr & 0xFF; buf[16] = (startAddr >> 8) & 0xFF;
  buf[17] = (startAddr >> 16) & 0xFF;
  buf[18] = deviceCode;
  buf.writeUInt16LE(wordCount, 19);
  return buf;
}

function build4EFrame(startAddr, wordCount, stationNo, regType, networkNo, serialNo) {
  // 🔧 v1.4.4 按 SLMP 规范重排（对照 pymcprotocol type4e.py / SH-080008）：
  // 副标题 54 00 + 序列号(2,LE) + 固定值 00 00(2) + 访问路由(网络/PC FF/IO FF03/站号)
  // 数据长 = 定时器(2)+指令(2)+子指令(2)+地址(3)+代码(1)+点数(2) = 12 (0x0C)，总长 25 字节。
  // 旧实现把序列号放在定时器之后且缺固定值（数据长误为 14），真机必报帧格式错误。
  var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;
  if (!(wordCount >= 1 && wordCount <= 960)) throw new Error('wordCount out of range (1-960): ' + wordCount);
  var buf = Buffer.alloc(25);
  buf[0] = 0x54; buf[1] = 0x00;
  buf[2] = serialNo & 0xFF; buf[3] = (serialNo >> 8) & 0xFF;
  buf[4] = 0x00; buf[5] = 0x00;
  buf[6] = networkNo || 0; buf[7] = 0xFF; buf[8] = 0xFF; buf[9] = 0x03;
  buf[10] = stationNo || 0;
  buf[11] = 0x0C; buf[12] = 0x00;
  buf[13] = 0x10; buf[14] = 0x00;
  buf[15] = 0x01; buf[16] = 0x04;
  buf[17] = 0x00; buf[18] = 0x00;
  buf[19] = startAddr & 0xFF; buf[20] = (startAddr >> 8) & 0xFF;
  buf[21] = (startAddr >> 16) & 0xFF;
  buf[22] = deviceCode;
  buf.writeUInt16LE(wordCount, 23);
  return buf;
}

// ===== 写入值编码（v1.5.0: 读解码的逆变换，byteOrder/wordOrder 为自逆操作）=====
/** JS 数值 → wire-format 16-bit 字数组；BOOL 类型抛异常（应由 RMW 路径处理） */
function encodeWriteWords(value, dataType, byteOrder, wordOrder) {
  var dt = dataType || 'INT16';
  if (dt === 'BOOL') throw new Error('encodeWriteWords does not support BOOL — use RMW path');

  function swap16(v) { return ((v & 0xFF) << 8) | ((v >> 8) & 0xFF); }

  if (dt === 'INT16' || dt === 'UINT16') {
    var v = parseInt(value, 10);
    if (isNaN(v)) v = 0;
    if (dt === 'UINT16') {
      if (v < 0) v = 0;  // P1-4: 负数不再通过 >>>0 静默回绕
      if (v > 65535) v = 65535;
      v = (v >>> 0) & 0xFFFF;
    } else {
      if (v < -32768) v = -32768;
      if (v > 32767) v = 32767;
      v = v & 0xFFFF;
    }
    return [byteOrder === 'BIG_ENDIAN' ? swap16(v) : v];
  }

  if (is32BitType(dt)) {
    var b32 = Buffer.alloc(4);
    if (dt === 'INT32') {
      // P1-4: NaN/clamp to 32-bit signed range，不用 value|0 静默截断
      var i32 = parseInt(value, 10);
      if (isNaN(i32)) i32 = 0;
      if (i32 > 2147483647) i32 = 2147483647;
      if (i32 < -2147483648) i32 = -2147483648;
      b32.writeInt32LE(i32);
    }
    else if (dt === 'UINT32') b32.writeUInt32LE((value >>> 0) || 0);
    else if (dt === 'FLOAT32') b32.writeFloatLE(parseFloat(value) || 0);
    var words = [b32.readUInt16LE(0), b32.readUInt16LE(2)];
    if (wordOrder === 'HIGH_FIRST') words.reverse();
    if (byteOrder === 'BIG_ENDIAN') words = words.map(swap16);
    return words;
  }

  if (is64BitType(dt)) {
    var b64 = Buffer.alloc(8);
    b64.writeDoubleLE(parseFloat(value) || 0);
    var w64 = [b64.readUInt16LE(0), b64.readUInt16LE(2), b64.readUInt16LE(4), b64.readUInt16LE(6)];
    if (wordOrder === 'HIGH_FIRST') w64.reverse();
    if (byteOrder === 'BIG_ENDIAN') w64 = w64.map(swap16);
    return w64;
  }

  // 未知类型按 INT16
  var def = parseInt(value, 10);
  if (isNaN(def)) def = 0;
  return [(byteOrder === 'BIG_ENDIAN' ? swap16(def) : def) & 0xFFFF];
}

// ===== 写帧构造 =====
function build3EWriteFrame(startAddr, words, stationNo, regType, networkNo) {
  // words: 16-bit 字值数组
  var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;
  var wc = words.length;
  if (!(wc >= 1 && wc <= 960)) throw new Error('wordCount out of range (1-960): ' + wc);
  // 数据长 = 定时器(2)+指令(2)+子指令(2)+地址(3)+代码(1)+点数(2)+写数据(2n) = 12+2n
  var dataLen = 12 + wc * 2;
  var buf = Buffer.alloc(21 + wc * 2);
  buf[0] = 0x50; buf[1] = 0x00;
  buf[2] = networkNo || 0; buf[3] = 0xFF; buf[4] = 0xFF; buf[5] = 0x03;
  buf[6] = stationNo || 0;
  buf.writeUInt16LE(dataLen, 7);
  buf[9] = 0x10; buf[10] = 0x00;
  buf[11] = 0x01; buf[12] = 0x14;  // 指令 0x1401 批量写
  buf[13] = 0x00; buf[14] = 0x00;
  buf[15] = startAddr & 0xFF; buf[16] = (startAddr >> 8) & 0xFF;
  buf[17] = (startAddr >> 16) & 0xFF;
  buf[18] = deviceCode;
  buf.writeUInt16LE(wc, 19);
  for (var wi = 0; wi < wc; wi++) buf.writeUInt16LE(words[wi] & 0xFFFF, 21 + wi * 2);
  return buf;
}

function build4EWriteFrame(startAddr, words, stationNo, regType, networkNo, serialNo) {
  var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;
  var wc = words.length;
  if (!(wc >= 1 && wc <= 960)) throw new Error('wordCount out of range (1-960): ' + wc);
  // 数据长 = 定时器(2)+指令(2)+子指令(2)+地址(3)+代码(1)+点数(2)+写数据(2n) = 12+2n
  var dataLen = 12 + wc * 2;
  var buf = Buffer.alloc(25 + wc * 2);
  buf[0] = 0x54; buf[1] = 0x00;
  buf[2] = serialNo & 0xFF; buf[3] = (serialNo >> 8) & 0xFF;
  buf[4] = 0x00; buf[5] = 0x00;
  buf[6] = networkNo || 0; buf[7] = 0xFF; buf[8] = 0xFF; buf[9] = 0x03;
  buf[10] = stationNo || 0;
  buf.writeUInt16LE(dataLen, 11);
  buf[13] = 0x10; buf[14] = 0x00;
  buf[15] = 0x01; buf[16] = 0x14;  // 指令 0x1401 批量写
  buf[17] = 0x00; buf[18] = 0x00;
  buf[19] = startAddr & 0xFF; buf[20] = (startAddr >> 8) & 0xFF;
  buf[21] = (startAddr >> 16) & 0xFF;
  buf[22] = deviceCode;
  buf.writeUInt16LE(wc, 23);
  for (var wi = 0; wi < wc; wi++) buf.writeUInt16LE(words[wi] & 0xFFFF, 25 + wi * 2);
  return buf;
}

/** 统一入口：无需调用方判 3E/4E */
function buildWriteFrame(frameType, startAddr, words, stationNo, regType, networkNo, serialNo) {
  return (frameType === '4E')
    ? build4EWriteFrame(startAddr, words, stationNo, regType, networkNo, serialNo || 0)
    : build3EWriteFrame(startAddr, words, stationNo, regType, networkNo);
}

// ===== v1.5.1: 原生位写入（消除 RMW 竞态，对标 pymcprotocol batchwrite_bitunits）=====
// SLMP 位单位批量写：子指令 0x0001，每字节打包 2 个位
// 偶索引（相对起始地址）占高 4 位(bits 4-7)，奇索引占低 4 位(bits 0-3)

/** 将位数组打包为 nibble-pair 字节。bits 必须严格连续（调用方 group 已保证），data.fill(0) 为防御性 dead code。 */
function encodeBitWriteData(bits) {
  if (!bits || bits.length === 0) return { data: Buffer.alloc(0), bitCount: 0, startAddr: 0 };
  var sorted = bits.slice().sort(function (a, b) { return a.addr - b.addr; });
  var startAddr = sorted[0].addr;
  var endAddr = sorted[sorted.length - 1].addr;
  var bitCount = endAddr - startAddr + 1;
  var dataLen = Math.ceil(bitCount / 2);
  var data = Buffer.alloc(dataLen);
  data.fill(0);  // 防御性：严格连续场景每个 nibble 都有主，永不可达
  for (var i = 0; i < sorted.length; i++) {
    var localIdx = sorted[i].addr - startAddr;
    var byteIdx = Math.floor(localIdx / 2);
    if (localIdx % 2 === 0) {
      if (sorted[i].value) data[byteIdx] |= 0x10;  // 偶→高 nibble
    } else {
      if (sorted[i].value) data[byteIdx] |= 0x01;  // 奇→低 nibble
    }
  }
  return { data: data, bitCount: bitCount, startAddr: startAddr };
}

function build3EBitWriteFrame(startAddr, bitCount, data, stationNo, regType, networkNo) {
  var deviceCode = MC_DEVICE_CODES[regType] || 0x90;
  if (!(bitCount >= 1 && bitCount <= 960)) throw new Error('bitCount out of range (1-960): ' + bitCount);
  var dataBytes = Math.ceil(bitCount / 2);
  var dataLen = 12 + dataBytes;  // 定时器2+指令2+子指令2+地址3+代码1+点数2+数据n
  var buf = Buffer.alloc(21 + dataBytes);
  buf[0] = 0x50; buf[1] = 0x00;
  buf[2] = networkNo || 0; buf[3] = 0xFF; buf[4] = 0xFF; buf[5] = 0x03;
  buf[6] = stationNo || 0;
  buf.writeUInt16LE(dataLen, 7);
  buf[9] = 0x10; buf[10] = 0x00;
  buf[11] = 0x01; buf[12] = 0x14;  // 指令 0x1401
  buf[13] = 0x01; buf[14] = 0x00;  // 子指令 0x0001 位单位批量写入
  buf[15] = startAddr & 0xFF; buf[16] = (startAddr >> 8) & 0xFF;
  buf[17] = (startAddr >> 16) & 0xFF;
  buf[18] = deviceCode;
  buf.writeUInt16LE(bitCount, 19);
  data.copy(buf, 21);
  return buf;
}

function build4EBitWriteFrame(startAddr, bitCount, data, stationNo, regType, networkNo, serialNo) {
  var deviceCode = MC_DEVICE_CODES[regType] || 0x90;
  if (!(bitCount >= 1 && bitCount <= 960)) throw new Error('bitCount out of range (1-960): ' + bitCount);
  var dataBytes = Math.ceil(bitCount / 2);
  var dataLen = 12 + dataBytes;
  var buf = Buffer.alloc(25 + dataBytes);
  buf[0] = 0x54; buf[1] = 0x00;
  buf[2] = serialNo & 0xFF; buf[3] = (serialNo >> 8) & 0xFF;
  buf[4] = 0x00; buf[5] = 0x00;
  buf[6] = networkNo || 0; buf[7] = 0xFF; buf[8] = 0xFF; buf[9] = 0x03;
  buf[10] = stationNo || 0;
  buf.writeUInt16LE(dataLen, 11);
  buf[13] = 0x10; buf[14] = 0x00;
  buf[15] = 0x01; buf[16] = 0x14;  // 指令 0x1401
  buf[17] = 0x01; buf[18] = 0x00;  // 子指令 0x0001
  buf[19] = startAddr & 0xFF; buf[20] = (startAddr >> 8) & 0xFF;
  buf[21] = (startAddr >> 16) & 0xFF;
  buf[22] = deviceCode;
  buf.writeUInt16LE(bitCount, 23);
  data.copy(buf, 25);
  return buf;
}

function buildBitWriteFrame(frameType, startAddr, bitCount, data, stationNo, regType, networkNo, serialNo) {
  return (frameType === '4E')
    ? build4EBitWriteFrame(startAddr, bitCount, data, stationNo, regType, networkNo, serialNo || 0)
    : build3EBitWriteFrame(startAddr, bitCount, data, stationNo, regType, networkNo);
}

// ===== v1.5.1: 串口 ASCII 通信模式（二进制帧 → hex + STX/ETX/checksum）=====
// ⚠ 仅适用于 RS-232/485 C24 串口模块；以太网 SLMP ASCII Code 请用 toAsciiHex / dehexifyFrame
// 部分老旧现场只开串口 ASCII；3E/4E 二进制帧经 hex 编码后按此格式收发

/** 二进制 Buffer → 串口 ASCII 帧 Buffer。格式: STX(1) + hex(2N) + ETX(1) + checksum(2 hex ASCII) */
function asciify(buf) {
  var sum = 0;
  var hex = '';
  for (var i = 0; i < buf.length; i++) {
    sum = (sum + buf[i]) & 0xFF;
    hex += ('0' + buf[i].toString(16)).slice(-2).toUpperCase();
  }
  var chk = ('0' + sum.toString(16)).slice(-2).toUpperCase();
  return Buffer.concat([
    Buffer.from([0x02]),        // STX
    Buffer.from(hex, 'ascii'),  // N 字节的 hex 编码
    Buffer.from([0x03]),        // ETX
    Buffer.from(chk, 'ascii')   // checksum 2 个 ASCII hex
  ]);
}

/**
 * 从累加缓冲区中提取串口 ASCII 帧。
 * 返回 { result: Buffer, consumed: number } 成功，
 * 或 { consumed: number } 等待更多数据，
 * 或 { err, consumed } 格式错误（已跳过坏帧）。
 */
function deasciify(buf) {
  if (!buf || buf.length < 4) return { consumed: 0 };  // 至少 STX+ETX+2chk = 4

  var stxIdx = buf.indexOf(0x02);
  if (stxIdx < 0) return { consumed: buf.length };  // 无 STX，全部丢弃

  // ETX 在 STX 之后
  var afterStx = buf.slice(stxIdx + 1);
  var etxIdx = afterStx.indexOf(0x03);
  if (etxIdx < 0) return { consumed: stxIdx };  // 保留 STX，等更多数据

  // 需要 ETX 后 2 字节 checksum
  var totalNeeded = stxIdx + 1 + etxIdx + 1 + 2;
  if (buf.length < totalNeeded) return { consumed: stxIdx };

  var hexStart = stxIdx + 1;
  var hexLen = etxIdx;
  var hexStr = buf.slice(hexStart, hexStart + hexLen).toString('ascii');

  if (hexLen % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hexStr)) {
    return { err: 'Invalid hex data in ASCII frame', consumed: totalNeeded };
  }

  var n = hexLen / 2;
  var result = Buffer.alloc(n);
  for (var hi = 0; hi < n; hi++) {
    result[hi] = parseInt(hexStr.substr(hi * 2, 2), 16);
  }

  // 校验和
  var sum = 0;
  for (var si = 0; si < result.length; si++) sum = (sum + result[si]) & 0xFF;
  var chkStr = buf.slice(hexStart + hexLen + 1, hexStart + hexLen + 3).toString('ascii');
  var expected = parseInt(chkStr, 16);
  if (isNaN(expected) || sum !== expected) {
    return { err: 'Checksum mismatch (got ' + sum.toString(16).toUpperCase() + ' expected ' + chkStr.toUpperCase() + ')', consumed: totalNeeded };
  }

  return { result: result, consumed: totalNeeded };
}

// ===== v1.5.2: SLMP ASCII Code（以太网 — 二进制帧 ⟷ hex 编解码，无 STX/ETX/校验和）=====
// 三菱 SLMP（以太网 MC 协议）支持两种通信数据代码：
//   Binary Code：原始 3E/4E 二进制帧（默认）
//   ASCII Code：整帧逐字节转 2 个 hex 字元，无任何帧头/帧尾/校验和（TCP 保证完整性）
// 此功能用于连接以太网口设置为 ASCII Code 的 PLC（旧设备/特定场景）

/** 二进制 Buffer → SLMP ASCII Code hex Buffer（纯 hex 文本，无 STX/ETX/校验和） */
// ===== v1.5.2 修正: SLMP ASCII Code 按字段正确编解码 =====

/** 二进制帧 → SLMP ASCII Code（按字段正确编码，UInt16 转大端 hex 字符串） */
function toAsciiHex(buf) {
  if (!buf || buf.length < 11) return Buffer.alloc(0);
  var is4E = (buf[0] === 0x54 || buf[0] === 0xD4);
  var isResp = (buf[0] === 0xD0 || buf[0] === 0xD4);  // 🔧 响应帧（无地址/点数段，写响应仅 11/15 字节）
  var hex = '';
  
  function b2h(b) { return ('0' + b.toString(16)).slice(-2).toUpperCase(); }
  function u16le2h(off) { return buf.readUInt16LE(off).toString(16).padStart(4, '0').toUpperCase(); }
  
  // 响应帧：子头 + 序列号(4E) + 固定值(4E) + 路由 + 数据长度 + 结束码 + 数据区
  if (isResp) {
    hex += b2h(buf[0]);      // 子头低（D0/D4）
    hex += b2h(buf[1]);      // 子头高
    if (is4E) {
      if (buf.length < 15) return Buffer.alloc(0);
      hex += u16le2h(2);     // 序列号回显
      hex += u16le2h(4);     // 固定值
    }
    var r = is4E ? 6 : 2;    // 路由起点（4E 多 4 字节）
    hex += b2h(buf[r]);      // 网络号
    hex += b2h(buf[r + 1]);  // PC号
    hex += u16le2h(r + 2);   // IO编号
    hex += b2h(buf[r + 4]);  // 站号
    hex += u16le2h(is4E ? 11 : 7);   // 数据长度
    hex += u16le2h(is4E ? 13 : 9);   // 结束码
    var dataStart = is4E ? 15 : 11;
    for (var ri = dataStart; ri < buf.length; ri++) hex += b2h(buf[ri]); // 数据区（读响应）
    return Buffer.from(hex, 'ascii');
  }
  
  if (is4E) {
    if (buf.length < 15) return Buffer.alloc(0);
    hex += b2h(buf[0]);      // 子头低
    hex += b2h(buf[1]);      // 子头高
    hex += u16le2h(2);       // 序列号
    hex += u16le2h(4);       // 固定值 0000
    hex += b2h(buf[6]);      // 网络号
    hex += b2h(buf[7]);      // PC号
    hex += u16le2h(8);       // IO编号
    hex += b2h(buf[10]);     // 站号
    hex += u16le2h(11);      // 数据长度
    hex += u16le2h(13);      // 监视定时器
    hex += u16le2h(15);      // 命令
    hex += u16le2h(17);      // 子命令
    for (var i = 19; i <= 21; i++) hex += b2h(buf[i]); // 地址 3 字节
    hex += b2h(buf[22]);     // 设备代码
    hex += u16le2h(23);      // 点数
    for (var i = 25; i < buf.length; i++) hex += b2h(buf[i]); // 后续数据
  } else {
    // 3E 帧
    hex += b2h(buf[0]);      // 子头低
    hex += b2h(buf[1]);      // 子头高
    hex += b2h(buf[2]);      // 网络号
    hex += b2h(buf[3]);      // PC号
    hex += u16le2h(4);       // IO编号
    hex += b2h(buf[6]);      // 站号
    hex += u16le2h(7);       // 数据长度
    hex += u16le2h(9);       // 监视定时器
    hex += u16le2h(11);      // 命令
    hex += u16le2h(13);      // 子命令
    for (var i = 15; i <= 17; i++) hex += b2h(buf[i]); // 地址 3 字节
    hex += b2h(buf[18]);     // 设备代码
    hex += u16le2h(19);      // 点数
    for (var i = 21; i < buf.length; i++) hex += b2h(buf[i]); // 后续数据
  }
  return Buffer.from(hex, 'ascii');
}

/** SLMP ASCII Code → 二进制帧（按字段正确解码，UInt16 大端字符串转回 UInt16LE） */
function fromAsciiHex(asciiBuf) {
  if (!asciiBuf || asciiBuf.length === 0 || asciiBuf.length % 2 !== 0) return null;
  var hexStr = asciiBuf.toString('ascii');
  if (!/^[0-9A-Fa-f]*$/.test(hexStr)) return null;
  
  var subheader = parseInt(hexStr.substr(0, 2), 16);
  var is4E = (subheader === 0x54 || subheader === 0xD4);
  var is3E = (subheader === 0x50 || subheader === 0xD0);
  if (!is3E && !is4E) return null;
  var isResponse = (subheader === 0xD0 || subheader === 0xD4);

  function h2b(off) { return parseInt(hexStr.substr(off, 2), 16); }
  function h2u16le(hexOff, buf, bufOff) {
    var val = parseInt(hexStr.substr(hexOff, 4), 16);
    buf.writeUInt16LE(val, bufOff);
  }
  
  var result;
  if (is4E) {
    if (hexStr.length < (isResponse ? 30 : 50)) return null;
    result = Buffer.alloc(hexStr.length / 2);
    result[0] = h2b(0);  result[1] = h2b(2);
    h2u16le(4, result, 2);   h2u16le(8, result, 4);
    result[6] = h2b(12);     result[7] = h2b(14);
    h2u16le(16, result, 8);  result[10] = h2b(20);
    h2u16le(22, result, 11); h2u16le(26, result, 13);
    if (isResponse) {
      // 响应帧：字节 15 起每个数据字 = 4 hex 字符（大端值）→ LE 2 字节
      for (var i = 30; i < hexStr.length; i += 4) h2u16le(i, result, 15 + (i - 30) / 2);
    } else {
      h2u16le(30, result, 15); h2u16le(34, result, 17);
      result[19] = h2b(38);    result[20] = h2b(40);
      result[21] = h2b(42);    result[22] = h2b(44);
      h2u16le(46, result, 23);
      for (var i = 50; i < hexStr.length; i += 2) result[25 + (i - 50) / 2] = h2b(i);
    }
  } else {
    if (hexStr.length < (isResponse ? 22 : 42)) return null;
    result = Buffer.alloc(hexStr.length / 2);
    result[0] = h2b(0);  result[1] = h2b(2);
    result[2] = h2b(4);  result[3] = h2b(6);
    h2u16le(8, result, 4);   result[6] = h2b(12);
    h2u16le(14, result, 7);  h2u16le(18, result, 9);
    if (isResponse) {
      // 响应帧：字节 11 起每个数据字 = 4 hex 字符（大端值）→ LE 2 字节
      for (var i = 22; i < hexStr.length; i += 4) h2u16le(i, result, 11 + (i - 22) / 2);
    } else {
      h2u16le(22, result, 11); h2u16le(26, result, 13);
      result[15] = h2b(30);    result[16] = h2b(32);
      result[17] = h2b(34);    result[18] = h2b(36);
      h2u16le(38, result, 19);
      for (var i = 42; i < hexStr.length; i += 2) result[21 + (i - 42) / 2] = h2b(i);
    }
  }
  return result;
}

/** 从 TCP 累加缓冲区中提取完整 ASCII 帧并解码为二进制 */
function dehexifyFrame(buf, hdrLen, dataLenOff) {
  var asciiHdrLen = hdrLen * 2;
  if (buf.length < asciiHdrLen) return { consumed: 0 };
  
  var hdrHex = buf.toString('ascii', 0, asciiHdrLen);
  if (!/^[0-9A-Fa-f]*$/.test(hdrHex)) return { err: 'Non-hex chars in frame header', consumed: 1 };
  
  var subheader = parseInt(hdrHex.substr(0, 2), 16);
  var is4E = (subheader === 0x54 || subheader === 0xD4);
  
  // ASCII 中数据长度字段偏移 = 二进制偏移 * 2，长度 4 字符
  var asciiDataLenOff = dataLenOff * 2;
  var dataLen = parseInt(hdrHex.substr(asciiDataLenOff, 4), 16) - 2;
  
  if (dataLen < 0 || dataLen > 2000) return { err: 'dataLen out of range: ' + dataLen, consumed: asciiHdrLen };
  
  var fullBinLen = hdrLen + dataLen;
  var totalHexLen = fullBinLen * 2;
  if (buf.length < totalHexLen) return { consumed: 0 };
  
  var bin = fromAsciiHex(buf.slice(0, totalHexLen));
  if (!bin) return { err: 'Hex decode failed for full frame', consumed: totalHexLen };
  return { result: bin, consumed: totalHexLen };
}

/**
 * 从 TCP 累加缓冲区中按 SLMP ASCII Code 提取完整帧并解码为二进制。
 * buf：累积的 hex 字符 Buffer（由多次 data 事件 concat 而来）
 * hdrLen：二进制 header 字节数（3E=11, 4E=15）
 * dataLenOff：header 中 data length 字段偏移（3E=7, 4E=11）
 *
 * @returns { result: Buffer, consumed: number } — 成功提取完整帧（result 为二进制）
 * @returns { consumed: number }              — 数据不足，等待下一 chunk
 * @returns { err: string, consumed: number } — hex 格式错误（已跳过 consumed 字节）
 */


// ===== 写响应解析 =====
// 写响应无数据区：3E 结束码 @9、4E 结束码 @13
function parseMCWriteResponse(buf, frameType, sentSN) {
  var is4E = (frameType === '4E');
  var minLen = is4E ? 15 : 11;
  if (!buf || buf.length < minLen) return { err: 'Buffer too short' };
  if (is4E && buf[0] !== 0xD4) return { err: 'Invalid subheader (expect 0xD4 for 4E)' };
  if (!is4E && buf[0] !== 0xD0) return { err: 'Invalid subheader (expect 0xD0 for 3E)' };
  if (is4E && sentSN !== undefined && sentSN !== null) {
    if (buf.readUInt16LE(2) !== sentSN) return { err: 'SerialNo mismatch' };
  }
  var endCodeOff = is4E ? 13 : 9;
  var endCode = buf.readUInt16LE(endCodeOff);
  if (endCode !== 0) return { mcError: endCode, mcErrorText: mcErrorText(endCode) };
  return { ok: true };
}

// ===== RMW 位操作分组（v1.5.0）=====
/** 将位写入 tag 按所在字分组，返回 [{ wordAddr, regType, bits: [{bitOffset, value}] }] */
function buildRMWWriteGroup(bitTags, regType, plcSeries) {
  var byWord = {};
  for (var i = 0; i < bitTags.length; i++) {
    var t = bitTags[i];
    var bitOff, wordAddr;
    if (BIT_DEVICES[regType]) {
      // M/X/Y/L/B：每个地址就是一个位，16 位一字
      bitOff = t.addr % 16;
      wordAddr = t.addr - bitOff;
    } else {
      // 字设备 BOOL：bitOffset 指定字内位（0-15），wordAddr = addr
      bitOff = (t.bitOffset !== null && t.bitOffset !== undefined) ? t.bitOffset : 0;
      wordAddr = t.addr;
    }
    var wk = regType + wordAddr;
    if (!byWord[wk]) byWord[wk] = { wordAddr: wordAddr, regType: regType, bits: [] };
    byWord[wk].bits.push({ bitOffset: bitOff, value: t.value ? 1 : 0, tagId: t.id });
  }
  var result = [];
  Object.keys(byWord).forEach(function (k) { result.push(byWord[k]); });
  // 按地址排序；组内 bits 按 bitOffset 排序（确定性输出，便于测试）
  result.sort(function (a, b) { return a.wordAddr - b.wordAddr; });
  result.forEach(function (r) { r.bits.sort(function (a, b) { return a.bitOffset - b.bitOffset; }); });
  return result;
}

// ===== 响应解析 =====
// 3E 响应: D4 00 布局[D0 00 | 路由(5) | 数据长@7(2) | 结束码@9(2) | 数据@11]
// 4E 响应: [D4 00 | 序列号@2(2) | 固定值@4(2) | 路由(5) | 数据长@11(2) | 结束码@13(2) | 数据@15]
function parseMCResponse(buf, startAddr, regType, frameType, sentSN) {
  var is4E = (frameType === '4E');
  var minLen = is4E ? 15 : 11;
  if (!buf || buf.length < minLen) return { err: 'Buffer too short' };
  // 🔧 review#9: 响应帧型必须与请求帧型严格一致（3E↔D0 00、4E↔D4 00），防错配置下错偏移解析
  if (is4E && buf[0] !== 0xD4) return { err: 'Invalid subheader (expect 0xD4 for 4E)' };
  if (!is4E && buf[0] !== 0xD0) return { err: 'Invalid subheader (expect 0xD0 for 3E)' };
  if (is4E && buf[0] === 0xD4 && sentSN !== undefined && sentSN !== null) {
    if (buf.readUInt16LE(2) !== sentSN) return { err: 'SerialNo mismatch' };
  }

  var lenOff = is4E ? 11 : 7;
  var endCodeOff = is4E ? 13 : 9;
  var dataStart = is4E ? 15 : 11;
  var endCode = buf.readUInt16LE(endCodeOff);
  if (endCode !== 0) return { mcError: endCode, mcErrorText: mcErrorText(endCode) };

  var dataLen = buf.readUInt16LE(lenOff) - 2;  // 数据长字段含结束码 2 字节
  if (dataLen < 0 || dataLen > 2000) return { err: 'Bad dataLen: ' + dataLen };
  if (buf.length < dataStart + dataLen) return { err: 'Incomplete frame' };

  var result = {};
  if (BIT_DEVICES[regType]) {
    for (var w = 0; w < dataLen / 2; w++) {
      var wordVal = buf.readUInt16LE(dataStart + w * 2);
      for (var b = 0; b < 16; b++) {
        result[regType + (startAddr + w * 16 + b)] = (wordVal >> b) & 1;
      }
    }
  } else {
    for (var i = 0; i < dataLen / 2; i++) {
      result[regType + (startAddr + i)] = buf.readInt16LE(dataStart + i * 2);
    }
  }
  return result;
}

// ===== 点位分组（v1.4.4 从 mitsubishi-read 内联逻辑提取，可单测）=====
// 按寄存器类型分组、地址排序后聚类：相邻地址间隙 ≤20 且**组内总字数 ≤960**（MC 批量读协议上限）。
// 旧实现 cluster<50 是保守拍脑袋值：万点场景帧数被放大 ~20 倍（200+ 帧 vs 11 帧）。
function groupTags(tags) {
  var byRegType = {};
  tags.forEach(function (t) {
    if (!byRegType[t.regType]) byRegType[t.regType] = [];
    byRegType[t.regType].push(t);
  });
  var groups = [];
  Object.keys(byRegType).forEach(function (rt) {
    var isBit = !!BIT_DEVICES[rt];
    var sorted = byRegType[rt].slice().sort(function (a, b) { return a.addr - b.addr; });
    function spanOf(t) { return isBit ? 0 : (wordSpanOf(t.dataType) - 1); }
    function wordsOf(start, max) {
      var s = start;
      if (isBit) s = s - (s % 16);
      return isBit ? Math.ceil((max - s + 1) / 16) : (max - start + 1);
    }
    var cluster = [sorted[0]];
    var clStart = sorted[0].addr;
    var clMax = sorted[0].addr + spanOf(sorted[0]);
    for (var i = 1; i < sorted.length; i++) {
      var t = sorted[i];
      var gap = t.addr - cluster[cluster.length - 1].addr;
      var candMax = Math.max(clMax, t.addr + spanOf(t));
      if (gap <= 20 && wordsOf(clStart, candMax) <= 960) {
        cluster.push(t);
        clMax = candMax;
      } else {
        groups.push({ regType: rt, tags: cluster });
        cluster = [t];
        clStart = t.addr;
        clMax = t.addr + spanOf(t);
      }
    }
    if (cluster.length > 0) groups.push({ regType: rt, tags: cluster });
  });
  return groups;
}

// ===== v1.5.0: 写入严格连续分组（无间隙，杜绝填 0 清空 PLC）=====
// 与 groupTags 不同：groupTags 允 20-gap 聚类（读场景松散，多读几个字无害）；
// 写入必须 addr+span 严格衔接才同组，有间隙就拆组——否则批量写中间隙会被填 0 破坏数据。
function groupTagsContiguous(tags) {
  var byRegType = {};
  tags.forEach(function (t) {
    if (!byRegType[t.regType]) byRegType[t.regType] = [];
    byRegType[t.regType].push(t);
  });
  var groups = [];
  Object.keys(byRegType).forEach(function (rt) {
    var isBit = !!BIT_DEVICES[rt];
    var sorted = byRegType[rt].slice().sort(function (a, b) { return a.addr - b.addr; });
    function spanOf(t) { return isBit ? 0 : (wordSpanOf(t.dataType) - 1); }
    function wordsOf(start, max) {
      var s = start;
      if (isBit) s = s - (s % 16);
      return isBit ? Math.ceil((max - s + 1) / 16) : (max - start + 1);
    }
    var cluster = [sorted[0]];
    var clStart = sorted[0].addr;
    var clMax = sorted[0].addr + spanOf(sorted[0]);
    for (var i = 1; i < sorted.length; i++) {
      var t = sorted[i];
      // 🔧 P0-2: 严格连续（next.addr == clMax+1），有间隙→拆组
      if (t.addr === clMax + 1 && wordsOf(clStart, clMax + 1 + spanOf(t)) <= 960) {
        cluster.push(t);
        clMax = clMax + 1 + spanOf(t);
      } else {
        groups.push({ regType: rt, tags: cluster });
        cluster = [t];
        clStart = t.addr;
        clMax = t.addr + spanOf(t);
      }
    }
    if (cluster.length > 0) groups.push({ regType: rt, tags: cluster });
  });
  return groups;
}

// ===== 点位解码（v1.4.4 从 mitsubishi-read 内联逻辑提取，可单测）=====
// raw = { 寄存器类型+地址: 字值 } 映射；返回 { value, quality, rawWord }
// quality: 0=GOOD 2=数据缺失；rawWord=首字原始值（备查）
function decodeTag(raw, regType, addr, dataType, byteOrder, wordOrder, bitOffset) {
  var isBit = !!BIT_DEVICES[regType];
  var originRv = raw[regType + addr];
  if (originRv === undefined || originRv === null) return { value: null, quality: 2, rawWord: null };
  if (isBit) return { value: originRv, quality: 0, rawWord: originRv };

  var dtTag = dataType || 'INT16';
  // byteOrder：16 位字内字节交换（默认 LITTLE_ENDIAN 不换；BIG_ENDIAN 交换后保持有符号语义）
  var wordVal = originRv;
  if (byteOrder === 'BIG_ENDIAN') {
    wordVal = ((originRv & 0xFF) << 8) | ((originRv >> 8) & 0xFF);
    if (wordVal >= 0x8000) wordVal -= 0x10000;
  }
  if (dtTag === 'BOOL') {
    // 字内取位（如 D100.3）：bitOffset 调用方已钳制 0-15
    // 🔧 修复#5：必须按 byteOrder 换序后再取位（此前用未换序的 originRv，BIG_ENDIAN 下位偏移整体错 8 位）
    var bitsWord = (byteOrder === 'BIG_ENDIAN')
      ? (((originRv & 0xFF) << 8) | ((originRv >> 8) & 0xFF))
      : (originRv & 0xFFFF);
    return { value: (bitsWord >> (bitOffset || 0)) & 1, quality: 0, rawWord: originRv };
  }
  if (dtTag === 'UINT16') return { value: (wordVal < 0) ? wordVal + 65536 : wordVal, quality: 0, rawWord: originRv };
  if (dtTag === 'INT16') return { value: wordVal, quality: 0, rawWord: originRv };

  if (is32BitType(dtTag) || is64BitType(dtTag)) {
    // 32/64 位类型：按跨度取相邻字，byteOrder 逐字处理，wordOrder 决定低字先后（默认 LOW_FIRST）
    var span = wordSpanOf(dtTag);
    var words = [];
    for (var wi = 0; wi < span; wi++) {
      var w = raw[regType + (addr + wi)];
      if (w === undefined || w === null) return { value: null, quality: 2, rawWord: originRv };
      if (byteOrder === 'BIG_ENDIAN') {
        w = ((w & 0xFF) << 8) | ((w >> 8) & 0xFF);
      }
      words.push(w & 0xFFFF);
    }
    if (wordOrder === 'HIGH_FIRST') words.reverse();
    if (is32BitType(dtTag)) {
      var combined = (words[1] << 16) | words[0];  // JS 位运算天然 int32 有符号
      if (dtTag === 'INT32') return { value: combined, quality: 0, rawWord: originRv };
      if (dtTag === 'UINT32') return { value: combined >>> 0, quality: 0, rawWord: originRv };
      if (dtTag === 'FLOAT32') {
        var b32 = Buffer.alloc(4);
        b32.writeUInt16LE(words[0], 0); b32.writeUInt16LE(words[1], 2);
        // 🔧 review#3: 不再 toFixed(4) 截断（0.00006 会被抹成 0.0001），保留完整精度
        return { value: b32.readFloatLE(0), quality: 0, rawWord: originRv };
      }
    }
    // DOUBLE（64 位浮点，4 字）
    var b64 = Buffer.alloc(8);
    for (var bi = 0; bi < 4; bi++) b64.writeUInt16LE(words[bi], bi * 2);
    return { value: b64.readDoubleLE(0), quality: 0, rawWord: originRv };
  }
  // 未知类型：按原值返回（调用方决定如何标记）
  return { value: originRv, quality: 0, rawWord: originRv };
}

// ===== v1.6.0: 工程值舍入 =====
// 10 位小数舍入消除浮点算术尾巴（27862*0.1=2786.2000000000003 → 2786.2），
// 同时保留小值精度（0.00006 不会像 review#3 前的 toFixed(4) 那样被抹成 0.0001）。
// |v|≥9e5 时 v*1e10 逼近 2^53，舍入反而引入误差，直接返回（大整数本身无尾巴）。
// 注：FLOAT32 解码源的值本身只有 ~7 位有效数字（PLC 存 2786.2 实为 2786.199951…），
// 此处按 10 位小数保留其精确值，显示层格式化另行处理。
function roundEng(v) {
  if (v === null || v === undefined) return v;
  if (Math.abs(v) >= 9e5) return v;
  return Math.round(v * 1e10) / 1e10;
}

// ===== 斜率偏移变换 =====
function applyTransform(rawValue, tagDef) {
  if (rawValue === null || rawValue === undefined) return null;
  // 🔧 slope=0 是合法值（恒等输出 offset），不能用 || 兜底成 1
  var slopeRaw = (tagDef.slope !== undefined && tagDef.slope !== null) ? tagDef.slope : tagDef.transformSlopeA;
  var offsetRaw = (tagDef.offset !== undefined && tagDef.offset !== null) ? tagDef.offset : tagDef.transformOffsetB;
  var slope = parseFloat((slopeRaw === undefined || slopeRaw === null) ? 1 : slopeRaw);
  var offset = parseFloat((offsetRaw === undefined || offsetRaw === null) ? 0 : offsetRaw);
  if (isNaN(slope)) slope = 1;
  if (isNaN(offset)) offset = 0;
  // 🔧 v1.6.0: 10 位小数舍入（与 review#3 "不去尾" 的和解方案：小值保得住，尾巴也没有）
  return roundEng(rawValue * slope + offset);
}


// ===== v1.7.0: Q 系列 MC 协议 ASCII（ascii_q，Q06UDEH 实机验证 2026-08-06）=====
// 与 SLMP ASCII（hex 直译）的两个关键差异：
//   ① 设备段 = 软元件名(2字符) + 6位地址（X/Y/W/B 十六进制，D/M/L/R 十进制）
//   ② 数据长字段 = 其后的 ASCII 字符数（不是二进制字节数）
var MC_DEVICE_NAMES = { D: 'D*', W: 'W*', X: 'X*', Y: 'Y*', M: 'M*', L: 'L*', B: 'B*', R: 'R*' };

function _h2(v) { return ('0' + v.toString(16)).slice(-2).toUpperCase(); }
function _h4(v) { return ('000' + v.toString(16)).slice(-4).toUpperCase(); }
function _isHexNameDev(rt) { return rt === 'X' || rt === 'Y' || rt === 'W' || rt === 'B'; }
function _addr6(startAddr, regType) {
  var s = _isHexNameDev(regType) ? startAddr.toString(16).toUpperCase() : String(startAddr);
  return ('000000' + s).slice(-6);
}

/** ascii_q 读请求（0401 字单位）→ ASCII 文本帧 Buffer */
function build3EAsciiQReadFrame(startAddr, wordCount, stationNo, regType, networkNo) {
  if (!(wordCount >= 1 && wordCount <= 960)) throw new Error('wordCount out of range (1-960): ' + wordCount);
  var body = '0010' + '0401' + '0000' + (MC_DEVICE_NAMES[regType] || 'D*') + _addr6(startAddr, regType) + _h4(wordCount);
  var head = '5000' + _h2(networkNo || 0) + 'FF' + '03FF' + _h2(stationNo || 0);
  return Buffer.from(head + _h4(body.length) + body, 'ascii');
}

/**
 * ascii_q 响应提取：TCP 累加缓冲 → 二进制 3E 响应帧（直接复用 parseMCResponse）
 * 返回 { result, consumed } / { consumed } 数据不足 / { err, consumed } 格式错误
 */
function extractAsciiQResponse(buf) {
  if (buf.length < 18) return { consumed: 0 };
  var head = buf.toString('ascii', 0, 18);
  if (!/^[0-9A-Fa-f]{18}$/.test(head) || head.substr(0, 4).toUpperCase() !== 'D000') {
    return { err: 'Bad ASCII-Q header', consumed: 1 };
  }
  var dataChars = parseInt(head.substr(14, 4), 16);   // ← 字符数语义（实机确认）
  if (isNaN(dataChars) || dataChars < 4 || dataChars > 8000) return { err: 'Bad dataLen: ' + head.substr(14, 4), consumed: 18 };
  var total = 18 + dataChars;
  if (buf.length < total) return { consumed: 0 };     // 帧不完整，等更多数据
  var text = buf.toString('ascii', 0, total);
  var endCode = parseInt(text.substr(18, 4), 16);
  // 🔧 v1.7.1: ASCII 数据区是"数值的字符表示"（值30 → "001E"），不是内存字节序；
  // 逐字解析再按 LE 写入二进制中间帧，下游 readInt16LE 才能读出原值（否则 30 变 7680）
  var payload;
  if (endCode === 0) {
    var dataHex = text.substr(22);
    var nWords = Math.floor(dataHex.length / 4);
    payload = Buffer.alloc(nWords * 2);
    for (var wi = 0; wi < nWords; wi++) {
      payload.writeUInt16LE(parseInt(dataHex.substr(wi * 4, 4), 16) & 0xFFFF, wi * 2);
    }
  } else {
    payload = Buffer.from(text.substr(22), 'hex');  // 错误详情为字段结构，原样保留备查
  }
  var bin = Buffer.alloc(11 + payload.length);
  bin[0] = 0xD0; bin[1] = 0x00;
  bin[2] = parseInt(text.substr(4, 2), 16);
  bin[3] = parseInt(text.substr(6, 2), 16);
  bin[4] = 0xFF; bin[5] = 0x03;
  bin[6] = parseInt(text.substr(12, 2), 16);
  bin.writeUInt16LE(2 + payload.length, 7);           // 二进制语义：含结束码 2 字节
  bin.writeUInt16LE(endCode, 9);
  payload.copy(bin, 11);
  return { result: bin, consumed: total };
}

/** ascii_q 批量写请求（1401 字单位）→ ASCII 文本帧 Buffer
 *  数据区每字 = 4 位大写 hex（值 30 → "001E"），与读取解析互逆 */
function build3EAsciiQWriteFrame(startAddr, words, stationNo, regType, networkNo) {
  var wc = (words || []).length;
  if (!(wc >= 1 && wc <= 960)) throw new Error('wordCount out of range (1-960): ' + wc);
  var data = '';
  for (var i = 0; i < wc; i++) data += _h4(words[i] & 0xFFFF);
  var body = '0010' + '1401' + '0000' + (MC_DEVICE_NAMES[regType] || 'D*') + _addr6(startAddr, regType) + _h4(wc) + data;
  var head = '5000' + _h2(networkNo || 0) + 'FF' + '03FF' + _h2(stationNo || 0);
  return Buffer.from(head + _h4(body.length) + body, 'ascii');
}

module.exports = {
  MC_DEVICE_CODES: MC_DEVICE_CODES,
  BIT_DEVICES: BIT_DEVICES,
  WORD_32_TYPES: WORD_32_TYPES,
  WORD_64_TYPES: WORD_64_TYPES,
  MC_ERROR_CODES: MC_ERROR_CODES,
  mcErrorText: mcErrorText,
  clampInt: clampInt,
  is32BitType: is32BitType,
  is64BitType: is64BitType,
  wordSpanOf: wordSpanOf,
  isHexAddrDevice: isHexAddrDevice,
  isFXSeries: isFXSeries,
  parseDeviceAddress: parseDeviceAddress,
  decodeTag: decodeTag,
  encodeWriteWords: encodeWriteWords,
  groupTags: groupTags,
  groupTagsContiguous: groupTagsContiguous,
  formatDeviceAddress: formatDeviceAddress,
  build3EFrame: build3EFrame,
  build4EFrame: build4EFrame,
  build3EWriteFrame: build3EWriteFrame,
  build4EWriteFrame: build4EWriteFrame,
  buildWriteFrame: buildWriteFrame,
  encodeBitWriteData: encodeBitWriteData,
  build3EBitWriteFrame: build3EBitWriteFrame,
  build4EBitWriteFrame: build4EBitWriteFrame,
  buildBitWriteFrame: buildBitWriteFrame,
  asciify: asciify,
  deasciify: deasciify,
  toAsciiHex: toAsciiHex,
  build3EAsciiQReadFrame: build3EAsciiQReadFrame,
  build3EAsciiQWriteFrame: build3EAsciiQWriteFrame,
  extractAsciiQResponse: extractAsciiQResponse,
  fromAsciiHex: fromAsciiHex,
  dehexifyFrame: dehexifyFrame,
  parseMCResponse: parseMCResponse,
  parseMCWriteResponse: parseMCWriteResponse,
  buildRMWWriteGroup: buildRMWWriteGroup,
  roundEng: roundEng,
  applyTransform: applyTransform
};
