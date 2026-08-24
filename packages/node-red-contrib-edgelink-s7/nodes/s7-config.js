/**
 * s7-config — 西门子 S7 PLC 连接配置节点
 * 保存 IP、端口、机架/槽位等连接参数，供 s7-read 节点引用
 * （S7-1200/1500 通常 rack=0 slot=1；S7-300 通常 rack=0 slot=2；S7-400 按硬件组态）
 */
module.exports = function (RED) {
  'use strict';

  function S7ConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name || 'S7-1';
    this.host = config.host || '192.168.1.10';
    var port = parseInt(config.port, 10);
    this.port = isNaN(port) ? 102 : port;
    var rack = parseInt(config.rack, 10);
    this.rack = isNaN(rack) ? 0 : rack;
    var slot = parseInt(config.slot, 10);
    this.slot = isNaN(slot) ? 1 : slot;
    var t = parseInt(config.timeout, 10);
    this.timeout = isNaN(t) ? 3000 : t;
    var mr = parseInt(config.maxRetries, 10);
    this.maxRetries = isNaN(mr) ? 2 : mr;
    var ri = parseInt(config.retryInterval, 10);
    this.retryInterval = isNaN(ri) ? 300 : ri;
  }

  RED.nodes.registerType('s7-config', S7ConfigNode);
};
