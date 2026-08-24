/**
 * ===========================================================================
 * mitsubishi-write.js — 三菱 MC Protocol 写入节点 v1.6.0
 * ===========================================================================
 *
 * 【文件定位】
 *   本文件是 Node-RED 写节点的运行时实现。负责将 JS 值安全地写入 PLC。
 *   写入操作有副作用——一次错误的写入可能导致设备误动作。
 *   因此本文件的设计原则是"宁可不写，不可错写"。
 *
 * 【与读节点的关键差异】
 *   1. 独立连接池 (CONN_POOL_W)：读写分离，写操作不阻塞周期读取
 *   2. 三路分流：字写入 / 原生位写入 / RMW (Read-Modify-Write)
 *   3. 严格连续分组 (groupTagsContiguous)：有间隙就拆组，不填 0
 *   4. 值校验与钳制 (coerceWriteValue)：非法值拒写而非静默写 0
 *   5. v1.6.0: 面板默认值列 + msg.tags 合并（替代全量覆盖）
 *
 * 【三路分流详解】
 *
 *   写入请求到达
 *     │
 *     ├─ 位设备 (M/X/Y/L/B) → 原生位写入 (子指令 0x0001)
 *     │    单往返，无 RMW 竞态。
 *     │    连续位打包为 nibble-pair 字节，非连续位自动拆帧。
 *     │    例：M100=1, M101=0 → 一帧搞定
 *     │
 *     ├─ 字设备非 BOOL (D100/INT16) → 批量字写入 (子指令 0x0000)
 *     │    groupTagsContiguous 严格连续分组 → encodeWriteWords → 一帧发送
 *     │    例：D100=100, D101=200 → 一帧搞定
 *     │
 *     └─ 字设备 BOOL (D100.3) → RMW (Read-Modify-Write)
 *         三步：读当前字 → 修改指定位 → 写回
 *         可能存在竞态（两个写操作同时 RMW 同一字），
 *         但在 JS 单线程 + 串行化队列模型下天然安全。
 *
 * 【v1.6.0 面板表格与 msg.tags 合并规则】
 *   - 无 msg.tags → 整轮用面板表格（默认值列生效，纯静态写入走通）
 *   - 有 msg.tags → msg 驱动本轮，每条 msg 点位按 id（其次 regType+addr）
 *     匹配面板行补齐缺失字段，value 缺省回落面板默认值
 *   - 未被 msg 引用的面板行本轮【不】执行（防静态值随动态轮次误写 —
 *     写操作有副作用，不是"多写几次没关系"的场景）
 *
 * 【测试覆盖】
 *   test/mitsubishi-write_spec.js (608 行): 字写/位写/RMW, golden buffer,
 *     P0-2 位回归, ASCII/UDP, v1.6.0 静态值/merge/副作用安全
 */

module.exports = function (RED) {
  var net = require('net');
  var mc = require('./mc-protocol');
  var mcUdp = require('./mc-udp');

  // =========================================================================
  // 第 1 章：值收敛 — 写入前的类型安全检查
  // =========================================================================

  /**
   * 将面板字符串值按数据类型收敛为 JS 数值
   *
   * 【为什么需要这个函数】
   *   面板默认值列是字符串类型（来自 HTML input），但写入 PLC 需要
   *   正确的 JS 数值类型。如果直接传递字符串给 encodeWriteWords：
   *   - "123" parseInt → 123 ✓
   *   - "true" → BOOL 应该为 1，但 parseInt("true") = NaN → 0 ✗
   *   - "0" → BOOL 应该为 0，但 truthy 判断 "0" 为 true ✗
   *
   * 【BOOL 处理策略（白名单方式）】
   *   true / 1 / "1" / "true" / "on" → 1
   *   其他一切 → 0
   *   注意：空字符串（面板留空）不走此函数——在入口处被过滤（视为缺省值）
   *
   * 【数字处理策略】
   *   Number() 转换，NaN → null（拒写）
   *   这是"宁可不写，不可错写"原则的体现。
   *
   * @param {*} v - 原始值（可能来自面板字符串或 msg 传入）
   * @param {string} dt - 数据类型
   * @returns {number|null} 收敛后的值，null 表示无效（应跳过此点位）
   */
  function coerceWriteValue(v, dt) {
    if (dt === 'BOOL') {
      return (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') ? 1 : 0;
    }
    if (typeof v === 'string') {
      var n = Number(v.trim());
      return isNaN(n) ? null : n;  // 非法值 → 拒写
    }
    if (typeof v === 'number') return isNaN(v) ? null : v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return null;  // 其他类型 → 拒写
  }

  // =========================================================================
  // 第 2 章：写入连接池（与读连接池 CONN_POOL 完全独立）
  // =========================================================================

  /**
   * 写入连接池设计原理（与读池结构相同，但命名空间独立）：
   *
   * 为什么读写必须分离？
   * - MC 协议是严格请求-响应串行的（maxParallel=1）
   * - 如果读写共享一条 TCP 连接，一个正在进行的读请求会阻塞写请求
   * - 写操作通常稀疏（偶尔下发参数），不应被高频读取阻塞
   * - 分离后：读走 CONN_POOL，写走 CONN_POOL_W，互不干扰
   *
   * 代价：同一 PLC 最多 2 条 TCP 连接（读一条、写一条）
   * 对于 PLC 以太网模块来说，2 条连接远低于其上限（通常 8-64 条）
   */
  var CONN_POOL_W = {};
  var IN_FLIGHT_W = {};
  var MAX_QUEUE = 50;
  var MAX_BACKOFF_MS = 10000;
  var _activeNodeCount = 0;
  var _cleanTimer = null;

  function ensureCleanTimer() {
    if (_cleanTimer) return;
    _cleanTimer = setInterval(function () {
      var now = Date.now();
      var keys = Object.keys(CONN_POOL_W);
      for (var i = 0; i < keys.length; i++) {
        var entry = CONN_POOL_W[keys[i]];
        if (!entry || entry.inUse || entry.connecting) continue;
        if (entry.socket && (now - entry.lastUsed > 600000)) {
          var q = entry.queue || [];
          entry.queue = [];
          for (var qi = 0; qi < q.length; qi++) {
            try { q[qi].callback(new Error('Connection idle timeout')); } catch (_) {}
          }
          try { entry.socket.destroy(); } catch (_) {}
          delete CONN_POOL_W[keys[i]];
        }
      }
    }, 300000);
    if (_cleanTimer.unref) _cleanTimer.unref();
  }

  function poolKey(plc) {
    return plc.host + ':' + plc.port + ':' + plc.frame + ':' + plc.networkNo + ':' + plc.stationNo + ':' + (plc.protocol || 'tcp');
  }

  /**
   * 写入连接池的 getConnection（与读池相同逻辑，操作 CONN_POOL_W）
   * @see mitsubishi-read.js getConnection 详细注释
   */
  function getConnection(node, plc, callback) {
    var key = poolKey(plc);
    var entry = CONN_POOL_W[key];
    if (entry && entry.backoffMs && entry.lastErrorTime) {
      var sinceErr = Date.now() - entry.lastErrorTime;
      if (sinceErr < entry.backoffMs) { callback(new Error('connect backoff (' + (entry.backoffMs - sinceErr) + 'ms)')); return; }
    }
    if (entry && entry.socket && !entry.socket.destroyed && !entry.inUse && !entry.connecting) {
      entry.inUse = true; entry.lastUsed = Date.now();
      entry.users = entry.users || {}; entry.users[node.id] = true;
      entry.socket.setTimeout(plc.timeout);
      callback(null, entry.socket); return;
    }
    if (entry && (entry.inUse || entry.connecting)) {
      entry.queue = entry.queue || [];
      if (entry.queue.length >= MAX_QUEUE) { callback(new Error('Queue full (' + MAX_QUEUE + ')')); return; }
      entry.queue.push({ callback: callback, timeout: plc.timeout, enqueueTime: Date.now() }); return;
    }
    if (!entry) { entry = CONN_POOL_W[key] = { socket: null, inUse: false, lastUsed: 0, queue: [], connecting: true, backoffMs: 0, lastErrorTime: 0 }; }
    else { entry.connecting = true; }
    var client = new net.Socket();
    client.setTimeout(plc.timeout); client.setKeepAlive(true, 30000);
    var connectTimer = setTimeout(function () { client.destroy(); onConnectError(new Error('connect timeout')); }, plc.timeout);
    function onConnectError(e) {
      clearTimeout(connectTimer); try { client.destroy(); } catch (_) {}
      entry.connecting = false; entry.socket = null; entry.inUse = false;
      entry.lastErrorTime = Date.now();
      var base = plc.retryInterval || 300;
      entry.backoffMs = Math.max(base, Math.min((entry.backoffMs || base) * 2, MAX_BACKOFF_MS));
      var q = entry.queue || []; entry.queue = [];
      for (var qi = 0; qi < q.length; qi++) { try { q[qi].callback(e); } catch (_) {} }
      callback(e);
    }
    client.once('error', onConnectError);
    client.connect(plc.port, plc.host, function () {
      clearTimeout(connectTimer); client.removeListener('error', onConnectError);
      entry.socket = client; entry.inUse = true; entry.connecting = false;
      entry.lastUsed = Date.now(); entry.backoffMs = 0; entry.lastErrorTime = 0;
      entry.users = entry.users || {}; entry.users[node.id] = true;
      client.once('end', function () { destroyConnection(key); });
      client.once('close', function () { destroyConnection(key); });
      client.once('error', function () { destroyConnection(key); });
      callback(null, client);
    });
  }

  function releaseConnection(key) {
    var entry = CONN_POOL_W[key];
    if (!entry) return;
    if (entry.queue && entry.queue.length > 0) {
      var now = Date.now();
      while (entry.queue.length > 0) {
        var next = entry.queue.shift();
        if (now - next.enqueueTime > next.timeout) { try { next.callback(new Error('Queue timeout')); } catch (_) {} continue; }
        entry.lastUsed = Date.now();
        if (entry.socket && !entry.socket.destroyed) { entry.inUse = true; entry.socket.setTimeout(next.timeout); try { next.callback(null, entry.socket); } catch (_) {} return; }
        try { next.callback(new Error('Connection lost')); } catch (_) {}
      }
    }
    entry.inUse = false; entry.lastUsed = Date.now();
  }

  function destroyConnection(key) {
    var entry = CONN_POOL_W[key];
    if (!entry || entry._destroyed) return;
    entry._destroyed = true;
    if (entry.socket && !entry.socket.destroyed) { try { entry.socket.destroy(); } catch (_) {} }
    var q = entry.queue || []; entry.queue = [];
    delete CONN_POOL_W[key];
    for (var qi = 0; qi < q.length; qi++) { try { q[qi].callback(new Error('Connection destroyed')); } catch (_) {} }
  }

  // =========================================================================
  // 第 3 章：主节点 — MitsubishiWriteNode
  // =========================================================================

  function MitsubishiWriteNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    _activeNodeCount++;
    ensureCleanTimer();

    node.plcConfig = RED.nodes.getNode(config.plc);
    if (!node.plcConfig) { /* ... error ... */ return; }

    node.serialNo = parseInt(config.serialNo, 10) || 0;
    node.configDeviceId = String(config.deviceId || '');
    node._usedConns = {};
    node._inFlightKeys = {};
    node._closed = false;

    var configTags = [];
    try { configTags = JSON.parse(config.tags || '[]'); } catch (e) { configTags = []; }

    node.on('input', function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };

      // ---- PLC 参数解析（同读节点）----
      var cfg = node.plcConfig;
      var incoming = msg.payload || {};
      var pp = incoming.protocolParams || {};
      var plc = {
        name: cfg.name, host: incoming.plcIp || cfg.host, port: incoming.plcPort || cfg.port,
        frame: String(pp.mcFrame || cfg.frame || '3E').toUpperCase(),
        series: pp.plcSeries || cfg.series || 'Q',
        protocol: String(pp.protocol || cfg.protocol || 'tcp').toLowerCase(),
        ascii: !!(pp.ascii !== undefined ? pp.ascii : cfg.ascii),
        networkNo: pp.networkNo || cfg.networkNo || 0, stationNo: pp.stationNo || cfg.stationNo || 0,
        timeout: mc.clampInt(incoming.timeout || cfg.timeout, 3000, 500, 30000),
        maxRetries: mc.clampInt(incoming.maxRetries || cfg.maxRetries, 2, 0, 10),
        retryInterval: mc.clampInt(incoming.retryInterval || cfg.retryInterval, 300, 50, 10000)
      };

      if (plc.protocol !== 'tcp' && plc.protocol !== 'udp') { /* error */ msg.payload = { error: '不支持的传输协议' }; node.send(msg); if (done) done(); return; }
      if (plc.frame !== '3E' && plc.frame !== '4E') { /* error */ msg.payload = { error: '不支持的帧格式' }; node.send(msg); if (done) done(); return; }

      var deviceId = /* resolveDeviceId — 与读节点相同 */ (function () { /* ... */ return 1000; })();
      var deviceName = incoming.deviceName || plc.name || ('PLC-' + deviceId);

      var _sent = false;
      function safeSend(m) {
        if (_sent) return; _sent = true;
        if (typeof connKey !== 'undefined' && connKey && IN_FLIGHT_W[connKey] === node.id) delete IN_FLIGHT_W[connKey];
        try { send(m); } catch (_) {}
        if (done) { try { done(); } catch (_) {} }
      }

      // =====================================================================
      // v1.6.0: 面板表格与 msg.tags 合并逻辑
      //
      // 【旧行为（v1.5.x）】
      //   msg.tags 全量覆盖面板表格。意味着如果你传了 msg.tags，
      //   面板里的 slope/offset 等信息全部丢失。
      //
      // 【新行为（v1.6.0）】
      //   msg.tags 按 id（其次 regType+addr）匹配面板行：
      //   - 面板中匹配到的行：补齐 msg 中缺失的字段
      //   - value 缺失：回落面板默认值列
      //   - msg 未引用的面板行：本轮不执行（副作用防护）
      //
      //   这个设计使得你可以：
      //   - 在面板中配好所有点位的结构信息（类型/字节序/名称等）
      //   - msg 中只传需要实时修改的字段（如 value），其它字段自动从面板补全
      // =====================================================================

      var msgTags = msg.tags || incoming.tags;
      var tags;
      if (!msgTags || (Array.isArray(msgTags) && msgTags.length === 0)) {
        // 无 msg.tags → 全量面板（静态默认值写入路径）
        tags = configTags.slice();
      } else {
        // 有 msg.tags → 逐条匹配面板行补齐字段
        if (!Array.isArray(msgTags)) msgTags = [msgTags];
        // 构建面板索引（按 id + 按 regType+addr 双索引）
        var cfgById = {}, cfgByAddr = {};
        configTags.forEach(function (ct) {
          if (ct.id !== undefined && ct.id !== null && ct.id !== '') cfgById[String(ct.id)] = ct;
          var ca = (ct.addr !== undefined && ct.addr !== null && ct.addr !== '') ? ct.addr : ct.regAddr;
          if (ca !== undefined && ca !== null && ca !== '') cfgByAddr[(ct.regType || 'D') + '|' + String(ca)] = ct;
        });
        tags = msgTags.map(function (mt) {
          var cfg = null;
          if (mt.id !== undefined && mt.id !== null && mt.id !== '') cfg = cfgById[String(mt.id)] || null;
          if (!cfg) {
            var ma = (mt.addr !== undefined && mt.addr !== null && mt.addr !== '') ? mt.addr : mt.regAddr;
            if (ma !== undefined && ma !== null && ma !== '') cfg = cfgByAddr[(mt.regType || 'D') + '|' + String(ma)] || null;
          }
          if (!cfg) return mt;  // 面板无匹配 → 原样使用 msg 数据
          // 面板兜底，msg 字段优先（undefined/null 不覆盖面板值）
          var merged = {};
          for (var ck in cfg) { if (cfg.hasOwnProperty(ck)) merged[ck] = cfg[ck]; }
          for (var mk in mt) { if (mt.hasOwnProperty(mk) && mt[mk] !== undefined && mt[mk] !== null) merged[mk] = mt[mk]; }
          return merged;
        });
      }

      // ---- 标签校验与值收敛 ----
      var allValidTags = [];
      for (var i = 0; i < tags.length; i++) {
        var t = tags[i];
        var rt = t.regType || 'D';
        if (!mc.MC_DEVICE_CODES[rt]) { if (rt) node.warn('[MC-WRITE] Unknown regType: ' + rt + ', using D'); rt = 'D'; }
        var DT_MAP = { 'FLOAT': 'FLOAT32', 'BIT': 'BOOL' };
        var dt = DT_MAP[t.dataType] || t.dataType || 'INT16';
        var rawAddr = (t.addr !== undefined) ? t.addr : (t.regAddr || t.tag_address || t.registerAddress || '');
        var addr = mc.parseDeviceAddress(rt, rawAddr, plc.series);
        if (addr < 0) { node.warn('[MC-WRITE] Invalid addr'); continue; }

        // ★ v1.6.0: 空值拒绝（面板留空 ≠ 写空串）
        if (t.value === undefined || t.value === null || t.value === '') {
          node.warn('[MC-WRITE] Missing value for tag ' + (t.id || t.name || (rt + addr)));
          continue;
        }

        var displayAddr = mc.formatDeviceAddress(rt, addr, plc.series).slice(rt.length);
        var tagId = t.id || t.name || (rt + displayAddr);

        // ★ 值收敛：字符串 → 数值；非法值 → null → 跳过
        var writeVal = coerceWriteValue(t.value, dt);
        if (writeVal === null) {
          node.warn('[MC-WRITE] Invalid value for tag ' + tagId + ': ' + t.value);
          continue;
        }

        // 值域钳制
        if (dt === 'UINT16' && writeVal > 65535) { node.warn('[MC-WRITE] UINT16 overflow'); writeVal = 65535; }
        else if (dt === 'INT16' && writeVal > 32767) { node.warn('[MC-WRITE] INT16 overflow'); writeVal = 32767; }
        else if (dt === 'INT16' && writeVal < -32768) { node.warn('[MC-WRITE] INT16 underflow'); writeVal = -32768; }

        allValidTags.push({
          id: String(tagId), regType: rt, addr: addr, displayAddr: displayAddr,
          dataType: dt, value: writeVal,
          byteOrder: t.byteOrder || null, wordOrder: t.wordOrder || null,
          bitOffset: (function () { /* bitOffset 钳制 0-15 */ return null; })(),
          name: t.name || (rt + displayAddr)
        });
      }

      if (allValidTags.length === 0) { /* error */ safeSend(msg); return; }

      var timeout = plc.timeout, maxRetries = plc.maxRetries, retryInterval = plc.retryInterval;
      var frameType = plc.frame, stationNo = plc.stationNo, networkNo = plc.networkNo;
      var roundStart = Date.now();
      var SIM_MODE = false; try { SIM_MODE = RED.settings.mcSimulationMode || false; } catch (e) {}
      if (SIM_MODE) { /* 模拟模式直接返回成功 */ safeSend(msg); return; }

      // =====================================================================
      // 三路分流：字写入 | 位设备原生位写 | 字内 BOOL RMW
      // =====================================================================
      var wordTags = [];       // 字设备非 BOOL → 批量字写
      var bitDeviceTags = [];  // M/X/Y/L/B → 原生位写（无 RMW 竞态）
      var wordBoolTags = [];   // D100.3 → RMW

      for (var wi = 0; wi < allValidTags.length; wi++) {
        var at = allValidTags[wi];
        var isBitDevice = !!mc.BIT_DEVICES[at.regType];
        // X 设备警告：输入继电器由 PLC 扫描刷新，写入可能无效
        if (at.regType === 'X') {
          node.warn('[MC-WRITE] X device write may be overwritten by PLC scan — 建议改用 M 或 B');
        }
        if (isBitDevice) bitDeviceTags.push(at);
        else if (at.dataType === 'BOOL') wordBoolTags.push(at);
        else wordTags.push(at);
      }

      var connKey = poolKey(plc);
      var hasFailed = false, firstError = '';
      var currentSN = node.serialNo;
      var allResults = {};  // tagId → { value, quality, ts }

      // 轮次闸 + 入口节流（同读节点）
      if (IN_FLIGHT_W[connKey]) { /* Round in progress */ safeSend(msg); return; }
      IN_FLIGHT_W[connKey] = node.id;
      node._inFlightKeys[connKey] = true;
      node._usedConns[connKey] = true;

      var poolEntry = CONN_POOL_W[connKey];
      if (poolEntry && poolEntry.inUse && poolEntry.queue && poolEntry.queue.length > 20) {
        delete IN_FLIGHT_W[connKey]; node.status({ fill: 'yellow', text: 'throttled' });
        msg.payload = { error: 'Throttled: queue > 20' }; safeSend(msg); return;
      }

      function assembleAndSend() { /* 与读节点相同的输出组装逻辑 */ }

      // ---- 构建统一任务队列：字写入 → 位设备原生位写 → RMW ----
      var wordGroups = wordTags.length > 0 ? mc.groupTagsContiguous(wordTags) : [];

      // 位设备原生位写分组（严格连续，含 P0-2 间隙防护）
      var bitWritePhases = [];
      if (bitDeviceTags.length > 0) {
        var bitByReg = {};
        bitDeviceTags.forEach(function (t) {
          if (!bitByReg[t.regType]) bitByReg[t.regType] = [];
          bitByReg[t.regType].push(t);
        });
        Object.keys(bitByReg).forEach(function (rt) {
          var sorted = bitByReg[rt].slice().sort(function (a, b) { return a.addr - b.addr; });
          var cluster = [sorted[0]];
          for (var bi = 1; bi < sorted.length; bi++) {
            var prevEnd = cluster[cluster.length - 1].addr;
            // ★ P0-2 位版：严格连续（有间隙就拆组，绝对不覆盖中间位）
            if (sorted[bi].addr === prevEnd + 1 && (sorted[bi].addr - cluster[0].addr + 1) <= 960) {
              cluster.push(sorted[bi]);
            } else {
              bitWritePhases.push({ regType: rt, tags: cluster });
              cluster = [sorted[bi]];
            }
          }
          if (cluster.length > 0) bitWritePhases.push({ regType: rt, tags: cluster });
        });
      }

      // RMW 分组（字内 BOOL，buildRMWWriteGroup 自动按字聚合）
      var rmwGroups = [];
      if (wordBoolTags.length > 0) {
        var boolByReg = {};
        wordBoolTags.forEach(function (t) {
          if (!boolByReg[t.regType]) boolByReg[t.regType] = [];
          boolByReg[t.regType].push(t);
        });
        Object.keys(boolByReg).forEach(function (rt) {
          var rmw = mc.buildRMWWriteGroup(boolByReg[rt], rt, plc.series);
          rmw.forEach(function (r) { rmwGroups.push(r); });
        });
      }

      // 合并所有类型到统一任务队列
      var totalPhases = [];
      wordGroups.forEach(function (wg) { totalPhases.push({ type: 'word', group: wg }); });
      bitWritePhases.forEach(function (bp) { totalPhases.push({ type: 'bit', group: bp }); });
      rmwGroups.forEach(function (rg) { totalPhases.push({ type: 'rmw', group: rg }); });

      if (totalPhases.length === 0) { assembleAndSend(); return; }

      // =====================================================================
      // UDP 写入路径（包含字写、位写、RMW 三个子路径）
      // 结构与 TCP 路径对称，使用 mcUdp.request 替代 socket.write + data 监听
      // =====================================================================
      if (plc.protocol === 'udp') {
        mcUdp.acquire(node, connKey, plc.timeout, function (aerr, udpEntry) {
          if (aerr) { /* error */ safeSend(msg); return; }
          function processPhaseUdp(pi) {
            if (node._closed) { mcUdp.release(connKey); return; }
            if (pi >= totalPhases.length) { mcUdp.release(connKey); assembleAndSend(); return; }
            var phase = totalPhases[pi];
            if (phase.type === 'bit') { /* processBitPhaseUdp — 原生位写UDP路径 */ }
            else if (phase.type === 'word') { /* processWordPhaseUdp — 字写UDP路径 */ }
            else { /* processRMWPhaseUdp — RMW UDP路径（读→改→写 三步串行）*/ }
          }
          processPhaseUdp(0);
        });
        return;
      }

      // =====================================================================
      // TCP 写入路径（主路径）
      // =====================================================================
      getConnection(node, plc, function (err, mcSocket) {
        if (err) { /* error */ safeSend(msg); return; }

        function processPhase(pi) {
          if (node._closed) { releaseConnection(connKey); return; }
          if (pi >= totalPhases.length) { releaseConnection(connKey); assembleAndSend(); return; }
          var phase = totalPhases[pi];
          if (phase.type === 'word') processWordPhase(pi, phase.group);
          else if (phase.type === 'bit') processBitPhase(pi, phase.group);
          else processRMWPhase(pi, phase.group);
        }

        /**
         * TCP 字写入 — 核心路径
         *
         * 流程：groupTagsContiguous 保证严格连续 → 顺序编码 →
         *       buildWriteFrame → socket.write → 等待响应 → parseMCWriteResponse
         *
         * 与读路径的差异：响应解析用 parseMCWriteResponse（只检查结束码，无数据区）
         */
        function processWordPhase(pi, grp) {
          if (node._closed) { releaseConnection(connKey); return; }
          var grpSorted = grp.tags.slice().sort(function (a, b) { return a.addr - b.addr; });
          var startA = grpSorted[0].addr;
          var lastTag = grpSorted[grpSorted.length - 1];
          var maxAddr = lastTag.addr + mc.wordSpanOf(lastTag.dataType) - 1;
          var wordCount = maxAddr - startA + 1;

          if (wordCount > 960) { /* 兜底拆分 */ }

          // 顺序编码：groupTagsContiguous 保证严格连续，直接遍历即可
          var words = [];
          for (var fi = 0; fi < grpSorted.length; fi++) {
            var encoded = mc.encodeWriteWords(grpSorted[fi].value, grpSorted[fi].dataType, grpSorted[fi].byteOrder, grpSorted[fi].wordOrder);
            for (var ei = 0; ei < encoded.length; ei++) words.push(encoded[ei]);
          }

          function attemptWordWrite(attempt) {
            if (node._closed) { releaseConnection(connKey); return; }
            if (mcSocket.destroyed) { /* reconnect */ }
            if (attempt > maxRetries) { hasFailed = true; /* ... */ processPhase(pi + 1); return; }

            var sentSN = (frameType === '4E') ? currentSN : 0;
            if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;
            var buf = Buffer.alloc(0), asciiBufW = Buffer.alloc(0);
            var resolved = false;
            var _tmoHandler = null, _errHandler = null, _dataHandler = null, _reqTimer = null;
            function cleanupListeners(sock) { /* ... */ }

            mcSocket.setTimeout(timeout);
            try {
              var frame = mc.buildWriteFrame(frameType, startA, words, stationNo, grp.regType, networkNo, sentSN);
              var wireFrameW = plc.ascii ? mc.asciify(frame) : frame;
              mcSocket.write(wireFrameW);
            } catch (e) { /* write error → reconnect */ return; }

            _dataHandler = function (sock) { return function (chunk) { /* TCP分帧 + 响应解析 */ }; }(mcSocket);
            mcSocket.on('data', _dataHandler);
            _tmoHandler = function (sock) { return function () { /* timeout → reconnect */ }; }(mcSocket);
            mcSocket.once('timeout', _tmoHandler);
            _errHandler = function (sock) { return function () { /* error → reconnect */ }; }(mcSocket);
            mcSocket.once('error', _errHandler);
            _reqTimer = setTimeout(function () { /* 请求级兜底定时器 */ }, timeout);
          }
          attemptWordWrite(0);
        }

        /**
         * TCP 原生位写入 — v1.5.1 新增，消除 RMW 竞态
         *
         * 使用 MC 协议子指令 0x0001（位单位批量写入），一次往返完成。
         * 相比 RMW 方案优势：
         * - 单往返（RMW 需要读+写两次往返）
         * - 无竞态（RMW 的读和写之间可能被其他写入干扰）
         * - PLC 内部原子执行
         */
        function processBitPhase(pi, bitGrp) { /* encodeBitWriteData → buildBitWriteFrame → 发送 */ }

        /**
         * TCP RMW 路径 — 三步串行：读当前字 → 修改指定位 → 写回
         *
         * 仅用于字设备 BOOL（如 D100.3），因为此类点位没有原生的"单一位写入"指令。
         * 位设备（M/X/Y/L/B）优先走 processBitPhase 的原生位写。
         *
         * 竞态分析：
         *   JS 单线程模型下，同一连接上的 RMW 是串行化的（IN_FLIGHT_W 闸 + maxParallel=1）。
         *   两个不同连接的 RMW 可能同时操作同一个字（竞态），
         *   但这需要两个不同的 Node-RED 写节点指向同一个 PLC——
         *   实际部署中写节点通常唯一，因此风险可控。
         */
        function processRMWPhase(pi, rmwGrp) {
          // Step 1: 读取当前字的内容
          // Step 2: 按位掩码修改（modified |= 1<<bit; modified &= ~(1<<bit)）
          // Step 3: 写回修改后的字
          // 三步均有独立的 _closed 守卫和重试循环
        }

        function finishWithError() { /* connection lost → error message */ }
        processPhase(0);
      });
    });

    // =====================================================================
    // close 生命周期（与读节点相同）
    // =====================================================================
    node.on('close', function (done) {
      node._closed = true;
      var fk = Object.keys(node._inFlightKeys || {});
      for (var fi = 0; fi < fk.length; fi++) { if (IN_FLIGHT_W[fk[fi]] === node.id) delete IN_FLIGHT_W[fk[fi]]; }
      node._inFlightKeys = {};
      try { mcUdp.releaseNode(node.id); } catch (_) {}
      _activeNodeCount--;
      if (_activeNodeCount <= 0 && _cleanTimer) { clearInterval(_cleanTimer); _cleanTimer = null; }
      var conns = node._usedConns || {};
      var keys = Object.keys(conns);
      for (var ci = 0; ci < keys.length; ci++) {
        var entry = CONN_POOL_W[keys[ci]];
        if (entry && entry.users) { delete entry.users[node.id]; if (Object.keys(entry.users).length === 0) destroyConnection(keys[ci]); }
      }
      node._usedConns = {};
      node.status({ fill: 'grey', shape: 'dot', text: 'closed' });
      if (typeof done === 'function') done();
    });
  }

  RED.nodes.registerType('mitsubishi-write', MitsubishiWriteNode);
};
