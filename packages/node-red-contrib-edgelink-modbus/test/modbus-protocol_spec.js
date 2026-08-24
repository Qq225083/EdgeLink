/* eslint-env mocha */
'use strict';

var assert = require('assert');
var mb = require('../nodes/modbus-protocol');

describe('modbus-protocol', function () {
  describe('clampInt', function () {
    it('clamps values within range', function () {
      assert.strictEqual(mb.clampInt(5, 10, 0, 100), 5);
      assert.strictEqual(mb.clampInt(50, 10, 0, 100), 50);
      assert.strictEqual(mb.clampInt(200, 10, 0, 100), 100);
      assert.strictEqual(mb.clampInt('abc', 10, 0, 100), 10);
    });
  });

  describe('buildModbusFrame', function () {
    it('constructs a 3E read holding register frame', function () {
      var r = mb.buildModbusFrame(1, 3, 100, 5);
      assert.strictEqual(r.buf.length, 12);
      assert.strictEqual(r.buf.readUInt16BE(2), 0); // Protocol ID
      assert.strictEqual(r.buf.readUInt16BE(4), 6); // Length
      assert.strictEqual(r.buf[6], 1); // Unit ID
      assert.strictEqual(r.buf[7], 3); // Function code
      assert.strictEqual(r.buf.readUInt16BE(8), 100); // Start address
      assert.strictEqual(r.buf.readUInt16BE(10), 5); // Quantity
      assert.ok(r.txnId > 0 && r.txnId <= 65535);
    });

    it('increments txnId across calls', function () {
      var r1 = mb.buildModbusFrame(1, 3, 0, 1);
      var r2 = mb.buildModbusFrame(1, 3, 0, 1);
      assert.strictEqual(r2.txnId, ((r1.txnId % 65535) + 1));
    });
  });

  describe('parseModbusResponse', function () {
    it('parses holding register response', function () {
      var data = Buffer.alloc(4);
      data.writeUInt16BE(0x1234, 0);
      data.writeUInt16BE(0x5678, 2);
      var hdr = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x05, 0x01, 0x03, 0x04]);
      var buf = Buffer.concat([hdr, data]);
      var res = mb.parseModbusResponse(buf, 10, 'holding', 2, 1);
      assert.strictEqual(res.err, undefined);
      assert.strictEqual(res[10], 0x1234);
      assert.strictEqual(res[11], 0x5678);
    });

    it('parses coil response', function () {
      // coils 0-7: 0b00001010 → coil1=1, coil3=1
      var hdr = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x04, 0x01, 0x01, 0x01, 0x0A]);
      var res = mb.parseModbusResponse(hdr, 0, 'coil', 8, 1);
      assert.strictEqual(res[0], 0);
      assert.strictEqual(res[1], 1);
      assert.strictEqual(res[2], 0);
      assert.strictEqual(res[3], 1);
    });

    it('detects exception response', function () {
      var hdr = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x01, 0x83, 0x02]);
      var res = mb.parseModbusResponse(hdr, 0, 'holding', 1, 1);
      assert.strictEqual(res.exCode, 2);
      assert.ok(res.exText.indexOf('Illegal data address') >= 0);
    });

    it('detects unit ID mismatch', function () {
      var hdr = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x02, 0x03, 0x02]);
      var res = mb.parseModbusResponse(hdr, 0, 'holding', 1, 1);
      assert.strictEqual(res.err, 'Unit ID mismatch');
    });
  });

  describe('decodeValue', function () {
    it('decodes INT16 with byte order AB', function () {
      assert.strictEqual(mb.decodeValue(0x1234, 0, {}, 'INT16', 'AB'), 0x1234);
    });

    it('decodes INT16 with byte order BA', function () {
      assert.strictEqual(mb.decodeValue(0x1234, 0, {}, 'INT16', 'BA'), 0x3412);
    });

    it('decodes negative INT16', function () {
      assert.strictEqual(mb.decodeValue(0xFFFF, 0, {}, 'INT16', 'AB'), -1);
    });

    it('decodes INT32 ABCD', function () {
      var rawData = { 10: 0x1234, 11: 0x5678 };
      assert.strictEqual(mb.decodeValue(0x1234, 10, rawData, 'INT32', 'ABCD'), 0x12345678);
    });

    it('decodes INT32 CDAB', function () {
      var rawData = { 10: 0x5678, 11: 0x1234 };
      assert.strictEqual(mb.decodeValue(0x5678, 10, rawData, 'INT32', 'CDAB'), 0x12345678);
    });

    it('decodes FLOAT32', function () {
      var rawData = { 0: 0x4040, 1: 0x0000 }; // 3.0 in ABCD
      var v = mb.decodeValue(0x4040, 0, rawData, 'FLOAT32', 'ABCD');
      assert.strictEqual(v, 3);
    });
  });

  describe('applyTransform', function () {
    it('applies slope and offset', function () {
      assert.strictEqual(mb.applyTransform(100, { slope: 0.1, offset: 5 }), 15);
      assert.strictEqual(mb.applyTransform(2530, { slope: 0.1, offset: 0 }), 253);
    });

    it('keeps slope = 0 (legal value, must not fall back to 1)', function () {
      assert.strictEqual(mb.applyTransform(100, { slope: 0, offset: 5 }), 5);
      assert.strictEqual(mb.applyTransform(100, { slope: 0 }), 0);
    });
  });

  describe('normalizeByteOrder', function () {
    it('maps panel vocabulary to protocol axes', function () {
      assert.deepStrictEqual(mb.normalizeByteOrder({ byteOrder: 'AB' }), { byteOrder: null, wordOrder: null });
      assert.deepStrictEqual(mb.normalizeByteOrder({ byteOrder: 'BA' }), { byteOrder: 'BIG_ENDIAN', wordOrder: null });
      assert.deepStrictEqual(mb.normalizeByteOrder({ byteOrder: 'ABCD' }), { byteOrder: null, wordOrder: 'HIGH_FIRST' });
      assert.deepStrictEqual(mb.normalizeByteOrder({ byteOrder: 'CDAB' }), { byteOrder: null, wordOrder: 'LOW_FIRST' });
      assert.deepStrictEqual(mb.normalizeByteOrder({ byteOrder: 'BADC' }), { byteOrder: 'BIG_ENDIAN', wordOrder: 'HIGH_FIRST' });
      assert.deepStrictEqual(mb.normalizeByteOrder({ byteOrder: 'DCBA' }), { byteOrder: 'BIG_ENDIAN', wordOrder: 'LOW_FIRST' });
    });

    it('passes protocol vocabulary through', function () {
      assert.deepStrictEqual(mb.normalizeByteOrder({ byteOrder: 'BIG_ENDIAN', wordOrder: 'HIGH_FIRST' }),
        { byteOrder: 'BIG_ENDIAN', wordOrder: 'HIGH_FIRST' });
      assert.deepStrictEqual(mb.normalizeByteOrder({}), { byteOrder: null, wordOrder: null });
    });
  });

  describe('buildWriteFrame', function () {
    it('constructs FC06 write single register frame', function () {
      var r = mb.buildWriteFrame(1, 6, 100, [42]);
      assert.strictEqual(r.buf.length, 12);
      assert.strictEqual(r.buf.readUInt16BE(2), 0);
      assert.strictEqual(r.buf.readUInt16BE(4), 6);
      assert.strictEqual(r.buf[6], 1);
      assert.strictEqual(r.buf[7], 6);
      assert.strictEqual(r.buf.readUInt16BE(8), 100);
      assert.strictEqual(r.buf.readUInt16BE(10), 42);
    });

    it('constructs FC05 coil frame (0xFF00 = ON)', function () {
      var r = mb.buildWriteFrame(2, 5, 3, [0xFF00]);
      assert.strictEqual(r.buf[7], 5);
      assert.strictEqual(r.buf.readUInt16BE(8), 3);
      assert.strictEqual(r.buf.readUInt16BE(10), 0xFF00);
    });

    it('constructs FC16 write multiple registers frame', function () {
      var r = mb.buildWriteFrame(1, 16, 200, [0x1111, 0x2222]);
      assert.strictEqual(r.buf.length, 17);
      assert.strictEqual(r.buf.readUInt16BE(4), 11); // 7 + 2*2
      assert.strictEqual(r.buf[7], 16);
      assert.strictEqual(r.buf.readUInt16BE(8), 200);
      assert.strictEqual(r.buf.readUInt16BE(10), 2);  // quantity
      assert.strictEqual(r.buf[12], 4);               // byteCount
      assert.strictEqual(r.buf.readUInt16BE(13), 0x1111);
      assert.strictEqual(r.buf.readUInt16BE(15), 0x2222);
    });
  });

  describe('parseWriteResponse', function () {
    it('accepts valid FC06 echo', function () {
      var hdr = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x06, 0x00, 0x64, 0x00, 0x2A]);
      var res = mb.parseWriteResponse(hdr, 6, 100, [42], 1);
      assert.strictEqual(res.ok, true);
    });

    it('accepts valid FC16 echo (addr + quantity)', function () {
      var hdr = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x10, 0x00, 0xC8, 0x00, 0x02]);
      var res = mb.parseWriteResponse(hdr, 16, 200, [0x1111, 0x2222], 1);
      assert.strictEqual(res.ok, true);
    });

    it('rejects value echo mismatch', function () {
      var hdr = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x06, 0x00, 0x64, 0x00, 0x2B]);
      var res = mb.parseWriteResponse(hdr, 6, 100, [42], 1);
      assert.ok(res.err.indexOf('Value echo mismatch') >= 0);
    });

    it('rejects address echo mismatch', function () {
      var hdr = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x06, 0x00, 0x65, 0x00, 0x2A]);
      var res = mb.parseWriteResponse(hdr, 6, 100, [42], 1);
      assert.ok(res.err.indexOf('Address echo mismatch') >= 0);
    });

    it('detects write exception response (9 bytes)', function () {
      var hdr = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x01, 0x86, 0x02]);
      var res = mb.parseWriteResponse(hdr, 6, 100, [42], 1);
      assert.strictEqual(res.exCode, 2);
      assert.ok(res.exText.indexOf('Illegal data address') >= 0);
    });
  });

  describe('encodeValue', function () {
    it('encodes INT16 negative', function () {
      assert.deepStrictEqual(mb.encodeValue(-1, 'INT16'), [0xFFFF]);
      assert.deepStrictEqual(mb.encodeValue(-2, 'INT16'), [0xFFFE]);
    });

    it('encodes UINT16 with BA byte swap', function () {
      assert.deepStrictEqual(mb.encodeValue(0x1234, 'UINT16', 'BA'), [0x3412]);
    });

    it('roundtrips INT32 via decodeValue (ABCD)', function () {
      var words = mb.encodeValue(0x12345678, 'INT32', 'ABCD');
      var rawData = { 10: words[0], 11: words[1] };
      assert.strictEqual(mb.decodeValue(words[0], 10, rawData, 'INT32', 'ABCD'), 0x12345678);
    });

    it('roundtrips negative INT32 (CDAB)', function () {
      var words = mb.encodeValue(-12345678, 'INT32', 'CDAB');
      var rawData = { 0: words[0], 1: words[1] };
      assert.strictEqual(mb.decodeValue(words[0], 0, rawData, 'INT32', 'CDAB'), -12345678);
    });

    it('roundtrips UINT32 max', function () {
      var words = mb.encodeValue(4294967295, 'UINT32');
      var rawData = { 0: words[0], 1: words[1] };
      assert.strictEqual(mb.decodeValue(words[0], 0, rawData, 'UINT32'), 4294967295);
    });

    it('roundtrips FLOAT32', function () {
      var words = mb.encodeValue(3.14, 'FLOAT32', 'ABCD');
      var rawData = { 4: words[0], 5: words[1] };
      var v = mb.decodeValue(words[0], 4, rawData, 'FLOAT32', 'ABCD');
      assert.ok(Math.abs(v - 3.14) < 0.001);
    });

    it('roundtrips FLOAT32 with DCBA', function () {
      var words = mb.encodeValue(-2.5, 'FLOAT32', 'DCBA');
      assert.strictEqual(words.length, 2);
      var rawData = { 0: words[0], 1: words[1] };
      var v = mb.decodeValue(words[0], 0, rawData, 'FLOAT32', 'DCBA');
      assert.ok(Math.abs(v - (-2.5)) < 0.001);
    });

    it('roundtrips DOUBLE (4 registers)', function () {
      var words = mb.encodeValue(123.456, 'DOUBLE', 'ABCD');
      assert.strictEqual(words.length, 4);
      var rawData = {};
      for (var i = 0; i < 4; i++) rawData[20 + i] = words[i];
      var v = mb.decodeValue(words[0], 20, rawData, 'DOUBLE', 'ABCD');
      assert.ok(Math.abs(v - 123.456) < 0.0001);
    });

    it('returns null for NaN and unknown type', function () {
      assert.strictEqual(mb.encodeValue('abc', 'INT16'), null);
      assert.strictEqual(mb.encodeValue(1, 'WEIRD_TYPE'), null);
    });

    it('DOUBLE encode→decode round-trip (Day6 review 补测)', function () {
      var words = mb.encodeValue(-9876.54321, 'DOUBLE', null, 'LOW_FIRST');
      assert.strictEqual(words.length, 4);
      var rawData = {};
      for (var i = 0; i < 4; i++) rawData[40 + i] = words[i];
      var v = mb.decodeValue(words[0], 40, rawData, 'DOUBLE', null, 'LOW_FIRST');
      assert.ok(Math.abs(v - (-9876.54321)) < 1e-8, 'got ' + v);
    });

    it('BOOL bitOffset clamps out-of-range to 0 (Day6 review 补测)', function () {
      // 0x0004 = bit2；越界 bitOffset 应按 0 处理（调用处另有 warn）
      assert.strictEqual(mb.decodeValue(0x0004, 0, { 0: 0x0004 }, 'BOOL', null, null, 20), 0);
      assert.strictEqual(mb.decodeValue(0x0004, 0, { 0: 0x0004 }, 'BOOL', null, null, 2), 1);
      assert.strictEqual(mb.decodeValue(0x0004, 0, { 0: 0x0004 }, 'BOOL', null, null, 'abc'), 0);
    });
    it('BOOL under BIG_ENDIAN swaps bytes before bit extraction（修复#5 回归）', function () {
      // 0x0100：BE 换序后 = 0x0001，bit0=1；不换序 bit0=0、bit8=1
      assert.strictEqual(mb.decodeValue(0x0100, 0, { 0: 0x0100 }, 'BOOL', 'BIG_ENDIAN', null, 0), 1);
      assert.strictEqual(mb.decodeValue(0x0100, 0, { 0: 0x0100 }, 'BOOL', null, null, 0), 0);
      assert.strictEqual(mb.decodeValue(0x0100, 0, { 0: 0x0100 }, 'BOOL', null, null, 8), 1);
    });
  });
});
