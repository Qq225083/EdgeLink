/**
 * edgelink-bootstrap.js — EdgeLink 边缘采集接入配置节点 v1.0.0
 *
 * 职责：把「后端地址 + 预分配密钥」从面板配置写入 Node-RED global context，
 *       供 config-manager 流程读取（edge_backendHost / edge_backendPort /
 *       edge_bootstrapKey / edge_bootstrapSecret / edge_hostPcIp）。
 *
 * 纪律（与 site-health 同款）：
 *   - 密钥走 credentials（flows_cred.json），明文不进 flows.json，导出自动脱敏；
 *   - 零输入零输出、零第三方依赖、只写 global，不触碰任何消息流；
 *   - 部署（实例化）时即写入，不等消息——config-manager 的启动 inject 晚于节点实例化，时序安全；
 *   - 空字段不覆盖（现场已用 settings.js 配置的机器不受影响）；
 *   - 单例约束：同一运行环境部署第二个实例即红灯告警（防配置打架）。
 */
module.exports = function (RED) {
    'use strict';

    // 进程级单例标记（deploy 重建时重置）
    var claimed = false;

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

        // 空字段不覆盖：只写入有值的项
        if (node.server) { g.set('edge_backendHost', node.server); }
        if (node.port) { g.set('edge_backendPort', node.port); }
        if (node.nodeKey) { g.set('edge_bootstrapKey', node.nodeKey); }
        if (node.secretKey) { g.set('edge_bootstrapSecret', node.secretKey); }
        if (node.hostPcIp) { g.set('edge_hostPcIp', node.hostPcIp); }

        // 单例检查
        if (claimed) {
            node.status({ fill: 'red', shape: 'ring', text: '接入配置只能部署一个，请删除多余节点' });
            node.error('[EdgeLink] 接入配置节点重复部署，仅首个生效');
            return;
        }
        claimed = true;
        node.on('close', function (removed, done) {
            claimed = false;
            if (done) { done(); }
        });

        if (!node.server || !node.secretKey) {
            node.status({ fill: 'red', shape: 'ring', text: '未配置：需后端地址 + 密钥' });
            return;
        }
        node.status({
            fill: 'green', shape: 'dot',
            text: '已生效：' + node.server + ':' + node.port + (node.nodeKey ? ' · ' + node.nodeKey : '')
        });
    }

    RED.nodes.registerType('edgelink-bootstrap', EdgeLinkBootstrapNode, {
        credentials: {
            secretKey: { type: 'password' }
        }
    });
};
