// 监控⑥PG统计上报：写库成功/失败计数差值上报；401 → 输出2 reauth（本周期去重）
var core = global.get('edgeCore');
var st = core.createStore(global);
var m = msg._mon;

var pgCount = st.get('pgSuccessCount');
var pgFailCount = st.get('pgFailCount');
var writeCount = pgCount - st.get('pgPrevCount');
var failCount = pgFailCount - st.get('pgFailPrev');
st.set('pgPrevCount', pgCount);
st.set('pgFailPrev', pgFailCount);

var success = (failCount === 0);
var p = 'node_id=' + encodeURIComponent(m.nodeId) + '&success=' + (success ? 'true' : 'false')
    + '&latency_ms=' + st.get('pgLastLatencyMs')
    + '&write_count=' + writeCount + '&device_count=' + m.devices.length
    + '&error_msg=' + encodeURIComponent(st.get('pgLastError') || '');

core.httpClient.requestJson({
    host: st.get('backendHost'), port: st.get('backendPort'),
    path: '/monitor/pg-write?' + p, method: 'POST',
    headers: { 'X-API-Key': m.apiKey, 'Authorization': 'Bearer ' + m.jwt, 'Content-Type': 'application/json' },
    body: '{}', timeout: 3000
}).then(function (r) {
    if (r.status === 401 && !st.get('reauthInProgress') && !m.reauthSent) {
        m.reauthSent = true;
        node.send([null, { payload: { action: 'reauth' } }]);
    }
    node.status({ fill: r.status === 200 ? 'green' : 'red', shape: 'dot', text: 'pg ' + (r.status || 'err') });
});
return null;
