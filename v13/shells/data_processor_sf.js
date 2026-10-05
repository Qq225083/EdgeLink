// === sf-data-processor（V13 STEP2 壳）: 换算 + 死区 + 质量码 + 历史 + 双输出 ===
// 纯逻辑已抽 lib：core.transform / core.reportFilter / core.calcTags / core.commState。
// 壳只负责：procGuard 防重入、状态读写（stateStore）、消息/告警组装、node.send/status。
// 行为与 V12 原版逐字节等价（输出结构、send 槽位、多消息数组、status 灯、日志文案不变）。
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, msg) { node.warn('[' + scope + '] ' + msg); });
var log = core.logger;
var DEBUG = st.get('debug');
log.setDebug(DEBUG);

var result = msg.payload;
if (!result) { node.send([null, null]); return; }

// === Per-device processing guard (prevents read-modify-write race) ===
var procGuard = st.get('procGuard');
var guardEntry = procGuard[result.deviceId];
// If locked but expired (>30s), force release (uncaught exception recovery)
if (guardEntry && (Date.now() - guardEntry.ts > 30000)) {
    delete procGuard[result.deviceId];
    guardEntry = undefined;
}
if (guardEntry) {
    // Drop duplicate — scheduler will re-collect this device next cycle
    log.debug('DP', 'ProcGuard locked for device ' + result.deviceId + ', dropping duplicate');
    return;
}
procGuard[result.deviceId] = { ts: Date.now() };

try {
var nodeId = st.get('nodeId') || 999;
var hostPcIp = st.get('hostPcIp');
var tagConfigs = st.get('tagConfigs');
var devTags = tagConfigs[result.deviceId] || [];
var now = new Date().toISOString();
var nowMs = Date.now();

// === State references ===
var lastGoodTags = st.get('lastGoodTags');
var historyData = st.get('historyData');
var commStatus = st.get('commStatus');
var commPending = st.get('commPending');
var lastBadSend = st.get('lastBadSend');

var devId = result.deviceId;
var devName = result.deviceName || ('PLC-' + devId);
// 获取设备 triggerKind（0=握手 1=固定周期 2=变化触发）
var devices = st.get('devices');
var devInfo = null;
for (var di = 0; di < devices.length; di++) {
    if (devices[di].id === devId) { devInfo = devices[di]; break; }
}
var triggerKind = devInfo ? (devInfo.triggerKind || 1) : 1;

// ===== FAILURE PATH =====
if (!result.success) {
    var t = core.commState.onFail(commStatus[devId], nowMs);
    var status = t.status;

    // Only push to pending on state change (online → offline)
    var alarmMsg = null;
    if (t.becameOffline) {
        commPending.push({
            deviceId: devId,
            success: false,
            error: result.error || 'communication failure',
            consecutiveFails: status.consecutiveFails,
            ts: now
        });
        st.set('commPending', commPending);
        log.debug('DP', 'Device ' + devName + ' state: online → offline');
        // Publish PLC_OFFLINE alarm via MQTT
        alarmMsg = {
            topic: 'edgelink/alarm/plc_offline/' + devId,
            payload: JSON.stringify({
                alert_type: 'PLC_OFFLINE',
                node_id: nodeId,
                device_id: devId,
                device_name: devName,
                host_pc_ip: hostPcIp,
                msg: devName + ' communication failure: ' + (result.error || 'unknown'),
                ts: now
            }),
            qos: 1,
            retain: false
        };
        var alerts = st.get('recentAlerts');
        alerts.push({
            alertType: 'PLC_OFFLINE',
            deviceId: devId,
            deviceName: devName,
            msg: result.error || 'communication failure',
            ts: now
        });
        if (alerts.length > 20) alerts = alerts.slice(-20);
        st.set('recentAlerts', alerts);
    }
    commStatus[devId] = status;
    st.set('commStatus', commStatus);

    // Re-publish last-good values with BAD quality (throttled: max every 30s)
    var mqttMsg = null;
    if (core.commState.shouldSendBad(lastBadSend[devId], nowMs) && lastGoodTags[devId] && lastGoodTags[devId].length > 0) {
        lastBadSend[devId] = nowMs;
        st.set('lastBadSend', lastBadSend);
        var badVals = JSON.parse(JSON.stringify(lastGoodTags[devId]));
        badVals.forEach(function (v) { v.quality = 'BAD'; });
        mqttMsg = {
            topic: 'edgelink/data/' + nodeId + '/' + devId,
            payload: JSON.stringify({
                node_id: nodeId,
                device_id: devId,
                device_name: devName,
                host_pc_ip: hostPcIp,
                ts: now,
                value_count: badVals.length,
                values: badVals,
                quality: 'BAD'
            }),
            qos: 1,
            retain: false
        };
    }

    delete procGuard[devId];
    st.set('procGuard', procGuard);
    // Send alarm + BAD data as array so mqtt-out publishes both
    // 多消息数组直接嵌进输出数组（mqtt-out 逐条扇出）
    var mqttOut = alarmMsg ? (mqttMsg ? [alarmMsg, mqttMsg] : [alarmMsg]) : (mqttMsg ? [mqttMsg] : []);
    node.send([mqttOut.length ? mqttOut : null, null]);
    node.status({ fill: 'red', shape: 'ring', text: devName + ' OFFLINE' });
    return;
}

// ===== SUCCESS PATH =====

// Reset comm status on success
var s = core.commState.onSuccess(commStatus[devId], nowMs);
commStatus[devId] = s.status;
st.set('commStatus', commStatus);

// Push to pending on recovery (offline → online)
if (s.recovered) {
    commPending.push({
        deviceId: devId,
        success: true,
        error: '',
        consecutiveFails: 0,
        ts: now
    });
    st.set('commPending', commPending);
    log.debug('DP', 'Device ' + devName + ' state: offline → online (recovered)');
}

var stdData = result.data || {};
var tagValues = [];
var pgRecords = [];
var validCount = 0;
var skippedCount = 0;

// Process each tag
(devTags.length > 0 ? devTags : []).forEach(function (tag) {
    var entry = stdData[tag.id];
    if (!entry || entry.rawValue === undefined || entry.rawValue === null) {
        // Tag not in this read, mark as missing
        tagValues.push({
            tag_id: tag.id,
            tag_address: tag.regAddr || '',
            tag_name: tag.name || '',
            raw_value: null,
            eng_value: null,
            unit: tag.unit || '',
            quality: 'UNCERTAIN',
            ts: now
        });
        return;
    }

    // Step 1: Transform (linear: y=a·x+b; slope_offset: 量程映射) + 质量码归一
    var tf = core.transform.applyTransform(entry.rawValue, entry.quality, tag);
    var eng = tf.eng;
    var quality = tf.quality;

    // Step 2: 上报过滤（变化触发 / 数值死区 / 强制周期）
    var prevVals = lastGoodTags[devId] || [];
    var prev = null;
    for (var pi = 0; pi < prevVals.length; pi++) {
        if (prevVals[pi].tag_id === tag.id) { prev = prevVals[pi]; break; }
    }
    if (!core.reportFilter.shouldReport({
        prev: prev,
        eng: eng,
        deadband: tag.deadband,
        forceIntervalMs: tag.reportForceIntervalMs,
        triggerKind: triggerKind,
        nowMs: nowMs
    })) {
        skippedCount++;
        return;
    }

    var tv = {
        tag_id: tag.id,
        tag_address: tag.regAddr || '',
        tag_name: tag.name || '',
        raw_value: entry.rawValue,
        register_type: tag.regType || '',
        eng_value: eng,
        unit: tag.unit || '',
        quality: quality,
        ts: now
    };
    tagValues.push(tv);
    validCount++;

    // PG record
    pgRecords.push({
        ts: now,
        node_id: nodeId,
        device_id: devId,
        device_name: devName,
        tag_id: tag.id,
        tag_address: tag.regAddr || '',
        tag_name: tag.name || '',
        raw_value: entry.rawValue,
        register_type: tag.regType || '',
        eng_value: eng,
        unit: tag.unit || '',
        quality: quality,
        host_pc_ip: hostPcIp
    });

    // History cache
    if (!historyData[devId]) historyData[devId] = {};
    if (!historyData[devId][tag.id]) historyData[devId][tag.id] = [];
    historyData[devId][tag.id].push({ ts: now, raw: entry.rawValue, eng: eng, q: quality });
    if (historyData[devId][tag.id].length > 100) {
        historyData[devId][tag.id] = historyData[devId][tag.id].slice(-100);
    }
});

// === 计算点位（派生点位）===
var calcOut = core.calcTags.evalCalcTags((devInfo && devInfo.calcTags) || [], {
    tagValues: tagValues,
    prevGood: lastGoodTags[devId] || [],
    lastCalc: st.get('lastCalc'),
    triggerKind: triggerKind,
    nowMs: nowMs,
    now: now,
    nodeId: nodeId,
    devId: devId,
    devName: devName,
    hostPcIp: hostPcIp
});
tagValues = tagValues.concat(calcOut.values);
pgRecords = pgRecords.concat(calcOut.pgRecords);
validCount += calcOut.values.length;
skippedCount += calcOut.skipped;
st.set('lastCalc', calcOut.lastCalc);

// Update lastGoodTags — 合并更新 + 未读到 tag 标记 UNCERTAIN
var prevGood = lastGoodTags[devId] || [];
var newGood = tagValues.filter(function (v) { return v.quality === 'GOOD'; });  // 只保留 GOOD
var prevMap = {};
// Mark all previous as stale, then overwrite with fresh reads
prevGood.forEach(function (pg) {
    prevMap[pg.tag_id] = { tag_id: pg.tag_id, tag_address: pg.tag_address, tag_name: pg.tag_name,
        raw_value: pg.raw_value, eng_value: pg.eng_value, unit: pg.unit,
        quality: 'UNCERTAIN', ts: pg.ts };
});
newGood.forEach(function (ng) { prevMap[ng.tag_id] = ng; });
var merged = [];
for (var k in prevMap) {
    if (Object.prototype.hasOwnProperty.call(prevMap, k)) merged.push(prevMap[k]);
}
lastGoodTags[devId] = merged;
st.set('lastGoodTags', lastGoodTags);
st.set('historyData', historyData);

// PG success counter is incremented by sf-pg-writer after successful write only

// === Build outputs ===
var mqttMsg = null;
if (tagValues.length > 0) {
    mqttMsg = {
        topic: 'edgelink/data/' + nodeId + '/' + devId,
        payload: JSON.stringify({
            node_id: nodeId,
            device_id: devId,
            device_name: devName,
            host_pc_ip: hostPcIp,
            ts: now,
            value_count: validCount,
            values: tagValues
        }),
        qos: 1,
        retain: false
    };
}

var pgMsg = null;
if (pgRecords.length > 0) {
    pgMsg = { payload: { pgRecords: pgRecords } };
}

if (DEBUG && validCount > 0) {
    node.status({ fill: 'green', shape: 'dot', text: devName + ' ' + validCount + ' vals' + (skippedCount > 0 ? ' (' + skippedCount + ' skipped)' : '') });
}

} finally {
delete procGuard[devId];
st.set('procGuard', procGuard);
}
node.send([mqttMsg, pgMsg]);
return;
