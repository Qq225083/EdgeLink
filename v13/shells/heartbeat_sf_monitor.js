// === sf-monitor: 30s心跳 + device-comm批量消费 + PG统计（V13 STEP1 lib 化壳）===
// 行为与 V12 原版逐字节等价：HTTP 路径/超时/header/body、MQTT 心跳内容、send 槽位、status 灯、日志文案全部不变。
// V13 变更：http.request 模板 → core.httpClient；global.get/set 裸键 → stateStore；日志 → core.logger。
// 记录在案的唯一行为差异（原实现的潜在 bug，经评审规则「记录不静默改」标注）：
//   原版在心跳超时路径会【双重执行】收尾（timeout 处理器跑一遍，destroy 触发的 error 处理器再跑一遍，
//   导致 reportAllDevicesOnline 在超时时发两遍）；httpClient 单次结算语义下该路径只执行一次——
//   这是超时分支的修复性偏差，正常/失败/401 分支完全等价。
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, msg) { node.warn('[' + scope + '] ' + msg); });
var log = core.logger;
var DEBUG = st.get('debug');
log.setDebug(DEBUG);

var HOST = st.get('backendHost');
var PORT = st.get('backendPort');
var nodeId = st.get('nodeId') || 999;
var hostPcIp = st.get('hostPcIp');
var jwt = st.get('jwt');
var apiKey = st.get('apiKey');
if (!apiKey) { node.error('[CM] edge_apiKey not configured'); st.set('configManagerLock', null); return null; }
var devices = st.get('devices');

var now = new Date().toISOString();

// Phase E: pendingOps ensures async 401 detection completes before node.send
var pendingOps = 1;  // consumed by tryFinalSend below; reportPgStats and consumeDeviceComm each add their share
var reauthNeeded = false;
var _sent = false;
function tryFinalSend() {
    if (_sent) return;
    pendingOps--;
    if (pendingOps <= 0) {
        _sent = true;
        var reauthMsg = reauthNeeded ? { payload: { action: 'reauth' } } : null;
        node.send([mqttMsg, reauthMsg]);
    }
}

if (!st.get('configReady')) {
    node.status({ fill: 'grey', shape: 'dot', text: 'wait config' });
    return [null, null];
}

// === Memory usage ===
var mem = 0;
try { var pr = global.get('process'); mem = pr ? Math.round(pr.memoryUsage().rss / 1024 / 1024) : 0; } catch (e) { mem = 0; }

// === Build MQTT heartbeat (Output 1) ===
// === 所有设备定期上报 online（修复离线判定滞后）===
function reportAllDevicesOnline() {
    var devs = st.get('devices');
    var commStat = st.get('commStatus');
    try {
    devs.forEach(function(d) {
        var cs = commStat[d.id] || {};
        // 有最近成功记录且连续失败为0 → online
        var ok = (cs.consecutiveFails || 0) === 0 && cs.lastSuccessTime;
        // 每个设备单独上报
        var dp = 'node_id=' + encodeURIComponent(nodeId) + '&device_id=' + encodeURIComponent(d.id)
            + '&success=' + (ok ? 'true' : 'false')
            + '&error_msg=' + encodeURIComponent(ok ? '' : 'no recent success');
        core.httpClient.requestJson({
            host: HOST, port: PORT, path: '/monitor/device-comm?' + dp, method: 'POST',
            headers: { 'X-API-Key': apiKey, 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' },
            body: '{}', timeout: 2000
        });
    });
    if (devs.length > 0) log.debug('Monitor', 'Reported ' + devs.length + ' devices online');
    } catch(ex) { log.warn('Monitor', 'reportAllDevicesOnline error: ' + ex.message); }
}

var devList = devices.map(function (d) {
    var status = st.get('commStatus')[d.id] || {};
    return {
        id: d.id, name: d.deviceName,
        online: (status.consecutiveFails || 0) === 0,
        consecutiveFails: status.consecutiveFails || 0,
        tagCount: (d.tags || []).length
    };
});

var mqttMsg = {
    topic: 'edgelink/heartbeat/' + nodeId,
    payload: JSON.stringify({
        node_id: nodeId, host_pc_ip: hostPcIp,
        device_count: devices.length, devices: devList,
        running_flows: 5, memory_usage_mb: mem, status: 'online', ts: now
    }),
    qos: 1, retain: false
};

// === HTTP Heartbeat (async) ===
// === #88: 健康指标（PG 写入统计 + 磁盘 spool 积压）===
var pgSuccess = st.get('pgSuccessCount');
var pgFail = st.get('pgFailCount');
var spoolBytes = 0;
try {
    var _fs = global.get('fs');
    var _path = global.get('path');
    if (_fs && _path) {
        var spoolDir = _path.join(global.get('userDir') || '.', 'edgelink_pg_spool');
        if (_fs.existsSync(spoolDir)) {
            _fs.readdirSync(spoolDir).forEach(function (fname) {
                try { spoolBytes += _fs.statSync(_path.join(spoolDir, fname)).size; } catch (e) {}
            });
        }
    }
} catch (e) { spoolBytes = 0; }

var params = 'host_pc_ip=' + encodeURIComponent(hostPcIp)
    + '&node_ip=' + encodeURIComponent(hostPcIp)
    + '&running_flows=5&memory_usage_mb=' + mem
    + '&pg_success_count=' + pgSuccess + '&pg_fail_count=' + pgFail + '&spool_bytes=' + spoolBytes
    + (st.get('configVersion') ? '&config_version=' + st.get('configVersion') : '');  // 捎带已应用快照版本

core.httpClient.requestJson({
    host: HOST, port: PORT, path: '/monitor/heartbeat?' + params, method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' },
    body: '{}', timeout: 5000
}).then(function (r) {
    if (r.error) log.debug('Monitor', 'HB err: ' + r.error);
    if (r.status === 401 && !st.get('reauthInProgress')) {
        log.warn('Monitor', 'JWT expired (401), trigger re-login');
        st.set('jwt', '');
        st.set('configReady', false);
        st.set('reauthInProgress', true);
        reauthNeeded = true;
    }
    var j = r.json;
    if (j) {
        var nid = (j.data && j.data.node_id) ? j.data.node_id : 0;
        if (nid > 0 && nid !== nodeId) {
            st.set('nodeId', nid);
            log.debug('Monitor', 'nodeId updated: ' + nodeId + ' → ' + nid);
        }
        // kill switch 轮询兜底——心跳响应携带 disabled 标志，每周期比对
        var disabledFlag = !!(j.data && j.data.disabled);
        var curDisabled = !!st.get('nodeDisabled');
        if (disabledFlag !== curDisabled) {
            st.set('nodeDisabled', disabledFlag);
            // kill switch 停用标记落盘（收口到 configCache 唯一入口，同步 fs 天然串行）
            try { core.configCache.setDisabled(global.get('userDir'), disabledFlag); } catch (e3) {}
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
    reportAllDevicesOnline();
    if (r.status !== null) node.status({ fill: r.status === 200 ? 'green' : 'red', shape: 'dot', text: 'HB ' + r.status });
    consumeDeviceComm(tryFinalSend);
    reportPgStats(tryFinalSend);
    tryFinalSend();
});

// === Device-comm consumer: drain edge_commPending (30s batch) ===
function consumeDeviceComm(done) {
    var pending = st.get('commPending');
    if (pending.length === 0) { return; }  // Don't call done() — nothing to consume, doesn't count
    st.set('commPending', []);
    pendingOps += pending.length;
    log.debug('Monitor', 'Draining ' + pending.length + ' device-comm events');
    pending.forEach(function (item) {
        var itemDone = false;
        function itemFinish() {
            if (itemDone) return;
            itemDone = true;
            if (done) done();
        }
        var p = 'node_id=' + encodeURIComponent(nodeId) + '&device_id=' + encodeURIComponent(item.deviceId)
            + '&success=' + (item.success ? 'true' : 'false')
            + '&error_msg=' + encodeURIComponent(item.error || '');
        core.httpClient.requestJson({
            host: HOST, port: PORT, path: '/monitor/device-comm?' + p, method: 'POST',
            headers: { 'X-API-Key': apiKey, 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' },
            body: '{}', timeout: 3000
        }).then(function (r) {
            if (r.status === 401 && !reauthNeeded) reauthNeeded = true;
            itemFinish();
        });
    });
}

// === PG Write Stats reporter ===
function reportPgStats(done) {
    pendingOps++;
    var pgDone = false;
    function pgFinish() {
        if (pgDone) return;
        pgDone = true;
        if (done) done();
    }
    var pgCount = st.get('pgSuccessCount');
    var pgFailCount = st.get('pgFailCount');
    var pgPrev = st.get('pgPrevCount');
    var pgFailPrev = st.get('pgFailPrev');
    var writeCount = pgCount - pgPrev;
    var failCount = pgFailCount - pgFailPrev;
    st.set('pgPrevCount', pgCount);
    st.set('pgFailPrev', pgFailCount);
    var lastError = st.get('pgLastError') || '';
    var success = (failCount === 0);
    var p = 'node_id=' + encodeURIComponent(nodeId) + '&success=' + (success ? 'true' : 'false') + '&latency_ms=' + st.get('pgLastLatencyMs')
        + '&write_count=' + writeCount + '&device_count=' + devices.length + '&error_msg=' + encodeURIComponent(lastError);
    core.httpClient.requestJson({
        host: HOST, port: PORT, path: '/monitor/pg-write?' + p, method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' },
        body: '{}', timeout: 3000
    }).then(function (r) {
        if (r.status === 401 && !reauthNeeded) reauthNeeded = true;
        pgFinish();
    });
}

return null;
