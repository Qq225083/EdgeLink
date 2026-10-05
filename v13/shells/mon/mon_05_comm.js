// 监控⑤commPending 批量消费：状态跳变事件逐条 POST；401 → 输出2 reauth（本周期去重）
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
var log = core.logger;
log.setDebug(st.get('debug'));
var m = msg._mon;

var pending = st.get('commPending');
if (pending.length === 0) {
    node.status({ fill: 'grey', shape: 'dot', text: 'comm -' });
    return [msg, null];
}
st.set('commPending', []);
log.debug('Monitor', 'Draining ' + pending.length + ' device-comm events');

pending.forEach(function (item) {
    var p = 'node_id=' + encodeURIComponent(m.nodeId) + '&device_id=' + encodeURIComponent(item.deviceId)
        + '&success=' + (item.success ? 'true' : 'false')
        + '&error_msg=' + encodeURIComponent(item.error || '');
    core.httpClient.requestJson({
        host: st.get('backendHost'), port: st.get('backendPort'),
        path: '/monitor/device-comm?' + p, method: 'POST',
        headers: { 'X-API-Key': m.apiKey, 'Authorization': 'Bearer ' + m.jwt, 'Content-Type': 'application/json' },
        body: '{}', timeout: 3000
    }).then(function (r) {
        if (r.status === 401 && !st.get('reauthInProgress') && !m.reauthSent) {
            m.reauthSent = true;
            node.send([null, { payload: { action: 'reauth' } }]);
        }
    });
});
node.status({ fill: 'blue', shape: 'dot', text: 'comm ×' + pending.length });
return [msg, null];
