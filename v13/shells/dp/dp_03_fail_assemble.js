// 数据管道③失败支路出口：PLC_OFFLINE 告警 + lastGood BAD 重发（30s 节流）+ 释放 guard
// 单输出口返回 [msgs数组]：数组逐条扇出（对接 mqtt-out）
var core = global.get('edgeCore');
var st = core.createStore(global);
var dp = msg._dp;
var nodeId = st.get('nodeId') || 999;
var hostPcIp = st.get('hostPcIp');

var msgs = [];
if (dp.becameOffline) {
    msgs.push({
        topic: 'edgelink/alarm/plc_offline/' + dp.devId,
        payload: JSON.stringify({
            alert_type: 'PLC_OFFLINE', node_id: nodeId, device_id: dp.devId,
            device_name: dp.devName, host_pc_ip: hostPcIp,
            msg: dp.devName + ' communication failure: ' + (msg.payload.error || 'unknown'),
            ts: dp.now
        }),
        qos: 1, retain: false
    });
}

var lastGoodTags = st.get('lastGoodTags');
var lastBadSend = st.get('lastBadSend');
if (core.commState.shouldSendBad(lastBadSend[dp.devId], dp.nowMs)
    && lastGoodTags[dp.devId] && lastGoodTags[dp.devId].length > 0) {
    lastBadSend[dp.devId] = dp.nowMs;
    st.set('lastBadSend', lastBadSend);
    var badVals = JSON.parse(JSON.stringify(lastGoodTags[dp.devId]));
    badVals.forEach(function (v) { v.quality = 'BAD'; });
    msgs.push({
        topic: 'edgelink/data/' + nodeId + '/' + dp.devId,
        payload: JSON.stringify({
            node_id: nodeId, device_id: dp.devId, device_name: dp.devName,
            host_pc_ip: hostPcIp, ts: dp.now,
            value_count: badVals.length, values: badVals, quality: 'BAD'
        }),
        qos: 1, retain: false
    });
}

// 释放防重入锁
var guard = st.get('procGuard');
delete guard[dp.devId];
st.set('procGuard', guard);

if (msgs.length === 0) { node.status({ fill: 'grey', shape: 'dot', text: 'nothing to send' }); return null; }
node.status({ fill: 'red', shape: 'dot', text: 'alarm out ×' + msgs.length });
return [msgs];
