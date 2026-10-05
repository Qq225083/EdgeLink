// 数据管道⑧成功支路出口：MQTT/PG 输出组装 + 释放 guard（二输出口）
var core = global.get('edgeCore');
var st = core.createStore(global);
var dp = msg._dp;
var nodeId = st.get('nodeId') || 999;

var mqttMsg = null;
if (dp.tagValues.length > 0) {
    mqttMsg = {
        topic: 'edgelink/data/' + nodeId + '/' + dp.devId,
        payload: JSON.stringify({
            node_id: nodeId, device_id: dp.devId, device_name: dp.devName,
            host_pc_ip: st.get('hostPcIp'), ts: dp.now,
            value_count: dp.validCount, values: dp.tagValues
        }),
        qos: 1, retain: false
    };
}
var pgMsg = dp.pgRecords.length > 0 ? { payload: { pgRecords: dp.pgRecords } } : null;

// 释放防重入锁
var guard = st.get('procGuard');
delete guard[dp.devId];
st.set('procGuard', guard);

node.status({
    fill: 'green', shape: 'dot',
    text: dp.devName + ' ' + dp.validCount + ' vals' + (dp.skippedCount > 0 ? ' (' + dp.skippedCount + ' skipped)' : '')
});
node.send([mqttMsg, pgMsg]);
return null;
