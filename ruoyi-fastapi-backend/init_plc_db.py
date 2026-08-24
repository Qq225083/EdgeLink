"""PLC 模块数据库初始化脚本（v2 — 与 DO 模型完全对齐）"""
import pymysql
import os

_DB_PASS = os.environ.get('MYSQL_PASSWORD')
if not _DB_PASS:
    raise SystemExit('错误: 请先设置环境变量 MYSQL_PASSWORD（不再提供默认密码）')

conn = pymysql.connect(
    host='127.0.0.1',
    port=3308,
    user='root',
    password=_DB_PASS,
    database='ruoyi',
    autocommit=True
)
cur = conn.cursor()

# ===================================================================
# 0. 建表 plc_driver（驱动元数据表 —— 必须先存在，后续 device 的 driver_code 依赖它）
# ===================================================================
cur.execute("""
CREATE TABLE IF NOT EXISTS plc_driver (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    driver_code VARCHAR(50) NOT NULL UNIQUE COMMENT '驱动编码（如 mitsubishi_mc / modbus_tcp）',
    driver_name VARCHAR(100) NOT NULL COMMENT '驱动显示名称',
    node_red_node_type VARCHAR(100) NOT NULL COMMENT 'Node-RED 节点类型名（如 mitsubishi-read / modbus-read）',
    config_schema JSON NOT NULL COMMENT '设备级协议参数 schema',
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
""")
print('[OK] plc_driver 表')

cur.execute("""
INSERT IGNORE INTO plc_driver (driver_code, driver_name, node_red_node_type, config_schema, register_types, data_types, address_pattern, bit_offset_supported, byte_order_supported, word_order_supported, enabled, sort_order) VALUES
('mitsubishi_mc', '三菱 MC 协议（以太网）', 'mitsubishi-read', '{
  "fields": [
    {"name": "mcFrame", "type": "select", "label": "帧格式", "options": ["3E", "4E"], "default": "3E", "required": true},
    {"name": "protocol", "type": "select", "label": "传输协议", "options": ["tcp", "udp"], "default": "tcp", "required": true, "comment": "MC以太网传输层：tcp=面向连接（默认，推荐）; udp=无连接低延迟"},
    {"name": "commCode", "type": "select", "label": "通信数据代码", "options": ["binary", "ascii_q", "ascii_slmp"], "default": "binary", "required": true, "comment": "binary=二进制帧（默认）; ascii_q=Q/L/E71软元件名式ASCII; ascii_slmp=FX5/iQ-R hex直译式ASCII"},
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
""")
print('[OK] plc_driver 种子数据（4 条）')

# ===================================================================
# 0b. 建表 plc_protocol_compat（品牌→系列→通信方式→驱动 映射表）
# ===================================================================
cur.execute("""
CREATE TABLE IF NOT EXISTS plc_protocol_compat (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    plc_brand VARCHAR(50) NOT NULL,
    plc_series VARCHAR(50) NOT NULL,
    com_type VARCHAR(50) NOT NULL,
    driver_code VARCHAR(50) NOT NULL DEFAULT 'UNKNOWN' COMMENT '驱动编码（对应 plc_driver.driver_code）',
    is_default_com_type TINYINT(1) DEFAULT 0,
    register_type VARCHAR(20) NOT NULL,
    register_type_label VARCHAR(50),
    sort_order INT DEFAULT 0,
    UNIQUE KEY uk_compat_brand_series_com (plc_brand, plc_series, com_type, register_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PLC协议兼容映射表';
""")
print('[OK] plc_protocol_compat 表')

cur.execute("""
INSERT IGNORE INTO plc_protocol_compat (plc_brand, plc_series, com_type, driver_code, is_default_com_type, register_type, register_type_label, sort_order) VALUES
-- 三菱 MC Protocol
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',1,'D','D（数据寄存器）',1),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',1,'W','W（链接寄存器）',2),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',1,'X','X（输入）',3),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',1,'Y','Y（输出）',4),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',1,'M','M（内部继电器）',5),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',1,'L','L（锁存继电器）',6),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',1,'B','B（链接继电器）',7),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',1,'R','R（文件寄存器）',8),
('Mitsubishi','L','MC_Protocol','mitsubishi_mc',1,'D','D（数据寄存器）',1),
('Mitsubishi','L','MC_Protocol','mitsubishi_mc',1,'W','W（链接寄存器）',2),
('Mitsubishi','L','MC_Protocol','mitsubishi_mc',1,'X','X（输入）',3),
('Mitsubishi','L','MC_Protocol','mitsubishi_mc',1,'Y','Y（输出）',4),
('Mitsubishi','L','MC_Protocol','mitsubishi_mc',1,'M','M（内部继电器）',5),
('Mitsubishi','FX','MC_Protocol','mitsubishi_mc',1,'D','D（数据寄存器）',1),
('Mitsubishi','FX','MC_Protocol','mitsubishi_mc',1,'X','X（输入）',2),
('Mitsubishi','FX','MC_Protocol','mitsubishi_mc',1,'Y','Y（输出）',3),
('Mitsubishi','FX','MC_Protocol','mitsubishi_mc',1,'M','M（内部继电器）',4),
('Mitsubishi','iQ-R','MC_Protocol','mitsubishi_mc',1,'D','D（数据寄存器）',1),
('Mitsubishi','iQ-R','MC_Protocol','mitsubishi_mc',1,'W','W（链接寄存器）',2),
('Mitsubishi','iQ-R','MC_Protocol','mitsubishi_mc',1,'X','X（输入）',3),
('Mitsubishi','iQ-R','MC_Protocol','mitsubishi_mc',1,'Y','Y（输出）',4),
('Mitsubishi','iQ-R','MC_Protocol','mitsubishi_mc',1,'M','M（内部继电器）',5),
-- 三菱 Modbus TCP
('Mitsubishi','Q','Modbus_TCP','modbus_tcp',0,'HR','HR（保持寄存器）',1),
('Mitsubishi','Q','Modbus_TCP','modbus_tcp',0,'IR','IR（输入寄存器）',2),
('Mitsubishi','Q','Modbus_TCP','modbus_tcp',0,'CR','CR（线圈）',3),
('Mitsubishi','L','Modbus_TCP','modbus_tcp',0,'HR','HR（保持寄存器）',1),
('Mitsubishi','FX','Modbus_TCP','modbus_tcp',0,'HR','HR（保持寄存器）',1),
-- 三菱 GOT / RS-232C
('Mitsubishi','Q','GOT','mitsubishi_mc',0,'D','D（数据寄存器）',1),
('Mitsubishi','Q','GOT','mitsubishi_mc',0,'M','M（内部继电器）',2),
('Mitsubishi','L','GOT','mitsubishi_mc',0,'D','D（数据寄存器）',1),
('Mitsubishi','Q','PLC_RS232C','mitsubishi_mc_serial',0,'D','D（数据寄存器）',1),
('Mitsubishi','FX','PLC_RS232C','mitsubishi_mc_serial',0,'D','D（数据寄存器）',1),
-- 西门子 Modbus TCP
('Siemens','S7-1200','Modbus_TCP','modbus_tcp',1,'HR','HR（保持寄存器）',1),
('Siemens','S7-1200','Modbus_TCP','modbus_tcp',1,'IR','IR（输入寄存器）',2),
('Siemens','S7-1200','Modbus_TCP','modbus_tcp',1,'CR','CR（线圈）',3),
('Siemens','S7-1500','Modbus_TCP','modbus_tcp',1,'HR','HR（保持寄存器）',1),
('Siemens','S7-1500','Modbus_TCP','modbus_tcp',1,'IR','IR（输入寄存器）',2),
('Siemens','S7-1500','Modbus_TCP','modbus_tcp',1,'CR','CR（线圈）',3),
('Siemens','S7-300/400','Modbus_TCP','modbus_tcp',1,'HR','HR（保持寄存器）',1),
('Siemens','S7-200 Smart','Modbus_TCP','modbus_tcp',1,'HR','HR（保持寄存器）',1),
-- 西门子 / 欧姆龙 RS-232C（当前无对应驱动，标记 UNKNOWN）
('Siemens','S7-1200','PLC_RS232C','UNKNOWN',0,'HR','HR（保持寄存器）',1),
('Siemens','S7-300/400','PLC_RS232C','UNKNOWN',0,'HR','HR（保持寄存器）',1),
('Omron','CJ','PLC_RS232C','UNKNOWN',0,'HR','HR（保持寄存器）',1),
-- 欧姆龙 Modbus TCP
('Omron','CJ','Modbus_TCP','modbus_tcp',1,'HR','HR（保持寄存器）',1),
('Omron','CJ','Modbus_TCP','modbus_tcp',1,'IR','IR（输入寄存器）',2),
('Omron','CS','Modbus_TCP','modbus_tcp',1,'HR','HR（保持寄存器）',1),
('Omron','CP','Modbus_TCP','modbus_tcp',1,'HR','HR（保持寄存器）',1),
('Omron','NX','Modbus_TCP','modbus_tcp',1,'HR','HR（保持寄存器）',1),
-- 基恩士 Modbus TCP
('Keyence','KV-8000','Modbus_TCP','modbus_tcp',1,'HR','HR（保持寄存器）',1),
('Keyence','KV-8000','Modbus_TCP','modbus_tcp',1,'IR','IR（输入寄存器）',2),
('Keyence','KV-7500','Modbus_TCP','modbus_tcp',1,'HR','HR（保持寄存器）',1),
('Keyence','KV-5500','Modbus_TCP','modbus_tcp',1,'HR','HR（保持寄存器）',1);
""")
print('[OK] plc_protocol_compat 映射数据')

# ===================================================================
# 1b. 建表 plc_publish_log（配置发布日志）
# ===================================================================
cur.execute("""
CREATE TABLE IF NOT EXISTS plc_publish_log (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    publish_by      VARCHAR(64)      COMMENT '发布人',
    publish_time    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '发布时间',
    device_count    INT DEFAULT 0    COMMENT '涉及设备数',
    node_count      INT DEFAULT 0    COMMENT '涉及采集节点数',
    ip_count        INT DEFAULT 0    COMMENT '涉及IP数',
    device_ids      JSON             COMMENT '发布的设备ID列表',
    remark          VARCHAR(500)     COMMENT '备注'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PLC配置发布日志表';
""")
print('[OK] plc_publish_log 表')

# ===================================================================
# 1c. 建表 edge_bootstrap_key（边缘节点初始接入密钥表）
# ===================================================================
cur.execute("""
CREATE TABLE IF NOT EXISTS edge_bootstrap_key (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    node_key VARCHAR(64) NOT NULL UNIQUE COMMENT '节点标识（如 pc-001）',
    node_name VARCHAR(100) COMMENT '节点名称',
    host_pc_ip VARCHAR(50) UNIQUE COMMENT '预设的节点标识（IP:端口，必须唯一）',
    secret_key VARCHAR(64) NOT NULL COMMENT '初始接入密钥',
    enabled TINYINT(1) DEFAULT 1 COMMENT '是否启用（0停用 1启用）',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_node_key (node_key),
    INDEX idx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='边缘节点初始接入密钥表';
""")
print('[OK] edge_bootstrap_key 表')

# ===================================================================
# 1. 建表 plc_device（25 字段，与 PlcDevice DO 模型一致 — plc_ip 可为空以支持 RS-232C）
# ===================================================================
cur.execute("""
CREATE TABLE IF NOT EXISTS plc_device (
    id               BIGINT       NOT NULL AUTO_INCREMENT  COMMENT '设备ID',
    device_name      VARCHAR(100) NOT NULL                 COMMENT '设备名称',
    device_code      VARCHAR(50)  DEFAULT NULL             COMMENT '设备编号（如PLC-Q-01），Node-RED短标识',
    plc_brand        VARCHAR(50)  NOT NULL DEFAULT 'Mitsubishi' COMMENT 'PLC品牌',
    plc_series       VARCHAR(50)  DEFAULT NULL             COMMENT 'PLC系列（Q/L/FX/iQ-R）',
    com_type         VARCHAR(50)  DEFAULT NULL             COMMENT '通信方式（MC_Protocol/Modbus_TCP/GOT/PLC_RS232C）',
    plc_ip           VARCHAR(50)  DEFAULT NULL             COMMENT 'PLC IP地址（RS-232C串口通信时可为空）',
    host_pc_ip       VARCHAR(50)  DEFAULT NULL             COMMENT '主采集节点标识（IP 或 IP:端口，多实例部署时用端口区分）',
    backup_pc_ip     VARCHAR(50)  DEFAULT NULL             COMMENT '备采集节点标识（IP 或 IP:端口，主节点宕机切换）',
    mes_ip           VARCHAR(50)  DEFAULT NULL             COMMENT 'MES/MDPS对接IP',
    mes_port         INT          NOT NULL DEFAULT 0       COMMENT 'MES/MDPS对接端口',
    plc_port         INT          NOT NULL DEFAULT 5007    COMMENT 'PLC通信端口',
    mc_frame         VARCHAR(10)  DEFAULT NULL             COMMENT 'MC协议帧格式（3E/4E）',
    station_no       INT          NOT NULL DEFAULT 0       COMMENT '站号（0-255）',
    network_no       INT          NOT NULL DEFAULT 0       COMMENT '网络号（0-255）',
    scan_interval_ms INT          NOT NULL DEFAULT 1000    COMMENT '采集周期（毫秒）',
    comm_timeout_ms  INT          NOT NULL DEFAULT 3000    COMMENT '通信超时（毫秒）',
    retry_count      INT          NOT NULL DEFAULT 2       COMMENT '失败重试次数',
    retry_interval_ms INT         NOT NULL DEFAULT 500     COMMENT '重试间隔（毫秒）',
    trigger_kind     INT          NOT NULL DEFAULT 0       COMMENT '触发方式（0=握手 1=固定周期 2=变化触发）',
    protocol_params  JSON                  DEFAULT NULL             COMMENT '协议专用参数（Modbus: unit_id/function_code; OPC UA: node_id/namespace_index; S7: rack/slot; MC: mc_frame/station_no/network_no 的JSON形式）',
    driver_code      VARCHAR(50)  NOT NULL DEFAULT 'UNKNOWN'      COMMENT '驱动编码（如 mitsubishi_mc / modbus_tcp，由品牌/系列/通信方式映射得到）',
    status           CHAR(1)      NOT NULL DEFAULT '0'     COMMENT '状态（0启用 1停用）',
    create_by        VARCHAR(64)  DEFAULT NULL             COMMENT '创建者',
    create_time      DATETIME     DEFAULT NULL             COMMENT '创建时间',
    update_by        VARCHAR(64)  DEFAULT NULL             COMMENT '更新者',
    update_time      DATETIME     DEFAULT NULL             COMMENT '更新时间',
    remark           VARCHAR(500) DEFAULT NULL             COMMENT '备注',
    del_flag         CHAR(1)      NOT NULL DEFAULT '0'     COMMENT '删除标志（0正常 2已删除）',
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PLC设备表';
""")
print('[OK] plc_device 表（27字段）')

# ===================================================================
# 2. 建表 plc_tag（23 字段，与 PlcTag DO 模型一致）
# ===================================================================
cur.execute("""
CREATE TABLE IF NOT EXISTS plc_tag (
    id               BIGINT       NOT NULL AUTO_INCREMENT  COMMENT '点位ID',
    device_id        BIGINT       NOT NULL                 COMMENT '所属设备ID',
    tag_name         VARCHAR(100) NOT NULL                 COMMENT '点位名称',
    register_type    VARCHAR(10)  NOT NULL                 COMMENT '寄存器类型（协议相关：MC=D/W/X/Y/M, Modbus=Coil/Discrete/Holding/Input, S7=DB/I/Q/M）',
    register_address VARCHAR(50)  NOT NULL                 COMMENT '寄存器地址',
    data_type        VARCHAR(20)  NOT NULL                 COMMENT '数据类型（INT16/INT32/FLOAT/BIT/UINT16/UINT32/BOOL/DOUBLE）',
    unit             VARCHAR(20)  DEFAULT NULL             COMMENT '物理单位（寄存器原始单位）',
    description      TEXT         DEFAULT NULL             COMMENT '点位描述',
    status           CHAR(1)      NOT NULL DEFAULT '0'     COMMENT '状态（0启用 1停用）',
    sort_order       INT          NOT NULL DEFAULT 0       COMMENT '排序号（升序）',
    transform_type   VARCHAR(20)  NOT NULL DEFAULT 'none'  COMMENT '换算类型（none/linear/slope_offset）',
    transform_slope_a FLOAT       NOT NULL DEFAULT 1.0     COMMENT '斜率/乘数 a',
    transform_offset_b FLOAT      NOT NULL DEFAULT 0.0     COMMENT '偏移量 b',
    raw_value_min    FLOAT        DEFAULT NULL             COMMENT '原始值有效范围下限',
    raw_value_max    FLOAT        DEFAULT NULL             COMMENT '原始值有效范围上限',
    eng_value_min    FLOAT        DEFAULT NULL             COMMENT '工程值下限',
    eng_value_max    FLOAT        DEFAULT NULL             COMMENT '工程值上限',
    eng_unit         VARCHAR(20)  DEFAULT NULL             COMMENT '工程单位（换算后的显示单位）',
    report_deadband_ms INT        NOT NULL DEFAULT 1000    COMMENT '变化上报死区（ms），0=每次上报',
    report_force_interval_ms INT  NOT NULL DEFAULT 5000    COMMENT '强制上报间隔（ms）',
    quality_enabled  CHAR(1)      NOT NULL DEFAULT '1'     COMMENT '是否启用数据质量码',
    protocol_params  JSON                  DEFAULT NULL             COMMENT '协议专用点位参数（bit_offset/byte_order/word_order/function_code 等）',
    bit_offset       INT          DEFAULT NULL             COMMENT '位偏移（BIT 类型时有效，0-15）',
    byte_order       VARCHAR(10)  DEFAULT NULL             COMMENT '字节序（LITTLE_ENDIAN/BIG_ENDIAN，INT32/FLOAT 时有效）',
    word_order       VARCHAR(10)  DEFAULT NULL             COMMENT '字序（LOW_FIRST/HIGH_FIRST，跨多寄存器时有效）',
    create_by        VARCHAR(64)  DEFAULT NULL             COMMENT '创建者',
    create_time      DATETIME     DEFAULT NULL             COMMENT '创建时间',
    update_by        VARCHAR(64)  DEFAULT NULL             COMMENT '更新者',
    update_time      DATETIME     DEFAULT NULL             COMMENT '更新时间',
    del_flag         CHAR(1)      NOT NULL DEFAULT '0'     COMMENT '删除标志（0正常 2已删除）',
    PRIMARY KEY (id),
    CONSTRAINT fk_plc_tag_device FOREIGN KEY (device_id) REFERENCES plc_device (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PLC采集点位表';
""")
print('[OK] plc_tag 表（27字段）')

# ===================================================================
# 3. 创建索引（Node-RED 每 1-5 秒拉配置，必须建索引）
# ===================================================================
indexes = [
    # 设备表索引
    ("idx_device_status_del", "plc_device", "status, del_flag"),
    ("idx_device_ip",        "plc_device", "plc_ip"),
    ("idx_device_brand",     "plc_device", "plc_brand"),
    # 点位表索引
    ("idx_tag_device_id",       "plc_tag", "device_id"),
    ("idx_tag_status_del",      "plc_tag", "status, del_flag"),
    ("idx_tag_device_status",   "plc_tag", "device_id, status, del_flag"),
    # 协议兼容表索引
    ("idx_plc_protocol_compat_brand_series_com", "plc_protocol_compat", "plc_brand, plc_series, com_type"),
]
for idx_name, table, cols in indexes:
    try:
        cur.execute(f"CREATE INDEX {idx_name} ON {table} ({cols})")
        print(f'[OK] 索引 {idx_name} 创建成功')
    except pymysql.err.OperationalError as e:
        if 'Duplicate key name' in str(e):
            print(f'[SKIP] 索引 {idx_name} 已存在')
        else:
            raise

# ===================================================================
# 3b. 兼容迁移：为旧表追加新字段（v2→v3 transform + deadband）
# ===================================================================
migrations = [
    # plc_device: v3 — plc_ip 支持 RS-232C 可为 NULL
    ("ALTER TABLE plc_device MODIFY COLUMN plc_ip VARCHAR(50) DEFAULT NULL COMMENT 'PLC IP地址（RS-232C串口通信时可为空）'",
     "doesn't exist"),  # 忽略表不存在的错误（新部署时 CREATE TABLE 已含正确定义）
    # plc_device
    ("ALTER TABLE plc_device ADD COLUMN backup_pc_ip VARCHAR(50) DEFAULT NULL COMMENT '备采集PC的办公网IP'",
     "Duplicate column name 'backup_pc_ip'"),
    # plc_tag: 换算参数
    ("ALTER TABLE plc_tag ADD COLUMN transform_type VARCHAR(20) NOT NULL DEFAULT 'none' COMMENT '换算类型'",
     "Duplicate column name 'transform_type'"),
    ("ALTER TABLE plc_tag ADD COLUMN transform_slope_a FLOAT NOT NULL DEFAULT 1.0 COMMENT '斜率/乘数 a'",
     "Duplicate column name 'transform_slope_a'"),
    ("ALTER TABLE plc_tag ADD COLUMN transform_offset_b FLOAT NOT NULL DEFAULT 0.0 COMMENT '偏移量 b'",
     "Duplicate column name 'transform_offset_b'"),
    ("ALTER TABLE plc_tag ADD COLUMN raw_value_min FLOAT DEFAULT NULL COMMENT '原始值范围下限'",
     "Duplicate column name 'raw_value_min'"),
    ("ALTER TABLE plc_tag ADD COLUMN raw_value_max FLOAT DEFAULT NULL COMMENT '原始值范围上限'",
     "Duplicate column name 'raw_value_max'"),
    ("ALTER TABLE plc_tag ADD COLUMN eng_value_min FLOAT DEFAULT NULL COMMENT '工程值下限'",
     "Duplicate column name 'eng_value_min'"),
    ("ALTER TABLE plc_tag ADD COLUMN eng_value_max FLOAT DEFAULT NULL COMMENT '工程值上限'",
     "Duplicate column name 'eng_value_max'"),
    ("ALTER TABLE plc_tag ADD COLUMN eng_unit VARCHAR(20) DEFAULT NULL COMMENT '工程单位'",
     "Duplicate column name 'eng_unit'"),
    # plc_tag: 死区上报
    ("ALTER TABLE plc_tag ADD COLUMN report_deadband_ms INT NOT NULL DEFAULT 1000 COMMENT '变化上报死区ms'",
     "Duplicate column name 'report_deadband_ms'"),
    ("ALTER TABLE plc_tag ADD COLUMN report_force_interval_ms INT NOT NULL DEFAULT 5000 COMMENT '强制上报间隔ms'",
     "Duplicate column name 'report_force_interval_ms'"),
    ("ALTER TABLE plc_tag ADD COLUMN quality_enabled CHAR(1) NOT NULL DEFAULT '1' COMMENT '质量码开关'",
     "Duplicate column name 'quality_enabled'"),
    # plc_device: v4 — 动态驱动
    ("ALTER TABLE plc_device ADD COLUMN protocol_params JSON DEFAULT NULL COMMENT '协议专用参数（Modbus: unit_id/function_code; OPC UA: node_id/namespace_index; S7: rack/slot; MC: mc_frame/station_no/network_no 的JSON形式）'",
     "Duplicate column name 'protocol_params'"),
    ("ALTER TABLE plc_device ADD COLUMN driver_code VARCHAR(50) NOT NULL DEFAULT 'UNKNOWN' COMMENT '驱动编码（如 mitsubishi_mc / modbus_tcp，由品牌/系列/通信方式映射得到）'",
     "Duplicate column name 'driver_code'"),
    # plc_tag: v4 — 协议参数扩展
    ("ALTER TABLE plc_tag ADD COLUMN protocol_params JSON DEFAULT NULL COMMENT '协议专用点位参数（bit_offset/byte_order/word_order/function_code 等）'",
     "Duplicate column name 'protocol_params'"),
    ("ALTER TABLE plc_tag ADD COLUMN bit_offset INT DEFAULT NULL COMMENT '位偏移（BIT 类型时有效，0-15）'",
     "Duplicate column name 'bit_offset'"),
    ("ALTER TABLE plc_tag ADD COLUMN byte_order VARCHAR(10) DEFAULT NULL COMMENT '字节序（LITTLE_ENDIAN/BIG_ENDIAN，INT32/FLOAT 时有效）'",
     "Duplicate column name 'byte_order'"),
    ("ALTER TABLE plc_tag ADD COLUMN word_order VARCHAR(10) DEFAULT NULL COMMENT '字序（LOW_FIRST/HIGH_FIRST，跨多寄存器时有效）'",
     "Duplicate column name 'word_order'"),
]
for sql, dup_msg in migrations:
    try:
        cur.execute(sql)
        print(f'[OK] {sql[:60]}...')
    except pymysql.err.OperationalError as e:
        if dup_msg in str(e):
            print(f'[SKIP] {dup_msg}')
        else:
            raise
print('[OK] 字段迁移检查完成')

# ===================================================================
# 4. 清理旧菜单（如果存在 — 兼容 v1 脚本）
# ===================================================================
old_menus = [
    "点位删除", "点位修改", "点位新增", "点位查询",
    "设备删除", "设备修改", "设备新增", "设备查询",
    "PLC设备管理", "数据点表", "连接配置",
]
for name in old_menus:
    cur.execute("DELETE FROM sys_menu WHERE menu_name = %s AND parent_id > 0", (name,))
cur.execute("DELETE FROM sys_menu WHERE menu_name = '连接配置' AND parent_id = 0")
print('[OK] 旧菜单清理完成')

# ===================================================================
# 5. 插入一级菜单「连接配置」
# ===================================================================
cur.execute("""
INSERT INTO sys_menu (
    menu_name, parent_id, order_num, path, component, query,
    is_frame, is_cache, menu_type, visible, status, perms, icon,
    create_by, create_time, update_by, update_time, remark
) VALUES (
    '连接配置', 0, 2, 'link', NULL, NULL,
    1, 0, 'M', '0', '0', NULL, 'el-icon-connection',
    'admin', NOW(), 'admin', NOW(), '连接配置一级菜单'
)
""")
link_config_id = cur.lastrowid
print(f'[OK] 一级菜单「连接配置」menu_id = {link_config_id}')

# ===================================================================
# 6. 插入二级菜单「PLC设备管理」（/plc/device）
# ===================================================================
cur.execute(f"""
INSERT INTO sys_menu (
    menu_name, parent_id, order_num, path, component, query,
    is_frame, is_cache, menu_type, visible, status, perms, icon,
    create_by, create_time, update_by, update_time, remark
) VALUES (
    'PLC设备管理', {link_config_id}, 1, 'plc/device', 'plc/device/index', NULL,
    1, 0, 'C', '0', '0', 'plc:device:list', 'el-icon-cpu',
    'admin', NOW(), 'admin', NOW(), 'PLC设备管理页面'
)
""")
plc_menu_id = cur.lastrowid
print(f'[OK] 二级菜单「PLC设备管理」menu_id = {plc_menu_id}')

# ===================================================================
# 7. 插入二级菜单「数据点表」（/plc/tag）
# ===================================================================
cur.execute(f"""
INSERT INTO sys_menu (
    menu_name, parent_id, order_num, path, component, query,
    is_frame, is_cache, menu_type, visible, status, perms, icon,
    create_by, create_time, update_by, update_time, remark
) VALUES (
    '数据点表', {link_config_id}, 2, 'plc/tag', 'plc/tag/index', NULL,
    1, 0, 'C', '0', '0', 'plc:tag:list', 'el-icon-s-grid',
    'admin', NOW(), 'admin', NOW(), '数据点表全局视图'
)
""")
tag_menu_id = cur.lastrowid
print(f'[OK] 二级菜单「数据点表」menu_id = {tag_menu_id}')

# ===================================================================
# 7.5 插入二级菜单「配置发布中心」（/plc/publish）
# ===================================================================
cur.execute(f"""
INSERT INTO sys_menu (
    menu_name, parent_id, order_num, path, component, query,
    is_frame, is_cache, menu_type, visible, status, perms, icon,
    create_by, create_time, update_by, update_time, remark
) VALUES (
    '配置发布中心', {link_config_id}, 3, 'plc/publish', 'plc/publish/index', NULL,
    1, 0, 'C', '0', '0', 'plc:publish:list', 'el-icon-upload',
    'admin', NOW(), 'admin', NOW(), 'PLC配置发布中心页面'
)
""")
publish_menu_id = cur.lastrowid
print(f'[OK] 二级菜单「配置发布中心」menu_id = {publish_menu_id}')

# ===================================================================
# 7.6 插入二级菜单「边缘节点管理」（/plc/bootstrap-key）
# ===================================================================
cur.execute(f"""
INSERT INTO sys_menu (
    menu_name, parent_id, order_num, path, component, query,
    is_frame, is_cache, menu_type, visible, status, perms, icon,
    create_by, create_time, update_by, update_time, remark
) VALUES (
    '边缘节点管理', {link_config_id}, 4, 'plc/bootstrap-key', 'plc/bootstrap-key/index', NULL,
    1, 0, 'C', '0', '0', 'plc:bootstrap-key:list', 'el-icon-key',
    'admin', NOW(), 'admin', NOW(), '边缘节点接入密钥管理页面'
)
""")
bootstrap_key_menu_id = cur.lastrowid
print(f'[OK] 二级菜单「边缘节点管理」menu_id = {bootstrap_key_menu_id}')

# ===================================================================
# 8. 插入 12 个按钮权限（4 设备 + 4 点位 + 1 发布 + 3 节点密钥）
# ===================================================================
buttons = [
    # 设备权限 —— 挂在 PLC设备管理 下
    ('设备查询', plc_menu_id, 1, 'plc:device:list'),
    ('设备新增', plc_menu_id, 2, 'plc:device:add'),
    ('设备修改', plc_menu_id, 3, 'plc:device:edit'),
    ('设备删除', plc_menu_id, 4, 'plc:device:remove'),
    # 点位权限 —— 挂在 数据点表 下
    ('点位查询', tag_menu_id, 1, 'plc:tag:list'),
    ('点位新增', tag_menu_id, 2, 'plc:tag:add'),
    ('点位修改', tag_menu_id, 3, 'plc:tag:edit'),
    ('点位删除', tag_menu_id, 4, 'plc:tag:remove'),
    # 发布权限 —— 挂在 配置发布中心 下
    ('发布配置编辑', publish_menu_id, 1, 'plc:publish:edit'),
    # 节点密钥权限 —— 挂在 边缘节点管理 下
    ('节点密钥查询', bootstrap_key_menu_id, 1, 'plc:bootstrap-key:list'),
    ('节点密钥新增', bootstrap_key_menu_id, 2, 'plc:bootstrap-key:add'),
    ('节点密钥修改', bootstrap_key_menu_id, 3, 'plc:bootstrap-key:edit'),
    ('节点密钥删除', bootstrap_key_menu_id, 4, 'plc:bootstrap-key:remove'),
]
for name, parent_id, order_num, perms in buttons:
    cur.execute("""
    INSERT INTO sys_menu (menu_name, parent_id, order_num, path, component,
        is_frame, is_cache, menu_type, visible, status, perms,
        create_by, create_time, update_by, update_time)
    VALUES (%s, %s, %s, '', '', 1, 0, 'F', '0', '0', %s,
        'admin', NOW(), 'admin', NOW())
    """, (name, parent_id, order_num, perms))
print('[OK] 13 个按钮权限插入成功')

# ===================================================================
# 9. 验证
# ===================================================================
print()
print('=' * 80)
print('菜单验证：')
cur.execute("""
SELECT menu_id, menu_name, parent_id, menu_type, perms, order_num
FROM sys_menu
WHERE menu_name IN ('连接配置', 'PLC设备管理', '数据点表', '配置发布中心', '边缘节点管理',
      '设备查询', '设备新增', '设备修改', '设备删除',
      '点位查询', '点位新增', '点位修改', '点位删除',
      '发布配置编辑',
      '节点密钥查询', '节点密钥新增', '节点密钥修改', '节点密钥删除')
ORDER BY parent_id, order_num, menu_id
""")
print(f'{"menu_id":<10} {"menu_name":<16} {"parent_id":<10} {"type":<4} {"perms"}')
print('-' * 80)
for row in cur.fetchall():
    mid, mname, pid, mtype, perms, onum = row
    print(f'{mid:<10} {mname:<16} {pid:<10} {mtype:<4} {perms or "NULL"}')

print()
print('=' * 80)
print('表验证：')
cur.execute('SHOW TABLES LIKE "plc%"')
tables = [t[0] for t in cur.fetchall()]
print(f'PLC 相关表: {tables}')

cur.execute('DESCRIBE plc_device')
print(f'\nplc_device ({cur.rowcount} 字段):')
for row in cur.fetchall():
    print(f'  {row[0]:<20} {row[1]:<15} {"NOT NULL" if row[2]=="NO" else "NULL":<10} DEFAULT={row[4]}')

cur.execute('DESCRIBE plc_tag')
print(f'\nplc_tag ({cur.rowcount} 字段):')
for row in cur.fetchall():
    print(f'  {row[0]:<20} {row[1]:<15} {"NOT NULL" if row[2]=="NO" else "NULL":<10} DEFAULT={row[4]}')

cur.execute('DESCRIBE plc_driver')
print(f'\nplc_driver ({cur.rowcount} 字段):')
for row in cur.fetchall():
    print(f'  {row[0]:<20} {row[1]:<15} {"NOT NULL" if row[2]=="NO" else "NULL":<10} DEFAULT={row[4]}')

cur.execute('DESCRIBE plc_protocol_compat')
print(f'\nplc_protocol_compat ({cur.rowcount} 字段):')
for row in cur.fetchall():
    print(f'  {row[0]:<20} {row[1]:<15} {"NOT NULL" if row[2]=="NO" else "NULL":<10} DEFAULT={row[4]}')

print()
print('=' * 80)
print('驱动与映射数据验证：')
cur.execute('SELECT COUNT(*) FROM plc_driver')
print(f'plc_driver 记录数: {cur.fetchone()[0]}')
cur.execute('SELECT driver_code, driver_name FROM plc_driver ORDER BY sort_order')
for row in cur.fetchall():
    print(f'  {row[0]:<24} {row[1]}')

cur.execute('SELECT COUNT(*) FROM plc_protocol_compat')
print(f'\nplc_protocol_compat 记录数: {cur.fetchone()[0]}')
cur.execute('SELECT driver_code, COUNT(*) AS cnt FROM plc_protocol_compat GROUP BY driver_code ORDER BY cnt DESC')
print('driver_code 分布:')
for row in cur.fetchall():
    print(f'  {row[0]:<24} {row[1]}')

cur.execute('''
SELECT plc_brand, plc_series, com_type, COUNT(*) AS cnt
FROM plc_protocol_compat
GROUP BY plc_brand, plc_series, com_type
HAVING cnt > 1
''')
dups = cur.fetchall()
print(f'\n(brand, series, com_type) 重复组数: {len(dups)}')
for row in dups:
    print(f'  {row[0]}/{row[1]}/{row[2]}: {row[3]} 条')

print()
print('=' * 80)
print('索引验证：')
cur.execute("SHOW INDEX FROM plc_device")
print(f'plc_device 索引: {cur.rowcount} 个')
cur.execute("SHOW INDEX FROM plc_tag")
print(f'plc_tag 索引:    {cur.rowcount} 个')
cur.execute("SHOW INDEX FROM plc_protocol_compat")
print(f'plc_protocol_compat 索引: {cur.rowcount} 个')

cur.close()
conn.close()
print()
print('=' * 80)
print('[OK] PLC 模块数据库初始化完成！')
