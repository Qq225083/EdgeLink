// 监控④逐台在线上报：每台设备单独 POST /monitor/device-comm（fire-and-forget）
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
var log = core.logger;
log.setDebug(st.get('debug'));
var m = msg._mon;

var commStat = st.get('commStatus');
try {
    m.devices.forEach(function (d) {
        var cs = commStat[d.id] || {};
        var ok = (cs.consecutiveFails || 0) === 0 && cs.lastSuccessTime;
        var dp = 'node_id=' + encodeURIComponent(m.nodeId) + '&device_id=' + encodeURIComponent(d.id)
            + '&success=' + (ok ? 'true' : 'false')
            + '&error_msg=' + encodeURIComponent(ok ? '' : 'no recent success');
        core.httpClient.requestJson({
            host: st.get('backendHost'), port: st.get('backendPort'),
            path: '/monitor/device-comm?' + dp, method: 'POST',
            headers: { 'X-API-Key': m.apiKey, 'Authorization': 'Bearer ' + m.jwt, 'Content-Type': 'application/json' },
            body: '{}', timeout: 2000
        });
    });
    if (m.devices.length > 0) log.debug('Monitor', 'Reported ' + m.devices.length + ' devices online');
    node.status({ fill: 'blue', shape: 'dot', text: 'dev online ×' + m.devices.length });
} catch (ex) { log.warn('Monitor', 'reportAllDevicesOnline error: ' + ex.message); }
return msg;
