// 监控①取态：凭据/就绪检查 + 公共上下文（_mon）。未就绪灰灯短路，零网络调用
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
core.logger.setDebug(st.get('debug'));

var apiKey = st.get('apiKey');
if (!apiKey) { node.error('[CM] edge_apiKey not configured'); st.set('configManagerLock', null); return null; }

if (!st.get('configReady')) {
    node.status({ fill: 'grey', shape: 'dot', text: 'wait config' });
    return null;
}

var mem = 0;
try { var pr = global.get('process'); mem = pr ? Math.round(pr.memoryUsage().rss / 1024 / 1024) : 0; } catch (e) { mem = 0; }

// 磁盘 spool 积压字节数（健康指标）
var spoolBytes = 0;
try {
    var _fs = global.get('fs');
    var _path = global.get('path');
    if (_fs && _path) {
        var spoolDir = _path.join(global.get('userDir') || '.', 'edgelink_pg_spool');
        if (_fs.existsSync(spoolDir)) {
            _fs.readdirSync(spoolDir).forEach(function (fname) {
                try { spoolBytes += _fs.statSync(_path.join(spoolDir, fname)).size; } catch (e) {}
            });
        }
    }
} catch (e) { spoolBytes = 0; }

msg._mon = {
    now: new Date().toISOString(),
    mem: mem,
    spoolBytes: spoolBytes,
    nodeId: st.get('nodeId') || 999,
    hostPcIp: st.get('hostPcIp'),
    jwt: st.get('jwt'),
    apiKey: apiKey,
    devices: st.get('devices'),
    reauthSent: false   // 本周期 reauth 去重标记（③⑤⑥ 共享）
};
node.status({ fill: 'blue', shape: 'dot', text: 'mem ' + mem + 'MB' });
return [msg, msg];
