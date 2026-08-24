/**
 * modbus-read — Modbus 读取节点 v1.5.0（TCP / RTU 串口双传输）
 *
 * v1.5.0: RTU 支持 — 配置/上游 protocolParams 带 serialPort 即走串口（CRC16 校验 +
 *         期望长度+帧间静默收帧），否则维持 TCP 行为不变；RTU 入同一连接池（rtu: 键）
 * v1.4.0: 连接池抽为共享模块 modbus-pool.js（读写节点复用）+ ownerId 属主追踪
 *         + 面板字节序词汇(AB/BA/ABCD...)映射到协议轴
 * v1.3.0: 生产级连接池 — 引用计数、退避、队列超时、connecting 状态、定时器生命周期
 * v1.2.1: 修复脏帧/延迟帧解析 + socket 闭包重连 + 监听器清理 + deviceName
 * v1.2.0: 设备ID手动配置 + 表格分页(支持上千点位) + 计算点位(referenceTag+operator) + CSV导入导出
 * v1.1.2: 队列上限+入口节流+响应txnId校验+Buffer上限+动态连接追踪+清理队列检查
 * 功能码: 01(线圈) 02(离散输入) 03(保持寄存器) 04(输入寄存器)
 * 数据类型: INT16/UINT16/INT32/UINT32/FLOAT32/BOOL
 * 字节序: AB/BA/ABCD/CDAB/BADC/DCBA
 */
module.exports = function (RED) {
  'use strict';
  var mb = require('./modbus-protocol');
  var pool = require('./modbus-pool');
  var mserial = require('./modbus-serial');

  var FC_MAP = mb.FC_MAP;
  var clampInt = mb.clampInt;
  var buildModbusFrame = mb.buildModbusFrame;
  var parseModbusResponse = mb.parseModbusResponse;
  var decodeValue = mb.decodeValue;
  var normalizeByteOrder = mb.normalizeByteOrder;
  var applyTransform = mb.applyTransform;
  // RTU 别名（input 处理器内 mb 被局部变量遮蔽，必须用顶层别名）
  var buildRtuFrame = mb.buildRtuFrame;
  var parseRtuResponse = mb.parseRtuResponse;
  var rtuExpectedResponseLen = mb.rtuExpectedResponseLen;

  // ==== 节点 ====
  function ModbusReadNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    node.modbusConfig = RED.nodes.getNode(config.modbus);
    if (!node.modbusConfig) {
      // 🔧 v1.4.0: 未入池——close 守卫据此跳过 nodeClosed，防 _activeNodeCount 多减
      node.error('未关联 Modbus 配置节点');
      return;
    }
    pool.nodeOpened();

    node._closed = false;  // 🔧 关闭守卫：close 后重连链/采集链立即终止（在途轮询不悬挂）
    node.configDeviceId = String(config.deviceId || '');  // 🆕 独立使用时手动配置的设备ID
    // 🆕 v1.5.0: 节点级串口覆盖（留空 → 跟随 modbus-config；有值 → 强制 RTU）
    node.serialOverride = {
      serialPort: (config.serialPort || '').trim(),
      baudRate: config.baudRate, dataBits: config.dataBits,
      parity: config.parity, stopBits: config.stopBits
    };

    var configTags = [];
    try { configTags = JSON.parse(config.tags || '[]'); } catch (e) { configTags = []; }

    node.on('input', function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };

      var _doneCalled = false;
      function safeDone() {
        if (_doneCalled) return;
        _doneCalled = true;
        if (typeof done === 'function') {
          try { done(); } catch (_) {}
        }
      }

      var incoming = msg.payload || {};

      var cfg = node.modbusConfig;
      var pp = incoming.protocolParams || {};
      // 🔧 兼容链：后端契约字段是 unitId，旧版读 slaveId，两者都接受（unitId 优先）
      var slaveIdRaw = (pp.unitId != null) ? pp.unitId : pp.slaveId;
      var unitId = slaveIdRaw != null ? parseInt(slaveIdRaw, 10) : (cfg.unitId || 1);
      if (isNaN(unitId)) unitId = 1;
      var portRaw = incoming.plcPort != null ? incoming.plcPort : cfg.port;
      var port = parseInt(portRaw, 10);
      if (isNaN(port) || port < 1 || port > 65535) port = 502;
      var mb = {
        name: cfg.name, host: incoming.plcIp || cfg.host,
        port: port, unitId: unitId,
        timeout: cfg.timeout, maxRetries: cfg.maxRetries,
        retryInterval: cfg.retryInterval
      };

      var timeout = clampInt(
        incoming.timeout != null ? incoming.timeout : mb.timeout,
        3000, 500, 30000
      );
      var maxRetries = clampInt(
        incoming.maxRetries != null ? incoming.maxRetries : mb.maxRetries,
        2, 0, 10
      );
      var retryInterval = clampInt(
        incoming.retryInterval != null ? incoming.retryInterval : mb.retryInterval,
        300, 50, 10000
      );

      // ==== 传输选择：带 serialPort（上游 protocolParams / 节点配置 / 连接配置）→ RTU，否则 TCP ====
      var serialCfg = mserial.normalizeSerialConfig({
        serialPort: pp.serialPort || node.serialOverride.serialPort || cfg.serialPort,
        baudRate: pp.baudRate != null ? pp.baudRate : (node.serialOverride.baudRate || cfg.baudRate),
        dataBits: pp.dataBits != null ? pp.dataBits : (node.serialOverride.dataBits || cfg.dataBits),
        parity: pp.parity != null ? pp.parity : (node.serialOverride.parity || cfg.parity),
        stopBits: pp.stopBits != null ? pp.stopBits : (node.serialOverride.stopBits || cfg.stopBits)
      });
      var isRtu = !!serialCfg;

      // 🔧 传输 shim：池操作统一走 tp.*，RTU/TCP 仅键与连接器不同
      var tp;
      if (isRtu) {
        tp = {
          peek: function () { return pool.peekSerialEntry(serialCfg); },
          get: function (cb) { pool.getSerialConnection(node, serialCfg, timeout, cb); },
          release: function () { pool.releaseSerialConnection(node, serialCfg); },
          destroy: function (sock) { pool.destroyConnection(pool.serialPoolKey(serialCfg), undefined, sock); },
          detach: function () { pool.detachSerialNode(node, serialCfg); }
        };
      } else {
        tp = {
          peek: function () { return pool.peekEntry(mb.host, mb.port); },
          get: function (cb) { pool.getConnection(node, mb.host, mb.port, timeout, cb); },
          release: function () { pool.releaseConnection(node, mb.host, mb.port); },
          destroy: function (sock) { pool.destroyConnection(mb.host, mb.port, sock); },
          detach: function () { pool.detachNode(node, mb.host, mb.port); }
        };
      }

      // 🔧 优先级: 面板填写 > 上游 msg.payload.id > msg.payload.deviceId > hash
      function resolveDeviceId(incoming, mb) {
        if (node.configDeviceId && node.configDeviceId !== '') {
          var n = parseInt(node.configDeviceId, 10);
          if (!isNaN(n) && n > 0) return n;
        }
        var id = incoming.id || incoming.deviceId;
        if (id !== undefined && id !== null && id !== '') {
          var m = parseInt(id, 10);
          if (!isNaN(m) && m > 0) return m;
        }
        var name = incoming.deviceName || mb.name || node.configDeviceId || (mb.host + ':' + mb.port);
        var hash = 0;
        for (var i = 0; i < name.length; i++) {
          hash = ((hash << 5) - hash) + name.charCodeAt(i);
          hash |= 0;
        }
        return Math.abs(hash) % 9000 + 1000;
      }
      var deviceId = resolveDeviceId(incoming, mb);
      var deviceName = incoming.deviceName || mb.name || ('PLC-' + deviceId);

      var _sent = false;
      function safeSend(m) {
        if (_sent) return;
        _sent = true;
        try { send(m); } catch (_) {}
        safeDone();
      }

      // 🔧 关闭早退统一出口：释放所有权（若在持有）+ 摘除 users 标记 + done
      function abortIfClosed() {
        if (!node._closed) return false;
        tp.detach();
        safeDone();
        return true;
      }

      // 点位来源
      var rawTags = msg.tags || incoming.tags;
      if (!rawTags || (Array.isArray(rawTags) && rawTags.length === 0)) rawTags = configTags;
      if (!Array.isArray(rawTags)) rawTags = [rawTags];

      // 校验清洗
      var validTags = [];
      var _seenIds = {};
      for (var i = 0; i < rawTags.length; i++) {
        var t = rawTags[i];
        var ALIAS = { 'HR': 'holding', 'IR': 'input', 'COIL': 'coil', 'DI': 'discrete', 'CR': 'coil', 'DISCRETE': 'discrete', 'CO': 'coil', 'INPUT': 'input' };  // 🔧 Day5: 补 CR/DISCRETE（此前静默降级为 holding 读错功能码）
        var DT_ALIAS = { 'FLOAT': 'FLOAT32', 'BIT': 'BOOL' };
        var rt = ALIAS[t.regType] || t.regType || 'holding';
        if (!FC_MAP[rt]) { node.warn('[MB] Unknown regType: ' + rt + ', using holding'); rt = 'holding'; }
        var dt = DT_ALIAS[t.dataType] || t.dataType || 'INT16';
        // 🔧 addr=0 是合法地址，不能用 || 兜底
        var addrRaw = (t.addr != null) ? t.addr : ((t.regAddr != null) ? t.regAddr : 0);
        var addr = parseInt(addrRaw, 10);
        if (isNaN(addr) || addr < 0 || addr > 65535) { node.warn('[MB] Invalid addr for tag ' + (t.id || t.name || ('#' + i))); continue; }
        var tagId = t.id || t.name || (rt + addr);
        if (_seenIds[tagId]) { node.warn('[MB] Duplicate tag id: ' + tagId + ' (addr=' + addr + ')'); }
        _seenIds[tagId] = true;
        // 🔧 面板词汇(AB/BA/ABCD...)映射到协议两轴；协议词汇(LITTLE_ENDIAN...)原样透传
        var _bo = normalizeByteOrder(t);
        validTags.push({
          id: String(tagId),
          regType: rt, addr: addr, dataType: dt,
          // 🔧 协议参数透传（此前 wordOrder/bitOffset 被静默忽略）
          byteOrder: _bo.byteOrder,
          wordOrder: _bo.wordOrder,
          // 🔧 Day6-review: bitOffset 钳制 0-15 + warn（越界此前被 JS 按 mod 32 移位静默取错位）
          bitOffset: (function () {
            if (t.bitOffset === undefined || t.bitOffset === null) return null;
            var bv = parseInt(t.bitOffset, 10);
            if (isNaN(bv) || bv < 0 || bv > 15) {
              node.warn('[MB] Invalid bitOffset ' + t.bitOffset + ' for tag ' + (t.id || t.name || ('#' + i)) + ', using 0');
              return 0;
            }
            return bv;
          })(),
          // 🔧 slope=0 是合法值，不能用 || 兜底
          slope: (t.slope != null) ? parseFloat(t.slope) : 1,
          offset: (t.offset != null) ? parseFloat(t.offset) : 0,
          operator: t.operator || '',
          referenceTag: t.referenceTag || '',
          name: t.name || (rt + addr)
        });
      }

      if (validTags.length === 0) {
        node.status({ fill: 'grey', shape: 'dot', text: '0 valid tags' });
        safeDone();
        return;
      }

      var roundStart = Date.now();

      // RTU 从站地址必须 1-247（TCP 兼容链保持原样不卡范围）
      if (isRtu && (unitId < 1 || unitId > 247)) {
        node.status({ fill: 'red', shape: 'ring', text: 'bad unitId' });
        msg.payload = { success: false, deviceId: deviceId, deviceName: deviceName, data: {}, error: 'RTU 模式从站地址 unitId 必须为 1-247（当前: ' + unitId + '）', driverType: 'driver-modbus-tcp', plcIp: mb.host, plcPort: mb.port, roundTimeMs: Date.now() - roundStart };
        safeSend(msg);
        return;
      }

      // 模拟模式
      var SIM = false;
      try { SIM = RED.settings.mbSimulationMode || false; } catch (e) {}

      if (SIM) {
        var simOut = {};
        validTags.forEach(function (t) {
          var raw = FC_MAP[t.regType].bit ? (Math.random() > 0.5 ? 1 : 0) : Math.floor(Math.random() * 2000);
          simOut[t.id] = { rawValue: raw, engValue: applyTransform(raw, t), quality: 0, ts: new Date().toISOString() };
        });
        msg.payload = { success: true, deviceId: deviceId, deviceName: deviceName, data: simOut, error: null, driverType: 'driver-modbus-tcp', plcIp: mb.host, plcPort: mb.port, roundTimeMs: Date.now() - roundStart };
        node.status({ fill: 'green', shape: 'dot', text: 'SIM ' + validTags.length + ' tags' });
        safeSend(msg);
        return;
      }

      // === 去重（计算点位不参与去重）===
      // 🔧 修复#3：dedup key 含 dataType+bitOffset——同寄存器不同位的 BOOL 点位是两个不同信号，折叠会静默丢弃告警点
      var seen = {};
      var deduped = [];
      for (var di = validTags.length - 1; di >= 0; di--) {
        var dtag = validTags[di];
        if (dtag.operator) { deduped.unshift(dtag); }
        else {
          var dk = dtag.regType + '|' + dtag.addr + '|' + (dtag.dataType || '') + '|' + (dtag.bitOffset != null ? dtag.bitOffset : '');
          if (!seen[dk]) { seen[dk] = true; deduped.unshift(dtag); }
        }
      }
      validTags = deduped;

      // 按 regType 分组 + 聚类
      var byRegType = {};
      validTags.forEach(function (t) {
        if (!byRegType[t.regType]) byRegType[t.regType] = [];
        byRegType[t.regType].push(t);
      });

      var groups = [];
      Object.keys(byRegType).forEach(function (rt) {
        var sorted = byRegType[rt].slice().sort(function (a, b) { return a.addr - b.addr; });
        var cluster = [sorted[0]];
        for (var i2 = 1; i2 < sorted.length; i2++) {
          var gap = sorted[i2].addr - cluster[cluster.length - 1].addr;
          if (gap <= 20 && cluster.length < 100) {
            cluster.push(sorted[i2]);
          } else {
            groups.push({ regType: rt, tags: cluster });
            cluster = [sorted[i2]];
          }
        }
        if (cluster.length > 0) groups.push({ regType: rt, tags: cluster });
      });

      if (groups.length === 0) {
        msg.payload = { success: false, deviceId: deviceId, deviceName: deviceName, data: {}, error: 'No valid groups', driverType: 'driver-modbus-tcp', plcIp: mb.host, plcPort: mb.port, roundTimeMs: Date.now() - roundStart };
        safeSend(msg);
        return;
      }

      // 🔧 R2: 入口节流 — 队列深度 > 20 时跳过本周期
      var poolEntry = tp.peek();
      if (poolEntry && poolEntry.inUse && poolEntry.queue && poolEntry.queue.length > 20) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'throttled' });
        msg.payload = { success: false, deviceId: deviceId, deviceName: deviceName, data: {}, error: 'Throttled: queue > 20', driverType: 'driver-modbus-tcp', plcIp: mb.host, plcPort: mb.port, roundTimeMs: Date.now() - roundStart };
        safeSend(msg);
        return;
      }

      var allRaw = {};
      var hasFailed = false;
      var firstError = '';

      tp.get(function (err, mcSocket) {
        if (err) {
          hasFailed = true;
          firstError = '[CONNECT] ' + err.message;
          msg.payload = {
            success: false,
            deviceId: deviceId,
            deviceName: deviceName,
            data: {},
            error: firstError,
            driverType: 'driver-modbus-tcp',
            plcIp: mb.host, plcPort: mb.port,
            roundTimeMs: Date.now() - roundStart
          };
          node.status({ fill: 'red', shape: 'ring', text: 'connect fail' });
          safeSend(msg);
          return;
        }

        function processGroup(gi) {
          if (abortIfClosed()) return;
          if (gi >= groups.length) {
            tp.release();
            var now = new Date().toISOString();
            var output = {};
            validTags.forEach(function (t) {
              var entry = allRaw[t.id];
              if (entry) {
                output[t.id] = {
                  // 🔧 P0-1: rawValue 必须是解码后的值（32/64 位多字组装结果），
                  // 下游 data-processor 只消费 rawValue；原始首字保留在 rawWord 备查（与 MC 侧契约一致）
                  rawValue: entry.convertedValue,
                  rawWord: entry.rawValue,
                  engValue: applyTransform(entry.convertedValue, t),
                  quality: entry.quality,
                  ts: entry.ts,
                  regType: t.regType
                };
              } else {
                output[t.id] = { rawValue: null, rawWord: null, engValue: null, quality: 2, ts: now, regType: t.regType };
              }
            });

            // 计算点位：rawValue 已是解码值，直接参与计算
            validTags.forEach(function (t) {
              if (!t.operator || !t.referenceTag) return;
              var thisEntry = output[t.id];
              var refEntry = output[t.referenceTag];
              if (!thisEntry || !refEntry) return;
              var a = thisEntry.rawValue;
              var b = refEntry.rawValue;
              if (a == null || b == null) return;
              var result = null;
              switch (t.operator) {
                case 'add': result = a + b; break;
                case 'sub': result = a - b; break;
                case 'mul': result = a * b; break;
                case 'div': result = b !== 0 ? a / b : null; break;
              }
              if (result != null) {
                var slope = parseFloat(t.slope); if (isNaN(slope)) slope = 1;
                var offset = parseFloat(t.offset); if (isNaN(offset)) offset = 0;
                thisEntry.rawValue = result;  // 🔧 不再 toFixed(4) 截断
                thisEntry.engValue = result * slope + offset;
              }
            });

            msg.payload = {
              success: !hasFailed,
              deviceId: deviceId,
              deviceName: deviceName,
              data: output,
              error: hasFailed ? firstError : null,
              driverType: 'driver-modbus-tcp',
              plcIp: mb.host,
              plcPort: mb.port,
              roundTimeMs: Date.now() - roundStart
            };
            node.status({ fill: hasFailed ? 'red' : 'green', shape: 'dot', text: (mb.name || mb.host) + ' ' + Object.keys(output).length + ' vals ' + (Date.now() - roundStart) + 'ms' });
            safeSend(msg);
            return;
          }

          var grp = groups[gi];
          var isBit = FC_MAP[grp.regType].bit;
          var fc = FC_MAP[grp.regType].fc;
          var addrs = grp.tags.map(function (t) { return t.addr; });
          var startA = addrs[0];

          // 🔧 类型跨度：32 位=2 寄存器，64 位(DOUBLE)=4 寄存器
          function _spanOf(d) {
            d = d || 'INT16';
            if (d === 'DOUBLE' || d === 'FLOAT64') return 4;
            if (d === 'INT32' || d === 'UINT32' || d === 'FLOAT32') return 2;
            return 1;
          }
          var lastAddr = addrs[addrs.length - 1];
          for (var ti = 0; ti < grp.tags.length; ti++) {
            var tEnd2 = grp.tags[ti].addr + _spanOf(grp.tags[ti].dataType) - 1;
            if (tEnd2 > lastAddr) lastAddr = tEnd2;
          }
          var quantity = lastAddr - startA + 1;
          var MAX_QUANTITY = isBit ? 2000 : 125;
          if (quantity > MAX_QUANTITY) {
            function _tagEnd(t) { return t.addr + _spanOf(t.dataType) - 1; }
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
              if (se === ss) se = ss + 1;
              newGroups.push({ regType: grp.regType, tags: grp.tags.slice(ss, se) });
              ss = se;
            }
            groups.splice.apply(groups, [gi, 1].concat(newGroups));
            setTimeout(function () { processGroup(gi); }, 0);
            return;
          }

          function attemptGroup(attempt) {
            if (abortIfClosed()) return;
            if (attempt > maxRetries) {
              hasFailed = true;
              if (!firstError) firstError = 'Modbus read failed for ' + grp.regType + ' addr=' + startA;
              cleanupListeners(mcSocket);
              setTimeout(function () { processGroup(gi + 1); }, 0);
              return;
            }

            if (mcSocket.destroyed) {
              tp.destroy(mcSocket);
              tp.get(function (e2, newSock) {
                if (abortIfClosed()) return;
                if (e2) {
                  hasFailed = true;
                  if (!firstError) firstError = '[RECONNECT] ' + e2.message;
                  finishWithError();
                  return;
                }
                mcSocket = newSock;
                attemptGroup(attempt);
              });
              return;
            }

            var buf = Buffer.alloc(0);
            var resolved = false;
            var _tmoHandler = null, _errHandler = null, _dataHandler = null;
            var _silenceTimer = null;  // RTU 帧间静默计时（TCP 不用）
            // RTU 收帧参数：期望长度 + 帧间静默阈值（≥3.5 字符时间，下限 30ms）
            var rtuExpectedLen = isRtu ? rtuExpectedResponseLen(fc, quantity) : 0;
            var rtuSilenceMs = isRtu ? Math.max(30, Math.ceil(3.5 * 11 * 1000 / serialCfg.baudRate)) : 0;

            function cleanupListeners(sock) {
              if (_silenceTimer) { clearTimeout(_silenceTimer); _silenceTimer = null; }
              if (!sock) return;
              // 🔧 v1.5.0: handler 判空——重试耗尽分支在新一轮 attemptGroup 里调本函数时
              // 局部 handler 尚为 null，removeListener(x, null) 在 Node 18 会直接抛错
              if (_dataHandler) sock.removeListener('data', _dataHandler);
              if (_tmoHandler) sock.removeListener('timeout', _tmoHandler);
              if (_errHandler) sock.removeListener('error', _errHandler);
            }

            mcSocket.setTimeout(timeout);

            function processBuffer() {
              if (isRtu) { processBufferRtu(); return; }
              if (resolved || buf.length < 9) return;
              // 🔧 整体 try/catch：setTimeout 重入口路径（slice 脏帧后递归）不再有机会让异常逃逸崩进程
              try {

              // 🔧 R3: 校验响应 txnId，丢弃脏帧/延迟帧
              if (buf.length >= 6) {
                var respTxnId = buf.readUInt16BE(0);
                if (sentTxnId > 0 && respTxnId !== sentTxnId) {
                  var staleMbapLen = buf.readUInt16BE(4);
                  if (staleMbapLen > 260) {
                    resolved = true;
                    cleanupListeners(mcSocket);
                    node.warn('[MB] Corrupt stale frame (MBAP len ' + staleMbapLen + '), reconnecting');
                    pool.destroyConnection(mb.host, mb.port, mcSocket);
                    pool.getConnection(node, mb.host, mb.port, timeout, function (e3, newSock2) {
                      if (abortIfClosed()) return;
                      if (e3) {
                        pool.releaseConnection(node, mb.host, mb.port);
                        finishWithError();
                        return;
                      }
                      mcSocket = newSock2;
                      setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                    });
                    return;
                  }
                  var skipLen2 = 6 + staleMbapLen;
                  if (skipLen2 <= buf.length) {
                    buf = buf.slice(skipLen2);
                    setTimeout(processBuffer, 0);
                    return;
                  }
                  // 脏帧尚未收完，等待更多数据
                  return;
                }
              }

              if (buf[7] & 0x80) {
                resolved = true;
                cleanupListeners(mcSocket);
                var exRaw = parseModbusResponse(buf, startA, grp.regType, quantity, unitId);
                if (exRaw && exRaw.exCode) {
                  hasFailed = true;
                  if (!firstError) firstError = '[MB 0x' + exRaw.exCode.toString(16) + '] ' + exRaw.exText;
                }
                setTimeout(function () { processGroup(gi + 1); }, 0);
                return;
              }

              var mbapLen = buf.readUInt16BE(4);
              if (mbapLen > 260) {
                resolved = true;
                cleanupListeners(mcSocket);
                hasFailed = true;
                if (!firstError) firstError = 'MBAP length too large: ' + mbapLen;
                setTimeout(function () { processGroup(gi + 1); }, 0);
                return;
              }

              var expectedLen = 6 + mbapLen;
              if (buf.length >= expectedLen) {
                resolved = true;
                cleanupListeners(mcSocket);

                // 🔧 R3: 二次校验 txnId
                var respTxnId2 = buf.readUInt16BE(0);
                if (sentTxnId > 0 && respTxnId2 !== sentTxnId) {
                  setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                  return;
                }

                var raw = parseModbusResponse(buf, startA, grp.regType, quantity, unitId);

                if (raw && raw.exCode) {
                  hasFailed = true;
                  if (!firstError) firstError = '[MB 0x' + raw.exCode.toString(16) + '] ' + raw.exText;
                  setTimeout(function () { processGroup(gi + 1); }, 0);
                } else if (raw && !raw.err) {
                  var groupTs = new Date().toISOString();
                  grp.tags.forEach(function (t) {
                    var rv = raw[t.addr];
                    var q = 0;
                    if (rv === undefined || rv === null) { q = 2; }
                    else if (!isBit) {
                      var cv = decodeValue(rv, t.addr, raw, t.dataType, t.byteOrder, t.wordOrder, t.bitOffset);
                      if (cv === null) q = 2;
                      allRaw[t.id] = { rawValue: rv, convertedValue: cv, quality: q, ts: groupTs };
                      return;
                    }
                    allRaw[t.id] = { rawValue: rv, convertedValue: rv, quality: q, ts: groupTs };
                  });
                  setTimeout(function () { processGroup(gi + 1); }, 0);
                } else {
                  setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                }
                return;
              }
              // 数据不足，等待下一次 data 事件

              } catch (pbErr) {
                node.warn('[MB] processBuffer error: ' + pbErr.message);
                resolved = true;
                cleanupListeners(mcSocket);
                hasFailed = true;
                if (!firstError) firstError = '[DATA] ' + pbErr.message;
                setTimeout(function () { processGroup(gi + 1); }, 0);
              }
            }

            // ===== RTU 收帧：期望长度 + 帧间静默兜底（不按固定字节数死等）=====
            function processBufferRtu() {
              if (resolved || buf.length < 2) return;
              try {
                var expLen = (buf[1] & 0x80) ? 5 : rtuExpectedLen;  // 异常帧固定 5 字节
                if (buf.length < expLen) return;  // 数据不足，等下一次 data 事件（或静默超时）
                finishRtuFrame(expLen);
              } catch (pbErr) {
                node.warn('[MB] RTU processBuffer error: ' + pbErr.message);
                resolved = true;
                cleanupListeners(mcSocket);
                hasFailed = true;
                if (!firstError) firstError = '[DATA] ' + pbErr.message;
                setTimeout(function () { processGroup(gi + 1); }, 0);
              }
            }

            // 帧尾到达（收齐 expLen 或静默截断）→ CRC 校验 + 解析
            function finishRtuFrame(expLen) {
              if (resolved) return;
              resolved = true;
              cleanupListeners(mcSocket);
              var raw = parseRtuResponse(buf.slice(0, expLen), startA, grp.regType, quantity, unitId);
              if (raw && raw.exCode) {
                hasFailed = true;
                if (!firstError) firstError = '[MB 0x' + raw.exCode.toString(16) + '] ' + raw.exText;
                setTimeout(function () { processGroup(gi + 1); }, 0);
              } else if (raw && !raw.err) {
                var groupTs = new Date().toISOString();
                grp.tags.forEach(function (t) {
                  var rv = raw[t.addr];
                  var q = 0;
                  if (rv === undefined || rv === null) { q = 2; }
                  else if (!isBit) {
                    var cv = decodeValue(rv, t.addr, raw, t.dataType, t.byteOrder, t.wordOrder, t.bitOffset);
                    if (cv === null) q = 2;
                    allRaw[t.id] = { rawValue: rv, convertedValue: cv, quality: q, ts: groupTs };
                    return;
                  }
                  allRaw[t.id] = { rawValue: rv, convertedValue: rv, quality: q, ts: groupTs };
                });
                setTimeout(function () { processGroup(gi + 1); }, 0);
              } else {
                // 🔧 CRC 错/截断帧：记录诊断并走与 TCP 相同的重试路径
                if (!firstError) firstError = '[RTU] ' + ((raw && raw.err) || 'bad frame');
                setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
              }
            }

            _dataHandler = function (sock) {
              return function (chunk) {
                try {
                  buf = Buffer.concat([buf, chunk]);
                  // 🔧 R5: Buffer 上限 64KB
                  if (buf.length > 65536) {
                    resolved = true;
                    cleanupListeners(sock);
                    node.warn('[MB] Buffer overflow ' + buf.length + ' bytes, discarding');
                    setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                    return;
                  }
                  // RTU：数据活动重置帧间静默计时；静默超阈值仍未收齐 → 按已收字节强制收尾（多半 CRC 错 → 重试）
                  if (isRtu && !resolved) {
                    if (_silenceTimer) clearTimeout(_silenceTimer);
                    _silenceTimer = setTimeout(function () {
                      if (resolved || buf.length === 0) return;
                      node.warn('[MB] RTU frame silence timeout (' + buf.length + 'B)');
                      try { finishRtuFrame(buf.length); } catch (_) {
                        resolved = true;
                        cleanupListeners(sock);
                        setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                      }
                    }, rtuSilenceMs);
                  }
                  processBuffer();
                } catch (e) {
                  node.warn('[MB] data error: ' + e.message);
                  cleanupListeners(sock);
                  resolved = true;
                  hasFailed = true;
                  if (!firstError) firstError = e.message;
                  setTimeout(function () { processGroup(gi + 1); }, 0);
                }
              };
            }(mcSocket);

            mcSocket.on('data', _dataHandler);

            _tmoHandler = function (sock) {
              return function () {
                if (resolved) return;
                resolved = true;
                cleanupListeners(sock);
                tp.destroy(sock);
                tp.get(function (e4, newSock3) {
                  if (abortIfClosed()) return;
                  if (e4) {
                    tp.release();
                    finishWithError();
                    return;
                  }
                  mcSocket = newSock3;
                  setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                });
              };
            }(mcSocket);
            mcSocket.once('timeout', _tmoHandler);

            _errHandler = function (sock) {
              return function () {
                if (resolved) return;
                resolved = true;
                cleanupListeners(sock);
                tp.destroy(sock);
                tp.get(function (e5, newSock4) {
                  if (abortIfClosed()) return;
                  if (e5) {
                    tp.release();
                    finishWithError();
                    return;
                  }
                  mcSocket = newSock4;
                  setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                });
              };
            }(mcSocket);
            mcSocket.once('error', _errHandler);

            // 🔧 R3: 捕获请求 txnId 用于响应校验（监听器已就位再发帧；RTU 无 txnId 恒为 0）
            var sentTxnId = 0;
            try {
              var frameResult = isRtu ? buildRtuFrame(unitId, fc, startA, quantity)
                                      : buildModbusFrame(unitId, fc, startA, quantity);
              sentTxnId = frameResult.txnId;
              mcSocket.write(frameResult.buf);
            } catch (e) {
              node.warn('[MB] write error: ' + e.message);
              resolved = true;
              cleanupListeners(mcSocket);
              tp.destroy(mcSocket);
              tp.get(function (e3, newSock2) {
                if (abortIfClosed()) return;
                if (e3) {
                  tp.release();
                  finishWithError();
                  return;
                }
                mcSocket = newSock2;
                setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
              });
              return;
            }
          }
          attemptGroup(0);
        }

        // 🔧 R10: finishWithError 增加防御性 releaseConnection
        function finishWithError() {
          tp.release();
          msg.payload = {
            success: false,
            deviceId: deviceId,
            deviceName: deviceName,
            data: {},
            error: firstError || 'Modbus connection lost',
            driverType: 'driver-modbus-tcp',
            plcIp: mb.host, plcPort: mb.port,
            roundTimeMs: Date.now() - roundStart
          };
          node.status({ fill: 'red', shape: 'ring', text: 'conn lost' });
          safeSend(msg);
        }

        processGroup(0);
      }); // getConnection
    }); // on('input')

    // ==== close: 归还连接池中的所有引用；在途属主由池直接销毁 ====
    node.on('close', function (done) {
      node._closed = true;  // 🔧 终止在途采集/重连链
      if (node.modbusConfig) pool.nodeClosed(node);   // 🔧 构造失败未入池的路径跳过，防计数多减
      node.status({ fill: 'grey', shape: 'dot', text: 'closed' });
      if (typeof done === 'function') done();
    });
  }

  RED.nodes.registerType('modbus-read', ModbusReadNode);
};
