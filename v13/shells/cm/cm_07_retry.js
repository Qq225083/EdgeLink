// 配置⑦登录重试调度：retryPolicy 状态机 + 指数退避（120s 熔断档）；成功 → 输出到 nodeId 反查
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
var log = core.logger;
log.setDebug(st.get('debug'));

var plan = core.retryPolicy.planRetry(st.get('retryState'));
st.set('retryState', plan.state);

if (plan.exhausted) {
    if (plan.warnOnce) log.warn('CM', 'Login retry exhausted (5x), next in 120s');
    node.status({ fill: 'red', shape: 'ring', text: 'retry exhausted, 120s' });
    setTimeout(function () {
        st.set('retryState', core.retryPolicy.resetRetry());
        node.send([null, msg]);   // 输出2：重置后重进本节点重新排程
    }, plan.delayMs);
    return null;
}

log.debug('CM', 'Retry login in ' + (plan.delayMs / 1000) + 's (attempt ' + plan.attemptForLog + '/5)...');
node.status({ fill: 'yellow', shape: 'ring', text: 'retry in ' + (plan.delayMs / 1000) + 's' });
setTimeout(function () {
    core.httpClient.requestJson({
        host: st.get('backendHost'), port: st.get('backendPort'),
        path: '/login', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=' + encodeURIComponent(st.get('backendUser')) + '&password=' + encodeURIComponent(st.get('backendPass')),
        timeout: 5000
    }).then(function (r) {
        var newJwt = (r.json && r.json.data && r.json.data.token) ? r.json.data.token : ((r.json && r.json.token) || '');
        if (newJwt) {
            st.set('retryState', core.retryPolicy.resetRetry());
            st.set('jwt', newJwt);
            st.set('reauthInProgress', false);
            log.debug('CM', 'Retry login OK, discovering...');
            msg._cm.jwt = newJwt;
            node.send([msg, null]);   // 输出1：成功 → 继续 nodeId 反查
        } else {
            log.debug('CM', 'Retry login failed (attempt ' + plan.attemptForLog + '/5), retrying...');
            node.send([null, msg]);   // 输出2：失败 → 重进本节点排下一次
        }
    });
}, plan.delayMs);
return null;
