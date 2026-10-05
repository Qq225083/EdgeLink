// 数据管道⑥成功支路：计算点位求值（追加到 tagValues/pgRecords）
var core = global.get('edgeCore');
var st = core.createStore(global);
var dp = msg._dp;

var calcOut = core.calcTags.evalCalcTags((dp.devInfo && dp.devInfo.calcTags) || [], {
    tagValues: dp.tagValues,
    prevGood: (st.get('lastGoodTags')[dp.devId]) || [],
    lastCalc: st.get('lastCalc'),
    triggerKind: dp.triggerKind,
    nowMs: dp.nowMs, now: dp.now,
    nodeId: st.get('nodeId') || 999,
    devId: dp.devId, devName: dp.devName, hostPcIp: st.get('hostPcIp')
});

dp.tagValues = dp.tagValues.concat(calcOut.values);
dp.pgRecords = dp.pgRecords.concat(calcOut.pgRecords);
dp.validCount += calcOut.values.length;
dp.skippedCount += calcOut.skipped;
st.set('lastCalc', calcOut.lastCalc);
node.status({ fill: 'blue', shape: 'dot', text: 'calc +' + calcOut.values.length });
return msg;
