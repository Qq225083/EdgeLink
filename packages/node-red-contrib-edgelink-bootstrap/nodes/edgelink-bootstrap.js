/**
 * edgelink-bootstrap.js — EdgeLink 边缘采集接入配置节点 v1.2.1
 *
 * v1.2.1: 🔧 拒答真正停采——后端明确拒答时清配置+断凭据（configReady=false、devices/tagConfigs
 *         清空、jwt/backendUser/backendPass/apiKey 清空），config-manager 下周期自动走完整重激活；
 *         且校验通过前不写 global（错误密钥不污染运行时）；网络层失败维持现状继续采集（抖动不停产）。
 *
 * v1.2.0: 简化激活链路（评审定论：保持严格绑定，删掉引导页）——
 *         面板填「后端地址+端口+密钥」，部署即调 /auto 完成密钥+IP:端口双绑定校验，
 *         结果直接上状态灯；校验通过同时落盘（0600，重启回读生效）。
 *         重试策略（与 site-health 同款）：网络错误 60s 重试；后端拒答 300s 低频重探自愈。
 *         删除：/edgelink/guide 引导页及其 API（v1.1.0 引入）。
 *
 * v1.1.0: 新增「首启引导页」（已删除）。
 *
 * 职责：把「后端地址 + 预分配密钥」从面板配置写入 Node-RED global context，
 *       供 config-manager 流程读取（edge_backendHost / edge_backendPort /
 *       edge_bootstrapKey / edge_bootstrapSecret / edge_hostPcIp）。
 *
 * 纪律（与 site-health 同款）：
 *   - 密钥走 credentials（flows_cred.json）/ 落盘文件（0600），明文不进 flows.json；
 *   - 零输入零输出、零第三方依赖、只写 global，不触碰任何消息流；
 *   - 部署（实例化）时即写入，不等消息——config-manager 的启动 inject 晚于节点实例化，时序安全；
 *   - 取值优先级：节点面板 > 落盘文件 > settings.js/环境变量（flows 侧读取）；
 *   - 单例约束：同一运行环境部署第二个实例即红灯告警（防配置打架）。
 */
module.exports = function (RED) {
    'use strict';

    var fs = require('fs');
    var os = require('os');
    var path = require('path');
    var http = require('http');
    var crypto = require('crypto');

    // 进程级单例标记（deploy 重建时重置）
    var claimed = false;

    var RETRY_NET_MS = 60 * 1000;    // 网络错误重试间隔
    var RETRY_REJECT_MS = 300 * 1000; // 后端拒答低频重探间隔

    // ---------- 落盘文件：userDir/edgelink-bootstrap.json ----------
    function credFile() {
        return path.join(RED.settings.userDir || '.', 'edgelink-bootstrap.json');
    }
    function loadSaved() {
        try { return JSON.parse(fs.readFileSync(credFile(), 'utf8')); } catch (e) { return null; }
    }
    function saveCred(obj) {
        // 密钥落盘仅限本机可读（0600）；userDir 不存在时静默失败（仅本次运行生效）
        try { fs.writeFileSync(credFile(), JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 }); } catch (e) { /* ignore */ }
    }

    // ---------- 网卡 IP 检测（与 v13/lib/netUtils.js 同逻辑，拷贝保持包零依赖独立）----------
    var VIRTUAL_IFACE = ['vethernet', 'vmware', 'virtualbox', 'vbox', 'docker', 'br-', 'wsl', 'hyper-v', 'loopback'];
    function isVirtualIface(name) {
        var lower = String(name).toLowerCase();
        for (var i = 0; i < VIRTUAL_IFACE.length; i++) {
            if (lower.indexOf(VIRTUAL_IFACE[i]) !== -1) return true;
        }
        return false;
    }
    function listCandidateIps() {
        var out = [];
        try {
            var nets = os.networkInterfaces();
            for (var name in nets) {
                if (!Object.prototype.hasOwnProperty.call(nets, name) || isVirtualIface(name)) continue;
                nets[name].forEach(function (info) {
                    var isV4 = info.family === 'IPv4' || info.family === 4;
                    if (isV4 && !info.internal && info.address.indexOf('169.254.') !== 0) out.push(info.address);
                });
            }
        } catch (e) { /* ignore */ }
        return out;
    }
    function detectIp() {
        var candidates = listCandidateIps();
        var i;
        // 双网卡采集 PC：办公网（10.*）优先于工业网（192.168.*），再退到第一个候选
        for (i = 0; i < candidates.length; i++) {
            if (candidates[i].indexOf('10.') === 0) return candidates[i];
        }
        for (i = 0; i < candidates.length; i++) {
            if (candidates[i].indexOf('192.168.') === 0) return candidates[i];
        }
        return candidates.length ? candidates[0] : '127.0.0.1';
    }
    function computeFingerprint() {
        try {
            var macs = [];
            var nets = os.networkInterfaces();
            for (var name in nets) {
                nets[name].forEach(function (iface) {
                    if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') macs.push(iface.mac);
                });
            }
            return crypto.createHash('sha256').update(os.hostname() + '|' + macs.sort().join(',')).digest('hex');
        } catch (e) { return ''; }
    }

    function uiPort() { return parseInt(RED.settings.uiPort, 10) || 1880; }

    /** 把激活结果写入 global context（config-manager 下个周期即生效） */
    function applyGlobals(g, c) {
        if (!g) return;
        if (c.server) g.set('edge_backendHost', c.server);
        if (c.port) g.set('edge_backendPort', c.port);
        if (c.secretKey) g.set('edge_bootstrapSecret', c.secretKey);
        if (c.hostPcIp) g.set('edge_hostPcIp', c.hostPcIp);
        if (c.nodeKey) g.set('edge_bootstrapKey', c.nodeKey);
    }

    /** 调后端 /auto：密钥 + IP:端口 双绑定校验 */
    function callAuto(host, port, hostPcIp, secretKey, cb) {
        var url = '/plc/config/bootstrap/auto?host_pc_ip=' + encodeURIComponent(hostPcIp)
            + '&secret_key=' + encodeURIComponent(secretKey)
            + '&fingerprint=' + encodeURIComponent(computeFingerprint());
        var req = http.request({ host: host, port: port, path: url, method: 'GET', timeout: 5000 }, function (res) {
            var buf = '';
            res.on('data', function (c) { buf += c; });
            res.on('end', function () {
                var j = null;
                try { j = JSON.parse(buf); } catch (e) { /* fallthrough */ }
                cb(null, { status: res.statusCode, json: j });
            });
        });
        req.on('timeout', function () { req.destroy(); cb(new Error('连接后端超时（5s）')); });
        req.on('error', function (e) { cb(new Error('无法连接后端 ' + host + ':' + port + '（' + e.code + '）')); });
        req.end();
    }

    // ---------- 节点本体 ----------
    function EdgeLinkBootstrapNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        node.server = (config.server || '').trim();
        node.port = parseInt(config.port, 10) || 9099;
        node.nodeKey = (config.nodeKey || '').trim();
        node.hostPcIp = (config.hostPcIp || '').trim();
        // 密钥来自 credential（flows_cred.json），明文不进 flows.json
        node.secretKey = (node.credentials && node.credentials.secretKey) || '';

        var g = node.context().global;
        var retryTimer = null;

        // 单例检查
        if (claimed) {
            node.status({ fill: 'red', shape: 'ring', text: '接入配置只能部署一个，请删除多余节点' });
            node.error('[EdgeLink] 接入配置节点重复部署，仅首个生效');
            return;
        }
        claimed = true;
        node.on('close', function (removed, done) {
            claimed = false;
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            if (done) { done(); }
        });

        var source = [];
        var panelComplete = !!(node.server && node.secretKey);

        if (!panelComplete) {
            // 面板未配齐：走落盘兜底（上次激活成功的存档，重启后生效路径）
            var saved = loadSaved();
            if (saved) {
                if (saved.host) { g.set('edge_backendHost', saved.host); source.push('落盘'); }
                if (saved.port) { g.set('edge_backendPort', saved.port); }
                if (saved.secretKey) { g.set('edge_bootstrapSecret', saved.secretKey); }
                if (saved.hostPcIp) { g.set('edge_hostPcIp', saved.hostPcIp); }
                if (saved.nodeKey) { g.set('edge_bootstrapKey', saved.nodeKey); }
            }
            var effHost = g.get('edge_backendHost');
            var effKey = g.get('edge_bootstrapSecret');
            if (!effHost || !effKey) {
                node.status({ fill: 'red', shape: 'ring', text: '未配置：请在面板填写后端地址和预分配密钥' });
                return;
            }
            node.status({
                fill: 'green', shape: 'dot',
                text: '已生效：' + effHost + ':' + g.get('edge_backendPort') + (source.length ? ' · 来源:' + source.join('+') : '')
            });
            return;
        }

        // 面板配齐地址+密钥 → 部署即调 /auto 激活（严格绑定校验）。
        // 纪律：校验通过前不写 global——错误密钥/错误地址绝不允许污染运行时配置。
        var effHostPcIp = node.hostPcIp || (detectIp() + ':' + uiPort());
        var activate = function () {
            node.status({ fill: 'yellow', shape: 'ring', text: '正在校验绑定 ' + node.server + ':' + node.port + ' …' });
            callAuto(node.server, node.port, effHostPcIp, node.secretKey, function (err, r) {
                if (err) {
                    // 网络层失败（后端宕机/抖动）：保留现有运行配置继续采集，60s 重试——抖动不停产
                    node.status({ fill: 'red', shape: 'ring', text: err.message + '，' + (RETRY_NET_MS / 1000) + 's 后重试（采集维持现状）' });
                    retryTimer = setTimeout(activate, RETRY_NET_MS);
                    return;
                }
                var j = r.json;
                if (j && j.code === 200 && j.data) {
                    // 校验通过：此刻才写入 global + 落盘存档
                    applyGlobals(g, {
                        server: node.server, port: node.port, secretKey: node.secretKey,
                        hostPcIp: effHostPcIp, nodeKey: j.data.nodeKey || node.nodeKey || ''
                    });
                    saveCred({
                        host: node.server, port: node.port, secretKey: node.secretKey,
                        hostPcIp: effHostPcIp,
                        nodeKey: j.data.nodeKey || '', nodeName: j.data.nodeName || '',
                        activatedAt: new Date().toISOString()
                    });
                    node.status({
                        fill: 'green', shape: 'dot',
                        text: '已绑定：' + (j.data.nodeName || j.data.nodeKey || 'OK') + '（' + effHostPcIp + '）'
                    });
                    retryTimer = null;
                } else {
                    // 后端明确拒答（密钥无效/地址不符/停用）= 配置问题而非抖动：
                    // 立即停采（清配置 + 断凭据），config-manager 下周期会因凭据缺失自动走完整重激活；
                    // 管理端修正/用户改回正确密钥后，300s 重探或重新部署即自愈
                    g.set('edge_configReady', false);
                    g.set('edge_devices', []);
                    g.set('edge_tagConfigs', {});
                    g.set('edge_jwt', '');
                    g.set('edge_backendUser', '');
                    g.set('edge_backendPass', '');
                    g.set('edge_apiKey', '');
                    var reason = (j && j.msg) || ('后端返回异常（HTTP ' + r.status + '）');
                    node.status({ fill: 'red', shape: 'ring', text: '绑定被拒：' + reason + '（采集已停止）' });
                    node.warn('[EdgeLink] 接入绑定被拒，采集已停止：' + reason + '（' + (RETRY_REJECT_MS / 1000) + 's 后自动重探）');
                    retryTimer = setTimeout(activate, RETRY_REJECT_MS);
                }
            });
        };
        activate();
    }

    RED.nodes.registerType('edgelink-bootstrap', EdgeLinkBootstrapNode, {
        credentials: {
            secretKey: { type: 'password' }
        }
    });
};
