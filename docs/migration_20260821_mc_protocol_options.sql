-- ============================================================
-- MC 以太网驱动增加「传输协议 tcp/udp」与「通信数据代码 binary/ascii_q/ascii_slmp」配置项
-- 背景：npm 采集节点（node-red-contrib-mitsubishi v1.4.4+/v1.7.0+）早已支持
--       plc.protocol(tcp|udp) 与 plc.commCode(binary|ascii_q|ascii_slmp)，
--       但平台配置链（驱动 schema → 动态表单 → protocolParams → 边缘）未暴露这两项。
-- 本脚本只更新 mitsubishi_mc 的 config_schema；串口驱动(mitsubishi_mc_serial)不适用。
-- 执行后即时生效：设备表单出现两个新下拉，值存入 protocolParams 并随快照下发边缘。
-- ============================================================
UPDATE plc_driver SET config_schema = '{
  "fields": [
    {"name": "mcFrame", "type": "select", "label": "帧格式", "default": "3E", "options": ["3E", "4E"], "required": true},
    {"name": "protocol", "type": "select", "label": "传输协议", "default": "tcp", "options": ["tcp", "udp"], "required": true, "comment": "MC以太网传输层：tcp=面向连接（默认，推荐）; udp=无连接低延迟"},
    {"name": "commCode", "type": "select", "label": "通信数据代码", "default": "binary", "options": ["binary", "ascii_q", "ascii_slmp"], "required": true, "comment": "binary=二进制帧（默认）; ascii_q=Q/L/E71软元件名式ASCII; ascii_slmp=FX5/iQ-R hex直译式ASCII"},
    {"name": "stationNo", "type": "number", "label": "站号", "default": 0, "min": 0, "max": 255, "required": true},
    {"name": "networkNo", "type": "number", "label": "网络号", "default": 0, "min": 0, "max": 255, "required": true},
    {"name": "plcPort", "type": "number", "label": "PLC 端口", "default": 5007, "min": 1, "max": 65535, "required": true}
  ]
}'
WHERE driver_code = 'mitsubishi_mc';
