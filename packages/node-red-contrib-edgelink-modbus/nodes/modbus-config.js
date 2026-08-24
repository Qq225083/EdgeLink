/**
 * modbus-config — Modbus 连接配置节点（TCP / RTU 串口）
 *
 * v1.5.0: RTU 串口参数 — serialPort 非空即走 RTU（否则 TCP，行为不变）
 */
module.exports = function (RED) {
  'use strict';

  function ModbusConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name || 'Modbus-1';
    this.host = config.host || '192.168.1.10';
    var port = parseInt(config.port, 10);
    this.port = isNaN(port) ? 502 : port;
    var uid = parseInt(config.unitId, 10);
    this.unitId = isNaN(uid) ? 1 : uid;
    var t = parseInt(config.timeout, 10);
    this.timeout = isNaN(t) ? 3000 : t;
    var mr = parseInt(config.maxRetries, 10);
    this.maxRetries = isNaN(mr) ? 2 : mr;
    var ri = parseInt(config.retryInterval, 10);
    this.retryInterval = isNaN(ri) ? 300 : ri;
    // RTU 串口参数（serialPort 留空 = TCP）
    this.serialPort = (config.serialPort || '').trim();
    var br = parseInt(config.baudRate, 10);
    this.baudRate = isNaN(br) ? 9600 : br;
    var db = parseInt(config.dataBits, 10);
    this.dataBits = isNaN(db) ? 8 : db;
    this.parity = config.parity || 'none';
    var sb = parseInt(config.stopBits, 10);
    this.stopBits = isNaN(sb) ? 1 : sb;
  }

  RED.nodes.registerType('modbus-config', ModbusConfigNode);
};
