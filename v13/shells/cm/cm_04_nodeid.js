// 配置④nodeId 反查：心跳注册取 nodeId（异步出口；失败放弃本轮不发）
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
var log = core.logger;
log.setDebug(st.get('debug'));
var cm = msg._cm;

var mem = 0;
try {
    var pr = global.get('process');
    mem = pr ? (Math.round((pr.memoryUsage().rss || 0) / 1048576) || 0) : 0;
} catch (e) { mem = 0; }

var nodeParams = 'host_pc_ip=' + encodeURIComponent(cm.hostPcIp)
    + '&node_ip=' + encodeURIComponent(cm.hostPcIp)
    + '&running_flows=5&memory_usage_mb=' + mem;

core.httpClient.requestJson({
    host: st.get('backendHost'), port: st.get('backendPort'),
    path: '/monitor/heartbeat?' + nodeParams, method: 'POST',
    headers: { 'X-API-Key': st.get('apiKey'), 'Authorization': 'Bearer ' + cm.jwt, 'Content-Type': 'application/json' },
    body: '{}', timeout: 5000
}).then(function (r) {
    var nid = (r.json && r.json.data && r.json.data.node_id) ? r.json.data.node_id : 0;
    if (nid > 0) {
        st.set('nodeId', nid);
        log.debug('CM', 'Node registered, nodeId=' + nid);
        node.status({ fill: 'green', shape: 'dot', text: 'nodeId=' + nid });
        node.send(msg);
    } else {
        // nodeId 获取失败即放弃本轮（下周期自动重试），不编造幽灵 id
        if (r.error) log.debug('CM', 'nodeId err: ' + r.error);
        else log.debug('CM', 'nodeId missing in heartbeat response, abort this round');
        log.warn('CM', 'nodeId unavailable, abort config pull this round');
        st.set('configManagerLock', null);
        st.set('configReady', false);
        st.set('lastConfigTs', new Date().toISOString());
        node.status({ fill: 'red', shape: 'ring', text: 'no nodeId' });
    }
});
return null;
