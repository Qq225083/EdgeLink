-- ============================================================
-- 西门子 S7 驱动接入：plc_driver 种子 + protocol_compat 映射
-- 背景：新增 node-red-contrib-edgelink-s7 包（包装 @st-one-io/nodes7 纯 JS S7 栈）。
--       本迁移把 S7 驱动注册进配置链：设备表单通信方式出现「S7 协议」，
--       协议参数区块出现 rack/slot，寄存器类型为 DB/M/I/Q（TIA 风格地址）。
-- 注意：S7 字节序固定大端，位寻址走地址语法（DBX0.0/M0.1），无独立位偏移字段。
-- ============================================================

INSERT IGNORE INTO plc_driver (driver_code, driver_name, node_red_node_type, config_schema, register_types, data_types, address_pattern, bit_offset_supported, byte_order_supported, word_order_supported, enabled, sort_order) VALUES
('siemens_s7', '西门子 S7 协议（以太网）', 's7-read', '{
  "fields": [
    {"name": "rack", "type": "number", "label": "机架号 rack", "default": 0, "min": 0, "max": 7, "required": true, "comment": "S7-1200/1500=0；S7-300=0"},
    {"name": "slot", "type": "number", "label": "槽位 slot", "default": 1, "min": 0, "max": 31, "required": true, "comment": "S7-1200/1500=1；S7-300=2（CPU 槽位）"},
    {"name": "plcPort", "type": "number", "label": "PLC 端口", "default": 102, "min": 1, "max": 65535, "required": true, "comment": "S7 协议固定 102"}
  ]
}', '[
  {"value": "DB", "label": "DB（数据块，如 DB1.DBW0）", "dataTypes": ["BOOL", "INT16", "UINT16", "INT32", "UINT32", "FLOAT"]},
  {"value": "M", "label": "M（标志位/内存，如 MW10）", "dataTypes": ["BOOL", "INT16", "UINT16", "INT32", "UINT32", "FLOAT"]},
  {"value": "I", "label": "I（输入映像，如 IW0）", "dataTypes": ["BOOL", "INT16", "UINT16", "INT32", "UINT32", "FLOAT"]},
  {"value": "Q", "label": "Q（输出映像，如 QW0）", "dataTypes": ["BOOL", "INT16", "UINT16", "INT32", "UINT32", "FLOAT"]}
]', '[
  {"value": "BIT", "label": "BIT", "bitOffsetSupport": false, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "BOOL", "label": "BOOL", "bitOffsetSupport": false, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "INT16", "label": "INT16", "bitOffsetSupport": false, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "UINT16", "label": "UINT16", "bitOffsetSupport": false, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "INT32", "label": "INT32", "bitOffsetSupport": false, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "UINT32", "label": "UINT32", "bitOffsetSupport": false, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "FLOAT", "label": "FLOAT", "bitOffsetSupport": false, "byteOrderSupport": false, "wordOrderSupport": false}
]', '^(DB[0-9]+\\.DB[WDX][0-9]+(\\.[0-7])?|[MIQ][WD]?[0-9]+(\\.[0-7])?)$', 0, 0, 0, 1, 3);

-- 西门子各系列的 S7 协议映射（寄存器类型 DB/M/I/Q）
INSERT IGNORE INTO plc_protocol_compat (plc_brand, plc_series, com_type, driver_code, is_default_com_type, register_type, register_type_label, sort_order) VALUES
('Siemens', 'S7-1200', 'S7', 'siemens_s7', 1, 'DB', 'DB（数据块，如 DB1.DBW0）', 1),
('Siemens', 'S7-1200', 'S7', 'siemens_s7', 1, 'M', 'M（标志位，如 MW10）', 2),
('Siemens', 'S7-1200', 'S7', 'siemens_s7', 1, 'I', 'I（输入映像，如 IW0）', 3),
('Siemens', 'S7-1200', 'S7', 'siemens_s7', 1, 'Q', 'Q（输出映像，如 QW0）', 4),
('Siemens', 'S7-1500', 'S7', 'siemens_s7', 1, 'DB', 'DB（数据块，如 DB1.DBW0）', 1),
('Siemens', 'S7-1500', 'S7', 'siemens_s7', 1, 'M', 'M（标志位，如 MW10）', 2),
('Siemens', 'S7-1500', 'S7', 'siemens_s7', 1, 'I', 'I（输入映像，如 IW0）', 3),
('Siemens', 'S7-1500', 'S7', 'siemens_s7', 1, 'Q', 'Q（输出映像，如 QW0）', 4),
('Siemens', 'S7-300/400', 'S7', 'siemens_s7', 1, 'DB', 'DB（数据块，如 DB1.DBW0）', 1),
('Siemens', 'S7-300/400', 'S7', 'siemens_s7', 1, 'M', 'M（标志位，如 MW10）', 2),
('Siemens', 'S7-300/400', 'S7', 'siemens_s7', 1, 'I', 'I（输入映像，如 IW0）', 3),
('Siemens', 'S7-300/400', 'S7', 'siemens_s7', 1, 'Q', 'Q（输出映像，如 QW0）', 4),
('Siemens', 'S7-200 Smart', 'S7', 'siemens_s7', 1, 'DB', 'DB（数据块，如 DB1.DBW0）', 1),
('Siemens', 'S7-200 Smart', 'S7', 'siemens_s7', 1, 'M', 'M（标志位，如 MW10）', 2),
('Siemens', 'S7-200 Smart', 'S7', 'siemens_s7', 1, 'I', 'I（输入映像，如 IW0）', 3),
('Siemens', 'S7-200 Smart', 'S7', 'siemens_s7', 1, 'Q', 'Q（输出映像，如 QW0）', 4);
