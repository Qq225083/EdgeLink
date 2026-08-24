/**
 * mitsubishi-read — 三菱 MC Protocol 3E/4E 读取节点 v1.7.3
 *
 * v1.7.3: UDP 路径支持三方言（binary/ascii_q/ascii_slmp）——UDP+ASCII 不再降级为 Binary
 * v1.7.2: 静默熔断器——连续3次零字节超时熔断60s并告警（防4E→内置网口把PLC MC连接行锁死），
 *         收到任意字节即复位；attemptGroup 熔断期直接失败不重连
 * v1.7.1: ascii_q+4E 显式拒绝（Q/L 内置网口仅支持 3E）；respFrameType 修正——
 *         ascii_q 中间帧恒为 3E 布局，parseMCResponse 不再误按 frameType=4E 偏移解析
 *
 * v1.5.1: 960 字 span 感知聚类（groupTags，万点 11 帧）、addr=0 修复、FX 八进制 8/9 拒绝、
 *         响应帧型严格校验、FLOAT32/applyTransform 去 toFixed(4) 精度截断、
 *         TCP 请求级兜底定时器（_tmoHandler 裸调用修正）、批次拆分 subMax 死变量清理
 * v1.4.4: UDP 传输（mc-udp 会话层）、4E 帧规范重排、X/Y 进制修正（FX=8 进制/余=16 进制）、
 *          32/64 位 rawValue=解码值（修复数据断线）、_closed 中止点统一释放连接、
 *          per-PLC 轮次闸、node.error(msg) 可捕获、编辑器补 byteOrder/wordOrder/bitOffset、
 *          bitOffset 钳制 0-15、slope=0 合法化、decodeTag 提取可单测
 * v1.4.0: 生产级修复 — 连接池键包含帧/网络/站号、并发建连串行化、
 *          INT32/UINT32 高低字修正、X/Y 八进制地址、4E 序列号始终携带、
 *          位元件字数上限修正、32 位范围扩展、队列超时、重连退避、
 *          done() 回调、清理定时器生命周期。
 * v1.3.0: 设备ID手动配置 + 表格分页 + 计算点位 + CSV导入导出
 * 变换: engValue = rawValue * slope + offset
 * 计算: 设置引用ID和运算符(add/sub/mul/div)即可合并多寄存器值
 * 输出: msg.payload.data[tagId] = {rawValue(解码值), rawWord(原始首字), engValue, quality, ts}
 */
module.exports = function (RED) {
  var net = require('net');
  var mc = require('./mc-protocol');
  var mcUdp = require('./mc-udp');  // 🔧 v1.4.4: UDP 传输会话层

  var DEBUG_WIRE = true;  // 🔧 v1.7.0: 线级日志（>>> 发出 / <<< 收到），现场调试用，量产可改 false

  // ===== 长连接池 v1.4.0 — 键含帧/网络/站号、并发建连串行化、队列超时、退避
  var CONN_POOL = {};  // key = "host:port:frame:network:station" → entry
  var IN_FLIGHT = {};  // 🔧 v1.4.4: per-PLC 轮次闸（poolKey → node.id），慢 PLC 时新轮次直接丢弃而非排队积压
  var MAX_QUEUE = 50;
  var MAX_BACKOFF_MS = 10000;
  var _activeNodeCount = 0;
  var _cleanTimer = null;

  function ensureCleanTimer() {
    if (_cleanTimer) return;
    _cleanTimer = setInterval(function () {
      var now = Date.now();
      var keys = Object.keys(CONN_POOL);
      for (var i = 0; i < keys.length; i++) {
        var entry = CONN_POOL[keys[i]];
        if (!entry || entry.inUse || entry.connecting) continue;
        if (entry.socket && (now - entry.lastUsed > 600000)) {
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

  function poolKey(plc) {
    // 同一 IP:端口 但帧格式/网络号/站号/传输协议不同不能复用连接（UDP 无连接，key 仅用于会话与轮次闸）
    // 🔧 v1.7.0: 键追加 commCode — 同 PLC 不同数据代码（binary/ascii_q/ascii_slmp）不得复用连接
    return plc.host + ':' + plc.port + ':' + plc.frame + ':' + plc.networkNo + ':' + plc.stationNo + ':' + (plc.protocol || 'tcp') + ':' + (plc.commCode || 'binary');
  }

  function getConnection(node, plc, callback) {
    var key = poolKey(plc);
    var entry = CONN_POOL[key];

    // 退避期：连接刚失败时避免立即重连风暴
    if (entry && entry.backoffMs && entry.lastErrorTime) {
      var sinceErr = Date.now() - entry.lastErrorTime;
      if (sinceErr < entry.backoffMs) {
        callback(new Error('connect backoff (' + (entry.backoffMs - sinceErr) + 'ms)'));
        return;
      }
    }

    // 复用空闲连接
    if (entry && entry.socket && !entry.socket.destroyed && !entry.inUse && !entry.connecting) {
      entry.inUse = true;
      entry.lastUsed = Date.now();
      entry.users = entry.users || {};
      entry.users[node.id] = true;
      entry.socket.setTimeout(plc.timeout);
      callback(null, entry.socket);
      return;
    }

    // 连接正忙或正在建立 → 排队
    if (entry && (entry.inUse || entry.connecting)) {
      entry.queue = entry.queue || [];
      if (entry.queue.length >= MAX_QUEUE) {
        callback(new Error('Queue full (' + MAX_QUEUE + ') — PLC too slow'));
        return;
      }
      entry.queue.push({ callback: callback, timeout: plc.timeout, enqueueTime: Date.now() });
      return;
    }

    // 新建连接
    if (!entry) {
      entry = CONN_POOL[key] = {
        socket: null,
        inUse: false,
        lastUsed: 0,
        queue: [],
        connecting: true,
        backoffMs: 0,
        lastErrorTime: 0
      };
    } else {
      entry.connecting = true;
    }

    var client = new net.Socket();
    client.setTimeout(plc.timeout);
    client.setKeepAlive(true, 30000);

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
      var base = plc.retryInterval || 300;
      entry.backoffMs = Math.max(base, Math.min((entry.backoffMs || base) * 2, MAX_BACKOFF_MS));
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
      client.removeListener('error', onConnectError);

      entry.socket = client;
      entry.inUse = true;
      entry.connecting = false;
      entry.lastUsed = Date.now();
      entry.backoffMs = 0;
      entry.lastErrorTime = 0;
      entry.users = entry.users || {};
      entry.users[node.id] = true;

      // 空闲断连：PLC/交换机干净关闭时立即清理
      // 🔧 修复#1：闭包校验 socket 身份——旧 socket 迟到的 close/end/error 不误杀池中新条目
      function destroyIfCurrent() {
        var e = CONN_POOL[key];
        if (e && e.socket === client) destroyConnection(key);
      }
      client.once('end', destroyIfCurrent);
      client.once('close', destroyIfCurrent);
      // 空闲错误：仅清理连接池，不调用请求 callback（由当前请求的 once('error') 处理）
      client.once('error', destroyIfCurrent);

      callback(null, client);
    });
  }

  function releaseConnection(key) {
    var entry = CONN_POOL[key];
    if (!entry) return;
    if (entry.queue && entry.queue.length > 0) {
      var now = Date.now();
      while (entry.queue.length > 0) {
        var next = entry.queue.shift();
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

  // ===== 🔧 v1.7.2: 静默熔断器 =====
  // 场景：帧类型/通信代码与 PLC 不匹配时（典型：4E 帧发到 Q/L 内置以太网口），PLC 零字节无响应。
  // 此时 KeepAlive 探测仍被操作系统正常应答，PLC 侧认为连接健康 → MC 连接行被无限期占用（只能断电或
  // GX Works2 以太网诊断→各连接状态→强制无效化 释放）。熔断器在连续零字节超时时切断重连风暴并大声告警。
  var SILENT_TRACKER = {};  // poolKey -> { count, until }
  var SILENT_LIMIT = 3;         // 连续零字节超时次数阈值
  var SILENT_COOLDOWN = 60000;  // 熔断时长 ms

  function noteSilentTimeout(key, node, plc) {
    var t = SILENT_TRACKER[key] || (SILENT_TRACKER[key] = { count: 0, until: 0 });
    t.count++;
    if (t.count >= SILENT_LIMIT && t.until < Date.now()) {
      t.until = Date.now() + SILENT_COOLDOWN;
      node.error('[MC] ' + plc.host + ':' + plc.port + ' 连续 ' + t.count +
        ' 次零字节无响应，已熔断 ' + (SILENT_COOLDOWN / 1000) + 's。' +
        '最常见原因：帧类型不匹配——Q/L 内置以太网口不支持 4E 帧，请改用 3E；' +
        '或通信代码（binary/ascii_q/ascii_slmp）与 PLC 的"通信数据代码"设置不符。' +
        '若端口已被占用：GX Works2 → 诊断 → 以太网诊断 → 各连接状态 → 强制无效化（再解除）即可释放，无需断电。');
    }
  }
  function noteCommAlive(key) {
    var t = SILENT_TRACKER[key];
    if (t) { t.count = 0; t.until = 0; }
  }
  function silentCircuitOpen(key) {
    var t = SILENT_TRACKER[key];
    return !!(t && t.until > Date.now());
  }

  // ===== 主节点 =====
  function MitsubishiReadNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    _activeNodeCount++;
    ensureCleanTimer();

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
    node.serialNo = parseInt(config.serialNo, 10) || 0;
    node.configDeviceId = String(config.deviceId || '');
    node._usedConns = {};
    node._inFlightKeys = {};  // 🔧 v1.4.4: 本节点持有的轮次闸 key（close 时清理，防跨部署泄漏）
    node._closed = false;  // 🔧 关闭守卫：close 后重连链/定时器链不再新建连接

    var configTags = [];
    try { configTags = JSON.parse(config.tags || '[]'); } catch (e) { configTags = []; }

    node.on('input', function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };

      var cfg = node.plcConfig;
      var incoming = msg.payload || {};
      var pp = incoming.protocolParams || {};
      var plc = {
        name: cfg.name,
        host: incoming.plcIp || cfg.host,
        port: incoming.plcPort || cfg.port,
        frame: String(pp.mcFrame || cfg.frame || '3E').toUpperCase(),
        series: pp.plcSeries || cfg.series || 'Q',
        protocol: String(pp.protocol || cfg.protocol || 'tcp').toLowerCase(),  // 🔧 v1.4.4: tcp|udp
        // 🔧 v1.7.0: 通信数据代码三态 — binary（默认）/ ascii_q（Q·L·E71 软元件名式，长度=字符数）/ ascii_slmp（FX5·iQ-R hex直译式）
        // 兼容旧配置：ascii=true → ascii_slmp
        commCode: (function () {
          var raw = (pp.commCode !== undefined) ? pp.commCode : cfg.commCode;
          var cc = String(raw || '').toLowerCase().replace(/[\s-]/g, '_');
          if (cc === 'ascii_q' || cc === 'ascii_slmp' || cc === 'binary') return cc;
          var legacy = (pp.ascii !== undefined) ? pp.ascii : cfg.ascii;
          return legacy ? 'ascii_slmp' : 'binary';
        })(),
        networkNo: pp.networkNo || cfg.networkNo || 0,
        stationNo: pp.stationNo || cfg.stationNo || 0,
        timeout: mc.clampInt(incoming.timeout || cfg.timeout, 3000, 500, 30000),
        maxRetries: mc.clampInt(incoming.maxRetries || cfg.maxRetries, 2, 0, 10),
        retryInterval: mc.clampInt(incoming.retryInterval || cfg.retryInterval, 300, 50, 10000)
      };
      // 🔧 传输协议白名单：仅 tcp/udp
      if (plc.protocol !== 'tcp' && plc.protocol !== 'udp') {
        msg.payload = { success: false, deviceId: incoming.id || incoming.deviceId, deviceName: incoming.deviceName, data: {}, error: '不支持的传输协议: ' + plc.protocol + '（仅支持 tcp/udp）', driverType: 'driver-mc-protocol' };
        node.error('[MC] 不支持的传输协议: ' + plc.protocol, msg);
        node.send(msg);
        if (done) done();
        return;
      }
      // 🔧 帧格式白名单：仅支持 3E/4E，1E 等未实现帧型显式报错（旧版会静默按 3E 发出错误报文）
      if (plc.frame !== '3E' && plc.frame !== '4E') {
        msg.payload = { success: false, deviceId: incoming.id || incoming.deviceId, deviceName: incoming.deviceName, data: {}, error: '不支持的 MC 帧格式: ' + plc.frame, driverType: 'driver-mc-protocol' };
        node.error('[MC] 不支持的 MC 帧格式: ' + plc.frame + '（仅支持 3E/4E）', msg);  // 🔧 v1.4.4: 带 msg，catch 节点可捕获
        node.send(msg);
        if (done) done();
        return;
      }

      // 🔧 v1.7.1: ascii_q + 4E 显式拒绝（与写入节点一致）。
      // ascii_q 是 QnA 兼容 3E 的 ASCII 格式，无 4E 变体；且 Q/L 内置以太网口本身只支持 3E 帧。
      if (plc.commCode === 'ascii_q' && plc.frame === '4E') {
        msg.payload = { success: false, deviceId: incoming.id || incoming.deviceId, deviceName: incoming.deviceName, data: {}, error: 'ascii_q 仅支持 3E 帧（Q/L 内置以太网口不支持 4E）', driverType: 'driver-mc-protocol' };
        node.error('[MC] ascii_q 仅支持 3E 帧', msg);
        node.send(msg);
        if (done) done();
        return;
      }

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

      var _sent = false;
      var ownsGate = false;  // 🔧 v1.7.4: 本轮是否已取得轮次闸——仅取得后才在 safeSend 里清闸
      function safeSend(m) {
        if (_sent) return;
        _sent = true;
        // 🔧 v1.4.4: 单出口清理轮次闸（connKey 靠 var 提升；仅当本轮真正取得闸才清，避免 "round in progress" 误删在途轮次）
        if (ownsGate && typeof connKey !== 'undefined' && connKey && IN_FLIGHT[connKey] === node.id) {
          delete IN_FLIGHT[connKey];
        }
        try { send(m); } catch (_) {}
        if (done) {
          try { done(); } catch (_) {}
        }
      }

      var rawTags = msg.tags || incoming.tags;
      if (!rawTags || (Array.isArray(rawTags) && rawTags.length === 0)) {
        rawTags = configTags;
      }
      if (!Array.isArray(rawTags)) rawTags = [rawTags];
      var tags = rawTags;

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
          // 🔧 协议参数字段透传（此前被静默忽略）
          byteOrder: t.byteOrder || null,
          wordOrder: t.wordOrder || null,
          // 🔧 v1.4.4: bitOffset 钳制 0-15（越界此前会被 JS 按 mod 32 移位静默取错位）
          bitOffset: (function () {
            if (t.bitOffset === undefined || t.bitOffset === null || String(t.bitOffset).trim() === '') return null;
            var bo = parseInt(t.bitOffset, 10);
            if (isNaN(bo) || bo < 0 || bo > 15) {
              node.warn('[MC] Invalid bitOffset ' + t.bitOffset + ' for tag ' + (t.id || t.name || ('#' + i)) + ', using 0');
              return 0;
            }
            return bo;
          })(),
          // 🔧 v1.4.4: 原样透传（slope=0 合法），兜底在 applyTransform 内统一处理
          slope: (t.slope !== undefined && t.slope !== null) ? t.slope : (t.transformSlopeA !== undefined ? t.transformSlopeA : null),
          offset: (t.offset !== undefined && t.offset !== null) ? t.offset : (t.transformOffsetB !== undefined ? t.transformOffsetB : null),
          operator: t.operator || '',
          referenceTag: t.referenceTag || '',
          name: t.name || (rt + displayAddr)
        });
      }

      if (validTags.length === 0) {
        // 🔧 不再静默 done()：发送失败消息，避免上游轮次悬空
        node.status({ fill: 'grey', shape: 'dot', text: '0 valid tags' });
        msg.payload = { success: false, deviceId: deviceId, deviceName: deviceName, data: {}, error: 'No valid tags (all addresses invalid)', driverType: 'driver-mc-protocol', plcIp: plc.host, plcPort: plc.port };
        node.error('[MC] No valid tags (all addresses invalid)', msg);  // 🔧 v1.4.4: catch 可捕获
        safeSend(msg);
        return;
      }

      var timeout = plc.timeout;
      var maxRetries = plc.maxRetries;
      var retryInterval = plc.retryInterval;
      var frameType = plc.frame;
      // 🔧 v1.7.1: ascii_q 中间帧恒为 3E 布局（extractAsciiQResponse 产物），响应解析必须按 3E 偏移，
      // 否则 frameType='4E' 时 parseMCResponse 按 4E 偏移解析会误报 Invalid subheader
      var respFrameType = (plc.commCode === 'ascii_q') ? '3E' : frameType;
      var stationNo = plc.stationNo;
      var networkNo = plc.networkNo;
      var roundStart = Date.now();

      var SIM_MODE = false;
      try { SIM_MODE = RED.settings.mcSimulationMode || false; } catch (e) {}

      if (SIM_MODE) {
        var simOut = {};
        validTags.forEach(function (t) {
          var raw = mc.BIT_DEVICES[t.regType] ? (Math.random() > 0.5 ? 1 : 0) : Math.floor(Math.random() * 1000);
          simOut[t.id] = { rawValue: raw, engValue: mc.applyTransform(raw, t), quality: 0, ts: new Date().toISOString(), regType: t.regType };
        });
        msg.payload = { success: true, deviceId: deviceId, deviceName: deviceName, data: simOut, error: null, driverType: 'driver-mc-protocol', plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart };
        node.status({ fill: 'green', shape: 'dot', text: 'SIM ' + validTags.length + ' tags' });
        safeSend(msg);
        return;
      }

      var seen = {};
      var deduped = [];
      for (var di = validTags.length - 1; di >= 0; di--) {
        var dtag = validTags[di];
        if (dtag.operator) {
          deduped.unshift(dtag);
        } else {
          // 🔧 v1.7.4: 去重键纳入 dataType/byteOrder/wordOrder/bitOffset——同 regType+addr 但解释不同（INT16 vs BOOL 位、大小端）不应被误去重
          var dk = dtag.regType + '|' + dtag.addr + '|' + dtag.dataType + '|' + (dtag.byteOrder || '') + '|' + (dtag.wordOrder || '') + '|' + (dtag.bitOffset === null || dtag.bitOffset === undefined ? '' : dtag.bitOffset);
          if (!seen[dk]) { seen[dk] = true; deduped.unshift(dtag); }
        }
      }
      if (deduped.length < validTags.length) {
        node.warn('[MC] Deduped ' + (validTags.length - deduped.length) + ' duplicate tags');
      }
      validTags = deduped;

      // 🔧 v1.4.4: 分组逻辑提取至 mc.groupTags（960 字 span 感知聚类，替代旧 cluster<50）
      var groups = mc.groupTags(validTags);

      if (groups.length === 0) {
        node.status({ fill: 'red', shape: 'ring', text: 'no groups' });
        msg.payload = { success: false, deviceId: deviceId, deviceName: deviceName, data: {}, error: 'No valid register groups', driverType: 'driver-mc-protocol', plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart };
        node.error('[MC] No valid register groups', msg);  // 🔧 v1.4.4: catch 可捕获
        safeSend(msg);
        return;
      }

      var connKey = poolKey(plc);
      var poolEntry = CONN_POOL[connKey];
      if (poolEntry && poolEntry.inUse && poolEntry.queue && poolEntry.queue.length > 20) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'throttled' });
        msg.payload = { success: false, deviceId: deviceId, deviceName: deviceName, data: {}, error: 'Throttled: queue > 20', driverType: 'driver-mc-protocol', plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart };
        node.error('[MC] Throttled: queue > 20', msg);  // 🔧 v1.4.4: catch 可捕获
        safeSend(msg);
        return;
      }

      var allRaw = {};
      var hasFailed = false;
      var firstError = '';
      var currentSN = node.serialNo;

      // 🔧 v1.4.4: per-PLC 轮次闸 — 同 PLC 上轮未结束时新轮次直接失败返回，
      // 避免慢 PLC 场景轮次在池队列中积压（排队超时的数据已过期，读了也是旧值）
      if (IN_FLIGHT[connKey]) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'round in progress' });
        msg.payload = { success: false, deviceId: deviceId, deviceName: deviceName, data: {}, error: 'Round in progress (previous scan not finished)', driverType: 'driver-mc-protocol', plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart };
        node.error('[MC] Round in progress (previous scan not finished)', msg);  // 🔧 v1.4.4: catch 可捕获
        safeSend(msg);
        return;
      }
      IN_FLIGHT[connKey] = node.id;
      node._inFlightKeys[connKey] = true;
      ownsGate = true;  // 🔧 v1.7.4: 本轮取得轮次闸，safeSend 才负责清闸

      node._usedConns[connKey] = true;

      // ===== 🔧 v1.4.4: 输出装配提取为共享函数（TCP/UDP 两路径复用）=====
      function assembleAndSend() {
        var output = {};
        var roundTs = new Date().toISOString();
        validTags.forEach(function (t) {
          var entry = allRaw[t.id];
          if (entry) {
            output[t.id] = {
              // rawValue 必须是解码后的值（32/64 位多字组装结果），
              // 下游 data-processor 只消费 rawValue；原始首字保留在 rawWord 备查
              rawValue: entry.convertedValue,
              rawWord: entry.rawValue,
              engValue: mc.applyTransform(entry.convertedValue, t),
              quality: entry.quality,
              ts: entry.ts,
              regType: t.regType
            };
          } else {
            // 采集失败/缺席的点位补齐 BAD 条目：下游可区分「没配置」和「本轮采失败」
            output[t.id] = {
              rawValue: null, rawWord: null, engValue: null,
              quality: 2, ts: roundTs, regType: t.regType
            };
          }
        });

        validTags.forEach(function (t) {
          if (!t.operator || !t.referenceTag) return;
          var thisEntry = output[t.id];
          var refEntry = output[t.referenceTag];
          if (!thisEntry || !refEntry) {
            node.warn('[MC] Calc tag ' + t.id + ' missing reference ' + t.referenceTag);
            return;
          }
          // rawValue 已是解码值，直接参与计算
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
            thisEntry.rawValue = mc.roundEng(result);  // 🔧 v1.6.0: 计算点位同步去浮点算术尾巴
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
          plcIp: plc.host,
          plcPort: plc.port,
          roundTimeMs: Date.now() - roundStart
        };
        node.status({
          fill: hasFailed ? 'red' : 'green',
          shape: 'dot',
          text: (plc.name || plc.host) + ' ' + Object.keys(output).length + ' vals ' + (Date.now() - roundStart) + 'ms'
        });
        safeSend(msg);
      }

      // ===== 🔧 v1.4.4: UDP 传输路径（SLMP 原生支持 UDP，帧格式与 TCP 完全一致）=====
      // 🔧 v1.7.3: UDP 路径支持三方言（binary / ascii_q / ascii_slmp），与 TCP 同一套组帧/解析
      if (plc.protocol === 'udp') {
        mcUdp.acquire(node, connKey, plc.timeout, function (aerr, udpEntry) {
          if (aerr) {
            msg.payload = {
              success: false, deviceId: deviceId, deviceName: deviceName, data: {},
              error: '[UDP-ACQUIRE] ' + aerr.message, driverType: 'driver-mc-protocol',
              plcIp: plc.host, plcPort: plc.port, roundTimeMs: Date.now() - roundStart
            };
            node.status({ fill: 'red', shape: 'ring', text: 'udp acquire fail' });
            node.error('[MC] [UDP-ACQUIRE] ' + aerr.message, msg);
            safeSend(msg);
            return;
          }

          function processGroupUdp(gi) {
            if (node._closed) { mcUdp.release(connKey); return; }
            if (gi >= groups.length) {
              mcUdp.release(connKey);
              assembleAndSend();
              return;
            }
            var grp = groups[gi];
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
              if (attempt > maxRetries) {
                hasFailed = true;
                if (!firstError) firstError = 'MC/UDP read failed for ' + grp.regType + startA;
                setTimeout(function () { processGroupUdp(gi + 1); }, 0);
                return;
              }
              var sentSN = (frameType === '4E') ? currentSN : 0;
              if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;
              var frame;
              try {
                if (plc.commCode === 'ascii_q') {
                  // 🔧 v1.7.3: ascii_q over UDP（3E ASCII 帧与传输层无关）
                  frame = mc.build3EAsciiQReadFrame(startA, wordCount, stationNo, grp.regType, networkNo);
                } else {
                  var binFrame = (frameType === '4E')
                    ? mc.build4EFrame(startA, wordCount, stationNo, grp.regType, networkNo, sentSN)
                    : mc.build3EFrame(startA, wordCount, stationNo, grp.regType, networkNo);
                  frame = (plc.commCode === 'ascii_slmp') ? mc.toAsciiHex(binFrame) : binFrame;
                }
              } catch (e) {
                node.warn('[MC] frame build error: ' + e.message);
                hasFailed = true;
                if (!firstError) firstError = '[FRAME] ' + e.message;
                setTimeout(function () { processGroupUdp(gi + 1); }, 0);
                return;
              }
              mcUdp.request(connKey, frame, plc.port, plc.host, timeout, function (rerr, buf) {
                if (node._closed) { mcUdp.release(connKey); return; }
                if (rerr || !buf) {
                  // 超时/ICMP/发送失败 → 重试
                  setTimeout(function () { attemptUdp(attempt + 1); }, retryInterval);
                  return;
                }
                // 🔧 v1.7.3: 三方言响应统一转二进制帧（UDP 一请求一报文，不存在半包，不完整即视为损坏）
                var binBuf = buf;
                if (plc.commCode === 'ascii_q') {
                  var ex = mc.extractAsciiQResponse(buf);
                  if (ex.err || !ex.result) {
                    node.warn('[MC] UDP ASCII-Q response invalid: ' + (ex.err || 'incomplete datagram'));
                    setTimeout(function () { attemptUdp(attempt + 1); }, retryInterval);
                    return;
                  }
                  binBuf = ex.result;
                } else if (plc.commCode === 'ascii_slmp') {
                  var _hl = (frameType === '4E') ? 15 : 11;
                  var _lo = (frameType === '4E') ? 11 : 7;
                  var df = mc.dehexifyFrame(buf, _hl, _lo);
                  if (df.err || !df.result) {
                    node.warn('[MC] UDP ASCII response invalid: ' + (df.err || 'incomplete datagram'));
                    setTimeout(function () { attemptUdp(attempt + 1); }, retryInterval);
                    return;
                  }
                  binBuf = df.result;
                }
                var raw;
                try {
                  raw = mc.parseMCResponse(binBuf, startA, grp.regType, respFrameType, sentSN);
                } catch (e) {
                  node.warn('[MC] parse error: ' + e.message);
                  setTimeout(function () { attemptUdp(attempt + 1); }, retryInterval);
                  return;
                }
                if (raw && raw.mcError) {
                  hasFailed = true;
                  if (!firstError) firstError = '[PLC 0x' + raw.mcError.toString(16).toUpperCase() + '] ' + raw.mcErrorText;
                  setTimeout(function () { processGroupUdp(gi + 1); }, 0);
                  return;
                }
                if (raw && !raw.err) {
                  var groupTs = new Date().toISOString();
                  grp.tags.forEach(function (t) {
                    var decoded = mc.decodeTag(raw, grp.regType, t.addr, t.dataType, t.byteOrder, t.wordOrder, t.bitOffset);
                    allRaw[t.id] = { rawValue: decoded.rawWord, convertedValue: decoded.value, quality: decoded.quality, ts: groupTs };
                  });
                  setTimeout(function () { processGroupUdp(gi + 1); }, 0);
                  return;
                }
                // 解析失败（残帧/串号不符）→ 重试
                setTimeout(function () { attemptUdp(attempt + 1); }, retryInterval);
              });
            }
            attemptUdp(0);
          }
          processGroupUdp(0);
        });
        return;
      }

      getConnection(node, plc, function (err, mcSocket) {
        if (err) {
          msg.payload = {
            success: false,
            deviceId: deviceId,
            deviceName: deviceName,
            data: {},
            error: '[CONNECT] ' + err.message,
            driverType: 'driver-mc-protocol',
            plcIp: plc.host, plcPort: plc.port,
            roundTimeMs: Date.now() - roundStart
          };
          node.status({ fill: 'red', shape: 'ring', text: 'connect fail' });
          node.error('[MC] [CONNECT] ' + err.message, msg);  // 🔧 v1.4.4: catch 可捕获
          safeSend(msg);
          return;
        }

        function processGroup(gi) {
          if (node._closed) { releaseConnection(connKey); return; }  // 🔧 v1.4.4: 关闭中止点统一归还连接，防池楔死
          if (gi >= groups.length) {
            releaseConnection(connKey);
            assembleAndSend();  // 🔧 v1.4.4: 输出装配共享函数（TCP/UDP 复用）
            return;
          }

          var grp = groups[gi];
          var addrs = grp.tags.map(function (t) { return t.addr; });
          var startA = addrs[0];
          var isBit = mc.BIT_DEVICES[grp.regType] || false;
          if (isBit) startA = startA - (startA % 16);

          var maxAddr = addrs[addrs.length - 1];
          var lastTag = grp.tags[grp.tags.length - 1];
          if (!isBit) {
            // 🔧 32 位类型跨 2 字、64 位类型（DOUBLE）跨 4 字，分组末地址按跨度扩展
            maxAddr += mc.wordSpanOf(lastTag.dataType) - 1;
          }

          var wordCount;
          if (isBit) {
            wordCount = Math.ceil((maxAddr - startA + 1) / 16);
          } else {
            wordCount = maxAddr - startA + 1;
          }

          // 字元件与位元件统一为 960 字（位元件 = 15360 点）
          var MAX_WORDS = 960;
          if (wordCount > MAX_WORDS) {
            var newGroups = [];
            var ss = 0;
            while (ss < grp.tags.length) {
              var se = ss;
              // 🔧 review#7: 删除只写不读的 subMax（旧代码误导，拆分判定只依赖 nextAddr 与组起点之差）
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

          function attemptGroup(attempt) {
            if (node._closed) { releaseConnection(connKey); return; }
            // 🔧 v1.7.2: 熔断期不发起连接（防 4E→内置口 场景把 PLC 端口彻底锁死）
            if (silentCircuitOpen(connKey)) {
              hasFailed = true;
              if (!firstError) firstError = '[CIRCUIT] PLC 持续零字节无响应，熔断冷却中（常见原因：4E 帧发到内置以太网口 / 通信代码不匹配）';
              setTimeout(function () { processGroup(gi + 1); }, 0);
              return;
            }
            if (mcSocket.destroyed) {
              destroyConnection(connKey);
              getConnection(node, plc, function (e2, newSock) {
                if (node._closed) { releaseConnection(connKey); return; }
                if (e2) {
                  hasFailed = true;
                  if (!firstError) firstError = '[RECONNECT] ' + e2.message;
                  releaseConnection(connKey);
                  finishWithError();
                  return;
                }
                mcSocket = newSock;
                attemptGroup(attempt);
              });
              return;
            }

            if (attempt > maxRetries) {
              hasFailed = true;
              if (!firstError) firstError = 'MC read failed for ' + grp.regType + startA;
              setTimeout(function () { processGroup(gi + 1); }, 0);
              return;
            }

            var sentSN = (frameType === '4E') ? currentSN : 0;
            if (frameType === '4E') currentSN = (currentSN + 1) & 0xFFFF;

            var buf = Buffer.alloc(0);
            var resolved = false;
            var _tmoHandler = null, _errHandler = null, _dataHandler = null;
            var _reqTimer = null;

            // 🔧 v1.7.0: typeof 守卫 — handler 为 null 时 removeListener 抛 TypeError 会崩掉整个 Node-RED
            function cleanupListeners(sock) {
              if (!sock) return;
              if (typeof _dataHandler === 'function') sock.removeListener('data', _dataHandler);
              if (typeof _tmoHandler === 'function') sock.removeListener('timeout', _tmoHandler);
              if (typeof _errHandler === 'function') sock.removeListener('error', _errHandler);
              if (_reqTimer) { clearTimeout(_reqTimer); _reqTimer = null; }
            }

            function retryLater() {
              setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
            }
            function nextGroup() {
              setTimeout(function () { processGroup(gi + 1); }, 0);
            }

            // 🔧 v1.7.0: 响应统一处理 — 三种方言都先转成二进制 3E/4E 帧再进这里，解析层零改动
            function handleResponse(binFrame) {
              var raw;
              try {
                raw = mc.parseMCResponse(binFrame, startA, grp.regType, respFrameType, sentSN);
              } catch (e) {
                node.warn('[MC] parse error: ' + e.message);
                retryLater();
                return;
              }
              if (raw && raw.mcError) {
                hasFailed = true;
                if (!firstError) firstError = '[PLC 0x' + raw.mcError.toString(16).toUpperCase() + '] ' + raw.mcErrorText;
                nextGroup();
              } else if (raw && !raw.err) {
                var groupTs = new Date().toISOString();
                grp.tags.forEach(function (t) {
                  var decoded = mc.decodeTag(raw, grp.regType, t.addr, t.dataType, t.byteOrder, t.wordOrder, t.bitOffset);
                  allRaw[t.id] = { rawValue: decoded.rawWord, convertedValue: decoded.value, quality: decoded.quality, ts: groupTs };
                });
                nextGroup();
              } else {
                retryLater();
              }
            }

            // 超时/错误统一处理：销毁连接 → 重连 → 重试
            function onSockFail(sock) {
              return function () {
                if (resolved) return;
                resolved = true;
                cleanupListeners(sock);
                if (buf.length === 0) noteSilentTimeout(connKey, node, plc);  // 🔧 v1.7.2: 零字节静默 → 熔断计数
                destroyConnection(connKey);
                getConnection(node, plc, function (e4, newSock3) {
                  if (node._closed) { releaseConnection(connKey); return; }
                  if (e4) {
                    releaseConnection(connKey);
                    finishWithError();
                    return;
                  }
                  mcSocket = newSock3;
                  retryLater();
                });
              };
            }

            _dataHandler = (function (sock) {
              return function (chunk) {
                try {
                  noteCommAlive(connKey);  // 🔧 v1.7.2: 对端有字节返回 → 熔断复位
                  if (DEBUG_WIRE) {
                    node.log('[MC] <<< len=' + chunk.length + ' [' +
                      chunk.toString(plc.commCode === 'binary' ? 'hex' : 'ascii') + ']');
                  }

                  // --- ascii_q：Q/L/E71 MC 协议 ASCII（软元件名式，长度=字符数）---
                  if (plc.commCode === 'ascii_q') {
                    if (buf.length + chunk.length > 65536) {
                      resolved = true; cleanupListeners(sock);
                      node.warn('[MC] ASCII-Q buffer overflow');
                      retryLater();
                      return;
                    }
                    buf = Buffer.concat([buf, chunk]);
                    var ex = mc.extractAsciiQResponse(buf);
                    if (ex.err) {
                      buf = buf.slice(ex.consumed);
                      node.warn('[MC] ASCII-Q frame error: ' + ex.err);
                      return;
                    }
                    if (!ex.result) return;  // 帧不完整，等更多数据
                    resolved = true;
                    cleanupListeners(sock);
                    buf = buf.slice(ex.consumed);
                    handleResponse(ex.result);
                    return;
                  }

                  // --- ascii_slmp：FX5/iQ-R SLMP ASCII（hex 直译）---
                  if (plc.commCode === 'ascii_slmp') {
                    if (buf.length + chunk.length > 65536) {
                      resolved = true; cleanupListeners(sock);
                      node.warn('[MC] ASCII buffer overflow');
                      retryLater();
                      return;
                    }
                    buf = Buffer.concat([buf, chunk]);
                    var _hdrLen = (frameType === '4E') ? 15 : 11;
                    var _lenOff = (frameType === '4E') ? 11 : 7;
                    var df = mc.dehexifyFrame(buf, _hdrLen, _lenOff);
                    if (df.err) {
                      buf = buf.slice(df.consumed);
                      node.warn('[MC] ASCII frame error: ' + df.err);
                      return;
                    }
                    if (!df.result) return;
                    resolved = true;
                    cleanupListeners(sock);
                    buf = buf.slice(df.consumed);
                    handleResponse(df.result);
                    return;
                  }

                  // --- binary：默认路径 ---
                  if (buf.length + chunk.length > 65536) {
                    resolved = true; cleanupListeners(sock);
                    node.warn('[MC] Buffer overflow, discarding');
                    retryLater();
                    return;
                  }
                  buf = Buffer.concat([buf, chunk]);
                  var hdrLen = (frameType === '4E') ? 15 : 11;
                  if (buf.length >= hdrLen) {
                    var dataLen = buf.readUInt16LE((frameType === '4E') ? 11 : 7) - 2;
                    if (dataLen < 0 || dataLen > 2000) {
                      resolved = true;
                      cleanupListeners(sock);
                      retryLater();
                      return;
                    }
                    if (buf.length >= hdrLen + dataLen) {
                      resolved = true;
                      cleanupListeners(sock);
                      handleResponse(buf);
                    }
                  }
                } catch (e) {
                  node.warn('[MC] data handler error: ' + e.message);
                  cleanupListeners(sock);
                  resolved = true;
                  hasFailed = true;
                  if (!firstError) firstError = '[DATA] ' + e.message;
                  nextGroup();
                }
              };
            })(mcSocket);

            _tmoHandler = onSockFail(mcSocket);
            _errHandler = onSockFail(mcSocket);

            // 🔧 v1.7.0: 先注册监听器，再写帧（旧版顺序相反，write 失败时 cleanup 引用 null handler 导致进程崩溃）
            mcSocket.on('data', _dataHandler);
            mcSocket.once('timeout', _tmoHandler);
            mcSocket.once('error', _errHandler);
            mcSocket.setTimeout(timeout);

            // 请求级兜底定时器（socket.setTimeout 是空闲超时，防慢滴漏无限挂起）
            _reqTimer = setTimeout(function () {
              if (resolved) return;
              node.warn('[MC] request-level timeout (slow-drip response or stuck peer)');
              _tmoHandler();
            }, timeout);

            // 组帧 + 发送（三方言）
            try {
              var wireFrame;
              if (plc.commCode === 'ascii_q') {
                wireFrame = mc.build3EAsciiQReadFrame(startA, wordCount, stationNo, grp.regType, networkNo);
              } else {
                var frame = (frameType === '4E')
                  ? mc.build4EFrame(startA, wordCount, stationNo, grp.regType, networkNo, sentSN)
                  : mc.build3EFrame(startA, wordCount, stationNo, grp.regType, networkNo);
                wireFrame = (plc.commCode === 'ascii_slmp') ? mc.toAsciiHex(frame) : frame;
              }
              if (DEBUG_WIRE) {
                node.log('[MC] >>> len=' + wireFrame.length + ' [' +
                  wireFrame.toString(plc.commCode === 'binary' ? 'hex' : 'ascii') + ']');
              }
              mcSocket.write(wireFrame);
            } catch (e) {
              node.warn('[MC] write error: ' + e.message);
              resolved = true;
              cleanupListeners(mcSocket);
              destroyConnection(connKey);
              getConnection(node, plc, function (e3, newSock2) {
                if (node._closed) { releaseConnection(connKey); return; }
                if (e3) {
                  releaseConnection(connKey);
                  finishWithError();
                  return;
                }
                mcSocket = newSock2;
                retryLater();
              });
              return;
            }
          }
          attemptGroup(0);
        }

        function finishWithError() {
          releaseConnection(connKey);
          msg.payload = {
            success: false,
            deviceId: deviceId,
            deviceName: deviceName,
            data: {},
            error: firstError || 'MC connection lost',
            driverType: 'driver-mc-protocol',
            plcIp: plc.host, plcPort: plc.port,
            roundTimeMs: Date.now() - roundStart
          };
          node.status({ fill: 'red', shape: 'ring', text: 'conn lost' });
          node.error('[MC] ' + (firstError || 'MC connection lost'), msg);  // 🔧 v1.4.4: catch 可捕获
          safeSend(msg);
        }

        processGroup(0);
      });
    });

    node.on('close', function (done) {
      node._closed = true;  // 🔧 阻止 close 后的重连/采集回调继续运行
      // 🔧 v1.4.4: 清理本节点持有的轮次闸（模块级状态跨部署存活，不清理会把新节点永久挡在闸外）
      var fk = Object.keys(node._inFlightKeys || {});
      for (var fi = 0; fi < fk.length; fi++) {
        if (IN_FLIGHT[fk[fi]] === node.id) delete IN_FLIGHT[fk[fi]];
      }
      node._inFlightKeys = {};
      // 🔧 v1.4.4: 释放 UDP 会话（本节点持有的）
      try { mcUdp.releaseNode(node.id); } catch (_) {}
      _activeNodeCount--;
      if (_activeNodeCount <= 0 && _cleanTimer) {
        clearInterval(_cleanTimer);
        _cleanTimer = null;
      }
      // 🔧 v1.4.1: 引用计数 — 仅当没有其他节点使用该连接时才销毁
      var conns = node._usedConns || {};
      var keys = Object.keys(conns);
      for (var ci = 0; ci < keys.length; ci++) {
        var entry = CONN_POOL[keys[ci]];
        if (entry && entry.users) {
          delete entry.users[node.id];
          if (Object.keys(entry.users).length === 0) {
            destroyConnection(keys[ci]);
          }
        }
      }
      try {
        var p2 = node.plcConfig;
        if (p2 && p2.host) {
          var cfgKey = poolKey({ host: p2.host, port: p2.port, frame: p2.frame || '3E', networkNo: p2.networkNo || 0, stationNo: p2.stationNo || 0 });
          var cfgEntry = CONN_POOL[cfgKey];
          if (cfgEntry && cfgEntry.users) {
            delete cfgEntry.users[node.id];
            if (Object.keys(cfgEntry.users).length === 0) {
              destroyConnection(cfgKey);
            }
          }
        }
      } catch (e) {}
      node._usedConns = {};
      node.status({ fill: 'grey', shape: 'dot', text: 'closed' });
      if (typeof done === 'function') done();
    });
  }

  RED.nodes.registerType('mitsubishi-read', MitsubishiReadNode);
};
