// 配置③JWT解析+缓存读取：输出1=继续（nodeId反查）/ 输出2=重试调度
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
var log = core.logger;
log.setDebug(st.get('debug'));

var apiKey = st.get('apiKey');
if (!apiKey) { node.error('[CM] edge_apiKey not configured'); st.set('configManagerLock', null); return null; }

// JWT 解析（登录响应在 msg.payload）
var jwtToken = '';
try {
    var r = JSON.parse(msg.payload);
    jwtToken = (r.data && r.data.token) ? r.data.token : (r.token || '');
} catch (e) { jwtToken = ''; }

// 先读本地配置缓存（前移到 JWT 校验之前）——后端不可用时也能用最近配置继续采集
var cached = core.configCache.readCache(global.get('userDir'));
if (cached && cached.disabled === true) {
    st.set('nodeDisabled', true);
    st.set('devices', []);
    st.set('tagConfigs', {});
    st.set('configReady', false);
    log.debug('CM', '节点处于停用状态（缓存标记），保持停止');
} else if (cached && cached.devices && cached.tagConfigs) {
    st.set('devices', cached.devices);
    st.set('tagConfigs', cached.tagConfigs);
    st.set('configReady', true);
    log.debug('CM', 'Loaded config from cache, ' + cached.devices.length + ' devices');
}

if (!jwtToken) {
    log.debug('CM', 'JWT FAIL: ' + (msg.payload || '').substring(0, 80));
    st.set('configManagerLock', null);
    node.status({ fill: 'red', shape: 'ring', text: 'JWT fail, retry' });
    return [null, msg];   // 输出2 → 登录重试调度
}

st.set('jwt', jwtToken);
st.set('reauthInProgress', false);
msg._cm.jwt = jwtToken;
log.debug('CM', 'JWT OK, hostPcIp=' + st.get('hostPcIp'));

// 防重入探测（原版 step2 内的 quirk 复刻：每次进入 attempt+1，5s 内重复触发丢弃）
var gate = core.retryPolicy.probeRetryGate(st.get('retryState'), Date.now());
if (gate.skip) return null;
st.set('retryState', gate.state);

node.status({ fill: 'green', shape: 'dot', text: 'JWT OK' });
return [msg, null];
