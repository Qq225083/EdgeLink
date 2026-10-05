// 数据管道①入口：防重入 guard + 公共上下文（_dp）
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
core.logger.setDebug(st.get('debug'));

var result = msg.payload;
if (!result) return null;

var devId = result.deviceId;
var guard = st.get('procGuard');
var g = guard[devId];
if (g && (Date.now() - g.ts > 30000)) { delete guard[devId]; g = undefined; }  // 过期锁强制释放
if (g) {
    core.logger.debug('DP', 'ProcGuard locked for device ' + devId + ', dropping duplicate');
    node.status({ fill: 'yellow', shape: 'ring', text: 'busy, drop ' + devId });
    return null;
}
guard[devId] = { ts: Date.now() };
st.set('procGuard', guard);

var devices = st.get('devices');
var devInfo = null;
for (var i = 0; i < devices.length; i++) { if (devices[i].id === devId) { devInfo = devices[i]; break; } }

msg._dp = {
    devId: devId,
    devName: result.deviceName || ('PLC-' + devId),
    devInfo: devInfo,
    triggerKind: devInfo ? (devInfo.triggerKind || 1) : 1,
    now: new Date().toISOString(),
    nowMs: Date.now()
};
node.status({ fill: 'blue', shape: 'dot', text: msg._dp.devName });
return msg;
