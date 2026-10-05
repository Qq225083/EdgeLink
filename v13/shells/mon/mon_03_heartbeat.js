// 监控③HTTP心跳：401检测 + nodeId更新 + kill switch → 输出1 继续支路 / 输出2 reauth
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
var log = core.logger;
log.setDebug(st.get('debug'));
var m = msg._mon;

var params = 'host_pc_ip=' + encodeURIComponent(m.hostPcIp)
    + '&node_ip=' + encodeURIComponent(m.hostPcIp)
    + '&running_flows=5&memory_usage_mb=' + m.mem
    + '&pg_success_count=' + st.get('pgSuccessCount') + '&pg_fail_count=' + st.get('pgFailCount')
    + '&spool_bytes=' + m.spoolBytes
    + (st.get('configVersion') ? '&config_version=' + st.get('configVersion') : '');

core.httpClient.requestJson({
    host: st.get('backendHost'), port: st.get('backendPort'),
    path: '/monitor/heartbeat?' + params, method: 'POST',
    headers: { 'X-API-Key': m.apiKey, 'Authorization': 'Bearer ' + m.jwt, 'Content-Type': 'application/json' },
    body: '{}', timeout: 5000
}).then(function (r) {
    if (r.error) log.debug('Monitor', 'HB err: ' + r.error);
    var reauthMsg = null;
    // 状态清理由心跳 401 独占（原版语义）；reauth 消息按周期去重（③⑤⑥ 共享 m.reauthSent）
    if (r.status === 401 && !st.get('reauthInProgress')) {
        log.warn('Monitor', 'JWT expired (401), trigger re-login');
        st.set('jwt', '');
        st.set('configReady', false);
        st.set('reauthInProgress', true);
    }
    if (r.status === 401 && !m.reauthSent) {
        m.reauthSent = true;
        reauthMsg = { payload: { action: 'reauth' } };
    }
    var j = r.json;
    if (j) {
        var nid = (j.data && j.data.node_id) ? j.data.node_id : 0;
        if (nid > 0 && nid !== m.nodeId) {
            st.set('nodeId', nid);
            log.debug('Monitor', 'nodeId updated: ' + m.nodeId + ' → ' + nid);
        }
        // kill switch 轮询兜底——心跳响应携带 disabled 标志，每周期比对
        var disabledFlag = !!(j.data && j.data.disabled);
        var curDisabled = !!st.get('nodeDisabled');
        if (disabledFlag !== curDisabled) {
            st.set('nodeDisabled', disabledFlag);
            try { core.configCache.setDisabled(global.get('userDir'), disabledFlag); } catch (e) {}
            if (disabledFlag) {
                st.set('devices', []);
                st.set('tagConfigs', {});
                st.set('configReady', false);
                log.warn('Monitor', '⚠ 本节点已被后端停用（心跳轮询发现），采集已停止');
            } else {
                st.set('configReady', false);
                log.warn('Monitor', '✅ 本节点已重新启用（心跳轮询发现），等待下轮配置刷新');
            }
        }
    }
    if (r.status !== null) node.status({ fill: r.status === 200 ? 'green' : 'red', shape: 'dot', text: 'HB ' + r.status });
    node.send([msg, reauthMsg]);
});
return null;
