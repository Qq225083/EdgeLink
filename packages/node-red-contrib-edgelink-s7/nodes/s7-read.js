/**
 * s7-read — 西门子 S7 读取节点 v0.1.0（基于 @st-one-io/nodes7，ISO-on-TCP/RFC1006）
 *
 * v0.1.0: 首版（只读）— TIA 风格地址（DB1.DBW0 / MW10 / I0.0）经 s7-address 译为 nodes7 地址，
 *         S7ItemGroup 批量读（nodes7 内部按 PDU 拆包）、S7Endpoint 长连接池（lib/s7-pool）、
 *         per-PLC 轮次闸、批次失败隔离（批量读失败 → 逐点单读兜底，坏点位 quality=1 不炸整轮）、
 *         DOUBLE(LREAL) 明确拒绝。
 *
 * 输入契约（msg.payload，EdgeLink 后端快照）：
 *   { id|deviceId, deviceName, plcIp, plcPort,
 *     protocolParams: { rack, slot },             // S7 机架/槽位（cfg 默认值兜底）
 *     tags: [{ id, regAddr, regType, dataType, name, ... }],
 *     timeout, maxRetries, retryInterval }
 *   ⚠️ 地址以 regAddr（TIA 风格字符串）为准；tag.addr 数字是中心侧按三菱规则解析的，对 S7 无意义。
 *
 * 输出契约（msg.payload，DP 管道依赖）：
 *   成功 { success:true, deviceId, deviceName,
 *          data: { <tagId>: { rawValue: number|0|1, quality, ts: ISO, regType } },
 *          error: null, driverType: 'driver-s7', plcIp, plcPort, roundTimeMs }
 *   失败 { success:false, ..., data: {}, error: '<错误信息>' } 且 node.error(err, msg)（catch 可捕获）
 *   quality 语义：0=GOOD 1=BAD 2=UNCERTAIN（与 MC 包一致）
 *
 * 线序：S7 协议固定大端，点位上的 byteOrder/wordOrder 一律忽略（见 s7-address.js 注释）。
 */
module.exports = function (RED) {
  'use strict';
  var nodes7 = require('@st-one-io/nodes7');
  var pool = require('./lib/s7-pool');
  var s7addr = require('./lib/s7-address');

  pool.init(nodes7);  // 注入 driver（测试经 proxyquire stub 后池内同为 stub）

  var IN_FLIGHT = {};  // per-PLC 轮次闸（poolKey → node.id），慢 PLC 时新轮次直接失败而非排队积压

  var MAX_BATCH = 32;  // 单批点位上限：限制一次批量读失败时的爆炸半径

  function clampInt(v, def, lo, hi) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.max(lo, Math.min(hi, n));
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      var t = setTimeout(resolve, ms);
      if (t.unref) t.unref();
    });
  }

  // ==== 节点 ====
  function S7ReadNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    node.s7Config = RED.nodes.getNode(config.s7);
    if (!node.s7Config) {
      // 未入池——close 守卫据此跳过 nodeClosed，防 _activeNodeCount 多减
      node.error('未关联 S7 配置节点');
      return;
    }
    pool.nodeOpened();

    node._closed = false;  // 关闭守卫：close 后采集链立即收尾（在途轮询不悬挂）
    node.configDeviceId = String(config.deviceId || '');  // 独立使用时手动配置的设备ID
    node._inFlightKeys = {};  // 本节点持有的轮次闸 key（close 时清理，防跨部署泄漏）

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
      var cfg = node.s7Config;
      var pp = incoming.protocolParams || {};

      var port = parseInt(incoming.plcPort != null ? incoming.plcPort : cfg.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) port = 102;
      var s7 = {
        name: cfg.name,
        host: incoming.plcIp || cfg.host,
        port: port,
        // S7 的机架/槽位从 protocolParams 来（cfg 默认值兜底）
        rack: clampInt(pp.rack != null ? pp.rack : cfg.rack, 0, 0, 7),
        slot: clampInt(pp.slot != null ? pp.slot : cfg.slot, 1, 0, 31)
      };
      var timeout = clampInt(incoming.timeout != null ? incoming.timeout : cfg.timeout, 3000, 500, 30000);
      var maxRetries = clampInt(incoming.maxRetries != null ? incoming.maxRetries : cfg.maxRetries, 2, 0, 10);
      var retryInterval = clampInt(incoming.retryInterval != null ? incoming.retryInterval : cfg.retryInterval, 300, 50, 10000);

      // 优先级: 面板填写 > 上游 msg.payload.id > msg.payload.deviceId > hash
      function resolveDeviceId(incoming) {
        if (node.configDeviceId && node.configDeviceId !== '') {
          var n = parseInt(node.configDeviceId, 10);
          if (!isNaN(n) && n > 0) return n;
        }
        var id = incoming.id || incoming.deviceId;
        if (id !== undefined && id !== null && id !== '') {
          var m = parseInt(id, 10);
          if (!isNaN(m) && m > 0) return m;
        }
        var name = incoming.deviceName || cfg.name || node.configDeviceId || (s7.host + ':' + s7.port);
        var hash = 0;
        for (var i = 0; i < name.length; i++) {
          hash = ((hash << 5) - hash) + name.charCodeAt(i);
          hash |= 0;
        }
        return ((hash >>> 0) % 9000) + 1000;
      }
      var deviceId = resolveDeviceId(incoming);
      var deviceName = incoming.deviceName || cfg.name || ('PLC-' + deviceId);
      var roundStart = Date.now();
      var connKey = pool.poolKey(s7);

      var _sent = false;
      var ownsGate = false;  // 本轮是否已取得轮次闸——仅取得后才在 safeSend 里清闸
      function safeSend(m) {
        if (_sent) return;
        _sent = true;
        // 单出口清理轮次闸（仅当本轮真正取得闸才清，避免误删他人在途轮次）
        if (ownsGate && IN_FLIGHT[connKey] === node.id) {
          delete IN_FLIGHT[connKey];
        }
        try { send(m); } catch (_) {}
        safeDone();
      }

      // 轮次级失败统一出口：data 置空 + node.error(msg)（catch 节点可捕获）+ 照常 send
      function failRound(errText) {
        msg.payload = {
          success: false,
          deviceId: deviceId,
          deviceName: deviceName,
          data: {},
          error: errText,
          driverType: 'driver-s7',
          plcIp: s7.host,
          plcPort: s7.port,
          roundTimeMs: Date.now() - roundStart
        };
        node.status({ fill: 'red', shape: 'ring', text: String(errText).slice(0, 40) });
        node.error('[S7] ' + errText, msg);
        safeSend(msg);
      }

      // ===== 点位清洗：以 regAddr（TIA 风格字符串）为准解析 =====
      var rawTags = msg.tags || incoming.tags;
      if (!rawTags || (Array.isArray(rawTags) && rawTags.length === 0)) rawTags = configTags;
      if (!Array.isArray(rawTags)) rawTags = [rawTags];

      var validTags = [];
      var addrById = {};
      var _seenIds = {};
      for (var i = 0; i < rawTags.length; i++) {
        var t = rawTags[i] || {};
        var regAddr = (t.regAddr !== undefined && t.regAddr !== null && t.regAddr !== '') ? t.regAddr
          : (t.registerAddress !== undefined && t.registerAddress !== null ? t.registerAddress : t.tag_address);
        var parsed = s7addr.parseTagAddress(t.regType, regAddr, t.dataType);
        if (!parsed.ok) {
          // 校验失败点位剔除并计入 warn
          node.warn('[S7] 点位 ' + (t.id || t.name || ('#' + i)) + ' 地址非法：' + parsed.error);
          continue;
        }
        var tagId = t.id || t.name || (parsed.area + '_' + parsed.nodes7Addr);
        if (_seenIds[tagId]) { node.warn('[S7] Duplicate tag id: ' + tagId + '（保留首个）'); continue; }
        _seenIds[tagId] = true;
        addrById[String(tagId)] = parsed.nodes7Addr;
        validTags.push({
          id: String(tagId),
          regType: parsed.area,
          name: t.name || String(tagId),
          dataType: String(t.dataType || '').toUpperCase(),
          nodes7Addr: parsed.nodes7Addr,
          isBit: parsed.isBit
        });
      }

      if (validTags.length === 0) {
        node.status({ fill: 'grey', shape: 'dot', text: '0 valid tags' });
        failRound('No valid tags (all addresses invalid)');
        return;
      }

      // ===== per-PLC 轮次闸：同 PLC 上轮未结束时新轮次直接失败返回 =====
      if (IN_FLIGHT[connKey]) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'round in progress' });
        failRound('Round in progress (previous scan not finished)');
        return;
      }
      IN_FLIGHT[connKey] = node.id;
      node._inFlightKeys[connKey] = true;
      ownsGate = true;

      // 分批（限制单次批量读失败的爆炸半径）
      var batches = [];
      for (var bi = 0; bi < validTags.length; bi += MAX_BATCH) {
        batches.push(validTags.slice(bi, bi + MAX_BATCH));
      }

      var valuesById = {};   // tagId → { value, ts }（仅读成功的点位）
      var hasFailed = false;
      var firstError = '';
      var aborted = false;   // 重连失败 → 剩余批次不再尝试

      pool.getConnection(node, s7, timeout, function (err, endpoint) {
        if (err) {
          failRound('[CONNECT] ' + err.message);
          return;
        }

        var curEndpoint = endpoint;

        // 单批读取：一个 S7ItemGroup 一把读（nodes7 内部按 PDU 拆包），带请求级超时兜底
        function groupReadOnce(tags) {
          return new Promise(function (resolve, reject) {
            var g = null;
            try {
              g = new nodes7.S7ItemGroup(curEndpoint);
              g.setTranslationCB(function (tag) { return addrById[tag] || tag; });
              g.addItems(tags.map(function (t) { return t.id; }));
            } catch (e) {
              if (g) { try { g.destroy(); } catch (_) {} }
              reject(e);
              return;
            }
            var settled = false;
            var timer = setTimeout(function () {
              if (settled) return;
              settled = true;
              try { g.destroy(); } catch (_) {}
              reject(new Error('read timeout (' + timeout + 'ms)'));
            }, timeout);
            if (timer.unref) timer.unref();
            Promise.resolve()
              .then(function () { return g.readAllItems(); })
              .then(function (values) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { g.destroy(); } catch (_) {}
                resolve(values || {});
              })
              .catch(function (e) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { g.destroy(); } catch (_) {}
                reject(e);
              });
          });
        }

        // 断线重连：归还旧连接（若还持有）并重取（池会重建 endpoint；退避期可能直接失败）
        function ensureConnected() {
          if (curEndpoint && curEndpoint.isConnected) return Promise.resolve(true);
          return new Promise(function (resolve) {
            pool.releaseConnection(node, connKey);
            pool.getConnection(node, s7, timeout, function (e2, ep2) {
              if (e2) { resolve(false); return; }
              curEndpoint = ep2;
              resolve(true);
            });
          });
        }

        function noteValue(t, v) {
          // nodes7 位类型返回 boolean → 归一化为 0/1（契约 rawValue: number|0|1）
          valuesById[t.id] = { value: (v === true ? 1 : (v === false ? 0 : v)), ts: new Date().toISOString() };
        }

        // 批量失败重试耗尽后的逐点单读兜底：隔离坏点，不炸整轮
        function readSingles(batch) {
          var seq = Promise.resolve();
          batch.forEach(function (t) {
            seq = seq.then(function () {
              return groupReadOnce([t]).then(function (values) {
                var v = values[t.id];
                if (v === undefined || v === null) throw new Error('read no value');
                noteValue(t, v);
              }).catch(function (e2) {
                // 单点失败：valuesById 缺席 → 输出 quality=1 占位（rawValue null）
                hasFailed = true;
                if (!firstError) firstError = '点位 ' + t.id + '（' + t.nodes7Addr + '）读取失败: ' + (e2 && e2.message ? e2.message : e2);
              });
            });
          });
          return seq;
        }

        function attemptBatch(batch, attempt) {
          return ensureConnected().then(function (ok) {
            if (!ok) {
              // 连接中断且重连失败：本批及剩余批次全部判失败，直接收尾
              hasFailed = true;
              aborted = true;
              if (!firstError) firstError = '[RECONNECT] 连接中断且重连失败';
              return;
            }
            return groupReadOnce(batch).then(function (values) {
              batch.forEach(function (t) {
                var v = values[t.id];
                if (v === undefined || v === null) {
                  // 成功响应但该项无值 —— 视为坏点（quality=1 占位）
                  hasFailed = true;
                  if (!firstError) firstError = '点位 ' + t.id + '（' + t.nodes7Addr + '）读取无值';
                  return;
                }
                noteValue(t, v);
              });
            }).catch(function (e) {
              if (attempt < maxRetries) {
                return delay(retryInterval).then(function () { return attemptBatch(batch, attempt + 1); });
              }
              return readSingles(batch);
            });
          });
        }

        var _finished = false;
        function finish() {
          if (_finished) return;
          _finished = true;
          pool.releaseConnection(node, connKey);
          var now = new Date().toISOString();
          var output = {};
          validTags.forEach(function (t) {
            var got = valuesById[t.id];
            if (got) {
              output[t.id] = { rawValue: got.value, quality: 0, ts: got.ts, regType: t.regType };
            } else {
              // 读失败的点位：quality=1 占位（rawValue null），下游可区分「没配置」和「本轮采失败」
              output[t.id] = { rawValue: null, quality: 1, ts: now, regType: t.regType };
            }
          });
          msg.payload = {
            success: !hasFailed,
            deviceId: deviceId,
            deviceName: deviceName,
            data: output,
            error: hasFailed ? firstError : null,
            driverType: 'driver-s7',
            plcIp: s7.host,
            plcPort: s7.port,
            roundTimeMs: Date.now() - roundStart
          };
          node.status({
            fill: hasFailed ? 'red' : 'green',
            shape: 'dot',
            text: (s7.name || s7.host) + ' ' + Object.keys(output).length + ' vals ' + (Date.now() - roundStart) + 'ms'
          });
          // 失败（含部分点位失败）必须 node.error(msg)，catch 节点可捕获
          if (hasFailed) node.error('[S7] ' + firstError, msg);
          safeSend(msg);
        }

        function processBatch(idx) {
          if (node._closed || aborted || idx >= batches.length) { finish(); return; }
          attemptBatch(batches[idx], 0)
            .then(function () { processBatch(idx + 1); })
            .catch(function (e) {
              // 防御：任何批异常都不得中断整轮
              node.warn('[S7] batch error: ' + (e && e.message ? e.message : e));
              hasFailed = true;
              if (!firstError) firstError = '[BATCH] ' + (e && e.message ? e.message : e);
              processBatch(idx + 1);
            });
        }

        processBatch(0);
      }); // getConnection
    }); // on('input')

    // ==== close: 清轮次闸 + 归还连接池中的所有引用；在途属主由池直接销毁 ====
    node.on('close', function (done) {
      node._closed = true;  // 终止在途采集链
      // 清理本节点持有的轮次闸（模块级状态跨部署存活，不清理会把新节点永久挡在闸外）
      var fk = Object.keys(node._inFlightKeys || {});
      for (var fi = 0; fi < fk.length; fi++) {
        if (IN_FLIGHT[fk[fi]] === node.id) delete IN_FLIGHT[fk[fi]];
      }
      node._inFlightKeys = {};
      if (node.s7Config) pool.nodeClosed(node);   // 构造失败未入池的路径跳过，防计数多减
      node.status({ fill: 'grey', shape: 'dot', text: 'closed' });
      if (typeof done === 'function') done();
    });
  }

  RED.nodes.registerType('s7-read', S7ReadNode);
};
