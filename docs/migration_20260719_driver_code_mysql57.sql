-- EdgeLink 动态驱动架构 Day 1 数据库迁移脚本（MySQL 5.7 兼容版）
-- 适用场景：已有 MySQL 5.7 数据库实例升级到支持 driver_code / plc_driver 的版本
-- 说明：
--   1. 使用 information_schema 判断列/表是否存在，避免 IF NOT EXISTS 语法错误。
--   2. 所有历史映射未知的记录统一用 'UNKNOWN'，应用层必须对 'UNKNOWN' 报错，禁止静默 fallback。
--   3. 设备回填使用子查询 + ORDER BY sort_order LIMIT 1，避免 UPDATE ... JOIN 多行匹配随机选行。
--   4. 本脚本可重复执行（所有操作均为幂等）。

-- ========== 1. 新增驱动元数据表（若不存在） ==========
CREATE TABLE IF NOT EXISTS plc_driver (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    driver_code VARCHAR(50) NOT NULL UNIQUE COMMENT '驱动编码（如 mitsubishi_mc / modbus_tcp）',
    driver_name VARCHAR(100) NOT NULL COMMENT '驱动显示名称',
    node_red_node_type VARCHAR(100) NOT NULL COMMENT 'Node-RED 节点类型名',
    config_schema JSON NOT NULL COMMENT '设备级协议参数 schema',
    register_types JSON NOT NULL COMMENT '支持的寄存器类型',
    data_types JSON NOT NULL COMMENT '支持的数据类型',
    address_pattern VARCHAR(255) COMMENT '寄存器地址校验正则',
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

-- 兼容：如果 plc_driver 表已存在但缺少 schema_version，则追加
DROP PROCEDURE IF EXISTS add_plc_driver_schema_version;
DELIMITER $$
CREATE PROCEDURE add_plc_driver_schema_version()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'plc_driver'
          AND column_name = 'schema_version'
    ) THEN
        ALTER TABLE plc_driver ADD COLUMN schema_version INT DEFAULT 1 COMMENT 'schema 版本';
    END IF;
END$$
DELIMITER ;
CALL add_plc_driver_schema_version();
DROP PROCEDURE add_plc_driver_schema_version;

-- ========== 1b. 初始化驱动元数据（幂等：已存在则跳过） ==========
INSERT IGNORE INTO plc_driver (driver_code, driver_name, node_red_node_type, config_schema, register_types, data_types, address_pattern, bit_offset_supported, byte_order_supported, word_order_supported, enabled, sort_order) VALUES
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
]', '^[0-9]+$', 1, 1, 1, 1, 1),
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
]', '^[0-9]+$', 1, 1, 1, 1, 2),
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
]', '^[0-9]+$', 1, 1, 1, 0, 99),
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

-- ========== 2. 给设备表增加 driver_code（若不存在） ==========
DROP PROCEDURE IF EXISTS add_plc_device_driver_code;
DELIMITER $$
CREATE PROCEDURE add_plc_device_driver_code()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'plc_device'
          AND column_name = 'driver_code'
    ) THEN
        ALTER TABLE plc_device ADD COLUMN driver_code VARCHAR(50) NULL COMMENT '驱动编码（对应 plc_driver.driver_code）';
    END IF;
END$$
DELIMITER ;
CALL add_plc_device_driver_code();
DROP PROCEDURE add_plc_device_driver_code;

-- ========== 3. 给协议兼容表增加 driver_code（若不存在） ==========
DROP PROCEDURE IF EXISTS add_plc_protocol_compat_driver_code;
DELIMITER $$
CREATE PROCEDURE add_plc_protocol_compat_driver_code()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'plc_protocol_compat'
          AND column_name = 'driver_code'
    ) THEN
        ALTER TABLE plc_protocol_compat ADD COLUMN driver_code VARCHAR(50) NOT NULL DEFAULT 'UNKNOWN' COMMENT '驱动编码（对应 plc_driver.driver_code）';
    END IF;
END$$
DELIMITER ;
CALL add_plc_protocol_compat_driver_code();
DROP PROCEDURE add_plc_protocol_compat_driver_code;

-- 如果之前已存在且默认值为 'modbus_tcp'，也统一改为 'UNKNOWN'
ALTER TABLE plc_protocol_compat ALTER COLUMN driver_code SET DEFAULT 'UNKNOWN';

-- ========== 4. 更新协议兼容表历史数据 ==========
UPDATE plc_protocol_compat SET driver_code = 'mitsubishi_mc' WHERE plc_brand = 'Mitsubishi' AND com_type IN ('MC_Protocol', 'GOT');
UPDATE plc_protocol_compat SET driver_code = 'modbus_tcp' WHERE com_type = 'Modbus_TCP';
UPDATE plc_protocol_compat SET driver_code = 'mitsubishi_mc_serial' WHERE plc_brand = 'Mitsubishi' AND com_type = 'PLC_RS232C';

-- 西门子/欧姆龙 RS232C 的真实协议不是 Modbus，当前没有对应驱动时，宁可标记为 UNKNOWN，也不要错误默认
UPDATE plc_protocol_compat SET driver_code = 'UNKNOWN' WHERE plc_brand = 'Siemens' AND com_type = 'PLC_RS232C';
UPDATE plc_protocol_compat SET driver_code = 'UNKNOWN' WHERE plc_brand = 'Omron' AND com_type = 'PLC_RS232C';

-- 任何仍未匹配到的记录保持 UNKNOWN，应用层必须显式处理

-- ========== 5. 回填设备表历史数据（确定性：取 sort_order 最小的第一条） ==========
UPDATE plc_device d
SET d.driver_code = (
    SELECT c.driver_code
    FROM plc_protocol_compat c
    WHERE c.plc_brand = d.plc_brand
      AND c.plc_series = d.plc_series
      AND c.com_type = d.com_type
    ORDER BY c.sort_order
    LIMIT 1
)
WHERE d.driver_code IS NULL;

-- ========== 6. 确保没有 driver_code 的设备标记为 UNKNOWN（兼容异常数据） ==========
UPDATE plc_device SET driver_code = 'UNKNOWN' WHERE driver_code IS NULL;

-- ========== 7. 回填完成后把 driver_code 改为 NOT NULL，避免后续出现 NULL 扩散 ==========
ALTER TABLE plc_device MODIFY COLUMN driver_code VARCHAR(50) NOT NULL COMMENT '驱动编码（对应 plc_driver.driver_code）';

-- ========== 8. 索引（若不存在） ==========
DROP PROCEDURE IF EXISTS add_plc_protocol_compat_idx;
DELIMITER $$
CREATE PROCEDURE add_plc_protocol_compat_idx()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'plc_protocol_compat'
          AND index_name = 'idx_plc_protocol_compat_brand_series_com'
    ) THEN
        CREATE INDEX idx_plc_protocol_compat_brand_series_com ON plc_protocol_compat (plc_brand, plc_series, com_type);
    END IF;
END$$
DELIMITER ;
CALL add_plc_protocol_compat_idx();
DROP PROCEDURE add_plc_protocol_compat_idx;
