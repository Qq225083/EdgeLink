-- EdgeLink PLC 驱动元数据表
-- 用于「后端配置驱动，前端协议可插拔」架构：
--   1. 前端通过 /plc/driver/list 动态渲染设备协议参数表单
--   2. 前端通过 /plc/driver/{driver_code}/schema 获取寄存器类型、数据类型、地址校验规则
--   3. Node-RED 通过 driverCode 查找 node_red_node_type 并实例化对应采集节点

CREATE TABLE IF NOT EXISTS plc_driver (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    driver_code VARCHAR(50) NOT NULL UNIQUE COMMENT '驱动编码（如 mitsubishi_mc / modbus_tcp）',
    driver_name VARCHAR(100) NOT NULL COMMENT '驱动显示名称',
    node_red_node_type VARCHAR(100) NOT NULL COMMENT 'Node-RED 节点类型名（如 mitsubishi-read / modbus-read）',
    config_schema JSON NOT NULL COMMENT '设备级协议参数 schema（字段列表、类型、默认值、必填、校验规则）',
    register_types JSON NOT NULL COMMENT '支持的寄存器类型 [{value, label, dataTypes:[...]}]',
    data_types JSON NOT NULL COMMENT '支持的数据类型 [{value, label, bitOffsetSupport, byteOrderSupport, wordOrderSupport}]',
    address_pattern VARCHAR(255) COMMENT '寄存器地址校验正则（可选）',
    bit_offset_supported TINYINT(1) DEFAULT 0 COMMENT '是否支持位偏移',
    byte_order_supported TINYINT(1) DEFAULT 0 COMMENT '是否支持字节序',
    word_order_supported TINYINT(1) DEFAULT 0 COMMENT '是否支持字序',
    enabled TINYINT(1) DEFAULT 1 COMMENT '是否启用',
    schema_version INT DEFAULT 1 COMMENT 'schema 版本，便于后续演进',
    sort_order INT DEFAULT 0 COMMENT '排序',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    remark VARCHAR(500) COMMENT '备注'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PLC 驱动元数据表';

-- ========== 三菱 MC Protocol 驱动 ==========
INSERT INTO plc_driver (driver_code, driver_name, node_red_node_type, config_schema, register_types, data_types, address_pattern, bit_offset_supported, byte_order_supported, word_order_supported, enabled, sort_order) VALUES
('mitsubishi_mc', '三菱 MC 协议（以太网）', 'mitsubishi-read', '{
  "fields": [
    {"name": "mcFrame", "type": "select", "label": "帧格式", "options": ["3E", "4E"], "default": "3E", "required": true},
    {"name": "stationNo", "type": "number", "label": "站号", "default": 0, "min": 0, "max": 255, "required": true},
    {"name": "networkNo", "type": "number", "label": "网络号", "default": 0, "min": 0, "max": 255, "required": true},
    {"name": "plcPort", "type": "number", "label": "PLC 端口", "default": 5007, "min": 1, "max": 65535, "required": true}
  ]
}', '[
  {"value": "D", "label": "D（数据寄存器）", "dataTypes": ["INT16", "UINT16", "INT32", "UINT32", "FLOAT", "DOUBLE"]},
  {"value": "W", "label": "W（链接寄存器）", "dataTypes": ["INT16", "UINT16", "INT32", "UINT32", "FLOAT", "DOUBLE"]},
  {"value": "R", "label": "R（文件寄存器）", "dataTypes": ["INT16", "UINT16", "INT32", "UINT32", "FLOAT", "DOUBLE"]},
  {"value": "X", "label": "X（输入）", "dataTypes": ["BIT", "BOOL"]},
  {"value": "Y", "label": "Y（输出）", "dataTypes": ["BIT", "BOOL"]},
  {"value": "M", "label": "M（内部继电器）", "dataTypes": ["BIT", "BOOL"]},
  {"value": "L", "label": "L（锁存继电器）", "dataTypes": ["BIT", "BOOL"]},
  {"value": "B", "label": "B（链接继电器）", "dataTypes": ["BIT", "BOOL"]}
]', '[
  {"value": "BIT", "label": "BIT", "bitOffsetSupport": true, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "BOOL", "label": "BOOL", "bitOffsetSupport": true, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "INT16", "label": "INT16", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": false},
  {"value": "UINT16", "label": "UINT16", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": false},
  {"value": "INT32", "label": "INT32", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "UINT32", "label": "UINT32", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "FLOAT", "label": "FLOAT", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "DOUBLE", "label": "DOUBLE", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true}
]', '^[0-9]+$', 1, 1, 1, 1, 1);

-- ========== Modbus TCP 驱动 ==========
INSERT INTO plc_driver (driver_code, driver_name, node_red_node_type, config_schema, register_types, data_types, address_pattern, bit_offset_supported, byte_order_supported, word_order_supported, enabled, sort_order) VALUES
('modbus_tcp', 'Modbus TCP', 'modbus-read', '{
  "fields": [
    {"name": "unitId", "type": "number", "label": "Unit ID / 从站地址", "default": 1, "min": 1, "max": 247, "required": true},
    {"name": "plcPort", "type": "number", "label": "PLC 端口", "default": 502, "min": 1, "max": 65535, "required": true}
  ]
}', '[
  {"value": "HR", "label": "HR（保持寄存器）", "dataTypes": ["INT16", "UINT16", "INT32", "UINT32", "FLOAT", "DOUBLE"]},
  {"value": "IR", "label": "IR（输入寄存器）", "dataTypes": ["INT16", "UINT16", "INT32", "UINT32", "FLOAT", "DOUBLE"]},
  {"value": "CR", "label": "CR（线圈）", "dataTypes": ["BIT", "BOOL"]},
  {"value": "COIL", "label": "COIL（输出线圈）", "dataTypes": ["BIT", "BOOL"]},
  {"value": "DISCRETE", "label": "DISCRETE（离散输入）", "dataTypes": ["BIT", "BOOL"]}
]', '[
  {"value": "BIT", "label": "BIT", "bitOffsetSupport": true, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "BOOL", "label": "BOOL", "bitOffsetSupport": true, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "INT16", "label": "INT16", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": false},
  {"value": "UINT16", "label": "UINT16", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": false},
  {"value": "INT32", "label": "INT32", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "UINT32", "label": "UINT32", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "FLOAT", "label": "FLOAT", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "DOUBLE", "label": "DOUBLE", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true}
]', '^[0-9]+$', 1, 1, 1, 1, 2);

-- ========== 三菱 MC 串口透传驱动（预留占位） ==========
INSERT INTO plc_driver (driver_code, driver_name, node_red_node_type, config_schema, register_types, data_types, address_pattern, bit_offset_supported, byte_order_supported, word_order_supported, enabled, sort_order) VALUES
('mitsubishi_mc_serial', '三菱 MC 协议（串口透传）', 'mitsubishi-read', '{
  "fields": [
    {"name": "mcFrame", "type": "select", "label": "帧格式", "options": ["3E", "4E"], "default": "3E", "required": true},
    {"name": "stationNo", "type": "number", "label": "站号", "default": 0, "min": 0, "max": 255, "required": true},
    {"name": "networkNo", "type": "number", "label": "网络号", "default": 0, "min": 0, "max": 255, "required": true},
    {"name": "serialPort", "type": "text", "label": "串口号（如 COM1）", "default": "COM1", "required": true}
  ]
}', '[
  {"value": "D", "label": "D（数据寄存器）", "dataTypes": ["INT16", "UINT16", "INT32", "UINT32", "FLOAT", "DOUBLE"]},
  {"value": "X", "label": "X（输入）", "dataTypes": ["BIT", "BOOL"]},
  {"value": "Y", "label": "Y（输出）", "dataTypes": ["BIT", "BOOL"]},
  {"value": "M", "label": "M（内部继电器）", "dataTypes": ["BIT", "BOOL"]}
]', '[
  {"value": "BIT", "label": "BIT", "bitOffsetSupport": true, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "BOOL", "label": "BOOL", "bitOffsetSupport": true, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "INT16", "label": "INT16", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": false},
  {"value": "UINT16", "label": "UINT16", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": false},
  {"value": "INT32", "label": "INT32", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "UINT32", "label": "UINT32", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "FLOAT", "label": "FLOAT", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "DOUBLE", "label": "DOUBLE", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true}
]', '^[0-9]+$', 1, 1, 1, 0, 99);

-- ========== 西门子 S7 驱动（预留占位，后续实现） ==========
INSERT INTO plc_driver (driver_code, driver_name, node_red_node_type, config_schema, register_types, data_types, address_pattern, bit_offset_supported, byte_order_supported, word_order_supported, enabled, sort_order) VALUES
('siemens_s7', '西门子 S7 协议（ISO-on-TCP）', 'siemens-s7-read', '{
  "fields": [
    {"name": "rack", "type": "number", "label": "机架号（Rack）", "default": 0, "min": 0, "max": 7, "required": true},
    {"name": "slot", "type": "number", "label": "槽号（Slot）", "default": 1, "min": 0, "max": 31, "required": true},
    {"name": "plcPort", "type": "number", "label": "PLC 端口", "default": 102, "min": 1, "max": 65535, "required": true}
  ]
}', '[
  {"value": "DB", "label": "DB（数据块）", "dataTypes": ["INT16", "UINT16", "INT32", "UINT32", "FLOAT", "DOUBLE"]},
  {"value": "M", "label": "M（标志位）", "dataTypes": ["BIT", "BOOL"]},
  {"value": "I", "label": "I（输入）", "dataTypes": ["BIT", "BOOL"]},
  {"value": "Q", "label": "Q（输出）", "dataTypes": ["BIT", "BOOL"]}
]', '[
  {"value": "BIT", "label": "BIT", "bitOffsetSupport": true, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "BOOL", "label": "BOOL", "bitOffsetSupport": true, "byteOrderSupport": false, "wordOrderSupport": false},
  {"value": "INT16", "label": "INT16", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": false},
  {"value": "UINT16", "label": "UINT16", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": false},
  {"value": "INT32", "label": "INT32", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "UINT32", "label": "UINT32", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "FLOAT", "label": "FLOAT", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true},
  {"value": "DOUBLE", "label": "DOUBLE", "bitOffsetSupport": false, "byteOrderSupport": true, "wordOrderSupport": true}
]', '^[0-9]+(\\.[0-9]+)?$', 1, 1, 1, 0, 99);
