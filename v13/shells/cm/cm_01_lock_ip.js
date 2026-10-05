// 配置①锁+IP检测：单例锁（60s）+ reauth 等待 + IP/指纹/端口规范化
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
var log = core.logger;
log.setDebug(st.get('debug'));

var isReauth = (msg.payload && msg.payload.action === 'reauth');
var existingJwt = st.get('jwt');

// 单例锁（60s 过期；reauth 最多等 30s）
var lock = st.get('configManagerLock');
if (lock && (Date.now() - lock.ts < 60000)) {
    if (isReauth) {
        if (Date.now() - lock.ts < 30000) {
            log.debug('CM', 'Re-auth waiting for active init (' + (Date.now() - lock.ts) + 'ms old)');
            setTimeout(function () { node.send(msg); }, 2000);
            return null;
        }
        log.debug('CM', 'Lock expired, force takeover for reauth');
    } else {
        log.debug('CM', 'Another init in progress, skip');
        return null;
    }
}
st.set('configManagerLock', { ts: Date.now(), nodeId: node.id });

// IP 检测：st.raw 不套默认值，保持旧 `global.get(...) || ...` 短路语义
var envHostPcIp = st.raw('hostPcIp') || global.get('EDGE_HOST_PC_IP') || '';
var detectedIp = envHostPcIp || core.netUtils.detectIp();
if (envHostPcIp) log.debug('CM', 'Using env edge_hostPcIp=' + envHostPcIp);

var actualPort = global.get('uiPort') || env.get('PORT') || 1880;
var hostPcIp = core.netUtils.normalizeHostPcIp(detectedIp, actualPort);
st.set('hostPcIp', hostPcIp);

msg._cm = {
    hostPcIp: hostPcIp,
    fingerprint: core.netUtils.computeFingerprint(),
    isReauth: isReauth,
    isFirstRun: !existingJwt && !isReauth,
    isRefresh: !isReauth && !!existingJwt
};
node.status({ fill: 'blue', shape: 'dot', text: hostPcIp });
return msg;
