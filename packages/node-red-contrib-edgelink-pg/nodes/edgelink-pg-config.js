/**
 * edgelink-pg-config.js — PG 连接配置节点 v1.1.1
 *
 * 职责：存储 PG 连接参数。Pool 生命周期由 edgelink-pg-store.js 中的 POOLS 管理。
 */
module.exports = function (RED) {
    'use strict';

    function EdgelinkPgConfig(n) {
        RED.nodes.createNode(this, n);
        this.name = n.name || 'PG-本地';
        this.host = n.host || '127.0.0.1';
        this.port = parseInt(n.port, 10) || 5432;
        this.database = n.database || 'ruoyi_pg';
        this.user = n.user || 'postgres';
        // 优先从节点配置读取，为空时从环境变量 PG_PASSWORD 读取（支持 Bootstrap/环境变量下发）
        this.password = typeof n.password === 'string' && n.password ? n.password : (process.env.PG_PASSWORD || '');
        this.maxConnections = parseInt(n.maxConnections, 10) || 10;
        this.idleTimeout = parseInt(n.idleTimeout, 10) || 30000;
        this.connectTimeout = parseInt(n.connectTimeout, 10) || 5000;
    }

    RED.nodes.registerType('edgelink-pg-config', EdgelinkPgConfig);
};
