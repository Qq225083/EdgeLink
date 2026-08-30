/**
 * site-health.js — 采集点健康度监视节点 v1.0.0
 *
 * 职责：定期采集本机 Node-RED 的运行信息（进程/整机内存、运行流数量、版本、运行时长），
 *       经 HTTP 直连上报到后端「存量采集点监控」的 /site-health/report 接口。
 *
 * 与 V12 采集体系完全解耦：
 *   - 不依赖 config-manager / MQTT / JWT，仅凭登记时下发的一次性 key 上报。
 *   - 零第三方依赖，只用 Node 内置 http/https/os，兼容旧版 Node-RED（>=1.0）。
 *   - 只读、旁观，不触碰任何既有采集消息流。
 *
 * 安全与健壮性纪律（对应设计评审 6 条）：
 *   1) 全部 try/catch，异常只走 node.error/status，绝不向上抛导致进程崩溃。
 *   2) 全程异步 HTTP + 纳秒级内存采集，不阻塞事件循环，不影响高频轮询。
 *   3) key 用 credential 机制存储（flows_cred.json），明文不入 flows.json。
 *   4) on('close') 清理定时器，避免 redeploy 后心跳翻倍。
 *   5) HTTP 超时 + 失败指数退避（封顶 5 分钟），后端宕机不刷爆连接/日志。
 *   6) setTimeout 链式调度 + inFlight 守卫，天然不重叠。
 */
module.exports = function (RED) {
    'use strict';
    var http = require('http');
    var https = require('https');
    var os = require('os');

    var MB = 1024 * 1024;

    function getNodeRedVersion() {
        try {
            if (typeof RED.version === 'function') return String(RED.version() || '');
        } catch (e) { /* ignore */ }
        try {
            if (RED.settings && RED.settings.version) return String(RED.settings.version);
        } catch (e) { /* ignore */ }
        return '';
    }

    function getNodeRedPort() {
        // 上报 Node-RED 监听端口，用于区分同一 IP 上的多个 Node-RED 实例（如 8000/8001）
        try {
            if (RED.settings && RED.settings.uiPort) return parseInt(RED.settings.uiPort, 10) || 0;
        } catch (e) { /* ignore */ }
        return 0;
    }

    function countRunningFlows() {
        // 统计已部署的 flow 页签数量（按节点的 z 去重）
        var flows = {};
        try {
            if (typeof RED.nodes.eachNode === 'function') {
                RED.nodes.eachNode(function (n) {
                    if (n && n.z) flows[n.z] = true;
                });
            }
        } catch (e) { /* ignore */ }
        return Object.keys(flows).length;
    }

    function SiteHealthNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        node.name = config.name || '采集点健康度';
        node.server = (config.server || '').trim();
        node.port = parseInt(config.port, 10) || 80;
        node.https = config.https === true;
        node.interval = parseInt(config.interval, 10) || 30;
        node.interval = Math.max(10, Math.min(180, node.interval));
        // 接口路径前缀：系统部署在子目录/反向代理下时填前缀（如 /prod-api），直连后端留空
        node.basePath = (config.basePath || '').trim().replace(/\/+$/, '');
        // key 来自 credential（flows_cred.json），明文不进 flows.json
        node.key = (node.credentials && node.credentials.key) || '';

        node.timer = null;
        node.inFlight = false;
        node.consecutiveFails = 0;

        function setRed(text) { node.status({ fill: 'red', shape: 'dot', text: text }); }
        function setYellow(text) { node.status({ fill: 'yellow', shape: 'dot', text: text }); }
        function setGreen(text) { node.status({ fill: 'green', shape: 'dot', text: text }); }

        function collect() {
            return {
                interval: node.interval,
                memory_rss_mb: Math.round(process.memoryUsage().rss / MB),
                memory_total_mb: Math.round(os.totalmem() / MB),
                memory_free_mb: Math.round(os.freemem() / MB),
                running_flows: countRunningFlows(),
                node_red_version: getNodeRedVersion(),
                uptime_sec: Math.round(process.uptime()),
                node_port: getNodeRedPort()
            };
        }

        function buildPath(metrics) {
            var qs = Object.keys(metrics).map(function (k) {
                return encodeURIComponent(k) + '=' + encodeURIComponent(String(metrics[k]));
            }).join('&');
            return node.basePath + '/site-health/report?' + qs;
        }

        function send() {
            if (node.inFlight) return;

            if (!node.key) { setRed('未配置密钥 Key'); return; }
            if (!node.server) { setRed('未配置服务器 IP'); return; }

            node.inFlight = true;
            var metrics = collect();
            var mod = node.https ? https : http;
            var req = mod.request({
                host: node.server,
                port: node.port,
                path: buildPath(metrics),
                method: 'POST',
                timeout: 5000,
                // key 走 Authorization 头，不进 URL，避免落入访问日志
                headers: { 'Authorization': 'Bearer ' + node.key }
            }, function (res) {
                var body = '';
                res.on('data', function (c) { body += c; });
                res.on('end', function () {
                    node.inFlight = false;
                    handleResponse(res.statusCode, body, metrics);
                });
            });

            // 传入 error 触发 'error' 事件复位 inFlight：老版本 Node 上无参 destroy() 可能不发 'error'
            req.on('timeout', function () { req.destroy(new Error('timeout')); });
            req.on('error', function () {
                node.inFlight = false;
                node.consecutiveFails++;
                setYellow('连接失败，退避重试');
                scheduleNext();
            });
            req.end();
        }

        function parseResult(statusCode, body) {
            var j = null;
            try { j = JSON.parse(body); } catch (e) { j = null; }
            // 后端成功/停用/密钥无效都走 2xx，业务结果在 data 里（ok/disabled/reason）
            if (j && j.data && typeof j.data === 'object') {
                return {
                    ok: j.data.ok !== false,
                    disabled: j.data.disabled === true,
                    reason: j.data.reason || null
                };
            }
            // 全局异常信封：HTTP 200 但 body 里 success=false / code>=400（如限流）
            if (j && (j.success === false || (typeof j.code === 'number' && j.code >= 400))) {
                return { ok: false, disabled: false, reason: 'error' };
            }
            // 非 JSON 或无明确标记：按 HTTP 状态兜底
            return { ok: statusCode >= 200 && statusCode < 300, disabled: false, reason: null };
        }

        function handleResponse(statusCode, body, metrics) {
            var r = parseResult(statusCode, body);

            // 密钥无效 / 未授权：停止心跳（重试不会自愈，需人工重配），避免刷接口
            if (r.reason === 'invalid_key' || statusCode === 401 || statusCode === 403) {
                stop('Key 无效或未授权，请重新配置');
                return;
            }
            // 上报 IP/端口与登记不符：修复可能发生在服务端（改登记信息），
            // 低频重探（300s）等待修正后自动恢复，不永久停止
            if (r.reason === 'ip_mismatch' || r.reason === 'port_mismatch') {
                node.consecutiveFails = 0;
                setYellow('上报IP/端口与登记不符，等待修正');
                scheduleNext(300);
                return;
            }
            if (r.disabled) {
                node.consecutiveFails = 0;
                setYellow('采集点已停用');
                scheduleNext(300); // 停用后低频重探，前端重新启用后可自动续报
                return;
            }
            if (r.ok) {
                node.consecutiveFails = 0;
                setGreen('正常 · 进程 ' + metrics.memory_rss_mb + 'MB');
                scheduleNext();
                return;
            }
            // 其余失败（限流/服务端错误/连接异常）→ 指数退避重试
            node.consecutiveFails++;
            setYellow('上报失败，退避重试');
            scheduleNext();
        }

        function scheduleNext(forcedDelaySec) {
            if (node.timer) clearTimeout(node.timer);
            var delaySec = forcedDelaySec || node.interval;
            if (!forcedDelaySec && node.consecutiveFails > 0) {
                delaySec = Math.min(300, node.interval * Math.pow(2, node.consecutiveFails - 1));
            }
            node.timer = setTimeout(send, delaySec * 1000);
        }

        function stop(text) {
            if (node.timer) { clearTimeout(node.timer); node.timer = null; }
            setRed(text || '已停止');
        }

        node.on('close', function (done) {
            if (node.timer) { clearTimeout(node.timer); node.timer = null; }
            node.inFlight = false;
            done();
        });

        // 启动：部署后 1 秒首报，便于现场尽快看到状态灯
        if (node.key && node.server) {
            node.status({ fill: 'grey', shape: 'dot', text: '即将上报' });
            node.timer = setTimeout(send, 1000);
        } else {
            setRed('未配置：需服务器 IP + 密钥 Key');
        }
    }

    RED.nodes.registerType('site-health', SiteHealthNode, {
        credentials: {
            key: { type: 'password' }
        }
    });
};
