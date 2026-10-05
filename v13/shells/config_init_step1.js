// === sf-config-manager Step 1（V13 壳）: IP检测 + 单例锁 + 分路径 + 登录请求 ===
// 纯逻辑已抽 lib：core.netUtils（IP/指纹/规范化）、core.bootstrap（拉取/停用复查）、core.configCache（停用标记落盘）。
// 行为与 V12 原版逐字节等价：锁语义、四条路径（首启/刷新/reauth/停用复查）、输出 msg 形状、日志文案不变。
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, msg) { node.warn('[' + scope + '] ' + msg); });
var log = core.logger;
var DEBUG = st.get('debug');
log.setDebug(DEBUG);

var isReauth = (msg.payload && msg.payload.action === 'reauth');
var existingJwt = st.get('jwt');

// === Singleton lock (60s expiry) ===
var lock = st.get('configManagerLock');
if (lock && (Date.now() - lock.ts < 60000)) {
    if (isReauth) {
        // Reauth: wait until current init finishes (max 30s)
        if (Date.now() - lock.ts < 30000) {
            log.debug('CM', 'Re-auth waiting for active init (' + (Date.now() - lock.ts) + 'ms old)');
            setTimeout(function () { node.send(msg); }, 2000);
            return null;
        }
        // Force takeover after 30s
        log.debug('CM', 'Lock expired, force takeover for reauth');
    } else {
        log.debug('CM', 'Another init in progress, skip');
        return null;
    }
}
st.set('configManagerLock', { ts: Date.now(), nodeId: node.id });

var isFirstRun = !existingJwt && !isReauth;
var isRefresh = !isReauth && !isFirstRun;

// === IP Detection (skip virtual NICs) ===
// 优先使用环境变量 edge_hostPcIp / EDGE_HOST_PC_IP（支持 ip:port 多实例区分），未设置才自动检测
// 注意：用 st.raw 读 edge_hostPcIp（不套默认值），与旧版 `global.get(...) || ...` 短路语义一致
var envHostPcIp = st.raw('hostPcIp') || global.get('EDGE_HOST_PC_IP') || '';
var detectedIp = '';

if (envHostPcIp) {
    detectedIp = envHostPcIp;
    log.debug('CM', 'Using env edge_hostPcIp=' + detectedIp);
} else {
    detectedIp = core.netUtils.detectIp();
}

var hostPcIp = detectedIp;
// 自动获取实际监听端口，支持一台 PC 多实例；已含端口则不重复追加
var actualPort = global.get('uiPort') || env.get('PORT') || 1880;
hostPcIp = core.netUtils.normalizeHostPcIp(hostPcIp, actualPort);
st.set('hostPcIp', hostPcIp);

// 机器指纹（hostname + MACs），用于 IP 变更时自动映射
var machineFingerprint = core.netUtils.computeFingerprint();

// === 停用态自愈：复查 bootstrap 是否已重新启用 ===
if (st.get('nodeDisabled')) {
    log.debug('CM', '节点处于停用态，复查 bootstrap 是否重新启用...');
    core.bootstrap.fetchBootstrap({
        host: st.get('backendHost'), port: st.get('backendPort'),
        hostPcIp: hostPcIp, secretKey: st.get('bootstrapSecret'), timeout: 5000
    }).then(function (r) {
        if (r.ok) {
            log.warn('CM', '✅ 节点已被重新启用，恢复采集');
            st.set('nodeDisabled', false);
            try { core.configCache.setDisabled(global.get('userDir'), false); } catch (e) {}
            node.send(proceedWithLogin());
        } else if (r.status !== null) {
            // 仍未启用：保持停止，释放锁，等待下一周期
            st.set('configManagerLock', null);
            node.status({ fill: 'red', shape: 'ring', text: 'DISABLED by server' });
            node.send([null, null]);
        } else {
            // 网络错误/超时：只释放锁（原版此分支不动状态灯）
            st.set('configManagerLock', null);
            node.send([null, null]);
        }
    });
    return null;
}

// === Bootstrap 配置拉取（v2.0 两阶段：/auto 注册 + /bootstrap 获取配置） ===
var bootstrapKey = st.get('bootstrapKey');
var bootstrapSecret = st.get('bootstrapSecret');
if (isFirstRun) {
    log.debug('CM', 'First run, fetching bootstrap from ' + st.get('backendHost') + ':' + st.get('backendPort'));

    core.bootstrap.fetchBootstrap({
        host: st.get('backendHost'), port: st.get('backendPort'),
        hostPcIp: hostPcIp, secretKey: bootstrapSecret, timeout: 5000
    }).then(function (r) {
        if (r.ok) {
            var cfg = r.config;
            st.set('apiKey', cfg.apiKey || '');
            st.set('backendUser', cfg.backendUser || '');
            st.set('backendPass', cfg.backendPass || '');
            st.set('mqttConfig', cfg.mqtt || {});
            if (cfg.hostPcIp) st.set('hostPcIp', cfg.hostPcIp);
            log.debug('CM', 'Bootstrap OK, hostPcIp=' + st.get('hostPcIp'));
        } else if (r.disabled) {
            // 节点已被后端停用：进入停用态，不走本地凭据兜底（kill switch 重启持久化路径）
            log.warn('CM', '⚠ 本节点已被后端停用，采集停止（等待重新启用）');
            st.set('nodeDisabled', true);
            st.set('devices', []);
            st.set('tagConfigs', {});
            st.set('configReady', false);
            st.set('configManagerLock', null);
            try { core.configCache.setDisabled(global.get('userDir'), true); } catch (e) {}
            return null;
        } else {
            log.debug('CM', 'Bootstrap failed: ' + (r.error || 'unknown'));
        }
        node.send(proceedWithLogin());
        return;
    });
    return null;
}

// === Default config (allow settings.js overrides) ===
return proceedWithLogin();

function proceedWithLogin() {
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
    st.set('debug', DEBUG);

    // === First run: initialize all state globals ===
    if (isFirstRun) {
        st.initAll();
        st.set('startTime', new Date().toISOString());
        log.debug('CM', 'First run, hostPcIp=' + hostPcIp);
    }

    // === Refresh path: keep configReady=true, don't interrupt collection ===
    if (isRefresh) {
        log.debug('CM', 'Periodic refresh, configReady stays true');
    }

    // === Reauth path: clear JWT, full re-login ===
    if (isReauth) {
        st.set('jwt', '');
        st.set('configReady', false);
        st.set('reauthInProgress', true);
        log.debug('CM', '401 reauth, full re-login');
    }

    // === Build login request ===
    var user = st.get('backendUser');
    var pass = st.get('backendPass');
    var host = st.get('backendHost');
    var port = st.get('backendPort');

    msg.url = 'http://' + host + ':' + port + '/login';
    msg.payload = 'username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass);

    return msg;
}
