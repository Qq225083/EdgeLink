// 配置②复查/bootstrap：停用态自愈复查 / 首启 bootstrap 拉凭据 → 输出登录请求 msg（异步出口）
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
var log = core.logger;
log.setDebug(st.get('debug'));
var cm = msg._cm;

// 停用态自愈：复查 bootstrap 是否已重新启用
if (st.get('nodeDisabled')) {
    log.debug('CM', '节点处于停用态，复查 bootstrap 是否重新启用...');
    core.bootstrap.fetchBootstrap({
        host: st.get('backendHost'), port: st.get('backendPort'),
        hostPcIp: cm.hostPcIp, secretKey: st.get('bootstrapSecret'), timeout: 5000
    }).then(function (r) {
        if (r.ok) {
            log.warn('CM', '✅ 节点已被重新启用，恢复采集');
            st.set('nodeDisabled', false);
            try { core.configCache.setDisabled(global.get('userDir'), false); } catch (e) {}
            node.send(buildLogin());
        } else if (r.status !== null) {
            st.set('configManagerLock', null);
            node.status({ fill: 'red', shape: 'ring', text: 'DISABLED by server' });
        } else {
            st.set('configManagerLock', null);
        }
    });
    return null;
}

// 首启：bootstrap 拉凭据
if (cm.isFirstRun) {
    log.debug('CM', 'First run, fetching bootstrap from ' + st.get('backendHost') + ':' + st.get('backendPort'));
    core.bootstrap.fetchBootstrap({
        host: st.get('backendHost'), port: st.get('backendPort'),
        hostPcIp: cm.hostPcIp, secretKey: st.get('bootstrapSecret'), timeout: 5000
    }).then(function (r) {
        if (r.ok) {
            var cfg = r.config;
            st.set('apiKey', cfg.apiKey || '');
            st.set('backendUser', cfg.backendUser || '');
            st.set('backendPass', cfg.backendPass || '');
            st.set('mqttConfig', cfg.mqtt || {});
            if (cfg.hostPcIp) st.set('hostPcIp', cfg.hostPcIp);
            log.debug('CM', 'Bootstrap OK, hostPcIp=' + st.get('hostPcIp'));
            node.send(buildLogin());
        } else if (r.disabled) {
            // 节点已被后端停用：进入停用态，不走本地凭据兜底（kill switch 重启持久化路径）
            log.warn('CM', '⚠ 本节点已被后端停用，采集停止（等待重新启用）');
            st.set('nodeDisabled', true);
            st.set('devices', []);
            st.set('tagConfigs', {});
            st.set('configReady', false);
            st.set('configManagerLock', null);
            try { core.configCache.setDisabled(global.get('userDir'), true); } catch (e) {}
        } else {
            log.debug('CM', 'Bootstrap failed: ' + (r.error || 'unknown'));
            node.send(buildLogin());
        }
    });
    return null;
}

// 刷新/reauth：直接构造登录请求
return buildLogin();

function buildLogin() {
    if (!st.raw('backendHost')) st.set('backendHost', '127.0.0.1');
    if (!st.raw('backendPort')) st.set('backendPort', 9099);
    var apiKey = st.get('apiKey') || global.get('EDGE_API_KEY') || '';
    var backendUser = st.get('backendUser') || global.get('EDGE_BACKEND_USER') || '';
    var backendPass = st.get('backendPass') || global.get('EDGE_BACKEND_PASS') || '';

    if (!apiKey || !backendUser || !backendPass) {
        node.error('[CM] 缺少必需配置：edge_apiKey / edge_backendUser / edge_backendPass，请通过 settings.js 的 functionGlobalContext 或环境变量配置后重启 Node-RED');
        st.set('configManagerLock', null);
        return null;
    }

    st.set('apiKey', apiKey);
    st.set('backendUser', backendUser);
    st.set('backendPass', backendPass);
    if (!st.get('enabledStatus')) st.set('enabledStatus', '0');
    st.set('debug', st.get('debug'));

    if (cm.isFirstRun) {
        st.initAll();
        st.set('startTime', new Date().toISOString());
        log.debug('CM', 'First run, hostPcIp=' + cm.hostPcIp);
    }
    if (cm.isRefresh) log.debug('CM', 'Periodic refresh, configReady stays true');
    if (cm.isReauth) {
        st.set('jwt', '');
        st.set('configReady', false);
        st.set('reauthInProgress', true);
        log.debug('CM', '401 reauth, full re-login');
    }

    msg.url = 'http://' + st.get('backendHost') + ':' + st.get('backendPort') + '/login';
    msg.payload = 'username=' + encodeURIComponent(st.get('backendUser')) + '&password=' + encodeURIComponent(st.get('backendPass'));
    return msg;
}
