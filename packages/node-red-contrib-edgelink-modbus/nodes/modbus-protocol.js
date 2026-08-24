/**
 * modbus-protocol — Modbus TCP 协议工具函数
 * 与运行时解耦，便于单元测试
 */

// ===== 功能码映射 =====
var FC_MAP = {
  'coil': { fc: 1, bit: true },
  'discrete': { fc: 2, bit: true },
  'holding': { fc: 3, bit: false },
  'input': { fc: 4, bit: false }
};

// ===== 异常码映射 =====
var EX_CODES = {
  1: 'Illegal function', 2: 'Illegal data address', 3: 'Illegal data value',
  4: 'Slave device failure', 5: 'Acknowledge', 6: 'Slave device busy',
  10: 'Gateway path unavailable', 11: 'Gateway target failed'
};

function exText(code) {
  return EX_CODES[code] || ('Unknown error 0x' + code.toString(16));
}

function clampInt(v, def, min, max) {
  var n = parseInt(v, 10);
  if (isNaN(n)) n = def;
  return Math.max(min, Math.min(n, max));
}

// ===== 帧构造（txnId 每次调用自增，返回值含 txnId 用于响应校验）=====
var _txnId = 1;
function buildModbusFrame(unitId, fc, startAddr, quantity) {
  var buf = Buffer.alloc(12);
  var txnId = _txnId++;
  if (_txnId > 65535) _txnId = 1;
  buf.writeUInt16BE(txnId, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(6, 4);
  buf[6] = unitId & 0xFF;
  buf[7] = fc & 0xFF;
  buf.writeUInt16BE(startAddr, 8);
  buf.writeUInt16BE(quantity, 10);
  return { buf: buf, txnId: txnId };
}

// ===== 写入帧构造（FC05 写单线圈 / FC06 写单寄存器 / FC16 写多寄存器）=====
function buildWriteFrame(unitId, fc, addr, words) {
  var txnId = _txnId++;
  if (_txnId > 65535) _txnId = 1;
  if (fc === 16) {
    var n = words.length;
    var buf = Buffer.alloc(13 + n * 2);
    buf.writeUInt16BE(txnId, 0);
    buf.writeUInt16BE(0, 2);
    buf.writeUInt16BE(7 + n * 2, 4);
    buf[6] = unitId & 0xFF;
    buf[7] = 16;
    buf.writeUInt16BE(addr, 8);
    buf.writeUInt16BE(n, 10);
    buf[12] = n * 2;
    for (var i = 0; i < n; i++) buf.writeUInt16BE(words[i] & 0xFFFF, 13 + i * 2);
    return { buf: buf, txnId: txnId };
  }
  // FC05/FC06：结构同读取帧，quantity 字段位置填写入值
  var buf2 = Buffer.alloc(12);
  buf2.writeUInt16BE(txnId, 0);
  buf2.writeUInt16BE(0, 2);
  buf2.writeUInt16BE(6, 4);
  buf2[6] = unitId & 0xFF;
  buf2[7] = fc & 0xFF;
  buf2.writeUInt16BE(addr, 8);
  buf2.writeUInt16BE((words[0] || 0) & 0xFFFF, 10);
  return { buf: buf2, txnId: txnId };
}

// ===== 写入响应解析（FC05/06 回显地址+值；FC16 回显地址+数量）=====
function parseWriteResponse(buf, fc, addr, words, requestUnitId) {
  if (!buf || buf.length < 9) return { err: 'Buffer too short' };
  if (buf.readUInt16BE(2) !== 0) return { err: 'Protocol ID mismatch' };
  if (requestUnitId != null && buf[6] !== requestUnitId) return { err: 'Unit ID mismatch' };
  var rfc = buf[7];
  if (rfc & 0x80) return { exCode: buf[8], exText: exText(buf[8]) };
  if (rfc !== fc) return { err: 'Function code mismatch: expect ' + fc + ', got ' + rfc };
  if (buf.length < 12) return { err: 'Buffer too short' };
  var echoAddr = buf.readUInt16BE(8);
  if (echoAddr !== addr) return { err: 'Address echo mismatch: expect ' + addr + ', got ' + echoAddr };
  if (fc === 16) {
    var echoQty = buf.readUInt16BE(10);
    if (echoQty !== words.length) return { err: 'Quantity echo mismatch: expect ' + words.length + ', got ' + echoQty };
  } else {
    var echoVal = buf.readUInt16BE(10);
    if (echoVal !== ((words[0] || 0) & 0xFFFF)) {
      return { err: 'Value echo mismatch: expect ' + ((words[0] || 0) & 0xFFFF) + ', got ' + echoVal };
    }
  }
  return { ok: true };
}

// ===== 字节序词汇标准化 =====
// 面板/CSV 词汇（AB/BA/ABCD/CDAB/BADC/DCBA）→ 协议两轴（byteOrder + wordOrder）
// 此前面板选的字节序被原样透传给 decodeValue，匹配不上协议词汇而被静默忽略
var BO_MAP = {
  'AB':   { byteOrder: null,         wordOrder: null },          // 16 位大端（默认，不交换）
  'BA':   { byteOrder: 'BIG_ENDIAN', wordOrder: null },          // 16 位：寄存器内两字节交换
  'ABCD': { byteOrder: null,         wordOrder: 'HIGH_FIRST' },  // 32 位大端：高字在低地址
  'CDAB': { byteOrder: null,         wordOrder: 'LOW_FIRST' },   // 32 位：高低字交换
  'BADC': { byteOrder: 'BIG_ENDIAN', wordOrder: 'HIGH_FIRST' },  // 32 位：字内字节交换
  'DCBA': { byteOrder: 'BIG_ENDIAN', wordOrder: 'LOW_FIRST' }    // 32 位全反
};
function normalizeByteOrder(tag) {
  var bo = tag.byteOrder || tag.byte_order || null;
  var wo = tag.wordOrder || tag.word_order || null;
  if (bo && BO_MAP[bo]) {
    var m = BO_MAP[bo];
    return { byteOrder: m.byteOrder, wordOrder: m.wordOrder };
  }
  // 协议词汇（LITTLE_ENDIAN/BIG_ENDIAN/HIGH_FIRST/LOW_FIRST）原样透传
  return { byteOrder: bo, wordOrder: wo };
}

// decodeValue/encodeValue 内部统一走这里，两种词汇都接受（幂等，可重复归一）
function _normAxes(byteOrder, wordOrder) {
  if (byteOrder && BO_MAP[byteOrder]) return BO_MAP[byteOrder];
  return { byteOrder: byteOrder || null, wordOrder: wordOrder || null };
}

// ===== 数据类型编码（decodeValue 的逆运算，写入用）=====
// 返回低字在前的字数组，再按 wordOrder/byteOrder 两轴调整为线上顺序
function encodeValue(value, dataType, byteOrder, wordOrder) {
  var dt = dataType || 'INT16';
  var n = Number(value);
  if (isNaN(n)) return null;
  var axes = _normAxes(byteOrder, wordOrder);
  byteOrder = axes.byteOrder;
  wordOrder = axes.wordOrder;
  var words = [];
  if (dt === 'BOOL' || dt === 'INT16' || dt === 'UINT16') {
    words = [Math.round(n) & 0xFFFF];
  } else if (dt === 'INT32' || dt === 'UINT32') {
    words = [n & 0xFFFF, Math.floor(n / 65536) & 0xFFFF];
  } else if (dt === 'FLOAT32' || dt === 'FLOAT') {
    var b4 = Buffer.alloc(4);
    b4.writeFloatLE(n, 0);
    words = [b4.readUInt16LE(0), b4.readUInt16LE(2)];
  } else if (dt === 'DOUBLE' || dt === 'FLOAT64') {
    var b8 = Buffer.alloc(8);
    b8.writeDoubleLE(n, 0);
    for (var i = 0; i < 4; i++) words.push(b8.readUInt16LE(i * 2));
  } else {
    return null;  // 未知类型
  }
  if (wordOrder === 'HIGH_FIRST') words.reverse();
  if (byteOrder === 'BIG_ENDIAN') {
    words = words.map(function (w) { return ((w & 0xFF) << 8) | ((w >> 8) & 0xFF); });
  }
  return words;
}

// ===== 响应解析 =====
function parseModbusResponse(buf, startAddr, regType, quantity, requestUnitId) {
  if (!buf || buf.length < 9) return { err: 'Buffer too short' };
  if (buf.readUInt16BE(2) !== 0) return { err: 'Protocol ID mismatch' };
  if (requestUnitId != null && buf[6] !== requestUnitId) return { err: 'Unit ID mismatch' };

  var fc = buf[7];
  if (fc & 0x80) return { exCode: buf[8], exText: exText(buf[8]) };

  // 🔧 功能码一致性校验（帧错乱时防止把 FC1 响应当 FC3 响应解析）
  var expectedFc = FC_MAP[regType] ? FC_MAP[regType].fc : null;
  if (expectedFc != null && fc !== expectedFc) {
    return { err: 'Function code mismatch: expect ' + expectedFc + ', got ' + fc };
  }

  var byteCount = buf[8];
  var isBit = FC_MAP[regType] ? FC_MAP[regType].bit : false;

  // 🔧 报文完整性校验：防止畸形帧 readUInt16BE 越界抛 RangeError（重入口在 try 外时可直接崩进程）
  if (buf.length < 9 + byteCount) {
    return { err: 'Incomplete frame: byteCount=' + byteCount + ', actual=' + Math.max(0, buf.length - 9) };
  }
  if (isBit) {
    if (byteCount * 8 < quantity) return { err: 'Bad byteCount: ' + byteCount + ' for ' + quantity + ' bits' };
  } else {
    if (byteCount < quantity * 2) return { err: 'Bad byteCount: ' + byteCount + ' for ' + quantity + ' registers' };
  }

  if (isBit) {
    var bitResult = {};
    for (var i = 0; i < byteCount; i++) {
      var b = buf[9 + i];
      for (var j = 0; j < 8; j++) {
        var addr = startAddr + i * 8 + j;
        if (addr - startAddr >= quantity) break;
        bitResult[addr] = (b >> j) & 1;
      }
    }
    return bitResult;
  }

  var wordResult = {};
  for (var wi = 0; wi < byteCount / 2; wi++) {
    wordResult[startAddr + wi] = buf.readUInt16BE(9 + wi * 2);
  }
  return wordResult;
}

// ===== 数据类型解码 =====
// 系统统一约定（与 MC 驱动一致）：
//   byteOrder = LITTLE_ENDIAN（默认）：16 位寄存器内不交换；BIG_ENDIAN：寄存器内两字节交换
//   wordOrder = LOW_FIRST（默认）：32/64 位值低字在低地址；HIGH_FIRST：低字在高地址
//   bitOffset：BOOL 在字元件上取第 N 位（缺省 0）
function decodeValue(raw, addr, rawData, dataType, byteOrder, wordOrder, bitOffset) {
  if (raw === null || raw === undefined) return null;
  var dt = dataType || 'INT16';
  var axes = _normAxes(byteOrder, wordOrder);
  byteOrder = axes.byteOrder;
  wordOrder = axes.wordOrder;

  // byteOrder：16 位寄存器内字节交换（🔧 修复#5：先交换再取位——此前 BOOL 在交换前 return，BIG_ENDIAN 下位偏移错 8 位）
  var w = raw & 0xFFFF;
  if (byteOrder === 'BIG_ENDIAN') {
    w = ((w & 0xFF) << 8) | ((w >> 8) & 0xFF);
  }

  // BOOL：位元件本身即 0/1（bitOffset=0 时等价原逻辑）；字元件按 bitOffset 取位
  // 🔧 Day6: bitOffset 钳制 0-15（JS 移位按 32 取模，越界会静默取错位）
  if (dt === 'BOOL') {
    var bo = parseInt(bitOffset, 10);
    if (isNaN(bo) || bo < 0 || bo > 15) bo = 0;
    return (w >> bo) & 1;
  }

  if (dt === 'INT16') return w > 0x7FFF ? w - 0x10000 : w;
  if (dt === 'UINT16') return w;

  var SPAN = { 'INT32': 2, 'UINT32': 2, 'FLOAT32': 2, 'DOUBLE': 4, 'FLOAT64': 4 };
  var span = SPAN[dt];
  if (!span) return raw;  // 未知类型回退原值

  var words = [];
  for (var i = 0; i < span; i++) {
    var rw = rawData[addr + i];
    if (rw === undefined || rw === null) return null;
    var uw = rw & 0xFFFF;
    if (byteOrder === 'BIG_ENDIAN') {
      uw = ((uw & 0xFF) << 8) | ((uw >> 8) & 0xFF);
    }
    words.push(uw);
  }
  // wordOrder：默认 LOW_FIRST（低字在低地址）
  if (wordOrder === 'HIGH_FIRST') words.reverse();

  if (dt === 'INT32') {
    var c32 = (words[1] << 16) | words[0];
    return c32 > 0x7FFFFFFF ? c32 - 0x100000000 : c32;
  }
  if (dt === 'UINT32') return ((words[1] << 16) | words[0]) >>> 0;
  if (dt === 'FLOAT32') {
    var b4 = Buffer.alloc(4);
    b4.writeUInt16LE(words[0], 0); b4.writeUInt16LE(words[1], 2);
    return b4.readFloatLE(0);
  }
  // 🔧 DOUBLE / FLOAT64（64 位浮点，4 寄存器）
  var b8 = Buffer.alloc(8);
  for (var bi = 0; bi < 4; bi++) b8.writeUInt16LE(words[bi], bi * 2);
  return b8.readDoubleLE(0);
}

// ===== 应用变换 =====
function applyTransform(rawValue, tagDef) {
  if (rawValue === null || rawValue === undefined) return null;
  var slope = parseFloat(tagDef.slope); if (isNaN(slope)) slope = 1;  // slope=0 合法（parseFloat(0)=0 非 NaN）
  var offset = parseFloat(tagDef.offset); if (isNaN(offset)) offset = 0;
  return rawValue * slope + offset;  // 🔧 不再 toFixed(4) 截断，保留完整精度
}

// ==================== Modbus RTU（串口）====================
// RTU 帧: [unitId][fc][PDU...][CRC16-LE]（无 MBAP 头，无 txnId）
// CRC16 Modbus: poly 0xA001、init 0xFFFF、refin/refout=true、低字节在前

// 逐位移位实现（与表驱动实现交叉验证：'123456789' → 0x4B37）
function crc16(buf, len) {
  var crc = 0xFFFF;
  var n = (len != null) ? len : buf.length;
  for (var i = 0; i < n; i++) {
    crc ^= buf[i];
    for (var j = 0; j < 8; j++) {
      crc = (crc & 1) ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
    }
  }
  return crc & 0xFFFF;
}

// 帧尾追加 CRC16（低字节在前），返回新 Buffer
function appendRtuCrc(frame) {
  var crc = crc16(frame);
  var out = Buffer.alloc(frame.length + 2);
  frame.copy(out, 0);
  out[out.length - 2] = crc & 0xFF;
  out[out.length - 1] = (crc >> 8) & 0xFF;
  return out;
}

// 校验完整单帧的 CRC（buf 必须恰好是一帧，调用方负责按期望长度切片）
function checkRtuCrc(buf) {
  if (!buf || buf.length < 4) return false;
  var crc = crc16(buf, buf.length - 2);
  return buf[buf.length - 2] === (crc & 0xFF) && buf[buf.length - 1] === ((crc >> 8) & 0xFF);
}

// ===== RTU 读取请求帧（返回 {buf, txnId:0} — RTU 无事务号，形状与 TCP 版一致）=====
function buildRtuFrame(unitId, fc, startAddr, quantity) {
  var buf = Buffer.alloc(6);
  buf[0] = unitId & 0xFF;
  buf[1] = fc & 0xFF;
  buf.writeUInt16BE(startAddr, 2);
  buf.writeUInt16BE(quantity, 4);
  return { buf: appendRtuCrc(buf), txnId: 0 };
}

// ===== RTU 写入请求帧（FC05/06 回显 8 字节；FC16 [unit][16][addr][qty][byteCount][data][crc]）=====
function buildRtuWriteFrame(unitId, fc, addr, words) {
  if (fc === 16) {
    var n = words.length;
    var buf = Buffer.alloc(7 + n * 2);
    buf[0] = unitId & 0xFF;
    buf[1] = 16;
    buf.writeUInt16BE(addr, 2);
    buf.writeUInt16BE(n, 4);
    buf[6] = n * 2;
    for (var i = 0; i < n; i++) buf.writeUInt16BE(words[i] & 0xFFFF, 7 + i * 2);
    return { buf: appendRtuCrc(buf), txnId: 0 };
  }
  // FC05/FC06：addr + 写入值，与请求回显结构一致
  var buf2 = Buffer.alloc(6);
  buf2[0] = unitId & 0xFF;
  buf2[1] = fc & 0xFF;
  buf2.writeUInt16BE(addr, 2);
  buf2.writeUInt16BE((words[0] || 0) & 0xFFFF, 4);
  return { buf: appendRtuCrc(buf2), txnId: 0 };
}

// ===== RTU 正常响应期望长度（异常帧固定 5 字节，由接收方另行判断）=====
function rtuExpectedResponseLen(fc, quantity) {
  if (fc === 1 || fc === 2) return 3 + Math.ceil(quantity / 8) + 2;  // 位：byteCount=ceil(qty/8)
  if (fc === 3 || fc === 4) return 3 + quantity * 2 + 2;             // 寄存器：byteCount=qty*2
  return 8;                                                          // FC05/06/15/16 回显
}

// ===== RTU 读取响应解析（buf 为完整单帧；返回形状与 parseModbusResponse 一致）=====
function parseRtuResponse(buf, startAddr, regType, quantity, requestUnitId) {
  if (!buf || buf.length < 5) return { err: 'Buffer too short' };
  if (requestUnitId != null && buf[0] !== requestUnitId) return { err: 'Unit ID mismatch' };
  // 🔧 CRC 校验先于一切解析：坏帧不得当好数据
  if (!checkRtuCrc(buf)) return { err: 'CRC mismatch' };

  var fc = buf[1];
  if (fc & 0x80) return { exCode: buf[2], exText: exText(buf[2]) };

  // 功能码一致性校验（与 TCP 版同一策略）
  var expectedFc = FC_MAP[regType] ? FC_MAP[regType].fc : null;
  if (expectedFc != null && fc !== expectedFc) {
    return { err: 'Function code mismatch: expect ' + expectedFc + ', got ' + fc };
  }

  var byteCount = buf[2];
  var isBit = FC_MAP[regType] ? FC_MAP[regType].bit : false;

  // 报文完整性校验（防越界 RangeError）
  if (buf.length < 3 + byteCount + 2) {
    return { err: 'Incomplete frame: byteCount=' + byteCount + ', actual=' + Math.max(0, buf.length - 5) };
  }
  if (isBit) {
    if (byteCount * 8 < quantity) return { err: 'Bad byteCount: ' + byteCount + ' for ' + quantity + ' bits' };
  } else {
    if (byteCount < quantity * 2) return { err: 'Bad byteCount: ' + byteCount + ' for ' + quantity + ' registers' };
  }

  if (isBit) {
    var bitResult = {};
    for (var i = 0; i < byteCount; i++) {
      var b = buf[3 + i];
      for (var j = 0; j < 8; j++) {
        var addr = startAddr + i * 8 + j;
        if (addr - startAddr >= quantity) break;
        bitResult[addr] = (b >> j) & 1;
      }
    }
    return bitResult;
  }

  var wordResult = {};
  for (var wi = 0; wi < byteCount / 2; wi++) {
    wordResult[startAddr + wi] = buf.readUInt16BE(3 + wi * 2);
  }
  return wordResult;
}

// ===== RTU 写入响应解析（FC05/06 回显地址+值；FC16 回显地址+数量）=====
function parseRtuWriteResponse(buf, fc, addr, words, requestUnitId) {
  if (!buf || buf.length < 5) return { err: 'Buffer too short' };
  if (requestUnitId != null && buf[0] !== requestUnitId) return { err: 'Unit ID mismatch' };
  if (!checkRtuCrc(buf)) return { err: 'CRC mismatch' };
  var rfc = buf[1];
  if (rfc & 0x80) return { exCode: buf[2], exText: exText(buf[2]) };
  if (rfc !== fc) return { err: 'Function code mismatch: expect ' + fc + ', got ' + rfc };
  if (buf.length < 8) return { err: 'Buffer too short' };
  var echoAddr = buf.readUInt16BE(2);
  if (echoAddr !== addr) return { err: 'Address echo mismatch: expect ' + addr + ', got ' + echoAddr };
  if (fc === 16) {
    var echoQty = buf.readUInt16BE(4);
    if (echoQty !== words.length) return { err: 'Quantity echo mismatch: expect ' + words.length + ', got ' + echoQty };
  } else {
    var echoVal = buf.readUInt16BE(4);
    if (echoVal !== ((words[0] || 0) & 0xFFFF)) {
      return { err: 'Value echo mismatch: expect ' + ((words[0] || 0) & 0xFFFF) + ', got ' + echoVal };
    }
  }
  return { ok: true };
}

module.exports = {
  FC_MAP: FC_MAP,
  EX_CODES: EX_CODES,
  exText: exText,
  clampInt: clampInt,
  buildModbusFrame: buildModbusFrame,
  buildWriteFrame: buildWriteFrame,
  parseModbusResponse: parseModbusResponse,
  parseWriteResponse: parseWriteResponse,
  normalizeByteOrder: normalizeByteOrder,
  decodeValue: decodeValue,
  encodeValue: encodeValue,
  applyTransform: applyTransform,
  crc16: crc16,
  appendRtuCrc: appendRtuCrc,
  checkRtuCrc: checkRtuCrc,
  buildRtuFrame: buildRtuFrame,
  buildRtuWriteFrame: buildRtuWriteFrame,
  rtuExpectedResponseLen: rtuExpectedResponseLen,
  parseRtuResponse: parseRtuResponse,
  parseRtuWriteResponse: parseRtuWriteResponse
};
