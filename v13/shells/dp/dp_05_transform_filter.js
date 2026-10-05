// 数据管道⑤成功支路：逐点位 变换 + 死区过滤 + 历史缓存
var core = global.get('edgeCore');
var st = core.createStore(global);
var dp = msg._dp;
var result = msg.payload;

var devTags = (st.get('tagConfigs')[dp.devId]) || [];
var lastGoodTags = st.get('lastGoodTags');
var historyData = st.get('historyData');
var stdData = result.data || {};
var nodeId = st.get('nodeId') || 999;
var hostPcIp = st.get('hostPcIp');

var tagValues = [], pgRecords = [], validCount = 0, skippedCount = 0;

devTags.forEach(function (tag) {
    var entry = stdData[tag.id];
    if (!entry || entry.rawValue === undefined || entry.rawValue === null) {
        tagValues.push({   // 本轮未读到：UNCERTAIN 占位
            tag_id: tag.id, tag_address: tag.regAddr || '', tag_name: tag.name || '',
            raw_value: null, eng_value: null, unit: tag.unit || '', quality: 'UNCERTAIN', ts: dp.now
        });
        return;
    }
    var tf = core.transform.applyTransform(entry.rawValue, entry.quality, tag);

    var prev = null;
    var prevVals = lastGoodTags[dp.devId] || [];
    for (var i = 0; i < prevVals.length; i++) { if (prevVals[i].tag_id === tag.id) { prev = prevVals[i]; break; } }

    if (!core.reportFilter.shouldReport({
        prev: prev, eng: tf.eng, deadband: tag.deadband,
        forceIntervalMs: tag.reportForceIntervalMs, triggerKind: dp.triggerKind, nowMs: dp.nowMs
    })) { skippedCount++; return; }

    tagValues.push({
        tag_id: tag.id, tag_address: tag.regAddr || '', tag_name: tag.name || '',
        raw_value: entry.rawValue, register_type: tag.regType || '',
        eng_value: tf.eng, unit: tag.unit || '', quality: tf.quality, ts: dp.now
    });
    validCount++;
    pgRecords.push({
        ts: dp.now, node_id: nodeId, device_id: dp.devId, device_name: dp.devName,
        tag_id: tag.id, tag_address: tag.regAddr || '', tag_name: tag.name || '',
        raw_value: entry.rawValue, register_type: tag.regType || '',
        eng_value: tf.eng, unit: tag.unit || '', quality: tf.quality, host_pc_ip: hostPcIp
    });
    if (!historyData[dp.devId]) historyData[dp.devId] = {};
    if (!historyData[dp.devId][tag.id]) historyData[dp.devId][tag.id] = [];
    historyData[dp.devId][tag.id].push({ ts: dp.now, raw: entry.rawValue, eng: tf.eng, q: tf.quality });
    if (historyData[dp.devId][tag.id].length > 100) historyData[dp.devId][tag.id] = historyData[dp.devId][tag.id].slice(-100);
});

st.set('historyData', historyData);
dp.tagValues = tagValues;
dp.pgRecords = pgRecords;
dp.validCount = validCount;
dp.skippedCount = skippedCount;
node.status({ fill: 'blue', shape: 'dot', text: validCount + ' vals' + (skippedCount ? ' (-' + skippedCount + ')' : '') });
return msg;
