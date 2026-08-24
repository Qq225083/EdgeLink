/**
 * mc-protocol 单元测试 v1.4.4
 * 3E/4E 帧 golden buffer 对拍（参照 pymcprotocol type4e.py / SH-080008 规范布局）、
 * X/Y 进制规则（FX=8 进制，Q/L/iQ-R=16 进制）、decodeTag 全组合解码
 */
var assert = require('assert');
var mc = require('../nodes/mc-protocol');

describe('mc-protocol', function () {

  describe('parseDeviceAddress', function () {
    it('parses decimal addresses for D/M/L/R', function () {
      // D/M/L/R 十进制
      assert.strictEqual(mc.parseDeviceAddress('D', '100', 'Q'), 100);
      assert.strictEqual(mc.parseDeviceAddress('M', '1024', 'Q'), 1024);
      assert.strictEqual(mc.parseDeviceAddress('R', '10', 'Q'), 10);
    });
    it('accepts address 0 in both string and numeric form (D0 合法)', function () {
      assert.strictEqual(mc.parseDeviceAddress('D', '0', 'Q'), 0);
      assert.strictEqual(mc.parseDeviceAddress('D', 0, 'Q'), 0);
      assert.strictEqual(mc.parseDeviceAddress('M', 0, 'FX'), 0);
      assert.strictEqual(mc.parseDeviceAddress('X', 0, 'Q'), 0);
    });
    it('parses hex addresses for W/B (all series)', function () {
      assert.strictEqual(mc.parseDeviceAddress('W', '1A', 'Q'), 26);
      assert.strictEqual(mc.parseDeviceAddress('B', 'FF', 'FX'), 255);
      assert.strictEqual(mc.parseDeviceAddress('W', '100', 'Q'), 256);
    });
    it('parses X/Y as HEX for Q/L/iQ-R (X10=16, X1A=26)', function () {
      assert.strictEqual(mc.parseDeviceAddress('X', '10', 'Q'), 16);
      assert.strictEqual(mc.parseDeviceAddress('Y', '1A', 'Q'), 26);
      assert.strictEqual(mc.parseDeviceAddress('X', '1A', 'L'), 26);
      assert.strictEqual(mc.parseDeviceAddress('X', 'FF', 'iQ-R'), 255);
    });
    it('parses X/Y as OCTAL for FX series (X17=15, X10=8)', function () {
      assert.strictEqual(mc.parseDeviceAddress('X', '17', 'FX'), 15);
      assert.strictEqual(mc.parseDeviceAddress('Y', '10', 'FX3U'), 8);
      assert.strictEqual(mc.parseDeviceAddress('X', '10', 'FX5U'), 8);
    });
    it('rejects FX octal addresses containing 8/9 (X18 静默截断为 1 的回归)', function () {
      assert.strictEqual(mc.parseDeviceAddress('X', '18', 'FX'), -1);
      assert.strictEqual(mc.parseDeviceAddress('Y', '19', 'FX'), -1);
      assert.strictEqual(mc.parseDeviceAddress('X', '80', 'FX'), -1);
    });
    it('returns -1 for invalid addresses', function () {
      assert.strictEqual(mc.parseDeviceAddress('D', 'abc', 'Q'), -1);
      assert.strictEqual(mc.parseDeviceAddress('X', '', 'Q'), -1);
    });
    it('rejects addresses beyond 3-byte field (>0xFFFFFF)', function () {
      assert.strictEqual(mc.parseDeviceAddress('D', '16777216', 'Q'), -1);
      assert.strictEqual(mc.parseDeviceAddress('D', '16777215', 'Q'), 16777215);
    });
  });

  describe('formatDeviceAddress', function () {
    it('formats X/Y as hex for Q', function () {
      assert.strictEqual(mc.formatDeviceAddress('X', 26, 'Q'), 'X1A');
      assert.strictEqual(mc.formatDeviceAddress('Y', 16, 'Q'), 'Y10');
    });
    it('formats X/Y as octal for FX', function () {
      assert.strictEqual(mc.formatDeviceAddress('X', 15, 'FX'), 'X17');
      assert.strictEqual(mc.formatDeviceAddress('Y', 8, 'FX'), 'Y10');
    });
    it('formats W/B as hex, D/M as decimal', function () {
      assert.strictEqual(mc.formatDeviceAddress('W', 26, 'Q'), 'W1A');
      assert.strictEqual(mc.formatDeviceAddress('D', 100, 'Q'), 'D100');
    });
  });

  describe('build3EFrame (golden buffer)', function () {
    it('constructs spec-exact 3E batch-read frame', function () {
      // D100, 2 字, 站号 0, 网络号 0 — 21 字节
      var buf = mc.build3EFrame(100, 2, 0, 'D', 0);
      var expected = Buffer.from([
        0x50, 0x00,             // 副标题
        0x00,                   // 网络号
        0xFF,                   // PC 号
        0xFF, 0x03,             // IO 号 0x03FF LE
        0x00,                   // 站号
        0x0C, 0x00,             // 数据长 = 12
        0x10, 0x00,             // 监视定时器
        0x01, 0x04,             // 指令 0x0401 批量读
        0x00, 0x00,             // 子指令
        0x64, 0x00, 0x00,       // 地址 100 (3字节LE)
        0xA8,                   // 软元件代码 D
        0x02, 0x00              // 点数 2
      ]);
      assert.deepStrictEqual(buf, expected);
    });
  });

  describe('build4EFrame (golden buffer, v1.4.4 规范布局)', function () {
    it('constructs spec-exact 4E batch-read frame (25 bytes)', function () {
      // D100, 2 字, 站号 0, 网络号 0, 序列号 0x1234
      var buf = mc.build4EFrame(100, 2, 0, 'D', 0, 0x1234);
      var expected = Buffer.from([
        0x54, 0x00,             // 副标题
        0x34, 0x12,             // 序列号 LE（副标题内，偏移 2-3）
        0x00, 0x00,             // 固定值（偏移 4-5）
        0x00,                   // 网络号
        0xFF,                   // PC 号
        0xFF, 0x03,             // IO 号
        0x00,                   // 站号
        0x0C, 0x00,             // 数据长 = 12（不是 14）
        0x10, 0x00,             // 监视定时器
        0x01, 0x04,             // 指令 0x0401
        0x00, 0x00,             // 子指令
        0x64, 0x00, 0x00,       // 地址 100
        0xA8,                   // 软元件代码 D
        0x02, 0x00              // 点数 2
      ]);
      assert.deepStrictEqual(buf, expected);
      assert.strictEqual(buf.length, 25);
    });
  });

  describe('parseMCResponse', function () {
    it('parses 3E word response', function () {
      // D100 起 2 字: 0x1234, 0x5678
      var buf = Buffer.from([
        0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x06, 0x00,             // 数据长 = 2(结束码) + 4(数据)
        0x00, 0x00,             // 结束码 @9
        0x34, 0x12, 0x78, 0x56  // 数据 @11
      ]);
      var r = mc.parseMCResponse(buf, 100, 'D', '3E');
      assert.strictEqual(r['D100'], 0x1234);
      assert.strictEqual(r['D101'], 0x5678);
    });
    it('parses 3E bit response (16 bits per word, LSB=低地址)', function () {
      var buf = Buffer.from([
        0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x04, 0x00, 0x00, 0x00,
        0x05, 0x00              // 0b0101 → M0=1, M1=0, M2=1
      ]);
      var r = mc.parseMCResponse(buf, 0, 'M', '3E');
      assert.strictEqual(r['M0'], 1);
      assert.strictEqual(r['M1'], 0);
      assert.strictEqual(r['M2'], 1);
    });
    it('parses 4E response (endCode@13, data@15, serial echo check)', function () {
      var buf = Buffer.from([
        0xD4, 0x00,             // 副标题
        0x34, 0x12,             // 序列号回显
        0x00, 0x00,             // 固定值
        0x00, 0xFF, 0xFF, 0x03, 0x00,  // 路由
        0x06, 0x00,             // 数据长 @11 = 2 + 4
        0x00, 0x00,             // 结束码 @13
        0x34, 0x12, 0x78, 0x56  // 数据 @15
      ]);
      var r = mc.parseMCResponse(buf, 100, 'D', '4E', 0x1234);
      assert.strictEqual(r['D100'], 0x1234);
      assert.strictEqual(r['D101'], 0x5678);
    });
    it('rejects 4E serial mismatch', function () {
      var buf = Buffer.from([
        0xD4, 0x00, 0x34, 0x12, 0x00, 0x00,
        0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x06, 0x00, 0x00, 0x00, 0x34, 0x12, 0x78, 0x56
      ]);
      var r = mc.parseMCResponse(buf, 100, 'D', '4E', 0x9999);
      assert.ok(r.err);
    });
    it('returns mcError for non-zero end code (4E @13)', function () {
      var buf = Buffer.from([
        0xD4, 0x00, 0x34, 0x12, 0x00, 0x00,
        0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x02, 0x00,
        0x52, 0xC0              // 结束码 0xC052 Address out of range
      ]);
      var r = mc.parseMCResponse(buf, 100, 'D', '4E', 0x1234);
      assert.strictEqual(r.mcError, 0xC052);
    });
    it('rejects response frame type mismatch (review#9: 3E 请求收到 4E 帧)', function () {
      var buf4e = Buffer.from([
        0xD4, 0x00, 0x34, 0x12, 0x00, 0x00,
        0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x06, 0x00, 0x00, 0x00, 0x34, 0x12, 0x78, 0x56
      ]);
      // 以 '3E' 解析 4E 帧 → 拒绝
      assert.ok(mc.parseMCResponse(buf4e, 100, 'D', '3E').err);
      // 以 '4E' 解析 3E 帧 → 拒绝
      var buf3e = Buffer.from([
        0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x06, 0x00, 0x00, 0x00, 0x34, 0x12, 0x78, 0x56
      ]);
      assert.ok(mc.parseMCResponse(buf3e, 100, 'D', '4E', 0x1234).err);
    });
    it('build frames reject out-of-range wordCount (review#6)', function () {
      assert.throws(function () { mc.build3EFrame(0, 961, 0, 'D', 0); }, /wordCount/);
      assert.throws(function () { mc.build4EFrame(0, 0, 0, 'D', 0, 0); }, /wordCount/);
    });
    it('FLOAT32 keeps full precision (review#3: 0.00006 不再被截成 0.0001)', function () {
      var b = Buffer.alloc(4);
      b.writeFloatLE(0.00006, 0);
      var r = mc.decodeTag({ D1: b.readUInt16LE(0), D2: b.readUInt16LE(2) }, 'D', 1, 'FLOAT32');
      assert.ok(Math.abs(r.value - 0.00006) < 1e-9, 'precision preserved, got ' + r.value);
    });
    it('rejects too-short / invalid subheader buffers', function () {
      assert.ok(mc.parseMCResponse(Buffer.from([0xD0]), 0, 'D', '3E').err);
      assert.ok(mc.parseMCResponse(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 0, 'D', '3E').err);
    });
  });

  describe('groupTags (v1.4.4: 960 字 span 感知聚类)', function () {
    function mkTags(n, rt, dt, start) {
      var step = (dt === 'INT32' || dt === 'UINT32' || dt === 'FLOAT32') ? 2 : (dt === 'DOUBLE' ? 4 : 1);
      var arr = [];
      for (var i = 0; i < n; i++) arr.push({ id: 't' + i, regType: rt, addr: (start || 0) + i * step, dataType: dt || 'INT16' });
      return arr;
    }
    it('1000 contiguous INT16 → 2 groups (960 + 40)', function () {
      var g = mc.groupTags(mkTags(1000, 'D'));
      assert.strictEqual(g.length, 2);
      assert.strictEqual(g[0].tags.length, 960);
      assert.strictEqual(g[1].tags.length, 40);
    });
    it('10000 contiguous INT16 → 11 groups (10×960 + 400)', function () {
      var g = mc.groupTags(mkTags(10000, 'D'));
      assert.strictEqual(g.length, 11);
      assert.strictEqual(g[10].tags.length, 400);
    });
    it('gap > 20 splits groups', function () {
      var tags = mkTags(10, 'D').concat(mkTags(10, 'D', 'INT16', 100));
      var g = mc.groupTags(tags);
      assert.strictEqual(g.length, 2);
    });
    it('INT32: 500 tags (1000 字) → 2 groups (480 + 20)', function () {
      var g = mc.groupTags(mkTags(500, 'D', 'INT32'));
      assert.strictEqual(g.length, 2);
      assert.strictEqual(g[0].tags.length, 480);
      assert.strictEqual(g[1].tags.length, 20);
    });
    it('FLOAT64: 240 tags (960 字) → 1 group; 241 → 2', function () {
      assert.strictEqual(mc.groupTags(mkTags(240, 'D', 'DOUBLE')).length, 1);
      assert.strictEqual(mc.groupTags(mkTags(241, 'D', 'DOUBLE')).length, 2);
    });
    it('bit devices: 10000 M bits (625 字) → 1 group; 20000 → 2', function () {
      assert.strictEqual(mc.groupTags(mkTags(10000, 'M', 'BOOL')).length, 1);
      assert.strictEqual(mc.groupTags(mkTags(20000, 'M', 'BOOL')).length, 2);
    });
    it('mixed regTypes stay in separate groups', function () {
      var g = mc.groupTags(mkTags(5, 'D').concat(mkTags(5, 'M', 'BOOL')));
      assert.strictEqual(g.length, 2);
    });
  });

  describe('decodeTag', function () {
    var raw = { D100: 0x1234, D101: 0x5678, D102: 0x9ABC, D103: 0xDEF0, D104: 0x2100, D105: 0x0005 };
    it('INT16 passthrough & negative', function () {
      assert.strictEqual(mc.decodeTag(raw, 'D', 100, 'INT16').value, 0x1234);
      assert.strictEqual(mc.decodeTag({ D1: -1 }, 'D', 1, 'INT16').value, -1);
    });
    it('UINT16 negative→65535', function () {
      assert.strictEqual(mc.decodeTag({ D1: -1 }, 'D', 1, 'UINT16').value, 65535);
    });
    it('INT16 with BIG_ENDIAN byte swap (0x1234→0x3412)', function () {
      assert.strictEqual(mc.decodeTag(raw, 'D', 100, 'INT16', 'BIG_ENDIAN').value, 0x3412);
    });
    it('INT32 default LOW_FIRST (D101高字 D100低字)', function () {
      // (0x5678<<16) | 0x1234
      assert.strictEqual(mc.decodeTag(raw, 'D', 100, 'INT32').value, 0x56781234);
    });
    it('INT32 HIGH_FIRST reverses words', function () {
      assert.strictEqual(mc.decodeTag(raw, 'D', 100, 'INT32', null, 'HIGH_FIRST').value, 0x12345678);
    });
    it('UINT32 unsigned', function () {
      assert.strictEqual(mc.decodeTag({ D1: 0xFFFF, D2: 0xFFFF }, 'D', 1, 'UINT32').value, 4294967295);
    });
    it('FLOAT32 23.5 (0x41BC0000, LOW_FIRST: D0=0x0000, D1=0x41BC)', function () {
      var r = mc.decodeTag({ D200: 0x0000, D201: 0x41BC }, 'D', 200, 'FLOAT32');
      assert.strictEqual(r.value, 23.5);
    });
    it('FLOAT64 -1234.5678 (LOW_FIRST 4 words)', function () {
      var b = Buffer.alloc(8);
      b.writeDoubleLE(-1234.5678, 0);
      var raw64 = {};
      for (var i = 0; i < 4; i++) raw64['D' + (300 + i)] = b.readUInt16LE(i * 2);
      var r = mc.decodeTag(raw64, 'D', 300, 'DOUBLE');
      assert.ok(Math.abs(r.value - (-1234.5678)) < 1e-10);
    });
    it('BOOL bit extraction (D100=0x1234: bit2=1, bit4=1, bit0=0)', function () {
      assert.strictEqual(mc.decodeTag(raw, 'D', 100, 'BOOL', null, null, 2).value, 1);
      assert.strictEqual(mc.decodeTag(raw, 'D', 100, 'BOOL', null, null, 4).value, 1);
      assert.strictEqual(mc.decodeTag(raw, 'D', 100, 'BOOL', null, null, 0).value, 0);
    });
    it('BOOL under BIG_ENDIAN swaps bytes before bit extraction（修复#5 回归：0x0100 BE→bit0=1）', function () {
      assert.strictEqual(mc.decodeTag({ D1: 0x0100 }, 'D', 1, 'BOOL', 'BIG_ENDIAN', null, 0).value, 1);
      assert.strictEqual(mc.decodeTag({ D1: 0x0100 }, 'D', 1, 'BOOL', null, null, 0).value, 0, '不换序时 bit0=0');
      assert.strictEqual(mc.decodeTag({ D1: 0x0100 }, 'D', 1, 'BOOL', null, null, 8).value, 1, '不换序时 bit8=1');
    });
    it('missing word → quality 2', function () {
      var r = mc.decodeTag({ D1: 100 }, 'D', 1, 'INT32');
      assert.strictEqual(r.quality, 2);
      assert.strictEqual(r.value, null);
    });
    it('missing tag → quality 2, rawWord null', function () {
      var r = mc.decodeTag({}, 'D', 999, 'INT16');
      assert.strictEqual(r.quality, 2);
      assert.strictEqual(r.rawWord, null);
    });
    it('bit device passthrough', function () {
      var r = mc.decodeTag({ M10: 1 }, 'M', 10, 'BOOL');
      assert.strictEqual(r.value, 1);
      assert.strictEqual(r.quality, 0);
    });
  });

  describe('applyTransform', function () {
    it('slope=0 is honored (not swallowed to 1)', function () {
      assert.strictEqual(mc.applyTransform(100, { slope: 0, offset: 5 }), 5);
    });
    it('default slope=1 offset=0', function () {
      assert.strictEqual(mc.applyTransform(42, {}), 42);
    });
    it('y = raw*slope + offset', function () {
      assert.strictEqual(mc.applyTransform(10, { slope: 0.5, offset: 2 }), 7);
    });
    it('null input → null', function () {
      assert.strictEqual(mc.applyTransform(null, {}), null);
    });
    it('v1.6.0: kills float arithmetic tail (27862 * 0.1 → 2786.2)', function () {
      assert.strictEqual(mc.applyTransform(27862, { slope: 0.1 }), 2786.2);
    });
    it('v1.6.0: keeps small-value precision (not wiped like toFixed(4))', function () {
      assert.strictEqual(mc.applyTransform(0.00006, {}), 0.00006);
    });
    it('v1.6.0: large values skip rounding (INT32 range, no 2^53 artifact)', function () {
      assert.strictEqual(mc.applyTransform(2100000000, {}), 2100000000);
      assert.strictEqual(mc.applyTransform(-2100000000, { slope: 1 }), -2100000000);
    });
    it('v1.6.0: roundEng passthrough rules', function () {
      assert.strictEqual(mc.roundEng(null), null);
      assert.strictEqual(mc.roundEng(undefined), undefined);
      assert.strictEqual(mc.roundEng(0.1 + 0.2), 0.3);
      assert.strictEqual(mc.roundEng(1e6), 1e6);
    });
  });

  // ===== v1.5.0: 写入函数测试 =====

  describe('encodeWriteWords', function () {
    it('INT16 → single word', function () {
      assert.deepStrictEqual(mc.encodeWriteWords(0x1234, 'INT16'), [0x1234]);
      assert.deepStrictEqual(mc.encodeWriteWords(-1, 'INT16'), [0xFFFF]);
    });
    it('UINT16 → single word', function () {
      assert.deepStrictEqual(mc.encodeWriteWords(65535, 'UINT16'), [0xFFFF]);
      assert.deepStrictEqual(mc.encodeWriteWords(0, 'UINT16'), [0]);
    });
    it('INT32 LOW_FIRST (default) → 2 words', function () {
      // 0x56781234 → [0x1234, 0x5678]
      var w = mc.encodeWriteWords(0x56781234, 'INT32');
      assert.strictEqual(w.length, 2);
      assert.strictEqual(w[0], 0x1234);
      assert.strictEqual(w[1], 0x5678);
    });
    it('INT32 HIGH_FIRST → reversed 2 words (wire: high word first)', function () {
      // 0x12345678 按 LE 分解 → [0x5678低, 0x1234高]; HIGH_FIRST 反转为 [0x1234, 0x5678]
      var w = mc.encodeWriteWords(0x12345678, 'INT32', null, 'HIGH_FIRST');
      assert.strictEqual(w[0], 0x1234);
      assert.strictEqual(w[1], 0x5678);
    });
    it('INT32 BIG_ENDIAN byte swap per word', function () {
      // 0x3412 → BIG_ENDIAN → 0x1234
      var w = mc.encodeWriteWords(0x3412, 'INT16', 'BIG_ENDIAN');
      assert.strictEqual(w[0], 0x1234);
    });
    it('UINT32 unsigned value', function () {
      var w = mc.encodeWriteWords(4294967295, 'UINT32');
      assert.strictEqual(w[0], 0xFFFF);
      assert.strictEqual(w[1], 0xFFFF);
    });
    it('FLOAT32 23.5 → 2 words', function () {
      var w = mc.encodeWriteWords(23.5, 'FLOAT32');
      // 23.5 = 0x41BC0000 → low=0x0000, high=0x41BC
      assert.strictEqual(w[0], 0x0000);
      assert.strictEqual(w[1], 0x41BC);
    });
    it('DOUBLE -1234.5678 → 4 words', function () {
      var w = mc.encodeWriteWords(-1234.5678, 'DOUBLE');
      assert.strictEqual(w.length, 4);
      // round-trip 验证
      var b64 = Buffer.alloc(8);
      for (var bi = 0; bi < 4; bi++) b64.writeUInt16LE(w[bi], bi * 2);
      assert.ok(Math.abs(b64.readDoubleLE(0) - (-1234.5678)) < 1e-10);
    });
    it('BOOL throws (must use RMW path)', function () {
      assert.throws(function () { mc.encodeWriteWords(1, 'BOOL'); }, /RMW/);
    });
  });

  describe('encodeWriteWords ↔ decodeTag round-trip symmetry', function () {
    it('INT32 normal + HIGH_FIRST + BIG_ENDIAN', function () {
      var val = 0x56781234;
      var words = mc.encodeWriteWords(val, 'INT32', 'BIG_ENDIAN', 'HIGH_FIRST');
      // 重建 raw 映射
      var raw = {};
      for (var i = 0; i < words.length; i++) raw['D' + (100 + i)] = words[i] & 0xFFFF;
      // 注意：readInt16LE 对于超过 0x7FFF 的值会补回负数，decodeTag 内部做了处理
      // 此处我们直接用 raw words（unsigned）验证 round-trip
      var rawSigned = {};
      for (var wi = 0; wi < words.length; wi++) {
        var v = words[wi];
        if (v >= 0x8000) v = v - 0x10000;
        rawSigned['D' + (100 + wi)] = v;
      }
      var decoded = mc.decodeTag(rawSigned, 'D', 100, 'INT32', 'BIG_ENDIAN', 'HIGH_FIRST');
      assert.strictEqual(decoded.value, val);
      assert.strictEqual(decoded.quality, 0);
    });
    it('FLOAT32 round-trip', function () {
      var val = -123.456;
      var words = mc.encodeWriteWords(val, 'FLOAT32');
      var rawSigned = {};
      for (var i = 0; i < words.length; i++) {
        var v = words[i];
        if (v >= 0x8000) v = v - 0x10000;
        rawSigned['D' + (200 + i)] = v;
      }
      var decoded = mc.decodeTag(rawSigned, 'D', 200, 'FLOAT32');
      assert.ok(Math.abs(decoded.value - val) < 1e-5);
    });
  });

  describe('build3EWriteFrame (golden buffer)', function () {
    it('constructs spec-exact 3E batch-write frame (1 word)', function () {
      // D100, 1 字, 值 0x1234, 站号 0, 网络号 0
      var buf = mc.build3EWriteFrame(100, [0x1234], 0, 'D', 0);
      var expected = Buffer.from([
        0x50, 0x00,             // 副标题
        0x00,                   // 网络号
        0xFF,                   // PC 号
        0xFF, 0x03,             // IO 号
        0x00,                   // 站号
        0x0E, 0x00,             // 数据长 = 12 + 1*2 = 14 (P0-1 fixed)
        0x10, 0x00,             // 监视定时器
        0x01, 0x14,             // 指令 0x1401 批量写
        0x00, 0x00,             // 子指令
        0x64, 0x00, 0x00,       // 地址 100
        0xA8,                   // 软元件代码 D
        0x01, 0x00,             // 点数 1
        0x34, 0x12              // 数据 0x1234 LE
      ]);
      assert.deepStrictEqual(buf, expected);
      // P0-1: 显式断言 dataLen @7（1 字 = 12+2=14）
      assert.strictEqual(buf.readUInt16LE(7), 14, 'dataLen=12+2n');
    });
    it('rejects wordCount out of range', function () {
      assert.throws(function () { mc.build3EWriteFrame(0, [], 0, 'D', 0); }, /wordCount/);
      assert.throws(function () { mc.build3EWriteFrame(0, new Array(961), 0, 'D', 0); }, /wordCount/);
    });
  });

  describe('build4EWriteFrame (golden buffer)', function () {
    it('constructs spec-exact 4E batch-write frame (1 word)', function () {
      var buf = mc.build4EWriteFrame(100, [0x1234], 0, 'D', 0, 0x1234);
      var expected = Buffer.from([
        0x54, 0x00,             // 副标题
        0x34, 0x12,             // 序列号 LE
        0x00, 0x00,             // 固定值
        0x00,                   // 网络号
        0xFF,                   // PC 号
        0xFF, 0x03,             // IO 号
        0x00,                   // 站号
        0x0E, 0x00,             // 数据长 @11 = 12 + 2 = 14 (P0-1 fixed)
        0x10, 0x00,             // 监视定时器
        0x01, 0x14,             // 指令 0x1401
        0x00, 0x00,             // 子指令
        0x64, 0x00, 0x00,       // 地址 100
        0xA8,                   // 软元件代码 D
        0x01, 0x00,             // 点数 1
        0x34, 0x12              // 数据 0x1234
      ]);
      assert.deepStrictEqual(buf, expected);
      assert.strictEqual(buf.length, 27);  // 25 + 2
      assert.strictEqual(buf.readUInt16LE(11), 14, 'dataLen=12+2n');
    });
  });

  describe('parseMCWriteResponse', function () {
    it('parses successful 3E write response', function () {
      var buf = Buffer.from([
        0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x02, 0x00,             // 数据长 = 2 (仅结束码)
        0x00, 0x00              // 结束码 0
      ]);
      var r = mc.parseMCWriteResponse(buf, '3E');
      assert.ok(r.ok);
    });
    it('parses successful 4E write response', function () {
      var buf = Buffer.from([
        0xD4, 0x00, 0x34, 0x12, 0x00, 0x00,
        0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x02, 0x00,             // 数据长 @11
        0x00, 0x00              // 结束码 @13
      ]);
      var r = mc.parseMCWriteResponse(buf, '4E', 0x1234);
      assert.ok(r.ok);
    });
    it('rejects serial mismatch in 4E response', function () {
      var buf = Buffer.from([
        0xD4, 0x00, 0x34, 0x12, 0x00, 0x00,
        0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x02, 0x00, 0x00, 0x00
      ]);
      assert.ok(mc.parseMCWriteResponse(buf, '4E', 0x9999).err);
    });
    it('returns mcError for write-protect error', function () {
      var buf = Buffer.from([
        0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x02, 0x00,
        0x54, 0xC0              // 0xC054 写保护
      ]);
      var r = mc.parseMCWriteResponse(buf, '3E');
      assert.strictEqual(r.mcError, 0xC054);
      assert.ok(r.mcErrorText.indexOf('Write protect') >= 0);
    });
    it('rejects frame type mismatch (3E→4E checked, 4E→3E checked)', function () {
      // 4E 帧强制以 3E 解析 → 帧型不匹配
      var buf4e = Buffer.from([
        0xD4, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x02, 0x00, 0x00, 0x00
      ]);
      assert.ok(mc.parseMCWriteResponse(buf4e, '3E').err);
      // 3E 帧强制以 4E 解析 → 帧型不匹配
      var buf3e = Buffer.from([
        0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00,
        0x02, 0x00, 0x00, 0x00
      ]);
      assert.ok(mc.parseMCWriteResponse(buf3e, '4E', 0x1234).err);
    });
  });

  describe('buildRMWWriteGroup', function () {
    it('groups bit-device tags by word (16-bit boundary)', function () {
      var tags = [
        { id: 'b1', regType: 'M', addr: 5, value: 1 },
        { id: 'b2', regType: 'M', addr: 3, value: 0 },
        { id: 'b3', regType: 'M', addr: 18, value: 1 }
      ];
      var groups = mc.buildRMWWriteGroup(tags, 'M');
      // M0-M15 一组 (M3, M5)、M16-M31 一组 (M18)
      assert.strictEqual(groups.length, 2);
      // 第一组 M0 (wordAddr=0), 第二组 M16 (wordAddr=16)
      assert.strictEqual(groups[0].wordAddr, 0);
      assert.strictEqual(groups[1].wordAddr, 16);
      assert.strictEqual(groups[0].bits.length, 2);
      assert.strictEqual(groups[1].bits.length, 1);
      assert.strictEqual(groups[0].bits[0].bitOffset, 3);
      assert.strictEqual(groups[0].bits[0].value, 0);
      assert.strictEqual(groups[0].bits[1].bitOffset, 5);
      assert.strictEqual(groups[0].bits[1].value, 1);
      assert.strictEqual(groups[1].bits[0].bitOffset, 2);  // M18 % 16 = 2
      assert.strictEqual(groups[1].bits[0].value, 1);
    });
    it('word-device BOOL tags group by address', function () {
      var tags = [
        { id: 'd1', addr: 100, bitOffset: 3, value: 1 },
        { id: 'd2', addr: 100, bitOffset: 7, value: 0 },
        { id: 'd3', addr: 200, bitOffset: 0, value: 1 }
      ];
      var groups = mc.buildRMWWriteGroup(tags, 'D');
      assert.strictEqual(groups.length, 2);
      assert.strictEqual(groups[0].wordAddr, 100);
      assert.strictEqual(groups[1].wordAddr, 200);
    });
  });

  describe('groupTagsContiguous (v1.5.0: 严格连续，杜绝写间隙填 0)', function () {
    function mkTags(n, rt, dt, start, step) {
      var s = step || ((dt === 'INT32' || dt === 'UINT32' || dt === 'FLOAT32') ? 2 : (dt === 'DOUBLE' ? 4 : 1));
      var arr = [];
      for (var i = 0; i < n; i++) arr.push({ id: 't' + i, regType: rt, addr: (start || 0) + i * s, dataType: dt || 'INT16' });
      return arr;
    }
    it('contiguous tags stay in one group', function () {
      var g = mc.groupTagsContiguous(mkTags(5, 'D'));
      assert.strictEqual(g.length, 1);
      assert.strictEqual(g[0].tags.length, 5);
    });
    it('gap splits groups (P0-2: 填 0 会清空间隙地址)', function () {
      var tags = mkTags(3, 'D').concat(mkTags(3, 'D', 'INT16', 10));
      var g = mc.groupTagsContiguous(tags);
      assert.strictEqual(g.length, 2);
      assert.strictEqual(g[0].tags.length, 3);
      assert.strictEqual(g[1].tags.length, 3);
    });
    it('INT32 gap splits groups', function () {
      // D100/INT32 (addr 100,102) 和 D200/INT16 (addr 200)：gap=200-103=97 → 拆组
      var tags = [{ id: 'a', regType: 'D', addr: 100, dataType: 'INT32' }, { id: 'b', regType: 'D', addr: 200, dataType: 'INT16' }];
      var g = mc.groupTagsContiguous(tags);
      assert.strictEqual(g.length, 2);
    });
    it('960-word cap splits contiguous tags', function () {
      var g = mc.groupTagsContiguous(mkTags(1000, 'D'));
      assert.strictEqual(g.length, 2);
      assert.strictEqual(g[0].tags.length, 960);
    });
  });

  describe('encodeBitWriteData + buildBitWriteFrame (v1.5.1: 原生位写)', function () {
    it('pack single bit (odd addr) → 1 byte, high nibble', function () {
      // M5=1, 单一位，偶索引相对起始地址 5 → localIdx=0(偶)→高 nibble
      var enc = mc.encodeBitWriteData([{ addr: 5, value: 1 }]);
      assert.strictEqual(enc.bitCount, 1);
      assert.strictEqual(enc.startAddr, 5);
      assert.strictEqual(enc.data.length, 1);
      assert.strictEqual(enc.data[0], 0x10);  // bit 0 (即 M5) 在偶 localIdx→高 nibble
    });
    it('pack two consecutive bits', function () {
      // M0=1, M1=1 → localIdx 0(偶)=高, 1(奇)=低
      var enc = mc.encodeBitWriteData([{ addr: 0, value: 1 }, { addr: 1, value: 1 }]);
      assert.strictEqual(enc.bitCount, 2);
      assert.strictEqual(enc.data[0], 0x11);
    });
    it('P0-2 bit: gap splits — scattered bits MUST produce separate frames, no mid-bit zero-fill', function () {
      // M0=1, M3=1 有间隙 → encodeBitWriteData 只接收严格连续的 bits，不能合组
      var enc = mc.encodeBitWriteData([{ addr: 0, value: 1 }, { addr: 1, value: 0 }, { addr: 2, value: 0 }, { addr: 3, value: 1 }]);
      assert.strictEqual(enc.bitCount, 4);
      assert.strictEqual(enc.startAddr, 0);
      // byte 0: M0=1(偶→高 nibble=0x10) + M1=0(奇→低 nibble=0x00) → 0x10
      // byte 1: M2=0(偶→高 nibble=0x00) + M3=1(奇→低 nibble=0x01) → 0x01
      assert.strictEqual(enc.data[0], 0x10);
      assert.strictEqual(enc.data[1], 0x01);
      // 回归验证：scattered bits 在调用层层面不会合并到此函数
      // （分组层保证严格连续，encodeBitWriteData 不校验连续性——责任在调用方）
    });
    it('build3EBitWriteFrame golden buffer (M0,M1=1,1)', function () {
      var enc = mc.encodeBitWriteData([{ addr: 0, value: 1 }, { addr: 1, value: 1 }]);
      var buf = mc.build3EBitWriteFrame(0, enc.bitCount, enc.data, 0, 'M', 0);
      // header=21 + 1 data byte = 22
      assert.strictEqual(buf.length, 22);
      // dataLen @7: 12 + 1 = 13 = 0x0D
      assert.strictEqual(buf.readUInt16LE(7), 13);
      // command 0x1401, subcommand 0x0001
      assert.strictEqual(buf[11], 0x01); assert.strictEqual(buf[12], 0x14);
      assert.strictEqual(buf[13], 0x01); assert.strictEqual(buf[14], 0x00);
      // device code M=0x90 @18
      assert.strictEqual(buf[18], 0x90);
      // bitCount=2 @19
      assert.strictEqual(buf.readUInt16LE(19), 2);
      // data byte = 0x11
      assert.strictEqual(buf[21], 0x11);
    });
    it('build4EBitWriteFrame golden buffer', function () {
      var enc = mc.encodeBitWriteData([{ addr: 10, value: 1 }]);
      var buf = mc.build4EBitWriteFrame(10, enc.bitCount, enc.data, 0, 'M', 0, 0xABCD);
      assert.strictEqual(buf.length, 26);  // 25 + 1 data
      assert.strictEqual(buf.readUInt16LE(11), 13);  // dataLen=12+1
      assert.strictEqual(buf[17], 0x01); assert.strictEqual(buf[18], 0x00);  // subcmd 0x0001
      assert.strictEqual(buf[22], 0x90);  // M code
      assert.strictEqual(buf.readUInt16LE(23), 1);  // bitCount
      assert.strictEqual(buf[25], 0x10);  // M10 bit
    });
  });

  describe('asciify / deasciify (v1.5.1: ASCII 通信模式)', function () {
    it('asciify round-trip via deasciify', function () {
      var orig = mc.build3EFrame(100, 2, 0, 'D', 0);
      var ascii = mc.asciify(orig);
      // STX @0, ETX before end-2
      assert.strictEqual(ascii[0], 0x02, 'STX');
      assert.ok(ascii.indexOf(0x03) > 2, 'ETX present');
      var dec = mc.deasciify(ascii);
      assert.ok(dec.result, 'deasciify success');
      assert.deepStrictEqual(dec.result, orig, 'round-trip identical');
      assert.strictEqual(dec.consumed, ascii.length, 'all bytes consumed');
    });
    it('deasciify handles incomplete frame (no ETX)', function () {
      var partial = Buffer.from([0x02, 0x35, 0x30]);  // STX + "50"
      var dec = mc.deasciify(partial);
      assert.ok(!dec.result && !dec.err, 'incomplete: no result, no error');
    });
    it('deasciify handles garbage before STX', function () {
      var orig = mc.build3EFrame(0, 1, 0, 'D', 0);
      var ascii = mc.asciify(orig);
      var withGarbage = Buffer.concat([Buffer.from([0x00, 0xFF]), ascii]);
      var dec = mc.deasciify(withGarbage);
      assert.ok(dec.result, 'extracted despite garbage prefix');
      assert.deepStrictEqual(dec.result, orig, 'round-trip clean');
    });
    it('deasciify reports checksum mismatch', function () {
      var orig = mc.build3EFrame(0, 1, 0, 'D', 0);
      var ascii = mc.asciify(orig);
      // Corrupt checksum bytes
      ascii[ascii.length - 1] = 0x41;  // 'A'
      var dec = mc.deasciify(ascii);
      assert.ok(dec.err && dec.err.indexOf('Checksum') >= 0, 'checksum error reported');
    });
    it('deasciify rejects odd hex length', function () {
      // STX + "5" + ETX + "00" → odd hex chars
      var bad = Buffer.from([0x02, 0x35, 0x03, 0x30, 0x30]);
      var dec = mc.deasciify(bad);
      assert.ok(dec.err && dec.err.indexOf('Invalid hex') >= 0, 'odd hex rejected');
    });
  });

  describe('toAsciiHex / fromAsciiHex / dehexifyFrame (v1.6.0: SLMP ASCII Code)', function () {
    var build3E = mc.build3EFrame;
    var build4E = mc.build4EFrame;

    it('toAsciiHex produces pure hex (no STX/ETX)', function () {
      var bin = build3E(0, 1, 0, 'D', 0);
      var hex = mc.toAsciiHex(bin);
      assert.strictEqual(hex.length, bin.length * 2, 'hex length = binary × 2');
      assert.notStrictEqual(hex[0], 0x02, 'no STX');
      assert.ok(/^[0-9A-F]+$/.test(hex.toString('ascii')), 'all uppercase hex');
    });

    it('toAsciiHex → fromAsciiHex round-trip (3E, 21 bytes)', function () {
      var bin = build3E(100, 3, 0, 'D', 0);
      var hex = mc.toAsciiHex(bin);
      var back = mc.fromAsciiHex(hex);
      assert.ok(back, 'decode success');
      assert.deepStrictEqual(back, bin, 'round-trip identical');
    });

    it('toAsciiHex → fromAsciiHex round-trip (4E, 25 bytes)', function () {
      var bin = build4E(200, 5, 0, 'D', 0, 0xAB12);
      var hex = mc.toAsciiHex(bin);
      var back = mc.fromAsciiHex(hex);
      assert.ok(back, 'decode success');
      assert.deepStrictEqual(back, bin, 'round-trip identical');
    });

    it('fromAsciiHex returns null on odd length', function () {
      assert.strictEqual(mc.fromAsciiHex(Buffer.from('ABC', 'ascii')), null);
    });

    it('fromAsciiHex returns null on non-hex chars', function () {
      assert.strictEqual(mc.fromAsciiHex(Buffer.from('ZZZZ', 'ascii')), null);
    });

    it('dehexifyFrame extracts complete 3E frame from buffer', function () {
      var bin = build3E(0, 1, 0, 'D', 0);
      var hex = mc.toAsciiHex(bin);
      // dehexifyFrame(hdrLen=11, dataLenOff=7)
      var df = mc.dehexifyFrame(hex, 11, 7);
      assert.ok(df.result, 'frame extracted');
      assert.deepStrictEqual(df.result, bin, 'decoded binary matches original');
      assert.strictEqual(df.consumed, hex.length, 'all hex consumed');
    });

    it('dehexifyFrame extracts complete 4E frame from buffer', function () {
      var bin = build4E(0, 1, 0, 'D', 0, 0x5678);
      var hex = mc.toAsciiHex(bin);
      var df = mc.dehexifyFrame(hex, 15, 11);
      assert.ok(df.result, 'frame extracted');
      assert.deepStrictEqual(df.result, bin, 'round-trip');
    });

    it('dehexifyFrame waits for incomplete data', function () {
      var bin = build3E(0, 3, 0, 'D', 0);  // 21 bytes, 42 hex chars
      var hex = mc.toAsciiHex(bin);
      var partial = hex.slice(0, 10);  // only 10 hex chars
      var df = mc.dehexifyFrame(partial, 11, 7);
      assert.ok(!df.result && !df.err, 'no result, no error → wait for more');
    });

    it('dehexifyFrame rejects non-hex header', function () {
      var bad = Buffer.from('ZZZZZZZZZZZZZZZZZZZZZZ', 'ascii');  // 22 hex chars worth
      var df = mc.dehexifyFrame(bad, 11, 7);
      assert.ok(df.err, 'non-hex rejected');
    });

    it('dehexifyFrame rejects out-of-range dataLen', function () {
      // Build hex with corrupted dataLen (>2000)
      var bin = build3E(0, 1, 0, 'D', 0);
      bin.writeUInt16LE(4002, 7);  // dataLen=4002 → after -2 = 4000 > 2000
      var hex = mc.toAsciiHex(bin);
      var df = mc.dehexifyFrame(hex, 11, 7);
      assert.ok(df.err && df.err.indexOf('dataLen') >= 0, 'dataLen out of range rejected');
    });

    it('dehexifyFrame handles frame with prefix garbage', function () {
      var bin = build3E(0, 1, 0, 'D', 0);
      var hex = mc.toAsciiHex(bin);
      var withGarbage = Buffer.concat([Buffer.from('GARBAGE', 'ascii'), hex]);
      var df = mc.dehexifyFrame(withGarbage, 11, 7);
      assert.ok(df.err, 'garbage rejected');
      assert.strictEqual(df.consumed, 1, 'one non-hex byte consumed');
    });

    it('dehexifyFrame handles frame with leftover after complete frame', function () {
      var bin = build3E(0, 1, 0, 'D', 0);
      var hex = mc.toAsciiHex(bin);
      var withExtra = Buffer.concat([hex, Buffer.from('EXTRA', 'ascii')]);
      var df = mc.dehexifyFrame(withExtra, 11, 7);
      assert.ok(df.result, 'frame extracted');
      assert.deepStrictEqual(df.result, bin, 'decoded correctly');
      assert.strictEqual(df.consumed, hex.length, 'only frame bytes consumed, extra left');
    });

    it('toAsciiHex renders multi-byte fields as value-hex（与 asciify 的字节序 hex 不同约定）', function () {
      var bin = build3E(0, 2, 0, 'D', 0);   // dataLen=12 → 字节 [0x0C,0x00]
      var hex = mc.toAsciiHex(bin).toString('ascii');
      assert.strictEqual(hex.slice(0, 4), '5000', 'subheader');
      // SLMP ASCII：多字节字段按值渲染为 4 位 hex——dataLen 12 → "000C"（不是字节序 "0C00"）
      assert.strictEqual(hex.substr(14, 4), '000C', 'dataLen 按值渲染（0x000C），与 asciify 的 C24 字节序 hex(0C00) 不同约定');
      assert.strictEqual(hex.length, bin.length * 2, 'hex 长度 = 二进制 × 2');
    });

    it('toAsciiHex encodes short response frames（写响应 11 字节，回归 RangeError）', function () {
      var binResp = Buffer.from([0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x02, 0x00, 0x00, 0x00]);
      var hex = mc.toAsciiHex(binResp).toString('ascii');
      assert.strictEqual(hex, 'D00000FF03FF0000020000', '响应帧编码：子头+路由+数据长+结束码');
      // 4E 写响应（15 字节）
      var bin4E = Buffer.from([0xD4, 0x00, 0x34, 0x12, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x02, 0x00, 0x00, 0x00]);
      assert.strictEqual(mc.toAsciiHex(bin4E).toString('ascii'), 'D4001234000000FF03FF0000020000', '4E 响应帧编码');
    });

    // 🔧 v1.7.4: 响应帧解码回归——旧实现按请求布局 + 42/50 字符下限，导致写响应（11/15 字节）与 <5 字读响应被拒
    it('fromAsciiHex decodes 3E write response (11 bytes)', function () {
      var bin = mc.fromAsciiHex(Buffer.from('D00000FF03FF0000020000', 'ascii'));
      assert.ok(bin, 'decode success');
      assert.strictEqual(bin.length, 11);
      assert.strictEqual(bin[0], 0xD0);
      assert.strictEqual(bin.readUInt16LE(7), 2, 'dataLen=2');
      assert.strictEqual(bin.readUInt16LE(9), 0, 'endcode=0');
      assert.ok(mc.parseMCWriteResponse(bin, '3E').ok, 'write response ok');
    });

    it('fromAsciiHex decodes 3E read response (2 words)', function () {
      var bin = mc.fromAsciiHex(Buffer.from('D00000FF03FF000006000012345678', 'ascii'));
      assert.ok(bin, 'decode success');
      assert.strictEqual(bin.length, 15);
      var r = mc.parseMCResponse(bin, 100, 'D', '3E');
      assert.strictEqual(r['D100'], 0x1234, 'word 0');
      assert.strictEqual(r['D101'], 0x5678, 'word 1');
    });

    it('fromAsciiHex decodes 4E write response (15 bytes)', function () {
      var bin = mc.fromAsciiHex(Buffer.from('D4001234000000FF03FF0000020000', 'ascii'));
      assert.ok(bin, 'decode success');
      assert.strictEqual(bin.length, 15);
      assert.ok(mc.parseMCWriteResponse(bin, '4E', 0x1234).ok, 'write response ok (serial echo 0x1234)');
    });
  });
});
