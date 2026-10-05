// === sf-config-manager Step 2（V13 壳）: JWT解析 + nodeId反查 + 拉取全局点位 + 分组输出 ===
// 纯逻辑已抽 lib：core.tagConfig（地址解析/分组/清理）、core.retryPolicy（重试状态机）、
// core.httpClient（HTTP）、core.configCache（缓存）。壳只保留编排顺序与 node 副作用。
// 行为与 V12 原版逐字节等价：分页熔断、停用中断、输出槽位 [configMsg, mqttMsg]、缓存前移读取不变。
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, msg) { node.warn('[' + scope + '] ' + msg); });
var log = core.logger;
var DEBUG = st.get('debug');
log.setDebug(DEBUG);

var HOST = st.get('backendHost');
var PORT = st.get('backendPort');
var myHostPcIp = st.get('hostPcIp');
var apiKey = st.get('apiKey');
if (!apiKey) { node.error('[CM] edge_apiKey not configured'); st.set('configManagerLock', null); return null; }

// 1. Parse JWT from login response
var jwtToken = '';
try {
    var r = JSON.parse(msg.payload);
    jwtToken = (r.data && r.data.token) ? r.data.token : (r.token || '');
} catch (e) {
    jwtToken = '';
}

// 启动时先读本地配置缓存（前移到 JWT 校验之前）——后端不可用时也能用最近配置继续采集
var cached = core.configCache.readCache(global.get('userDir'));
if (cached && cached.disabled === true) {
    // 节点处于停用状态（缓存标记），保持停止，不加载缓存配置
    st.set('nodeDisabled', true);
    st.set('devices', []);
    st.set('tagConfigs', {});
    st.set('configReady', false);
    log.debug('CM', '节点处于停用状态（缓存标记），保持停止');
} else if (cached && cached.devices && cached.tagConfigs) {
    st.set('devices', cached.devices);
    st.set('tagConfigs', cached.tagConfigs);
    st.set('configReady', true);
    log.debug('CM', 'Loaded config from cache, ' + cached.devices.length + ' devices');
}

if (!jwtToken) {
    log.debug('CM', 'JWT FAIL: ' + (msg.payload || '').substring(0, 80));
    st.set('configManagerLock', null);
    // 使用 httpClient 直接重试登录
    retryLogin();
    return null;
}

st.set('jwt', jwtToken);
st.set('reauthInProgress', false);
log.debug('CM', 'JWT OK, hostPcIp=' + myHostPcIp);


// 2. Discover/register nodeId via heartbeat
function discoverNodeId(callback) {
    var mem = 0;
    try {
        var pr = global.get('process');
        mem = pr ? (Math.round((pr.memoryUsage().rss || 0) / 1048576) || 0) : 0;
    } catch (e) { mem = 0; }
    var nodeParams = 'host_pc_ip=' + encodeURIComponent(myHostPcIp)
        + '&node_ip=' + encodeURIComponent(myHostPcIp)
        + '&running_flows=5&memory_usage_mb=' + mem;
    core.httpClient.requestJson({
        host: HOST, port: PORT, path: '/monitor/heartbeat?' + nodeParams, method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Authorization': 'Bearer ' + jwtToken, 'Content-Type': 'application/json' },
        body: '{}', timeout: 5000
    }).then(function (r) {
        var nid = (r.json && r.json.data && r.json.data.node_id) ? r.json.data.node_id : 0;
        if (nid > 0) {
            st.set('nodeId', nid);
            log.debug('CM', 'Node registered, nodeId=' + nid);
            callback(nid);
        } else {
            // 后端未返回有效 nodeId → 不编造幽灵 id，本轮放弃待重试
            if (r.error) log.debug('CM', 'nodeId err: ' + r.error);
            else log.debug('CM', 'nodeId missing in heartbeat response, abort this round');
            callback(0);
        }
    });
}

// 3. Fetch global tag list (paged, 5000/page) + group by deviceId + filter
function discoverTags(nodeId) {
    var PAGE_SIZE = 5000;
    var allRecords = [];
    fetchTagPage(1);

    // 统一失败出口（原版 4 处相同收尾的收口）
    function fail(msgText) {
        log.warn('CM', msgText);
        st.set('configManagerLock', null);
        st.set('configReady', false);
        st.set('lastConfigTs', new Date().toISOString());
        node.send([null, null]);
    }

    function fetchTagPage(pageNum) {
        // 熔断：超过 200 页（100 万点位）必定是分页参数未生效，防止无限翻页打满后端
        if (pageNum > 200) {
            fail('Tag paging exceeded 200 pages, aborting (backend paging params not honored?)');
            return;
        }
        var tagPath = '/plc/config/snapshot/list?pageSize=' + PAGE_SIZE + '&pageNum=' + pageNum;  // camelCase 绑定
        core.httpClient.requestJson({
            host: HOST, port: PORT, path: tagPath, method: 'GET',
            headers: { 'Authorization': 'Bearer ' + jwtToken }, timeout: 10000
        }).then(function (r) {
            if (r.error) { fail('Tag fetch error: ' + r.error); return; }
            var j = r.json;
            if (!j) { fail('Tag API parse error'); return; }
            if (j.code !== 200) { fail('Tag API returned code ' + (j.code || 'unknown') + ', will retry on refresh'); return; }
            if (j.snapshotVersion !== undefined && j.snapshotVersion !== null) {
                st.set('configVersion', j.snapshotVersion);  // 发布即版本：记录已应用快照版本，随心跳上报
            }
            var pageRows = j.rows || [];
            allRecords = allRecords.concat(pageRows);
            // hasNext 优先；行数等于页大小时也再拉一页（末页恰好满页时空页收尾）
            if (j.hasNext === true || pageRows.length === PAGE_SIZE) {
                fetchTagPage(pageNum + 1);
                return;
            }
            processRecords(allRecords);
        });
    }

    function processRecords(records) {
        // 节点已被后端停用时，忽略本次配置拉取，保持停止状态
        if (st.get('nodeDisabled')) {
            log.warn('CM', '节点已停用，忽略本次配置拉取（等待重新启用）');
            st.set('devices', []);
            st.set('tagConfigs', {});
            st.set('configReady', false);
            st.set('configManagerLock', null);
            node.send([null, null]);
            return;
        }
        try {
            if (records.length === 0) {
                // 🔧 快照为空 = 全部设备已删除/停用（拉取已保证 code=200，空是合法终态，非故障）——清空本机配置并停止采集
                log.warn('CM', 'No tags in system — 快照为空，清空本机配置并停止采集');
                st.set('devices', []);
                st.set('tagConfigs', {});
                st.set('configReady', false);
                st.set('lastConfigTs', new Date().toISOString());
                var cleaned0 = core.tagConfig.cleanupStaleState({}, {}, {
                    historyData: st.get('historyData'),
                    lastGoodTags: st.get('lastGoodTags'),
                    commStatus: st.get('commStatus'),
                    commPending: st.get('commPending')
                });
                st.set('historyData', cleaned0.historyData);
                st.set('lastGoodTags', cleaned0.lastGoodTags);
                st.set('commStatus', cleaned0.commStatus);
                st.set('commPending', cleaned0.commPending);
                try { core.configCache.writeConfig(global.get('userDir'), [], {}); } catch (e) {}
                st.set('configManagerLock', null);
                node.status({ fill: 'grey', shape: 'dot', text: 'no devices' });
                node.send([null, null]);
                return;
            }

            // 分组 + 本机/启用过滤 + MC 有效地址校验（lib）
            var grouped = core.tagConfig.groupByDevice(records, {
                myHostPcIp: myHostPcIp,
                enabledStatus: st.get('enabledStatus')
            });
            grouped.skipped.forEach(function (s) {
                log.debug('CM', 'Device ' + s.deviceName + ' has no valid registers, skipped');
            });

            var myDevices = grouped.devices;
            var myTagConfigs = grouped.tagConfigs;
            st.set('devices', myDevices);
            st.set('tagConfigs', myTagConfigs);
            st.set('configReady', true);
            st.set('lastConfigTs', new Date().toISOString());
            // 缓存配置到本地文件，后端崩溃时重启也能用最近配置继续采集
            try {
                core.configCache.writeConfig(global.get('userDir'), myDevices, myTagConfigs);
                log.debug('CM', 'Config cached');
            } catch (e) {
                log.debug('CM', 'Config cache write failed: ' + e.message);
            }
            // 清理被移除设备/点位的残留状态（lib）
            var validDevIds = {};
            myDevices.forEach(function (d) { validDevIds[d.id] = true; });
            var validTagIds = {};
            myDevices.forEach(function (d) {
                (d.tags || []).forEach(function (t) { validTagIds[t.id] = true; });
            });
            var cleaned = core.tagConfig.cleanupStaleState(validDevIds, validTagIds, {
                historyData: st.get('historyData'),
                lastGoodTags: st.get('lastGoodTags'),
                commStatus: st.get('commStatus'),
                commPending: st.get('commPending')
            });
            st.set('historyData', cleaned.historyData);
            st.set('lastGoodTags', cleaned.lastGoodTags);
            st.set('commStatus', cleaned.commStatus);
            st.set('commPending', cleaned.commPending);
            // 配置完成，释放锁
            st.set('configManagerLock', null);

            if (DEBUG) {
                log.debug('CM', 'Discovered ' + myDevices.length + ' devices (nodeId=' + nodeId + '):');
                myDevices.forEach(function (d) {
                    log.debug('CM', '  ' + d.deviceName + ' (' + d.plcIp + ':' + d.plcPort + ') ' + d.tags.length + ' tags comType=' + d.comType);
                });
            }

            // Output 1: config for main flow scheduler
            var configMsg = {
                payload: {
                    jwt: jwtToken,
                    nodeId: nodeId,
                    hostPcIp: myHostPcIp,
                    devices: myDevices
                }
            };

            // Output 2: MQTT node online
            var now = new Date().toISOString();
            var devList = myDevices.map(function (d) {
                return { device_id: d.id, device_name: d.deviceName, tag_count: d.tags.length };
            });
            var mqttMsg = {
                topic: 'edgelink/nodes/' + nodeId + '/status',
                payload: JSON.stringify({
                    node_id: nodeId,
                    host_pc_ip: myHostPcIp,
                    status: 'online',
                    device_count: myDevices.length,
                    devices: devList,
                    ts: now
                }),
                qos: 1,
                retain: true
            };

            node.send([configMsg, mqttMsg]);
            log.debug('CM', 'Config complete, ' + myDevices.length + ' devices ready');

        } catch (e) {
            log.debug('CM', 'Tag parsing error: ' + e.message);
            st.set('configManagerLock', null);
            node.send([null, null]);
        }
    }
}

// 全局状态防重入（多实例重试互斥）——每次函数进入都探测（含现网 attempt 只增不减的 quirk 复刻）
var gate = core.retryPolicy.probeRetryGate(st.get('retryState'), Date.now());
if (gate.skip) { return; }
st.set('retryState', gate.state);

function retryLogin() {
    var plan = core.retryPolicy.planRetry(st.get('retryState'));
    st.set('retryState', plan.state);
    if (plan.exhausted) {
        if (plan.warnOnce) log.warn('CM', 'Login retry exhausted (5x), next in 120s');
        setTimeout(function () {
            st.set('retryState', core.retryPolicy.resetRetry());
            retryLogin();
        }, plan.delayMs);
        return;
    }
    var thisDelay = plan.delayMs;
    log.debug('CM', 'Retry login in ' + (thisDelay / 1000) + 's (attempt ' + plan.attemptForLog + '/5)...');
    setTimeout(function () {
        var user = st.get('backendUser');
        var pass = st.get('backendPass');
        core.httpClient.requestJson({
            host: st.get('backendHost'), port: st.get('backendPort'), path: '/login', method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass),
            timeout: 5000
        }).then(function (r) {
            var newJwt = (r.json && r.json.data && r.json.data.token) ? r.json.data.token : ((r.json && r.json.token) || '');
            if (newJwt) {
                st.set('retryState', core.retryPolicy.resetRetry());
                st.set('jwt', newJwt);
                st.set('reauthInProgress', false);
                log.debug('CM', 'Retry login OK, discovering...');
                discoverNodeId(function (nid) {
                    // nodeId 获取失败即放弃本轮，不编造幽灵 id
                    if (nid > 0) { discoverTags(nid); return; }
                    log.warn('CM', 'nodeId unavailable after login retry, abort this round');
                    st.set('configManagerLock', null);
                    st.set('configReady', false);
                    st.set('lastConfigTs', new Date().toISOString());
                    node.send([null, null]);
                });
            } else {
                log.debug('CM', 'Retry login failed (attempt ' + plan.attemptForLog + '/5), retrying...');
                retryLogin();
            }
        });
    }, thisDelay);
}

// Execute: nodeId → tags
discoverNodeId(function (nid) {
    // nodeId 获取失败即放弃本轮（30s 后自动重试），不编造幽灵 id
    if (nid > 0) { discoverTags(nid); return; }
    log.warn('CM', 'nodeId unavailable, abort config pull this round');
    st.set('configManagerLock', null);
    st.set('configReady', false);
    st.set('lastConfigTs', new Date().toISOString());
    node.send([null, null]);
});

return null;
