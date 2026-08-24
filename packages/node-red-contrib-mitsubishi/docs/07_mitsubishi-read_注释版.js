/**
 * ===========================================================================
 * mitsubishi-read.js — 三菱 MC Protocol 读取节点 v1.6.0
 * ===========================================================================
 *
 * 【文件定位】
 *   本文件是 Node-RED 读节点的运行时实现。它负责：
 *   1. 连接管理（长连接池 + 指数退避重连 + 空闲回收）
 *   2. 标签解析与校验（msg.tags / 静态配置）
 *   3. 协议调度（分组 → 逐帧发送 → 响应解析 → 组装输出）
 *   4. 生命周期管理（close 清理、引用计数、轮次闸）
 *
 * 【架构总览】
 *
 *   ┌─ inject/trigger ─→ mitsubishi-read ─→ downstream nodes
 *   │                       │
 *   │    ┌──────────────────┼──────────────────┐
 *   │    │                  │                  │
 *   │    ▼                  ▼                  ▼
 *   │  标签解析          连接获取           生命周期
 *   │  (msg.tags        (CONN_POOL          (_closed,
 *   │   → 静态配置        → getConnection    IN_FLIGHT,
 *   │   → 校验)          → 退避/队列)       引用计数)
 *   │    │                  │                  │
 *   │    ▼                  ▼                  │
 *   │  分组              帧发送               │
 *   │  (groupTags        (build3EFrame/       │
 *   │   → 960字聚类)      build4EFrame)       │
 *   │    │                  │                  │
 *   │    ▼                  ▼                  │
 *   │  串行发送           响应解析             │
 *   │  (processGroup     (parseMCResponse     │
 *   │   → 递归)           → decodeTag)        │
 *   │    │                  │                  │
 *   │    └────────┬─────────┘                  │
 *   │             ▼                            │
 *   │         组装输出                          │
 *   │         (assembleAndSend                 │
 *   │          → rawValue/engValue/quality)     │
 *   │             │                            │
 *   │             ▼                            │
 *   └───────── safeSend(msg) ──────────────────┘
 *
 * 【连接池设计（最关键的部分）】
 *
 *   CONN_POOL 是模块级（module-level）变量，意味着：
 *   - Node-RED redeploy 时，节点实例被销毁重建，但 CONN_POOL 保持
 *   - 多个 Read 节点指向同一 PLC 时，共享同一条 TCP 连接
 *   - 这就是为什么要用引用计数（entry.users）：
 *     一个节点 close 不能销毁其他节点正在用的连接
 *
 *   poolKey = host:port:frame:networkNo:stationNo:protocol
 *   这个 key 设计保证了：
 *   - 不同 PLC → 不同连接 ✓
 *   - 同一 PLC 不同帧格式（3E/4E）→ 不同连接 ✓
 *   - 同一 PLC 不同站号 → 不同连接 ✓
 *
 * 【IN_FLIGHT 轮次闸】
 *   IN_FLIGHT[connKey] = node.id
 *   同一 PLC 同时只允许一轮扫描。如果上一轮还没完成（慢 PLC），
 *   新一轮直接拒绝 "Round in progress"。
 *   这避免了请求在队列中积压——积压的数据读到也是过期的。
 *
 * 【_closed 守卫模式】
 *   node._closed 在 close 事件中设为 true。
 *   所有异步回调（数据到达、超时、错误、重连）在执行前都检查此标志。
 *   如果在 redeploy 时一个请求正在飞行中：
 *   1. close 先触发 → _closed = true
 *   2. 稍后 data 事件触发 → 检查 _closed → 释放连接并 return
 *   这个过程防止了"关闭后的回调操作已销毁节点"的崩溃。
 *
 * 【安全机制清单】
 *   - 指数退避重连（base=retryInterval, max=10s）
 *   - 队列上限 50 + 显式 reject（不静默丢弃）
 *   - 入口节流（队列 > 20 时拒绝本周期）
 *   - Buffer 溢出保护（> 65536 字节丢弃）
 *   - 请求级兜底定时器（_reqTimer，不受 socket.setTimeout 重置影响）
 *   - 帧格式白名单（仅 3E/4E）
 *   - 传输协议白名单（仅 tcp/udp）
 *   - 连接空闲 10 分钟自动回收
 *   - _closed 全路径守卫（7 个中止点）
 *
 * 【测试覆盖】
 *   test/mitsubishi-read_spec.js (253 行): TCP/UDP 端到端, 模拟/超时/丢包
 *   test/stress_10k_spec.js (75 行): 10000 点连续采集, 内存验证
 */

module.exports = function (RED) {
  var net = require('net');
  var mc = require('./mc-protocol');
  var mcUdp = require('./mc-udp');

  // =========================================================================
  // 第 1 章：连接池 — 模块级全局状态
  // =========================================================================

  /**
   * 全局读连接池
   * key = "host:port:frame:networkNo:stationNo:protocol"（由 poolKey() 生成）
   *
   * 每个 entry 结构：
   *   socket:      net.Socket 实例（null 表示尚未建立）
   *   inUse:       当前是否有请求在使用此连接
   *   connecting:  是否正在建立连接（防止并发建连）
   *   lastUsed:    最后使用时间戳（空闲回收用）
   *   queue:       等待队列 [{callback, timeout, enqueueTime}]
   *   users:       引用计数 {nodeId: true}（close 时判断是否可销毁）
   *   backoffMs:   当前退避毫秒数（指数增长）
   *   lastErrorTime: 上次连接失败时间戳
   *   _destroyed:  防止重复销毁标志
   */
  var CONN_POOL = {};
  var IN_FLIGHT = {};     // per-PLC 轮次闸: poolKey → node.id
  var MAX_QUEUE = 50;     // 单连接最大排队请求数
  var MAX_BACKOFF_MS = 10000;  // 最大退避时间
  var _activeNodeCount = 0;
  var _cleanTimer = null;

  /**
   * 空闲连接清理定时器（懒初始化）
   * 每 5 分钟扫描，销毁超过 10 分钟无活动的连接。
   * unref() 确保不阻止 Node.js 进程退出。
   */
  function ensureCleanTimer() {
    if (_cleanTimer) return;
    _cleanTimer = setInterval(function () {
      var now = Date.now();
      var keys = Object.keys(CONN_POOL);
      for (var i = 0; i < keys.length; i++) {
        var entry = CONN_POOL[keys[i]];
        if (!entry || entry.inUse || entry.connecting) continue;
        if (entry.socket && (now - entry.lastUsed > 600000)) {
          // 通知所有排队者连接已超时
          var q = entry.queue || [];
          entry.queue = [];
          for (var qi = 0; qi < q.length; qi++) {
            try { q[qi].callback(new Error('Connection idle timeout')); } catch (_) {}
          }
          try { entry.socket.destroy(); } catch (_) {}
          delete CONN_POOL[keys[i]];
        }
      }
    }, 300000);
    if (_cleanTimer.unref) _cleanTimer.unref();
  }

  /**
   * 生成连接池 key
   *
   * 【重要】key 包含 frame/networkNo/stationNo/protocol 而不仅仅是 IP:port。
   * 这是因为同一台 PLC 可能：
   * - 同时使用 3E 和 4E 帧格式（不同的 MC 协议版本）
   * - 有多个站号（多 CPU 系统）
   * - 同时使用 TCP 和 UDP
   * 如果只按 IP:port 做 key，这些场景会错误地共享连接。
   */
  function poolKey(plc) {
    return plc.host + ':' + plc.port + ':' + plc.frame + ':' + plc.networkNo + ':' + plc.stationNo + ':' + (plc.protocol || 'tcp');
  }

  /**
   * 获取或创建连接 — 整个读节点的核心调度函数
   *
   * 【调用时机】
   *   每次 inject/trigger 触发读取时调用。
   *
   * 【状态机】
   *   1. 退避期 → 立即拒绝（避免重连风暴）
   *   2. 空闲连接可用 → 复用
   *   3. 连接正忙/建立中 → 排队
   *   4. 无连接 → 新建 TCP socket
   *
   * 【指数退避算法】
   *   backoffMs = max(base, min(prevBackoff * 2, MAX_BACKOFF_MS))
   *   其中 base = retryInterval（默认 300ms），MAX_BACKOFF_MS = 10000
   *   序列：300 → 600 → 1200 → 2400 → 4800 → 9600 → 10000 → 10000...
   *   连接成功后 backoffMs 归零。
   *
   * @param {Object} node - Node-RED 节点实例
   * @param {Object} plc - PLC 连接参数
   * @param {Function} callback - callback(err, socket)
   */
  function getConnection(node, plc, callback) {
    var key = poolKey(plc);
    var entry = CONN_POOL[key];

    // ---- 退避期：快速拒绝 ----
    if (entry && entry.backoffMs && entry.lastErrorTime) {
      var sinceErr = Date.now() - entry.lastErrorTime;
      if (sinceErr < entry.backoffMs) {
        callback(new Error('connect backoff (' + (entry.backoffMs - sinceErr) + 'ms)'));
        return;
      }
    }

    // ---- 复用空闲连接 ----
    if (entry && entry.socket && !entry.socket.destroyed && !entry.inUse && !entry.connecting) {
      entry.inUse = true;
      entry.lastUsed = Date.now();
      entry.users = entry.users || {};
      entry.users[node.id] = true;
      entry.socket.setTimeout(plc.timeout);
      callback(null, entry.socket);
      return;
    }

    // ---- 排队：连接正忙或正在建立 ----
    if (entry && (entry.inUse || entry.connecting)) {
      entry.queue = entry.queue || [];
      if (entry.queue.length >= MAX_QUEUE) {
        callback(new Error('Queue full (' + MAX_QUEUE + ') — PLC too slow'));
        return;
      }
      entry.queue.push({ callback: callback, timeout: plc.timeout, enqueueTime: Date.now() });
      return;
    }

    // ---- 新建 TCP 连接 ----
    if (!entry) {
      entry = CONN_POOL[key] = {
        socket: null, inUse: false, lastUsed: 0, queue: [],
        connecting: true, backoffMs: 0, lastErrorTime: 0
      };
    } else {
      entry.connecting = true;
    }

    var client = new net.Socket();
    client.setTimeout(plc.timeout);
    client.setKeepAlive(true, 30000);  // TCP KeepAlive 30 秒

    var connectTimer = setTimeout(function () {
      client.destroy();
      onConnectError(new Error('connect timeout'));
    }, plc.timeout);

    function onConnectError(e) {
      clearTimeout(connectTimer);
      try { client.destroy(); } catch (_) {}
      entry.connecting = false;
      entry.socket = null;
      entry.inUse = false;
      entry.lastErrorTime = Date.now();
      // 指数退避：翻倍到 10 秒上限
      var base = plc.retryInterval || 300;
      entry.backoffMs = Math.max(base, Math.min((entry.backoffMs || base) * 2, MAX_BACKOFF_MS));
      // 通知所有排队者
      var q = entry.queue || [];
      entry.queue = [];
      for (var qi = 0; qi < q.length; qi++) {
        try { q[qi].callback(e); } catch (_) {}
      }
      callback(e);
    }

    client.once('error', onConnectError);

    client.connect(plc.port, plc.host, function () {
      clearTimeout(connectTimer);
      client.removeListener('error', onConnectError);  // 建连成功，移除建连期的 error handler

      entry.socket = client;
      entry.inUse = true;
      entry.connecting = false;
      entry.lastUsed = Date.now();
      entry.backoffMs = 0;       // 连接成功 → 退避归零
      entry.lastErrorTime = 0;
      entry.users = entry.users || {};
      entry.users[node.id] = true;

      // 空闲期断连监听：PLC/交换机干净关闭时立即清理
      client.once('end', function () { destroyConnection(key); });
      client.once('close', function () { destroyConnection(key); });
      // 空闲期错误：仅清理连接池结构（当前请求的 error handler 由上层独立注册）
      client.once('error', function () { destroyConnection(key); });

      callback(null, client);
    });
  }

  /**
   * 归还连接（释放 inUse 锁 + 唤醒排队者）
   *
   * 【排队唤醒策略】
   *   - 跳过超时的排队者（Queue timeout）
   *   - socket 已被销毁 → 通知 Connection lost
   *   - 正常 → 唤醒
   *   - 队列为空 → 仅设置 inUse = false（连接回归空闲池）
   */
  function releaseConnection(key) {
    var entry = CONN_POOL[key];
    if (!entry) return;
    if (entry.queue && entry.queue.length > 0) {
      var now = Date.now();
      while (entry.queue.length > 0) {
        var next = entry.queue.shift();
        // 排队超时检查
        if (now - next.enqueueTime > next.timeout) {
          try { next.callback(new Error('Queue timeout')); } catch (_) {}
          continue;
        }
        entry.lastUsed = Date.now();
        if (entry.socket && !entry.socket.destroyed) {
          entry.inUse = true;
          entry.socket.setTimeout(next.timeout);
          try { next.callback(null, entry.socket); } catch (_) {}
          return;
        }
        try { next.callback(new Error('Connection lost')); } catch (_) {}
      }
    }
    entry.inUse = false;
    entry.lastUsed = Date.now();
  }

  /**
   * 强制销毁连接
   * 通知所有排队者、销毁 socket、从池中删除。
   * _destroyed 标志防止重复销毁（end/close/error 可能先后触发）。
   */
  function destroyConnection(key) {
    var entry = CONN_POOL[key];
    if (!entry || entry._destroyed) return;
    entry._destroyed = true;
    if (entry.socket && !entry.socket.destroyed) {
      try { entry.socket.destroy(); } catch (_) {}
    }
    var q = entry.queue || [];
    entry.queue = [];
    delete CONN_POOL[key];
    for (var qi = 0; qi < q.length; qi++) {
      try { q[qi].callback(new Error('Connection destroyed')); } catch (_) {}
    }
  }

  // =========================================================================
  // 第 2 章：主节点定义 — MitsubishiReadNode
  // =========================================================================

  function MitsubishiReadNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    _activeNodeCount++;
    ensureCleanTimer();

    // ---- 关联配置节点 ----
    node.plcConfig = RED.nodes.getNode(config.plc);
    if (!node.plcConfig) {
      _activeNodeCount--;
      if (_activeNodeCount <= 0 && _cleanTimer) {
        clearInterval(_cleanTimer);
        _cleanTimer = null;
      }
      node.error('未关联 PLC 配置节点');
      return;
    }

    // ---- 节点级状态 ----
    node.serialNo = parseInt(config.serialNo, 10) || 0;
    node.configDeviceId = String(config.deviceId || '');
    node._usedConns = {};       // 本节点使用过的连接 key 集合（close 时清理）
    node._inFlightKeys = {};    // 本节点持有的轮次闸 key（close 时释放）
    node._closed = false;       // 关闭守卫：置 true 后所有异步回调直接 return

    // 解析静态标签配置（隐藏字段 node-input-tags 中的 JSON）
    var configTags = [];
    try { configTags = JSON.parse(config.tags || '[]'); } catch (e) { configTags = []; }

    // ---- input 事件：每次 inject/trigger 触发执行 ----
    node.on('input', function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };

      // ---- 解析 PLC 连接参数（支持 msg 动态覆盖）----
      var cfg = node.plcConfig;
      var incoming = msg.payload || {};
      var pp = incoming.protocolParams || {};
      var plc = {
        name: cfg.name,
        host: incoming.plcIp || cfg.host,
        port: incoming.plcPort || cfg.port,
        frame: String(pp.mcFrame || cfg.frame || '3E').toUpperCase(),
        series: pp.plcSeries || cfg.series || 'Q',
        protocol: String(pp.protocol || cfg.protocol || 'tcp').toLowerCase(),
        ascii: !!(pp.ascii !== undefined ? pp.ascii : cfg.ascii),
        networkNo: pp.networkNo || cfg.networkNo || 0,
        stationNo: pp.stationNo || cfg.stationNo || 0,
        timeout: mc.clampInt(incoming.timeout || cfg.timeout, 3000, 500, 30000),
        maxRetries: mc.clampInt(incoming.maxRetries || cfg.maxRetries, 2, 0, 10),
        retryInterval: mc.clampInt(incoming.retryInterval || cfg.retryInterval, 300, 50, 10000)
      };

      // ---- 白名单校验 ----
      if (plc.protocol !== 'tcp' && plc.protocol !== 'udp') {
        msg.payload = { success: false, /* ... */ error: '不支持的传输协议: ' + plc.protocol };
        node.error('[MC] 不支持的传输协议: ' + plc.protocol, msg);
        node.send(msg); if (done) done(); return;
      }
      if (plc.frame !== '3E' && plc.frame !== '4E') {
        msg.payload = { success: false, /* ... */ error: '不支持的 MC 帧格式: ' + plc.frame };
        node.error('[MC] 不支持的 MC 帧格式: ' + plc.frame + '（仅支持 3E/4E）', msg);
        node.send(msg); if (done) done(); return;
      }

      // ---- Device ID 解析（用于设备追踪）----
      function resolveDeviceId(incoming, plc) {
        if (node.configDeviceId && node.configDeviceId !== '') {
          var n = parseInt(node.configDeviceId, 10);
          if (!isNaN(n) && n > 0) return n;
        }
        var id = incoming.id || incoming.deviceId;
        if (id !== undefined && id !== null && id !== '') {
          var m = parseInt(id, 10);
          if (!isNaN(m) && m > 0) return m;
        }
        // 兜底：基于设备名的确定性哈希（9000-9999）
        var name = incoming.deviceName || plc.name || node.configDeviceId || (plc.host + ':' + plc.port);
        var hash = 0;
        for (var i = 0; i < name.length; i++) {
          hash = ((hash << 5) - hash) + name.charCodeAt(i);
          hash |= 0;
        }
        return ((hash >>> 0) % 9000) + 1000;
      }
      var deviceId = resolveDeviceId(incoming, plc);
      var deviceName = incoming.deviceName || plc.name || ('PLC-' + deviceId);

      /**
       * 安全发送（防止重复发送 + 自动清理轮次闸）
       *
       * Node-RED 的异步流程可能导致 send 被多次调用。
       * _sent 标志保证只发送一次（第一条消息）。
       * 同时自动清理 IN_FLIGHT 轮次闸。
       */
      var _sent = false;
      function safeSend(m) {
        if (_sent) return;
        _sent = true;
        if (typeof connKey !== 'undefined' && connKey && IN_FLIGHT[connKey] === node.id) {
          delete IN_FLIGHT[connKey];
        }
        try { send(m); } catch (_) {}
        if (done) { try { done(); } catch (_) {} }
      }

      // ---- 标签解析：msg.tags → 静态配置 → 校验 ----
      var rawTags = msg.tags || incoming.tags;
      if (!rawTags || (Array.isArray(rawTags) && rawTags.length === 0)) {
        rawTags = configTags;  // 回退到静态配置
      }
      if (!Array.isArray(rawTags)) rawTags = [rawTags];
      var tags = rawTags;

      /**
       * 标签校验与标准化
       * 每个 raw tag 经过以下处理：
       * 1. regType 校验（未知类型用 D 兜底 + warn）
       * 2. dataType 别名映射（FLOAT→FLOAT32, BIT→BOOL）
       * 3. 地址解析（parseDeviceAddress）— 含进制处理和范围校验
       * 4. bitOffset 钳制（0-15，越界 warn）
       * 5. slope/offset 透传（slope=0 合法，不在入口吞掉）
       */
      var validTags = [];
      for (var i = 0; i < tags.length; i++) {
        var t = tags[i];
        var rt = t.regType || 'D';
        if (!mc.MC_DEVICE_CODES[rt]) {
          if (rt) node.warn('[MC] Unknown regType: ' + rt + ', using D');
          rt = 'D';
        }
        var DT_MAP = { 'FLOAT': 'FLOAT32', 'BIT': 'BOOL' };
        var dt = DT_MAP[t.dataType] || t.dataType || 'INT16';
        var rawAddr = (t.addr !== undefined) ? t.addr : (t.regAddr || t.tag_address || t.registerAddress || '');
        var addr = mc.parseDeviceAddress(rt, rawAddr, plc.series);
        if (addr < 0) {
          node.warn('[MC] Invalid addr for tag ' + (t.id || t.name || ('#' + i)));
          continue;
        }
        var displayAddr = mc.formatDeviceAddress(rt, addr, plc.series).slice(rt.length);
        var tagId = t.id || t.name || (rt + displayAddr);
        validTags.push({
          id: String(tagId),
          regType: rt,
          addr: addr,
          displayAddr: displayAddr,
          dataType: dt,
          byteOrder: t.byteOrder || null,
          wordOrder: t.wordOrder || null,
          bitOffset: (function () {
            if (t.bitOffset === undefined || t.bitOffset === null) return null;
            var bo = parseInt(t.bitOffset, 10);
            if (isNaN(bo) || bo < 0 || bo > 15) {
              node.warn('[MC] Invalid bitOffset ' + t.bitOffset + ' for tag ' + (t.id || t.name || ('#' + i)) + ', using 0');
              return 0;
            }
            return bo;
          })(),
          // slope/offset 原样透传（0 和 null 语义不同，在 applyTransform 内统一处理）
          slope: (t.slope !== undefined && t.slope !== null) ? t.slope : (t.transformSlopeA !== undefined ? t.transformSlopeA : null),
          offset: (t.offset !== undefined && t.offset !== null) ? t.offset : (t.transformOffsetB !== undefined ? t.transformOffsetB : null),
          operator: t.operator || '',
          referenceTag: t.referenceTag || '',
          name: t.name || (rt + displayAddr)
        });
      }

      if (validTags.length === 0) {
        node.status({ fill: 'grey', shape: 'dot', text: '0 valid tags' });
        msg.payload = { success: false, /* ... */ error: 'No valid tags (all addresses invalid)' };
        node.error('[MC] No valid tags (all addresses invalid)', msg);
        safeSend(msg); return;
      }

      var timeout = plc.timeout;
      var maxRetries = plc.maxRetries;
      var retryInterval = plc.retryInterval;
      var frameType = plc.frame;
      var stationNo = plc.stationNo;
      var networkNo = plc.networkNo;
      var roundStart = Date.now();

      // ---- 模拟模式 ----
      var SIM_MODE = false;
      try { SIM_MODE = RED.settings.mcSimulationMode || false; } catch (e) {}
      if (SIM_MODE) {
        var simOut = {};
        validTags.forEach(function (t) {
          var raw = mc.BIT_DEVICES[t.regType] ? (Math.random() > 0.5 ? 1 : 0) : Math.floor(Math.random() * 1000);
          simOut[t.id] = { rawValue: raw, engValue: mc.applyTransform(raw, t), quality: 0, ts: new Date().toISOString(), regType: t.regType };
        });
        msg.payload = { success: true, data: simOut, /* ... */ };
        node.status({ fill: 'green', shape: 'dot', text: 'SIM ' + validTags.length + ' tags' });
        safeSend(msg); return;
      }

      // ---- 标签去重（同一地址只保留一个，计算标签始终保留）----
      var seen = {};
      var deduped = [];
      for (var di = validTags.length - 1; di >= 0; di--) {
        var dtag = validTags[di];
        if (dtag.operator) { deduped.unshift(dtag); }  // 计算标签可能引用同一地址多次
        else {
          var dk = dtag.regType + '|' + dtag.addr;
          if (!seen[dk]) { seen[dk] = true; deduped.unshift(dtag); }
        }
      }
      if (deduped.length < validTags.length) {
        node.warn('[MC] Deduped ' + (validTags.length - deduped.length) + ' duplicate tags');
      }
      validTags = deduped;

      // ---- 自动分组（960 字 span 感知聚类）----
      var groups = mc.groupTags(validTags);
      if (groups.length === 0) { /* ... error ... */ safeSend(msg); return; }

      /**
       * 入口节流：队列 > 20 时拒绝本周期
       * 避免在 PLC 已经过载时继续堆积请求（雪崩效应）。
       * 下一个 inject 周期会自动重试。
       */
      var connKey = poolKey(plc);
      var poolEntry = CONN_POOL[connKey];
      if (poolEntry && poolEntry.inUse && poolEntry.queue && poolEntry.queue.length > 20) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'throttled' });
        msg.payload = { success: false, error: 'Throttled: queue > 20' };
        node.error('[MC] Throttled: queue > 20', msg);
        safeSend(msg); return;
      }

      var allRaw = {};       // tagId → { rawValue, convertedValue, quality, ts }
      var hasFailed = false;
      var firstError = '';
      var currentSN = node.serialNo;  // 4E 帧序列号

      // ---- 轮次闸：同一 PLC 同时只允许一轮扫描 ----
      if (IN_FLIGHT[connKey]) {
        msg.payload = { success: false, error: 'Round in progress (previous scan not finished)' };
        node.error('[MC] Round in progress', msg);
        safeSend(msg); return;
      }
      IN_FLIGHT[connKey] = node.id;
      node._inFlightKeys[connKey] = true;
      node._usedConns[connKey] = true;

      /**
       * 组装最终输出消息（assembleAndSend）
       *
       * TCP 和 UDP 两条路径最终都调用此函数。
       * 将所有 allRaw 中的解码结果 + tag 定义组装为 msg.payload。
       *
       * 【输出结构】
       *   msg.payload.data[tagId] = {
       *     rawValue:  解码后的完整值（FLOAT32=组装后的 float, INT32=组装后的 int32）
       *     rawWord:   原始首字值（监查用，保留在 rawWord 而非 rawValue）
       *     engValue:  applyTransform(rawValue) 工程值
       *     quality:   0=GOOD, 2=BAD/缺失
       *     ts:        采集时间戳
       *     regType:   软元件类型
       *   }
       *
       * 【计算标签处理】
       *   遍历所有 operator 标签，取出本标签和引用标签的 rawValue，
       *   执行 add/sub/mul/div，用 roundEng 去浮点尾巴。
       */
      function assembleAndSend() {
        var output = {};
        var roundTs = new Date().toISOString();
        validTags.forEach(function (t) {
          var entry = allRaw[t.id];
          if (entry) {
            output[t.id] = {
              rawValue: entry.convertedValue,   // ★ v1.4.4: 必须用解码后的值（而非首字 rawWord）
              rawWord: entry.rawValue,           // 原始首字保留备查
              engValue: mc.applyTransform(entry.convertedValue, t),
              quality: entry.quality,
              ts: entry.ts,
              regType: t.regType
            };
          } else {
            // 采集失败的点位：补齐 BAD 条目
            output[t.id] = { rawValue: null, rawWord: null, engValue: null, quality: 2, ts: roundTs, regType: t.regType };
          }
        });

        // ---- 计算标签（operator: add/sub/mul/div）----
        validTags.forEach(function (t) {
          if (!t.operator || !t.referenceTag) return;
          var thisEntry = output[t.id];
          var refEntry = output[t.referenceTag];
          if (!thisEntry || !refEntry) { node.warn('[MC] Calc tag missing reference'); return; }
          var a = thisEntry.rawValue, b = refEntry.rawValue;
          if (a == null || b == null) return;
          var result = null;
          switch (t.operator) {
            case 'add': result = a + b; break;
            case 'sub': result = a - b; break;
            case 'mul': result = a * b; break;
            case 'div': result = b !== 0 ? a / b : null; break;  // 除零保护
          }
          if (result != null) {
            thisEntry.rawValue = mc.roundEng(result);
            thisEntry.engValue = mc.applyTransform(result, t);
          }
        });

        msg.payload = {
          success: !hasFailed,
          deviceId: deviceId,
          deviceName: deviceName,
          data: output,
          error: hasFailed ? firstError : null,
          driverType: 'driver-mc-protocol',
          plcIp: plc.host, plcPort: plc.port,
          roundTimeMs: Date.now() - roundStart
        };
        node.status({
          fill: hasFailed ? 'red' : 'green', shape: 'dot',
          text: (plc.name || plc.host) + ' ' + Object.keys(output).length + ' vals ' + (Date.now() - roundStart) + 'ms'
        });
        safeSend(msg);
      }

      // =====================================================================
      // UDP 传输路径
      // =====================================================================
      if (plc.protocol === 'udp') {
        mcUdp.acquire(node, connKey, plc.timeout, function (aerr, udpEntry) {
          if (aerr) { /* ... error handling ... */ safeSend(msg); return; }

          function processGroupUdp(gi) {
            if (node._closed) { mcUdp.release(connKey); return; }
            if (gi >= groups.length) { mcUdp.release(connKey); assembleAndSend(); return; }
            var grp = groups[gi];
            // 计算读取范围（含 32/64 位类型的扩展）
            var addrs = grp.tags.map(function (t) { return t.addr; });
            var startA = addrs[0];
            var isBit = mc.BIT_DEVICES[grp.regType] || false;
            if (isBit) startA = startA - (startA % 16);
            var maxAddr = addrs[addrs.length - 1];
            var lastTag = grp.tags[grp.tags.length - 1];
            if (!isBit) maxAddr += mc.wordSpanOf(lastTag.dataType) - 1;
            var wordCount = isBit ? Math.ceil((maxAddr - startA + 1) / 16) : (maxAddr - startA + 1);

            function attemptUdp(attempt) {
              if (node._closed) { mcUdp.release(connKey); return; }
              if (attempt > maxRetries) { hasFailed = true; /* ... */ processGroupUdp(gi + 1); return; }
              var sentSN = (frameType === '4E') ? currentSN : 0;
              if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;
              var frame;
              try {
                frame = (frameType === '4E')
                  ? mc.build4EFrame(startA, wordCount, stationNo, grp.regType, networkNo, sentSN)
                  : mc.build3EFrame(startA, wordCount, stationNo, grp.regType, networkNo);
              } catch (e) { /* ... */ processGroupUdp(gi + 1); return; }
              mcUdp.request(connKey, frame, plc.port, plc.host, timeout, function (rerr, buf) {
                if (node._closed) { mcUdp.release(connKey); return; }
                if (rerr || !buf) { setTimeout(function () { attemptUdp(attempt + 1); }, retryInterval); return; }
                var raw = mc.parseMCResponse(buf, startA, grp.regType, frameType, sentSN);
                if (raw && raw.mcError) { hasFailed = true; /* ... */ processGroupUdp(gi + 1); return; }
                if (raw && !raw.err) {
                  var groupTs = new Date().toISOString();
                  grp.tags.forEach(function (t) {
                    var decoded = mc.decodeTag(raw, grp.regType, t.addr, t.dataType, t.byteOrder, t.wordOrder, t.bitOffset);
                    allRaw[t.id] = { rawValue: decoded.rawWord, convertedValue: decoded.value, quality: decoded.quality, ts: groupTs };
                  });
                  setTimeout(function () { processGroupUdp(gi + 1); }, 0);
                } else { setTimeout(function () { attemptUdp(attempt + 1); }, retryInterval); }
              });
            }
            attemptUdp(0);
          }
          processGroupUdp(0);
        });
        return;
      }

      // =====================================================================
      // TCP 传输路径（主路径）
      // =====================================================================
      getConnection(node, plc, function (err, mcSocket) {
        if (err) { /* ... error handling ... */ safeSend(msg); return; }

        /**
         * 递归处理分组 — 整个读取流程的核心循环
         *
         * processGroup(0) → attemptGroup(0) → 发送帧 → 等待响应
         *   → 成功 → processGroup(1) → ... → processGroup(n) → assembleAndSend
         *   → 失败 → attemptGroup(1) → ... → attemptGroup(maxRetries) → 标记失败 → processGroup(gi+1)
         *
         * 关键：只有在 node._closed === false 时才继续递归。
         * 如果 redeploy 发生在循环中间，_closed 会在各中止点被检查。
         */
        function processGroup(gi) {
          if (node._closed) { releaseConnection(connKey); return; }
          if (gi >= groups.length) { releaseConnection(connKey); assembleAndSend(); return; }

          var grp = groups[gi];
          var addrs = grp.tags.map(function (t) { return t.addr; });
          var startA = addrs[0];
          var isBit = mc.BIT_DEVICES[grp.regType] || false;
          if (isBit) startA = startA - (startA % 16);

          var maxAddr = addrs[addrs.length - 1];
          var lastTag = grp.tags[grp.tags.length - 1];
          if (!isBit) { maxAddr += mc.wordSpanOf(lastTag.dataType) - 1; }

          var wordCount = isBit ? Math.ceil((maxAddr - startA + 1) / 16) : (maxAddr - startA + 1);
          var MAX_WORDS = 960;

          // ---- 兜底拆分（groupTags 可能因 32/64 位 span 扩展而超限）----
          if (wordCount > MAX_WORDS) {
            var newGroups = [];
            var ss = 0;
            while (ss < grp.tags.length) {
              var se = ss;
              while (se + 1 < grp.tags.length) {
                var nextAddr = grp.tags[se + 1].addr + (mc.wordSpanOf(grp.tags[se + 1].dataType) - 1);
                if (nextAddr - grp.tags[ss].addr >= MAX_WORDS) break;
                se++;
              }
              newGroups.push({ regType: grp.regType, tags: grp.tags.slice(ss, se + 1) });
              ss = se + 1;
            }
            groups.splice.apply(groups, [gi, 1].concat(newGroups));
            setTimeout(function () { processGroup(gi); }, 0);
            return;
          }

          /**
           * 尝试发送当前组（含重试逻辑）
           *
           * 【TCP 分帧策略】
           *   TCP 是流式协议，不能假设一个 data 事件 = 一帧。
           *   本实现采用"缓冲累积 + 头长度分帧"模式：
           *   1. 收到 chunk → buf = concat(buf, chunk)
           *   2. 检查 buf.length ≥ headerLen → 读取 dataLen 字段
           *   3. 检查 buf.length ≥ headerLen + dataLen → 帧完整 → 解析
           *   4. 否则继续等待更多 data 事件
           *
           * 【请求级兜底定时器 (_reqTimer)】
           *   socket.setTimeout 是空闲超时：每收到一个 data chunk 会重置。
           *   如果 PLC 以极慢速度逐字节发送（slow-drip），超时永远不会触发。
           *   _reqTimer 从 write 完成时刻开始倒计时，不受 data 事件影响。
           *   这保证了"最多等 timeout 毫秒，然后强制超时"。
           */
          function attemptGroup(attempt) {
            if (node._closed) { releaseConnection(connKey); return; }
            // socket 意外断开 → 销毁 + 重连 → 继续
            if (mcSocket.destroyed) { /* ... reconnect logic ... */ return; }
            if (attempt > maxRetries) { hasFailed = true; processGroup(gi + 1); return; }

            var sentSN = (frameType === '4E') ? currentSN : 0;
            if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;

            var buf = Buffer.alloc(0);
            var asciiBuf = Buffer.alloc(0);
            var resolved = false;
            var _tmoHandler = null, _errHandler = null, _dataHandler = null;
            var _reqTimer = null;

            function cleanupListeners(sock) {
              if (!sock) return;
              sock.removeListener('data', _dataHandler);
              sock.removeListener('timeout', _tmoHandler);
              sock.removeListener('error', _errHandler);
              if (_reqTimer) { clearTimeout(_reqTimer); _reqTimer = null; }
            }

            mcSocket.setTimeout(timeout);

            // ---- 构建并发送帧 ----
            try {
              var frame = (frameType === '4E')
                ? mc.build4EFrame(startA, wordCount, stationNo, grp.regType, networkNo, sentSN)
                : mc.build3EFrame(startA, wordCount, stationNo, grp.regType, networkNo);
              var wireFrame = plc.ascii ? mc.asciify(frame) : frame;
              mcSocket.write(wireFrame);
            } catch (e) { /* ... write error → reconnect ... */ return; }

            // ---- data 事件处理（TCP 分帧）----
            _dataHandler = function (sock) {
              return function (chunk) {
                try {
                  // ASCII 模式：累加 → deasciify → 提取二进制帧 → 按二进制流程处理
                  if (plc.ascii) {
                    asciiBuf = Buffer.concat([asciiBuf, chunk]);
                    while (true) {
                      var d = mc.deasciify(asciiBuf); asciiBuf = asciiBuf.slice(d.consumed);
                      if (d.err) { node.warn('[MC] ASCII decode: ' + d.err); continue; }
                      if (!d.result) return;
                      resolved = true; cleanupListeners(sock);
                      var asciiRaw = mc.parseMCResponse(d.result, startA, grp.regType, frameType, sentSN);
                      if (asciiRaw && asciiRaw.mcError) { hasFailed = true; processGroup(gi + 1); }
                      else if (asciiRaw && !asciiRaw.err) {
                        var groupTs = new Date().toISOString();
                        grp.tags.forEach(function (t) {
                          var decoded = mc.decodeTag(asciiRaw, grp.regType, t.addr, t.dataType, t.byteOrder, t.wordOrder, t.bitOffset);
                          allRaw[t.id] = { rawValue: decoded.rawWord, convertedValue: decoded.value, quality: decoded.quality, ts: groupTs };
                        });
                        setTimeout(function () { processGroup(gi + 1); }, 0);
                      } else { setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval); }
                      return;
                    }
                  }
                  // Buffer 溢出保护：> 65536 字节视为畸形数据
                  if (buf.length + chunk.length > 65536) { /* ... discard + retry ... */ return; }
                  buf = Buffer.concat([buf, chunk]);
                  // 读取帧头，提取数据长度
                  var hdrLen = (frameType === '4E') ? 15 : 11;
                  if (!resolved && buf.length >= hdrLen) {
                    var dataLen = buf.readUInt16LE((frameType === '4E') ? 11 : 7) - 2;
                    if (dataLen < 0 || dataLen > 2000) { /* ... invalid, retry ... */ return; }
                    if (buf.length >= hdrLen + dataLen) {
                      resolved = true; cleanupListeners(sock);
                      var raw = mc.parseMCResponse(buf, startA, grp.regType, frameType, sentSN);
                      if (raw && raw.mcError) { hasFailed = true; processGroup(gi + 1); }
                      else if (raw && !raw.err) {
                        var groupTs = new Date().toISOString();
                        grp.tags.forEach(function (t) {
                          var decoded = mc.decodeTag(raw, grp.regType, t.addr, t.dataType, t.byteOrder, t.wordOrder, t.bitOffset);
                          allRaw[t.id] = { rawValue: decoded.rawWord, convertedValue: decoded.value, quality: decoded.quality, ts: groupTs };
                        });
                        setTimeout(function () { processGroup(gi + 1); }, 0);
                      } else { setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval); }
                    }
                  }
                } catch (e) { /* ... cleanup + next group ... */ }
              };
            }(mcSocket);
            mcSocket.on('data', _dataHandler);

            // ---- timeout 事件处理（socket 空闲超时 + 请求级兜底定时器）----
            _tmoHandler = function (sock) {
              return function () {
                if (resolved) return;
                resolved = true; cleanupListeners(sock);
                destroyConnection(connKey);
                getConnection(node, plc, function (e4, newSock3) {
                  if (node._closed) { releaseConnection(connKey); return; }
                  if (e4) { releaseConnection(connKey); finishWithError(); return; }
                  mcSocket = newSock3;
                  setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                });
              };
            }(mcSocket);
            mcSocket.once('timeout', _tmoHandler);

            // ---- error 事件处理（TCP RST/网络不可达等）----
            _errHandler = function (sock) {
              return function () {
                if (resolved) return;
                resolved = true; cleanupListeners(sock);
                destroyConnection(connKey);
                getConnection(node, plc, function (e5, newSock4) {
                  if (node._closed) { releaseConnection(connKey); return; }
                  if (e5) { releaseConnection(connKey); finishWithError(); return; }
                  mcSocket = newSock4;
                  setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                });
              };
            }(mcSocket);
            mcSocket.once('error', _errHandler);

            // 请求级兜底定时器（不受 socket.setTimeout 重置影响）
            _reqTimer = setTimeout(function () {
              if (resolved) return;
              node.warn('[MC] request-level timeout (slow-drip response or stuck peer)');
              _tmoHandler();
            }, timeout);
          }
          attemptGroup(0);
        }

        function finishWithError() { /* ... conn lost → error msg ... */ }
        processGroup(0);
      });
    });

    // =====================================================================
    // 第 3 章：close 生命周期 — 资源清理
    // =====================================================================

    /**
     * 节点关闭时的清理流程：
     * 1. _closed = true（阻塞所有异步回调）
     * 2. 清理本节点持有的轮次闸（IN_FLIGHT）
     * 3. 释放 UDP 会话（mcUdp.releaseNode）
     * 4. 引用计数检查 → 无其他使用者则销毁连接
     * 5. 清理定时器（_cleanTimer）
     */
    node.on('close', function (done) {
      node._closed = true;
      var fk = Object.keys(node._inFlightKeys || {});
      for (var fi = 0; fi < fk.length; fi++) {
        if (IN_FLIGHT[fk[fi]] === node.id) delete IN_FLIGHT[fk[fi]];
      }
      node._inFlightKeys = {};
      try { mcUdp.releaseNode(node.id); } catch (_) {}
      _activeNodeCount--;
      if (_activeNodeCount <= 0 && _cleanTimer) { clearInterval(_cleanTimer); _cleanTimer = null; }
      var conns = node._usedConns || {};
      var keys = Object.keys(conns);
      for (var ci = 0; ci < keys.length; ci++) {
        var entry = CONN_POOL[keys[ci]];
        if (entry && entry.users) {
          delete entry.users[node.id];
          if (Object.keys(entry.users).length === 0) destroyConnection(keys[ci]);
        }
      }
      // 兜底清理：按 plcConfig 参数生成的备用 key
      try {
        var p2 = node.plcConfig;
        if (p2 && p2.host) {
          var cfgKey = poolKey({ host: p2.host, port: p2.port, frame: p2.frame || '3E', networkNo: p2.networkNo || 0, stationNo: p2.stationNo || 0 });
          var cfgEntry = CONN_POOL[cfgKey];
          if (cfgEntry && cfgEntry.users) { delete cfgEntry.users[node.id];
            if (Object.keys(cfgEntry.users).length === 0) destroyConnection(cfgKey); }
        }
      } catch (e) {}
      node._usedConns = {};
      node.status({ fill: 'grey', shape: 'dot', text: 'closed' });
      if (typeof done === 'function') done();
    });
  }

  RED.nodes.registerType('mitsubishi-read', MitsubishiReadNode);
};
