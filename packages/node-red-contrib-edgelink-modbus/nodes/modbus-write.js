/**
 * modbus-write — Modbus 写入节点 v1.5.0（TCP / RTU 串口双传输）
 *
 * v1.5.0: RTU 支持 — 配置/payload 带 serialPort 即走串口（CRC16 + 回显校验），
 *         否则维持 TCP 行为不变；RTU 入同一连接池（rtu: 键）
 * 功能码: 05(写单线圈) 06(写单寄存器) 16(写多寄存器 — 32/64 位类型原子写入)
 * 触发契约:
 *   msg.payload = 裸值(number/boolean)        → 使用面板配置的地址/类型
 *   msg.payload = { regType, addr, value, dataType, byteOrder, wordOrder,
 *                   unitId, plcIp, plcPort, serialPort, timeout, deviceId, deviceName }
 * 安全约定:
 *   - 仅支持 coil / holding；input/discrete 只读，直接拒绝
 *   - 写失败【不自动重试】——写操作有副作用，失败后由上游决定是否重发
 *   - 响应做 txnId 校验（TCP）/ CRC16 校验（RTU）+ 回显校验（地址/值/数量不一致判失败）
 */
module.exports = function (RED) {
  'use strict';
  var mb = require('./modbus-protocol');
  var pool = require('./modbus-pool');
  var mserial = require('./modbus-serial');

  var clampInt = mb.clampInt;

  function ModbusWriteNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    node.modbusConfig = RED.nodes.getNode(config.modbus);
    if (!node.modbusConfig) {
      // 🔧 v1.4.0: 未入池——close 守卫据此跳过 nodeClosed，防 _activeNodeCount 多减
      node.error('未关联 Modbus 配置节点');
      return;
    }
    pool.nodeOpened();

    node._closed = false;
    node.configDeviceId = String(config.deviceId || '');
    // 面板静态默认（msg.payload 为裸值时使用；对象 payload 可逐字段覆盖）
    node.staticRegType = config.regType || 'holding';
    node.staticAddr = (config.addr !== undefined && config.addr !== null) ? String(config.addr) : '';
    node.staticDataType = config.dataType || 'INT16';
    node.staticByteOrder = config.byteOrder || '';
    // 🆕 v1.5.0: 节点级串口覆盖（留空 → 跟随 modbus-config；有值 → 强制 RTU）
    node.serialOverride = {
      serialPort: (config.serialPort || '').trim(),
      baudRate: config.baudRate, dataBits: config.dataBits,
      parity: config.parity, stopBits: config.stopBits
    };

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

      var _sent = false;
      function safeSend(m) {
        if (_sent) return;
        _sent = true;
        try { send(m); } catch (_) {}
        safeDone();
      }

      var roundStart = Date.now();
      var cfg = node.modbusConfig;
      var p = msg.payload;

      // 裸值 → 面板配置；对象 → 逐字段（payload 优先于面板）
      var req = {};
      if (p !== null && p !== undefined && typeof p === 'object') {
        req = p;
      } else if (p !== null && p !== undefined) {
        req = { value: p };
      }

      // === 连接参数（优先 payload，回落配置节点）===
      var uidRaw = (req.unitId != null) ? req.unitId : ((req.slaveId != null) ? req.slaveId : cfg.unitId);
      var unitId = parseInt(uidRaw, 10);
      if (isNaN(unitId) || unitId < 0 || unitId > 247) unitId = 1;
      var port = parseInt(req.plcPort != null ? req.plcPort : cfg.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) port = 502;
      var host = req.plcIp || cfg.host;
      var timeout = clampInt(req.timeout != null ? req.timeout : cfg.timeout, 3000, 500, 30000);

      // ==== 传输选择：带 serialPort（payload/protocolParams/节点配置/连接配置）→ RTU，否则 TCP ====
      var rpp = req.protocolParams || {};
      var serialCfg = mserial.normalizeSerialConfig({
        serialPort: req.serialPort || rpp.serialPort || node.serialOverride.serialPort || cfg.serialPort,
        baudRate: req.baudRate != null ? req.baudRate : (rpp.baudRate != null ? rpp.baudRate : (node.serialOverride.baudRate || cfg.baudRate)),
        dataBits: req.dataBits != null ? req.dataBits : (rpp.dataBits != null ? rpp.dataBits : (node.serialOverride.dataBits || cfg.dataBits)),
        parity: req.parity != null ? req.parity : (rpp.parity != null ? rpp.parity : (node.serialOverride.parity || cfg.parity)),
        stopBits: req.stopBits != null ? req.stopBits : (rpp.stopBits != null ? rpp.stopBits : (node.serialOverride.stopBits || cfg.stopBits))
      });
      var isRtu = !!serialCfg;

      // 🔧 传输 shim：池操作统一走 tp.*（RTU 用 rtu: 池键）
      var tp;
      if (isRtu) {
        tp = {
          get: function (cb) { pool.getSerialConnection(node, serialCfg, timeout, cb); },
          release: function () { pool.releaseSerialConnection(node, serialCfg); },
          destroy: function (sock) { pool.destroyConnection(pool.serialPoolKey(serialCfg), undefined, sock); },
          detach: function () { pool.detachSerialNode(node, serialCfg); }
        };
      } else {
        tp = {
          get: function (cb) { pool.getConnection(node, host, port, timeout, cb); },
          release: function () { pool.releaseConnection(node, host, port); },
          destroy: function (sock) { pool.destroyConnection(host, port, sock); },
          detach: function () { pool.detachNode(node, host, port); }
        };
      }

      // === deviceId / deviceName（与 modbus-read 同一归一化规则）===
      var deviceId;
      var configIdNum = parseInt(node.configDeviceId, 10);
      var reqId = req.id || req.deviceId;
      if (!isNaN(configIdNum) && configIdNum > 0) {
        deviceId = configIdNum;
      } else if (reqId !== undefined && reqId !== null && reqId !== '' && !isNaN(parseInt(reqId, 10)) && parseInt(reqId, 10) > 0) {
        deviceId = parseInt(reqId, 10);
      } else {
        var name0 = req.deviceName || cfg.name || node.configDeviceId || (host + ':' + port);
        var hash = 0;
        for (var hi = 0; hi < name0.length; hi++) {
          hash = ((hash << 5) - hash) + name0.charCodeAt(hi);
          hash |= 0;
        }
        deviceId = Math.abs(hash) % 9000 + 1000;
      }
      var deviceName = req.deviceName || cfg.name || ('PLC-' + deviceId);

      function outPayload(success, write, errText) {
        return {
          success: success,
          deviceId: deviceId,
          deviceName: deviceName,
          write: write,
          error: errText,
          driverType: 'driver-modbus-tcp',
          plcIp: host,
          plcPort: port,
          roundTimeMs: Date.now() - roundStart
        };
      }

      function fail(errText) {
        node.status({ fill: 'red', shape: 'ring', text: String(errText).slice(0, 32) });
        msg.payload = outPayload(false, null, errText);
        safeSend(msg);
      }

      // === 请求校验 ===
      // RTU 从站地址必须 1-247（unitId=0 广播不予支持）
      if (isRtu && (unitId < 1 || unitId > 247)) {
        fail('RTU 模式从站地址 unitId 必须为 1-247（当前: ' + unitId + '）');
        return;
      }

      var RT_ALIAS = { 'HR': 'holding', 'COIL': 'coil' };
      var regType = RT_ALIAS[req.regType] || req.regType || node.staticRegType;
      if (regType !== 'coil' && regType !== 'holding') {
        node.status({ fill: 'red', shape: 'ring', text: 'not writable' });
        msg.payload = outPayload(false, null, '寄存器类型不可写: ' + regType + '（仅支持 coil / holding）');
        safeSend(msg);
        return;
      }

      var addrRaw = (req.addr != null) ? req.addr : ((req.regAddr != null) ? req.regAddr : node.staticAddr);
      var addr = parseInt(addrRaw, 10);
      if (isNaN(addr) || addr < 0 || addr > 65535) {
        fail('无效地址: ' + addrRaw);
        return;
      }

      var value = req.value;
      if (value === undefined || value === null || value === '') {
        fail('缺少写入值 value');
        return;
      }

      var fc, words, dataType = null;
      if (regType === 'coil') {
        fc = 5;
        var truthy = (value === true || value === 1 || value === '1' || value === 'true' || value === 'on');
        words = [truthy ? 0xFF00 : 0x0000];
        value = truthy ? 1 : 0;
      } else {
        var DT_ALIAS = { 'FLOAT': 'FLOAT32', 'BIT': 'BOOL' };
        dataType = DT_ALIAS[req.dataType] || req.dataType || node.staticDataType;
        var _bo = mb.normalizeByteOrder({
          byteOrder: req.byteOrder || node.staticByteOrder,
          wordOrder: req.wordOrder || req.word_order || null
        });
        words = mb.encodeValue(value, dataType, _bo.byteOrder, _bo.wordOrder);
        if (!words) {
          fail('无法按 ' + dataType + ' 编码值: ' + value);
          return;
        }
        fc = words.length > 1 ? 16 : 6;
      }

      var writeInfo = { regType: regType, addr: addr, value: value, fc: fc };
      if (dataType) writeInfo.dataType = dataType;

      // 模拟模式：不连设备直接成功（与 modbus-read 同一开关）
      var SIM = false;
      try { SIM = RED.settings.mbSimulationMode || false; } catch (e) {}
      if (SIM) {
        node.status({ fill: 'green', shape: 'dot', text: 'SIM W ' + regType + ' ' + addr + '=' + value });
        msg.payload = outPayload(true, writeInfo, null);
        safeSend(msg);
        return;
      }

      // 🔧 关闭早退统一出口
      function abortIfClosed() {
        if (!node._closed) return false;
        tp.detach();
        safeDone();
        return true;
      }

      tp.get(function (err, wSock) {
        if (err) {
          fail('[CONNECT] ' + err.message);
          return;
        }
        if (abortIfClosed()) return;

        // 🔧 修复#4：字寄存器 BOOL 位写走 RMW（FC03 读→改位→FC06 写），
        // 不再 FC06 整字覆写清掉其余 15 位（读-改-写竞态见 README 声明）
        var needRmw = (regType !== 'coil') && (dataType === 'BOOL') &&
                      (req.bitOffset !== undefined && req.bitOffset !== null && req.bitOffset !== '');
        var rmwBit = 0;
        if (needRmw) {
          rmwBit = parseInt(req.bitOffset, 10);
          if (isNaN(rmwBit) || rmwBit < 0 || rmwBit > 15) rmwBit = 0;
        }

        // 单请求封装：同一持有连接上可顺序调用（RMW 需要读+写两轮）
        function doRequest(reqFc, reqAddr, reqWords, isRead, cb) {
          var buf = Buffer.alloc(0);
          var resolved = false;
          var sentTxnId = 0;
          var _dataHandler = null, _tmoHandler = null, _errHandler = null;
          var _silenceTimer = null;
          // RTU 收帧参数：期望长度（异常帧 5 字节另判）+ 帧间静默阈值
          var rtuExpLen = isRtu ? (isRead ? mb.rtuExpectedResponseLen(reqFc, 1) : 8) : 0;
          var rtuSilenceMs = isRtu ? Math.max(30, Math.ceil(3.5 * 11 * 1000 / serialCfg.baudRate)) : 0;

          function cleanupListeners(sock) {
            if (_silenceTimer) { clearTimeout(_silenceTimer); _silenceTimer = null; }
            if (!sock) return;
            // 🔧 v1.5.0: handler 判空（防御，与读节点一致）
            if (_dataHandler) sock.removeListener('data', _dataHandler);
            if (_tmoHandler) sock.removeListener('timeout', _tmoHandler);
            if (_errHandler) sock.removeListener('error', _errHandler);
          }

          function doneErr(errText, destroy) {
            if (resolved) return;
            resolved = true;
            cleanupListeners(wSock);
            cb(new Error(errText), null, destroy === true);
          }
          function doneOk(readWord) {
            if (resolved) return;
            resolved = true;
            cleanupListeners(wSock);
            cb(null, readWord, false);
          }

          // RTU 帧尾到达（收齐或静默截断）→ CRC + 回显校验
          function finishRtuFrame(expLen) {
            if (resolved) return;
            var frame = buf.slice(0, expLen);
            if (isRead) {
              // FC03 读响应：[unit][03][byteCount][data...][crc]
              var r = mb.parseRtuResponse(frame, reqAddr, 'holding', 1, unitId);
              if (r.exCode) { doneErr('[MB 0x' + r.exCode.toString(16) + '] read exception', false); return; }
              if (r.err) { doneErr(r.err, false); return; }
              doneOk(r[reqAddr]);
              return;
            }
            var res = mb.parseRtuWriteResponse(frame, reqFc, reqAddr, reqWords, unitId);
            if (res.exCode) { doneErr('[MB 0x' + res.exCode.toString(16) + '] ' + res.exText, false); return; }
            if (res.err) { doneErr(res.err, false); return; }
            doneOk(null);
          }

          function processBuffer() {
            if (resolved) return;
            if (isRtu) {
              if (buf.length < 2) return;
              var expLen = (buf[1] & 0x80) ? 5 : rtuExpLen;  // 异常帧固定 5 字节
              if (buf.length < expLen) return;  // 数据不足，等下一次 data 事件（或静默超时）
              finishRtuFrame(expLen);
              return;
            }
            if (buf.length < 9) return;
            try {
              // 🔧 txnId 校验，丢弃脏帧/延迟帧（与读节点同一策略）
              var respTxnId = buf.readUInt16BE(0);
              if (sentTxnId > 0 && respTxnId !== sentTxnId) {
                var staleLen = buf.readUInt16BE(4);
                if (staleLen > 260 || staleLen < 3) {
                  doneErr('Corrupt stale frame (MBAP len ' + staleLen + ')', true);
                  return;
                }
                var skip = 6 + staleLen;
                if (skip <= buf.length) {
                  buf = buf.slice(skip);
                  setTimeout(processBuffer, 0);
                }
                return;
              }
              var mbapLen = buf.readUInt16BE(4);
              if (mbapLen > 260 || mbapLen < 3) {
                doneErr('MBAP length invalid: ' + mbapLen, false);
                return;
              }
              if (buf.length < 6 + mbapLen) return;  // 数据不足，等下一次 data 事件

              if (isRead) {
                // FC03 读响应：txn(2)proto(2)len(2)unit(1)fc(1)byteCount(1)data(2)
                var rfc = buf.readUInt8(7);
                if (rfc & 0x80) { doneErr('[MB 0x' + buf.readUInt8(8).toString(16) + '] read exception', false); return; }
                if (rfc !== 3) { doneErr('read fc mismatch: ' + rfc, false); return; }
                doneOk(buf.readUInt16BE(6 + mbapLen - 2));
                return;
              }
              var res = mb.parseWriteResponse(buf, reqFc, reqAddr, reqWords, unitId);
              if (res.exCode) { doneErr('[MB 0x' + res.exCode.toString(16) + '] ' + res.exText, false); return; }
              if (res.err) { doneErr(res.err, false); return; }
              doneOk(null);
            } catch (pbErr) {
              doneErr('[DATA] ' + pbErr.message, false);
            }
          }

          wSock.setTimeout(timeout);

          // 先挂监听器，再发帧
          _dataHandler = function (chunk) {
            try {
              buf = Buffer.concat([buf, chunk]);
              if (buf.length > 65536) {
                doneErr('Buffer overflow ' + buf.length + ' bytes', true);
                return;
              }
              // RTU：帧间静默超阈值仍未收齐 → 按已收字节强制收尾（多半 CRC 错 → 失败）
              if (isRtu && !resolved) {
                if (_silenceTimer) clearTimeout(_silenceTimer);
                _silenceTimer = setTimeout(function () {
                  if (resolved || buf.length === 0) return;
                  try { finishRtuFrame(buf.length); } catch (_) {
                    doneErr('[RTU] frame silence timeout', false);
                  }
                }, rtuSilenceMs);
              }
              processBuffer();
            } catch (e) {
              doneErr('[DATA] ' + e.message, false);
            }
          };
          wSock.on('data', _dataHandler);

          _tmoHandler = function () {
            // 🔧 写超时【不重试】：请求可能已到达设备，盲重发有副作用
            doneErr('write timeout (' + timeout + 'ms)', true);
          };
          wSock.once('timeout', _tmoHandler);

          _errHandler = function (e) {
            doneErr('socket error: ' + ((e && e.message) || 'unknown'), true);
          };
          wSock.once('error', _errHandler);

          try {
            var frame;
            if (isRtu) {
              frame = isRead ? mb.buildRtuFrame(unitId, reqFc, reqAddr, 1)
                             : mb.buildRtuWriteFrame(unitId, reqFc, reqAddr, reqWords);
            } else {
              frame = isRead ? mb.buildModbusFrame(unitId, reqFc, reqAddr, 1)
                             : mb.buildWriteFrame(unitId, reqFc, reqAddr, reqWords);
            }
            sentTxnId = frame.txnId;
            wSock.write(frame.buf);
          } catch (e) {
            doneErr('write frame error: ' + e.message, true);
          }
        }

        function finalFail(errText, destroy) {
          if (destroy) tp.destroy(wSock);
          else tp.release();
          fail(errText);
        }
        function finalOk() {
          tp.release();
          node.status({ fill: 'green', shape: 'dot', text: 'W ' + regType + ' ' + addr + '=' + value + ' ' + (Date.now() - roundStart) + 'ms' });
          msg.payload = outPayload(true, writeInfo, null);
          safeSend(msg);
        }

        if (needRmw) {
          // RMW: FC03 读当前字 → 修改目标位 → FC06 写回
          doRequest(3, addr, null, true, function (rerr, curWord) {
            if (rerr) { finalFail('[RMW-READ] ' + rerr.message, true); return; }
            var truthy = (value === true || value === 1 || value === '1' || value === 'true' || value === 'on');
            var newWord = truthy ? (curWord | (1 << rmwBit)) : (curWord & ~(1 << rmwBit));
            value = truthy ? 1 : 0;
            writeInfo.value = value;
            writeInfo.rmw = true;
            doRequest(6, addr, [newWord], false, function (werr) {
              if (werr) { finalFail('[RMW-WRITE] ' + werr.message, true); return; }
              finalOk();
            });
          });
          return;
        }

        doRequest(fc, addr, words, false, function (err, _w, destroy) {
          if (err) { finalFail(err.message, destroy); return; }
          finalOk();
        });
      }); // getConnection
    }); // on('input')

    node.on('close', function (done) {
      node._closed = true;
      if (node.modbusConfig) pool.nodeClosed(node);   // 🔧 构造失败未入池的路径跳过，防计数多减
      node.status({ fill: 'grey', shape: 'dot', text: 'closed' });
      if (typeof done === 'function') done();
    });
  }

  RED.nodes.registerType('modbus-write', ModbusWriteNode);
};
