// 数据管道②失败支路：通断状态转换 + 离线事件（仅跳变时）+ 告警入队
var core = global.get('edgeCore');
var st = core.createStore(global);
var dp = msg._dp;

var commStatus = st.get('commStatus');
var t = core.commState.onFail(commStatus[dp.devId], dp.nowMs);
commStatus[dp.devId] = t.status;
st.set('commStatus', commStatus);
dp.becameOffline = t.becameOffline;
dp.consecutiveFails = t.status.consecutiveFails;

if (t.becameOffline) {
    var commPending = st.get('commPending');
    commPending.push({
        deviceId: dp.devId, success: false,
        error: msg.payload.error || 'communication failure',
        consecutiveFails: t.status.consecutiveFails, ts: dp.now
    });
    st.set('commPending', commPending);

    var alerts = st.get('recentAlerts');
    alerts.push({
        alertType: 'PLC_OFFLINE', deviceId: dp.devId, deviceName: dp.devName,
        msg: msg.payload.error || 'communication failure', ts: dp.now
    });
    if (alerts.length > 20) alerts = alerts.slice(-20);
    st.set('recentAlerts', alerts);

    node.status({ fill: 'red', shape: 'ring', text: dp.devName + ' OFFLINE' });
} else {
    node.status({ fill: 'red', shape: 'dot', text: dp.devName + ' fail×' + t.status.consecutiveFails });
}
return msg;
