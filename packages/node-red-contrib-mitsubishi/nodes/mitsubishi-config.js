/**
 * mitsubishi-config — 三菱 PLC 连接配置节点
 * 保存 IP、端口、帧格式等连接参数，供 mitsubishi-read 节点引用
 */
module.exports = function (RED) {
  function MitsubishiConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name || 'PLC-1';
    this.host = config.host || '192.168.1.10';
    this.port = parseInt(config.port, 10) || 5007;
    this.frame = config.frame || '3E';
    this.series = config.series || 'Q';  // 🔧 v1.4.4: PLC 系列（X/Y 地址进制依赖：FX=8 进制，其余=16 进制）
    this.protocol = config.protocol || 'tcp';  // 🔧 v1.4.4: 传输协议 tcp|udp
    this.ascii = config.ascii === true || config.ascii === 'true';  // 🔧 v1.5.1: ASCII 通信模式
    this.networkNo = parseInt(config.networkNo, 10) || 0;
    this.stationNo = parseInt(config.stationNo, 10) || 0;
    this.timeout = parseInt(config.timeout, 10) || 3000;
    this.maxRetries = parseInt(config.maxRetries, 10);
    this.commCode = config.commCode;
    if (isNaN(this.maxRetries)) this.maxRetries = 2;
    this.retryInterval = parseInt(config.retryInterval, 10);
    if (isNaN(this.retryInterval)) this.retryInterval = 300;
  }
  RED.nodes.registerType('mitsubishi-config', MitsubishiConfigNode);
};
