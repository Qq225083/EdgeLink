// 监控②MQTT心跳组装 → 输出1（edgelink/heartbeat/{nodeId}）
var core = global.get('edgeCore');
var st = core.createStore(global);
var m = msg._mon;

var commStat = st.get('commStatus');
var devList = m.devices.map(function (d) {
    var cs = commStat[d.id] || {};
    return {
        id: d.id, name: d.deviceName,
        online: (cs.consecutiveFails || 0) === 0,
        consecutiveFails: cs.consecutiveFails || 0,
        tagCount: (d.tags || []).length
    };
});

node.status({ fill: 'blue', shape: 'dot', text: 'MQTT HB ×' + m.devices.length });
return {
    topic: 'edgelink/heartbeat/' + m.nodeId,
    payload: JSON.stringify({
        node_id: m.nodeId, host_pc_ip: m.hostPcIp,
        device_count: m.devices.length, devices: devList,
        running_flows: 5, memory_usage_mb: m.mem, status: 'online', ts: m.now
    }),
    qos: 1, retain: false
};
