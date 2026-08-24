// EdgeLink MQTT 探针 — runtime_healthcheck.py 的辅助工具
// 用法:
//   node mqtt_probe.js sub <user> <pass> <topic1,topic2,...>   逐主题测试订阅权限
//   node mqtt_probe.js pubsub <backendUser> <backendPass> <edgeUser> <edgePass>
//        后端发 CONFIG_REFRESH(node_id:0 无害) → 边缘账号订阅 notify/broadcast 收消息 = 端到端回路
// 输出机器可读行: PROBE_RESULT ...
const mqtt = require('D:/nodered/node_modules/mqtt');
const BROKER = 'mqtt://127.0.0.1:1883';
const mode = process.argv[2];

function connect(user, pass) {
    return mqtt.connect(BROKER, { username: user, password: pass, connectTimeout: 4000, reconnectPeriod: 0 });
}

if (mode === 'sub') {
    const [, , , user, pass, topicsArg] = process.argv;
    const topics = topicsArg.split(',');
    const c = connect(user, pass);
    let done = 0;
    c.on('error', e => { console.log('PROBE_RESULT CONN_ERR ' + e.message); process.exit(2); });
    c.on('connect', () => {
        topics.forEach(t => {
            c.subscribe(t, (e) => {
                console.log('PROBE_RESULT SUB ' + (e ? 'DENIED' : 'ALLOWED') + ' ' + t);
                if (++done === topics.length) { c.end(); process.exit(0); }
            });
        });
    });
    setTimeout(() => { console.log('PROBE_RESULT TIMEOUT'); process.exit(3); }, 8000);
} else if (mode === 'pubsub') {
    const [, , , bu, bp, eu, ep] = process.argv;
    const sub = connect(eu, ep);
    let finished = false;
    const finish = (code, msg) => { if (!finished) { finished = true; console.log('PROBE_RESULT ' + msg); process.exit(code); } };
    sub.on('error', e => finish(2, 'EDGE_CONN_ERR ' + e.message));
    sub.on('connect', () => {
        sub.subscribe('edgelink/notify/broadcast', (e) => {
            if (e) finish(2, 'EDGE_SUB_DENIED');
            const pub = connect(bu, bp);
            pub.on('error', err => finish(2, 'BACKEND_CONN_ERR ' + err.message));
            pub.on('connect', () => {
                pub.publish('edgelink/notify/broadcast', JSON.stringify({ alert_type: 'CONFIG_REFRESH', node_id: 0, probe: true }), { qos: 1 }, (err) => {
                    if (err) finish(2, 'BACKEND_PUB_ERR ' + err.message);
                });
            });
        });
    });
    sub.on('message', (t, m) => {
        try { const j = JSON.parse(m.toString()); if (j.probe) finish(0, 'ROUNDTRIP_OK'); } catch (e) {}
    });
    setTimeout(() => finish(1, 'ROUNDTRIP_FAIL(no message in 8s)'), 8000);
} else if (mode === 'brokercred') {
    // 解密 flows_cred.json，用其中的 broker 凭据实测连接
    // 参数: brokercred <brokerNodeId> <expectedUser>
    const [, , , brokerId, expectedUser] = process.argv;
    const crypto = require('crypto');
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('D:/nodered/data/.config.runtime.json', 'utf8'));
    const key = crypto.createHash('sha256').update(cfg._credentialSecret).digest();
    const raw = JSON.parse(fs.readFileSync('D:/nodered/data/flows_cred.json', 'utf8'));
    let plain = raw;
    if (raw['$']) {
        const s = raw['$'];
        const iv = Buffer.from(s.substring(0, 32), 'hex');
        const d = crypto.createDecipheriv('aes-256-ctr', key, iv);
        plain = JSON.parse(d.update(s.substring(32), 'base64', 'utf8') + d.final('utf8'));
    }
    const entry = plain[brokerId];
    if (!entry) { console.log('PROBE_RESULT CRED_MISSING ' + brokerId); process.exit(1); }
    console.log('PROBE_RESULT CRED_USER_MATCH=' + (entry.user === expectedUser));
    const c = connect(entry.user, entry.password);
    c.on('error', e => { console.log('PROBE_RESULT CRED_CONN_ERR ' + e.message); process.exit(1); });
    c.on('connect', () => { console.log('PROBE_RESULT CRED_CONN_OK'); c.end(); process.exit(0); });
    setTimeout(() => { console.log('PROBE_RESULT TIMEOUT'); process.exit(3); }, 8000);
} else {
    console.log('PROBE_RESULT BAD_MODE');
    process.exit(2);
}
