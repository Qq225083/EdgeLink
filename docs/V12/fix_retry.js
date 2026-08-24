const fs = require('fs');
const path = 'c:/Users/admin/Desktop/RuoYi-Vue-FastAPI/docs/V12/edgelink_v12_main_flow.json';
const flow = JSON.parse(fs.readFileSync(path, 'utf8'));
const node = flow.find(n => n.name === 'JWT解析 + nodeId + 点位发现');
let fc = node.func;

// Replace the entire retryLogin function with a fixed version
const oldStart = '// 🔧 P1#10: 直接 HTTP 重试登录，指数退避，上限5次\nvar _retryAttempt = 0;\nvar MAX_RETRY = 5;\nvar _retryDelay = 10000;\nfunction retryLogin() {';
const oldEnd = '// Execute: nodeId → tags';

const idx1 = fc.indexOf(oldStart);
const idx2 = fc.indexOf(oldEnd);

if (idx1 === -1 || idx2 === -1) {
    console.log('Pattern not found');
    console.log('oldStart at:', idx1);
    console.log('oldEnd at:', idx2);
    process.exit(1);
}

const newRetryFunc = `// 🔧 P1#10: 全局状态防重入（多实例重试互斥）
var _r = global.get('edge_retryState') || {};
if (Date.now() - (_r.lastAttempt || 0) < 5000) { return; }
_r.attempt = (_r.attempt || 0) + 1;
_r.lastAttempt = Date.now();
global.set('edge_retryState', _r);

function retryLogin() {
    var _r = global.get('edge_retryState') || {};
    if (_r.attempt >= 5) {
        if (_r.attempt === 5) { node.warn('[CM] Login retry exhausted (5x), next in 120s'); }
        _r.attempt++;
        _r.delay = 120000;
        global.set('edge_retryState', _r);
        setTimeout(function() {
            var _r2 = global.get('edge_retryState') || {};
            _r2.attempt = 0; _r2.delay = 10000;
            global.set('edge_retryState', _r2);
            retryLogin();
        }, 120000);
        return;
    }
    _r.attempt++;
    var thisDelay = _r.delay || 10000;
    _r.delay = Math.min((_r.delay || 10000) * 2, 60000);
    global.set('edge_retryState', _r);
    setTimeout(function () {
        var user = global.get('edge_backendUser');
        var pass = global.get('edge_backendPass');
        var host = global.get('edge_backendHost') || '127.0.0.1';
        var port = global.get('edge_backendPort') || 9099;
        var retryOpts = {
            hostname: host, port: port, path: '/login', method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        };
        if (DEBUG) node.warn('[CM] Retry login in ' + (thisDelay/1000) + 's (attempt ' + _r.attempt + '/5)...');
        var retryReq = http.request(retryOpts, function (res) {
            var b = '';
            res.on('data', function (d) { b += d; });
            res.on('end', function () {
                var newJwt = '';
                try {
                    var r = JSON.parse(b);
                    newJwt = (r.data && r.data.token) ? r.data.token : (r.token || '');
                } catch (e) {}
                if (newJwt) {
                    var _r2 = global.get('edge_retryState') || {};
                    _r2.attempt = 0; _r2.delay = 10000;
                    global.set('edge_retryState', _r2);
                    global.set('edge_jwt', newJwt);
                    global.set('edge_reauthInProgress', false);
                    if (DEBUG) node.warn('[CM] Retry login OK, discovering...');
                    discoverNodeId(function (nid) { discoverTags(nid); });
                } else {
                    if (DEBUG) node.warn('[CM] Retry login failed (attempt ' + _r.attempt + '/5), retrying...');
                    retryLogin();
                }
            });
        });
        retryReq.setTimeout(5000, function () {
            retryReq.destroy();
            if (DEBUG) node.warn('[CM] Retry login timeout (attempt ' + _r.attempt + '/5)');
            retryLogin();
        });
        retryReq.on('error', function () {
            if (DEBUG) node.warn('[CM] Retry login network error (attempt ' + _r.attempt + '/5)');
            retryLogin();
        });
        retryReq.write('username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass));
        retryReq.end();
    }, thisDelay);
}

// Execute: nodeId → tags`;

fc = fc.substring(0, idx1) + newRetryFunc + fc.substring(idx2 + oldEnd.length);

// Verify
if (fc.includes('_retryAttempt')) {
    console.log('WARNING: _retryAttempt still present');
} else {
    console.log('OK: _retryAttempt removed');
}
if (fc.includes('edge_retryState')) {
    console.log('OK: edge_retryState used');
}

node.func = fc;
fs.writeFileSync(path, JSON.stringify(flow, null, 2));
fs.copyFileSync(path, 'D:/nodered/flows.json');
console.log('Saved + synced to Node-RED');
