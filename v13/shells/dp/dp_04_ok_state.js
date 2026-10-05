// 数据管道④成功支路：通断状态恢复（offline→online 记恢复事件）
var core = global.get('edgeCore');
var st = core.createStore(global);
var dp = msg._dp;

var commStatus = st.get('commStatus');
var s = core.commState.onSuccess(commStatus[dp.devId], dp.nowMs);
commStatus[dp.devId] = s.status;
st.set('commStatus', commStatus);

if (s.recovered) {
    var commPending = st.get('commPending');
    commPending.push({ deviceId: dp.devId, success: true, error: '', consecutiveFails: 0, ts: dp.now });
    st.set('commPending', commPending);
    node.status({ fill: 'green', shape: 'dot', text: dp.devName + ' recovered' });
} else {
    node.status({ fill: 'green', shape: 'dot', text: dp.devName + ' online' });
}
return msg;
