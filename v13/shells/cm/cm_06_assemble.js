// 配置⑥分组+清理+缓存+输出组装：输出1=configMsg（调度器）/ 输出2=MQTT 节点上线
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
var log = core.logger;
log.setDebug(st.get('debug'));
var cm = msg._cm;

// 节点已被后端停用时，忽略本次配置拉取
if (st.get('nodeDisabled')) {
    log.warn('CM', '节点已停用，忽略本次配置拉取（等待重新启用）');
    st.set('devices', []);
    st.set('tagConfigs', {});
    st.set('configReady', false);
    st.set('configManagerLock', null);
    return null;
}

var records = cm.records || [];
if (records.length === 0) {
    // 🔧 快照为空 = 全部设备已删除/停用（⑤已保证 code=200，空是合法终态，非故障）——清空本机配置并停止采集
    log.warn('CM', 'No tags in system — 快照为空，清空本机配置并停止采集');
    st.set('devices', []);
    st.set('tagConfigs', {});
    st.set('configReady', false);
    st.set('lastConfigTs', new Date().toISOString());
    // 清掉残留状态（全部设备/点位已失效）
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
    return null;
}

// 分组 + 本机/启用过滤 + MC 有效地址校验（lib）
var grouped = core.tagConfig.groupByDevice(records, {
    myHostPcIp: cm.hostPcIp,
    enabledStatus: st.get('enabledStatus')
});
grouped.skipped.forEach(function (s) {
    log.debug('CM', 'Device ' + s.deviceName + ' has no valid registers, skipped');
});

st.set('devices', grouped.devices);
st.set('tagConfigs', grouped.tagConfigs);
st.set('configReady', true);
st.set('lastConfigTs', new Date().toISOString());
try {
    core.configCache.writeConfig(global.get('userDir'), grouped.devices, grouped.tagConfigs);
    log.debug('CM', 'Config cached');
} catch (e) {
    log.debug('CM', 'Config cache write failed: ' + e.message);
}

// 清理被移除设备/点位的残留状态（lib）
var validDevIds = {};
grouped.devices.forEach(function (d) { validDevIds[d.id] = true; });
var validTagIds = {};
grouped.devices.forEach(function (d) {
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
st.set('configManagerLock', null);   // 配置完成，释放锁

var now = new Date().toISOString();
var devList = grouped.devices.map(function (d) {
    return { device_id: d.id, device_name: d.deviceName, tag_count: d.tags.length };
});
var configMsg = {
    payload: { jwt: cm.jwt, nodeId: st.get('nodeId'), hostPcIp: cm.hostPcIp, devices: grouped.devices }
};
var mqttMsg = {
    topic: 'edgelink/nodes/' + st.get('nodeId') + '/status',
    payload: JSON.stringify({
        node_id: st.get('nodeId'), host_pc_ip: cm.hostPcIp, status: 'online',
        device_count: grouped.devices.length, devices: devList, ts: now
    }),
    qos: 1, retain: true
};
log.debug('CM', 'Config complete, ' + grouped.devices.length + ' devices ready');
node.status({ fill: 'green', shape: 'dot', text: 'ready ×' + grouped.devices.length });
node.send([configMsg, mqttMsg]);
return null;
