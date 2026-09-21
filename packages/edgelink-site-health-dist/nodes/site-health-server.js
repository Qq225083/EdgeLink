/**
 * site-health-server.js — 存量监控共享服务器配置节点 v1.1.0
 *
 * 职责：集中维护「后端服务器地址/端口/路径前缀/HTTPS/密钥 Key」，
 *       供 site-health（心跳）与 site-flows-upload（flows.json 上传）两个节点引用。
 *
 * 好处：Key 只维护一处——重置密钥后只需改这一个配置节点，不用逐个改功能节点。
 *
 * 注意：这是 config 节点（无输入输出，不出现在左侧调色板），
 *       在任意功能节点的「服务器配置」下拉框里新建/选择。
 */
module.exports = function (RED) {
    'use strict';

    function SiteHealthServerNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name || '';
        this.server = (config.server || '').trim();
        this.port = parseInt(config.port, 10) || 80;
        this.https = config.https === true;
        this.basePath = (config.basePath || '').trim().replace(/\/+$/, '');
        // key 走 credential（flows_cred.json），明文不进 flows.json
        this.key = (this.credentials && this.credentials.key) || '';
    }

    RED.nodes.registerType('site-health-server', SiteHealthServerNode, {
        credentials: {
            key: { type: 'password' }
        }
    });
};
