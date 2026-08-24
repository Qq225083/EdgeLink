/**
 * modbus-read — Modbus TCP 读取节点 v1.0
 *
 * 功能码: 01(线圈) 02(离散输入) 03(保持寄存器) 04(输入寄存器)
 * 数据类型: INT16/UINT16/INT32/UINT32/FLOAT32/BOOL
 * 字节序: AB/BA/ABCD/CDAB/BADC/DCBA
 */
module.exports = function (RED) {
  'use strict';
  var net = require('net');

  // ==== 功能码映射 ====
  var FC_MAP = {
    'coil': { fc: 1, bit: true },
    'discrete': { fc: 2, bit: true },
    'holding': { fc: 3, bit: false },
    'input': { fc: 4, bit: false }
  };

  // ==== 异常码映射 ====
  var EX_CODES = {
    1: 'Illegal function', 2: 'Illegal data address', 3: 'Illegal data value',
    4: 'Slave device failure', 5: 'Acknowledge', 6: 'Slave device busy',
    10: 'Gateway path unavailable', 11: 'Gateway target failed'
  };
  function exText(code) { return EX_CODES[code] || ('Unknown error 0x' + code.toString(16)); }

  function clampInt(v, def, min, max) {
    var n = parseInt(v, 10);
    if (isNaN(n)) n = def;
    return Math.max(min, Math.min(n, max));
  }

  // ==== 字节序处理 ====
  function applyByteOrder(buf16, byteOrder) {
    // buf16: 2-byte Buffer, or 4-byte for 32-bit
    if (buf16.length === 2) {
      var lo = buf16[0], hi = buf16[1];
      if (byteOrder === 'BA') return (hi << 8) | lo;
      return (lo << 8) | hi; // AB default
    }
    if (buf16.length === 4) {
      var a = buf16[0], b = buf16[1], c = buf16[2], d = buf16[3];
      switch (byteOrder) {
        case 'ABCD': return (a << 24) | (b << 16) | (c << 8) | d;
        case 'CDAB': return (c << 24) | (d << 16) | (a << 8) | b;
        case 'BADC': return (b << 24) | (a << 16) | (d << 8) | c;
        case 'DCBA': return (d << 24) | (c << 16) | (b << 8) | a;
        default: return (a << 24) | (b << 16) | (c << 8) | d;
      }
    }
    return 0;
  }

  // ==== 帧构造 ====
  function buildModbusFrame(unitId, fc, startAddr, quantity) {
    var buf = Buffer.alloc(12);
    buf.writeUInt16BE(1, 0);   // Transaction ID
    buf.writeUInt16BE(0, 2);   // Protocol ID
    buf.writeUInt16BE(6, 4);   // Length
    buf[6] = unitId;           // Unit ID
    buf[7] = fc;               // Function Code
    buf.writeUInt16BE(startAddr, 8);  // Start Address
    buf.writeUInt16BE(quantity, 10);  // Quantity
    return buf;
  }

  // ==== 响应解析 ====
  function parseModbusResponse(buf, startAddr, regType, quantity, byteOrder) {
    if (!buf || buf.length < 9) return { err: 'Buffer too short' };
    if (buf.readUInt16BE(0) !== 1) return { err: 'Transaction ID mismatch' };

    var fc = buf[7];
    if (fc & 0x80) return { exCode: buf[8], exText: exText(buf[8]) };

    var byteCount = buf[8];
    var isBit = FC_MAP[regType] ? FC_MAP[regType].bit : false;

    if (isBit) {
      var result = {};
      for (var i = 0; i < byteCount; i++) {
        var b = buf[9 + i];
        for (var j = 0; j < 8; j++) {
          var addr = startAddr + i * 8 + j;
          if (addr - startAddr >= quantity) break;
          result[addr] = (b >> j) & 1;
        }
      }
      return result;
    }

    // 字寄存器
    var result = {};
    for (var i = 0; i < byteCount / 2; i++) {
      var raw = buf.slice(9 + i * 2, 9 + i * 2 + 2);
      result[startAddr + i] = applyByteOrder(raw, byteOrder || 'AB');
    }
    return result;
  }

  // ==== 数据类型解码 ====
  function decodeValue(raw, addr, rawData, dataType, byteOrder) {
    if (raw === null || raw === undefined) return null;
    var dt = dataType || 'INT16';

    if (dt === 'BOOL') return raw ? 1 : 0;
    if (dt === 'INT16') return raw > 0x7FFF ? raw - 0x10000 : raw;
    if (dt === 'UINT16') return raw;

    // 32-bit: 需要相邻两个寄存器
    var hiRaw = raw;
    var loAddr = addr + 1;
    var loRaw = rawData[loAddr];
    if (loRaw === undefined || loRaw === null) return null;

    var buf4 = Buffer.alloc(4);
    // 按字节序写入
    switch (byteOrder || 'ABCD') {
      case 'ABCD':
        buf4.writeUInt16BE(hiRaw, 0); buf4.writeUInt16BE(loRaw, 2); break;
      case 'CDAB':
        buf4.writeUInt16BE(loRaw, 0); buf4.writeUInt16BE(hiRaw, 2); break;
      case 'BADC':
        buf4.writeUInt16BE(hiRaw, 0); buf4.writeUInt16BE(loRaw, 2);
        var tmp = buf4[0]; buf4[0] = buf4[1]; buf4[1] = tmp;
        tmp = buf4[2]; buf4[2] = buf4[3]; buf4[3] = tmp;
        break;
      case 'DCBA':
        buf4.writeUInt16BE(loRaw, 0); buf4.writeUInt16BE(hiRaw, 2);
        var tmp2 = buf4[0]; buf4[0] = buf4[1]; buf4[1] = tmp2;
        tmp2 = buf4[2]; buf4[2] = buf4[3]; buf4[3] = tmp2;
        break;
      default:
        buf4.writeUInt16BE(hiRaw, 0); buf4.writeUInt16BE(loRaw, 2);
    }

    if (dt === 'INT32') return buf4.readInt32BE(0);
    if (dt === 'UINT32') return buf4.readUInt32BE(0);
    if (dt === 'FLOAT32') return parseFloat(buf4.readFloatBE(0).toFixed(4));

    return raw;
  }

  // ==== 应用变换 ====
  function applyTransform(rawValue, tagDef) {
    if (rawValue === null || rawValue === undefined) return null;
    var slope = parseFloat(tagDef.slope || 1);
    var offset = parseFloat(tagDef.offset || 0);
    if (isNaN(slope)) slope = 1;
    if (isNaN(offset)) offset = 0;
    return parseFloat((rawValue * slope + offset).toFixed(4));
  }

  // ==== 节点 ====
  function ModbusReadNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    node.modbusConfig = RED.nodes.getNode(config.modbus);
    if (!node.modbusConfig) {
      node.error('未关联 Modbus 配置节点');
      return;
    }

    var configTags = [];
    try { configTags = JSON.parse(config.tags || '[]'); } catch (e) { configTags = []; }

    node.on('input', function (msg) {
      // 动态IP覆盖: msg.payload.plcIp/plcPort 可覆盖 config, 一个节点采多台设备
      var cfg = node.modbusConfig;
      var mb = {
        name: cfg.name, host: msg.payload.plcIp || cfg.host,
        port: msg.payload.plcPort || cfg.port, unitId: cfg.unitId,
        timeout: cfg.timeout, maxRetries: cfg.maxRetries,
        retryInterval: cfg.retryInterval
      };

      // 点位来源
      var rawTags = msg.tags || (msg.payload && msg.payload.tags);
      if (!rawTags || (Array.isArray(rawTags) && rawTags.length === 0)) rawTags = configTags;
      if (!Array.isArray(rawTags)) rawTags = [rawTags];

      // 校验清洗
      var validTags = [];
      for (var i = 0; i < rawTags.length; i++) {
        var t = rawTags[i];
        var ALIAS = { 'HR': 'holding', 'IR': 'input', 'COIL': 'coil', 'DI': 'discrete' };
        var DT_ALIAS = { 'FLOAT': 'FLOAT32', 'BIT': 'BOOL' };
        var rt = ALIAS[t.regType] || t.regType || 'holding';
        if (!FC_MAP[rt]) { node.warn('[MB] Unknown regType: ' + rt + ', using holding'); rt = 'holding'; }
        var dt = DT_ALIAS[t.dataType] || t.dataType || 'INT16';
        var addr = parseInt(t.addr || t.regAddr || 0, 10);
        if (isNaN(addr) || addr < 0) { node.warn('[MB] Invalid addr for tag ' + (t.id || t.name || ('#' + i))); continue; }
        var tagId = t.id || t.name || (rt + addr);
        validTags.push({
          id: String(tagId),
          regType: rt,
          addr: addr,
          dataType: dt,
          byteOrder: t.byteOrder || t.byte_order || 'AB',
          slope: t.slope || 1,
          offset: t.offset || 0,
          name: t.name || (rt + addr)
        });
      }

      if (validTags.length === 0) {
        node.status({ fill: 'grey', shape: 'dot', text: '0 valid tags' });
        return;
      }

      var timeout = clampInt(mb.timeout, 3000, 500, 30000);
      var maxRetries = clampInt(mb.maxRetries, 2, 0, 10);
      var retryInterval = clampInt(mb.retryInterval, 300, 50, 10000);
      var unitId = mb.unitId || 1;
      var roundStart = Date.now();

      // 模拟模式
      var SIM = false;
      try { SIM = RED.settings.mbSimulationMode || false; } catch (e) {}

      if (SIM) {
        var simOut = {};
        validTags.forEach(function (t) {
          var raw = FC_MAP[t.regType].bit ? (Math.random() > 0.5 ? 1 : 0) : Math.floor(Math.random() * 2000);
          simOut[t.id] = { rawValue: raw, engValue: applyTransform(raw, t), quality: 0, ts: new Date().toISOString() };
        });
        var devId = mb.name || (mb.host + ':' + mb.port);
        msg.payload = { success: true, deviceId: devId, data: simOut, error: null, roundTimeMs: Date.now() - roundStart };
        node.status({ fill: 'green', shape: 'dot', text: 'SIM ' + validTags.length + ' tags' });
        node.send(msg);
        return;
      }

      // 按 regType 分组
      var byRegType = {};
      validTags.forEach(function (t) {
        if (!byRegType[t.regType]) byRegType[t.regType] = [];
        byRegType[t.regType].push(t);
      });

      var groups = [];
      Object.keys(byRegType).forEach(function (rt) {
        var sorted = byRegType[rt].slice().sort(function (a, b) { return a.addr - b.addr; });
        var cluster = [sorted[0]];
        for (var i = 1; i < sorted.length; i++) {
          var gap = sorted[i].addr - cluster[cluster.length - 1].addr;
          if (gap <= 20 && cluster.length < 100) {
            cluster.push(sorted[i]);
          } else {
            groups.push({ regType: rt, tags: cluster });
            cluster = [sorted[i]];
          }
        }
        if (cluster.length > 0) groups.push({ regType: rt, tags: cluster });
      });

      if (groups.length === 0) {
        msg.payload = { success: false, data: {}, error: 'No valid groups' };
        node.send(msg);
        return;
      }

      // 全局锁
      var lockKey = 'edge_mb_lock_' + mb.host + '_' + mb.port;
      if (!global._mbLocks) global._mbLocks = {};
      if (global._mbLocks[lockKey] && (Date.now() - global._mbLocks[lockKey] < 60000)) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'busy' });
        return;
      }
      global._mbLocks[lockKey] = Date.now();

      var allRaw = {};
      var hasFailed = false;
      var firstError = '';

      function processGroup(gi) {
        if (gi >= groups.length) {
          var output = {};
          validTags.forEach(function (t) {
            var entry = allRaw[t.id];
            if (entry) {
              output[t.id] = {
                rawValue: entry.rawValue,
                engValue: applyTransform(entry.convertedValue != null ? entry.convertedValue : entry.rawValue, t),
                quality: entry.quality,
                ts: entry.ts,
                regType: t.regType
              };
            }
          });
          msg.payload = {
            success: !hasFailed,
            deviceId: msg.payload.id || msg.payload.deviceName || mb.name || (mb.host + ':' + mb.port),
            data: output,
            error: hasFailed ? firstError : null,
            driverType: 'driver-modbus-tcp',
            plcIp: mb.host,
            plcPort: mb.port,
            roundTimeMs: Date.now() - roundStart
          };
          node.status({ fill: hasFailed ? 'red' : 'green', shape: 'dot', text: (mb.name || mb.host) + ' ' + Object.keys(output).length + ' vals' });
          delete global._mbLocks[lockKey];
          node.send(msg);
          return;
        }

        var grp = groups[gi];
        var isBit = FC_MAP[grp.regType].bit;
        var fc = FC_MAP[grp.regType].fc;
        var addrs = grp.tags.map(function (t) { return t.addr; });
        var startA = addrs[0];

        // BUG-2 fix: Modbus 协议支持任意起始地址，不对齐
        // BUG-3 fix: 32位类型需要读2个寄存器，扩展范围
        var lastAddr = addrs[addrs.length - 1];
        for (var ti = 0; ti < grp.tags.length; ti++) {
          var dt2 = grp.tags[ti].dataType || 'INT16';
          if (dt2 === 'INT32' || dt2 === 'UINT32' || dt2 === 'FLOAT32') {
            if (grp.tags[ti].addr + 1 > lastAddr) lastAddr = grp.tags[ti].addr + 1;
          }
        }
        var quantity = lastAddr - startA + 1;
        var MAX_QUANTITY = isBit ? 2000 : 125;
        if (quantity > MAX_QUANTITY) {
          // BUG-A fix: 拆分按扩展后的结束地址，防 32 位边界死循环
          function _tagEnd(t) { var d = t.dataType || 'INT16'; return t.addr + ((d==='INT32'||d==='UINT32'||d==='FLOAT32') ? 1 : 0); }
          var newGroups = [];
          var ss = 0;
          while (ss < grp.tags.length) {
            var se = ss;
            var subStart = grp.tags[ss].addr;
            while (se < grp.tags.length) {
              var tEnd = _tagEnd(grp.tags[se]);
              if (tEnd - subStart + 1 > MAX_QUANTITY) break;
              se++;
            }
            if (se === ss) se = ss + 1; // 单标签超限：至少取一个
            newGroups.push({ regType: grp.regType, tags: grp.tags.slice(ss, se) });
            ss = se;
          }
          groups.splice.apply(groups, [gi, 1].concat(newGroups));
          setTimeout(function () { processGroup(gi); }, 0);
          return;
        }

        function attempt(n) {
          if (attempt > maxRetries) {
            hasFailed = true;
            if (!firstError) firstError = 'Modbus read failed for ' + grp.regType + ' addr=' + startA;
            setTimeout(function () { processGroup(gi + 1); }, 0);
            return;
          }

          var client = new net.Socket();
          var buf = Buffer.alloc(0);
          var resolved = false;
          var destroyedByUs = false;
          var connectTimer = null;
          client.setTimeout(timeout);

          // BUG-4 fix: connect 超时
          node._activeClient = client;  // BUG-5 fix: 追踪当前 socket
          connectTimer = setTimeout(function () {
            if (!resolved) { resolved = true; try { client.destroy(); } catch (e) {} }
            setTimeout(function () { attempt(n + 1); }, retryInterval);
          }, timeout);

          client.connect(mb.port, mb.host, function () {
            if (connectTimer) clearTimeout(connectTimer);
            try {
              var frame = buildModbusFrame(unitId, fc, startA, quantity);
              client.write(frame);
            } catch (e) {
              if (!resolved) { resolved = true; try { client.destroy(); } catch (e2) {} }
              setTimeout(function () { attempt(n + 1); }, retryInterval);
            }
          });

          client.on('data', function (chunk) {
            try {
              buf = Buffer.concat([buf, chunk]);
              if (!resolved && buf.length >= 9) {
                // BUG-1 fix: 先检查异常响应 (FC|0x80, 固定9字节)
                if (buf[7] & 0x80) {
                  resolved = true;
                  var exRaw = parseModbusResponse(buf, startA, grp.regType, quantity, grp.tags[0] ? grp.tags[0].byteOrder : 'AB');
                  if (exRaw && exRaw.exCode) {
                    hasFailed = true;
                    if (!firstError) firstError = '[MB 0x' + exRaw.exCode.toString(16) + '] ' + exRaw.exText;
                    destroyedByUs = true; try { client.destroy(); } catch (e) {}
                    setTimeout(function () { processGroup(gi + 1); }, 0);
                  }
                  return;
                }
                // 用 MBAP Length 计算完整帧长: 6 + length
                var mbapLen = buf.readUInt16BE(4);
                var expectedLen = 6 + mbapLen;
                if (buf.length >= expectedLen) {
                  resolved = true;
                  var raw = parseModbusResponse(buf, startA, grp.regType, quantity, grp.tags[0] ? grp.tags[0].byteOrder : 'AB');

                  if (raw && raw.exCode) {
                    hasFailed = true;
                    if (!firstError) firstError = '[MB 0x' + raw.exCode.toString(16) + '] ' + raw.exText;
                    destroyedByUs = true; try { client.destroy(); } catch (e) {}
                    setTimeout(function () { processGroup(gi + 1); }, 0);
                  } else if (raw && !raw.err) {
                    grp.tags.forEach(function (t) {
                      var rv = raw[t.addr];
                      var q = 0;
                      if (rv === undefined || rv === null) { q = 2; }
                      else if (!isBit) {
                        var adjAddr = t.addr + 1;
                        var rawData = {};
                        for (var k in raw) { rawData[k] = raw[k]; }
                        var cv = decodeValue(rv, t.addr, rawData, t.dataType, t.byteOrder);
                        allRaw[t.id] = { rawValue: rv, convertedValue: cv, quality: q, ts: new Date().toISOString() };
                        return;
                      }
                      allRaw[t.id] = { rawValue: rv, convertedValue: rv, quality: q, ts: new Date().toISOString() };
                    });
                    destroyedByUs = true; try { client.destroy(); } catch (e) {}
                    setTimeout(function () { processGroup(gi + 1); }, 0);
                  } else {
                    destroyedByUs = true; try { client.destroy(); } catch (e) {}
                    setTimeout(function () { attempt(n + 1); }, retryInterval);
                  }
                }
              }
            } catch (e) {
              node.warn('[MB] data error: ' + e.message);
              if (!resolved) { resolved = true; try { client.destroy(); } catch (e2) {} }
              setTimeout(function () { processGroup(gi + 1); }, 0);
            }
          });

          client.on('timeout', function () { if (resolved) return; resolved = true; try { client.destroy(); } catch (e) {} setTimeout(function () { attempt(n + 1); }, retryInterval); });
          client.on('error', function () { if (resolved) return; resolved = true; try { client.destroy(); } catch (e) {} setTimeout(function () { attempt(n + 1); }, retryInterval); });
          client.on('close', function () {
            if (destroyedByUs) return;
            if (!resolved) {
              resolved = true;
              if (buf.length === 0) { hasFailed = true; if (!firstError) firstError = '[NETWORK] TCP closed (no data)'; setTimeout(function () { processGroup(gi + 1); }, 0); }
              else { setTimeout(function () { attempt(n + 1); }, retryInterval); }
            }
          });
        }
        attempt(0);
      }

      try { processGroup(0); } catch (e) {
        node.warn('[MB] Exception: ' + e.message);
        delete global._mbLocks[lockKey];
        msg.payload = { success: false, data: {}, error: e.message };
        node.send(msg);
      }
    });

    // close 处理器
    node.on('close', function (done) {
      try {
        var m2 = node.modbusConfig;
        if (m2 && m2.host) { var lk = 'edge_mb_lock_' + m2.host + '_' + m2.port; delete global._mbLocks[lk]; }
        // BUG-5 fix: 销毁正在通信的 socket
        if (node._activeClient) { try { node._activeClient.destroy(); } catch (e) {} node._activeClient = null; }
      } catch (e) {}
      node.status({ fill: 'grey', shape: 'dot', text: 'closed' });
      if (typeof done === 'function') done();
    });
  }

  RED.nodes.registerType('modbus-read', ModbusReadNode);
};
