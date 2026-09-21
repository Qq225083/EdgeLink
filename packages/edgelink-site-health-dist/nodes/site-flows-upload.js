/**
 * site-flows-upload.js — flows.json 手动上传节点 v1.1.0
 *
 * 职责：编辑器节点按钮点击 → 输入上传原因 → 读取本机 flows.json →
 *       POST 到后端「存量采集点监控」的 /site-health/flows/upload 接口（记录上传时间，每站点留最近 5 份）。
 *       用于现场改动前留档 / 出问题时把现场流程快照传回后端，供监控页下载对照。
 *
 * 设计要点：
 *   - 与 site-health 共用 site-health-server 共享配置（服务器/端口/前缀/HTTPS/Key）。
 *   - 纯人工触发：无定时器，不上传时完全静默，不占任何资源。
 *   - flows 文件路径默认自动推断（settings.flowsFile → userDir/flows.json），可手填覆盖。
 *   - 后端校验链与心跳一致：key + 启停 + IP 绑定 + 端口绑定；另加 10MB 上限与 SHA-256 完整性校验。
 *   - 编辑器 → 运行时通过本节点注册的 admin 接口触发（参照 inject 按钮机制）。
 *
 * 安全纪律：全部 try/catch，异常只走 node.error/status；key 走 credential，不进 flows.json。
 */
module.exports = function (RED) {
    'use strict';
    var http = require('http');
    var https = require('https');
    var fs = require('fs');
    var path = require('path');
    var crypto = require('crypto');

    var MAX_BYTES = 10 * 1024 * 1024; // 与后端 _FLOWS_MAX_BYTES 对齐

    function getNodeRedPort() {
        try {
            if (RED.settings && RED.settings.uiPort) return parseInt(RED.settings.uiPort, 10) || 0;
        } catch (e) { /* ignore */ }
        return 0;
    }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    function nowText() {
        var d = new Date();
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    // admin 接口读 body 兜底：部分老版本 Node-RED 未给自定义 httpAdmin 路由挂 body-parser，
    // req.body 可能是 undefined（在案坑），此时手动收流解析
    function readBody(req, cb) {
        if (req.body && typeof req.body === 'object') return cb(req.body);
        var data = '';
        req.on('data', function (c) { data += c; });
        req.on('end', function () {
            try { cb(JSON.parse(data || '{}')); } catch (e) { cb({}); }
        });
    }

    function SiteFlowsUploadNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        node.name = config.name || 'flows.json 上传';
        node.flowsPath = (config.flowsPath || '').trim();

        // 共享配置节点（必填）：服务器/端口/前缀/HTTPS/Key
        var shared = null;
        try {
            if (config.serverRef) shared = RED.nodes.getNode(config.serverRef);
        } catch (e) { /* ignore */ }
        node.conn = shared || null;

        node.uploading = false;

        function resolveFlowsFile() {
            if (node.flowsPath) return node.flowsPath;
            try {
                var userDir = (RED.settings && RED.settings.userDir) || process.cwd();
                var flowsFile = RED.settings && RED.settings.flowsFile;
                if (flowsFile) return path.isAbsolute(flowsFile) ? flowsFile : path.join(userDir, flowsFile);
                return path.join(userDir, 'flows.json');
            } catch (e) {
                return 'flows.json';
            }
        }

        /**
         * 执行上传。cb(result) result = { ok, message }
         */
        node.doUpload = function (reason, cb) {
            if (node.uploading) return cb({ ok: false, message: '上传进行中，请勿重复点击' });
            if (!node.conn || !node.conn.server || !node.conn.key) {
                return cb({ ok: false, message: '未配置服务器（请在节点中选择「服务器配置」并填好 Key）' });
            }
            reason = String(reason || '').trim();
            if (!reason) return cb({ ok: false, message: '上传原因不能为空' });
            if (reason.length > 200) reason = reason.slice(0, 200);

            node.uploading = true;
            node.status({ fill: 'blue', shape: 'dot', text: '上传中…' });

            var done = function (result) {
                node.uploading = false;
                if (result.ok) {
                    node.status({ fill: 'green', shape: 'dot', text: '上传成功 ' + nowText() });
                } else {
                    node.status({ fill: 'red', shape: 'dot', text: result.message });
                }
                cb(result);
            };

            var file = resolveFlowsFile();
            var content;
            try {
                var st = fs.statSync(file);
                if (st.size > MAX_BYTES) {
                    return done({ ok: false, message: 'flows.json 超过 10MB 上限（' + Math.round(st.size / 1024) + 'KB）' });
                }
                content = fs.readFileSync(file, 'utf8');
            } catch (e) {
                return done({ ok: false, message: '读取 flows.json 失败：' + file });
            }

            var body;
            try {
                body = JSON.stringify({
                    reason: reason,
                    content: content,
                    sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
                    node_port: getNodeRedPort()
                });
            } catch (e) {
                return done({ ok: false, message: '序列化失败：' + e.message });
            }

            var mod = node.conn.https ? https : http;
            var req;
            try {
                req = mod.request({
                    host: node.conn.server,
                    port: node.conn.port,
                    path: node.conn.basePath + '/site-health/flows/upload',
                    method: 'POST',
                    timeout: 30000, // 文件可能有几 MB，超时放宽到 30s
                    headers: {
                        'Authorization': 'Bearer ' + node.conn.key,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body)
                    }
                }, function (res) {
                    var respBody = '';
                    res.on('data', function (c) { respBody += c; });
                    res.on('end', function () {
                        var j = null;
                        try { j = JSON.parse(respBody); } catch (e) { j = null; }
                        if (j && j.data && typeof j.data === 'object') {
                            return done({
                                ok: j.data.ok === true,
                                message: j.data.message || (j.data.ok ? '上传成功' : '上传被拒（' + (j.data.reason || '?') + '）')
                            });
                        }
                        if (j && (j.success === false || (typeof j.code === 'number' && j.code >= 400))) {
                            return done({ ok: false, message: j.message || j.msg || '服务端拒绝' });
                        }
                        done({
                            ok: res.statusCode >= 200 && res.statusCode < 300,
                            message: 'HTTP ' + res.statusCode
                        });
                    });
                });
            } catch (e) {
                return done({ ok: false, message: '请求创建失败：' + e.message });
            }
            req.on('timeout', function () { req.destroy(new Error('timeout')); });
            req.on('error', function (e) {
                done({ ok: false, message: '连接失败：' + (e && e.message ? e.message : '网络不可达') });
            });
            req.write(body);
            req.end();
        };

        if (!node.conn) {
            node.status({ fill: 'red', shape: 'ring', text: '未选择服务器配置' });
        } else {
            node.status({ fill: 'grey', shape: 'ring', text: '待命（点击按钮上传）' });
        }

        node.on('close', function (done) { done(); });
    }

    RED.nodes.registerType('site-flows-upload', SiteFlowsUploadNode);

    // ===== 编辑器按钮 → 运行时 的触发通道（参照 inject 按钮机制）=====
    var needsPermission = null;
    try {
        if (RED.auth && typeof RED.auth.needsPermission === 'function') {
            needsPermission = RED.auth.needsPermission('site-flows-upload.write');
        }
    } catch (e) { /* 老版本无 auth：不挂权限中间件 */ }
    var middlewares = needsPermission ? [needsPermission] : [];

    middlewares.push(function (req, res) {
        var node = RED.nodes.getNode(req.params.id);
        if (!node || typeof node.doUpload !== 'function') {
            res.status(404).json({ ok: false, message: '节点不存在或未部署' });
            return;
        }
        readBody(req, function (body) {
            var reason = body && body.reason;
            try {
                node.doUpload(reason, function (result) {
                    res.status(result.ok ? 200 : 400).json(result);
                });
            } catch (e) {
                res.status(500).json({ ok: false, message: '上传异常：' + e.message });
            }
        });
    });

    RED.httpAdmin.post.apply(RED.httpAdmin, ['/site-flows-upload/:id/upload'].concat(middlewares));
};
