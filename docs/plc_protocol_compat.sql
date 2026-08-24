-- EdgeLink PLC 协议兼容表
-- 定义 品牌→系列→通信方式→寄存器类型 的级联关系，并映射到 driver_code
-- 注意：一个 (brand, series, com_type) 组合可能有多个驱动，此处取 sort_order 最小的作为默认；
--      设备层允许覆盖 driver_code 以支持非默认驱动。

CREATE TABLE IF NOT EXISTS plc_protocol_compat (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    plc_brand VARCHAR(50) NOT NULL,
    plc_series VARCHAR(50) NOT NULL,
    com_type VARCHAR(50) NOT NULL,
    driver_code VARCHAR(50) NOT NULL DEFAULT 'UNKNOWN' COMMENT '驱动编码（对应 plc_driver.driver_code）',
    is_default_com_type TINYINT(1) DEFAULT 0,
    register_type VARCHAR(20) NOT NULL,
    register_type_label VARCHAR(50),
    sort_order INT DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== 三菱 Mitsubishi ==========
-- MC Protocol
INSERT INTO plc_protocol_compat (plc_brand, plc_series, com_type, driver_code, is_default_com_type, register_type, register_type_label, sort_order) VALUES
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',true,'D','D（数据寄存器）',1),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',true,'W','W（链接寄存器）',2),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',true,'X','X（输入）',3),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',true,'Y','Y（输出）',4),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',true,'M','M（内部继电器）',5),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',true,'L','L（锁存继电器）',6),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',true,'B','B（链接继电器）',7),
('Mitsubishi','Q','MC_Protocol','mitsubishi_mc',true,'R','R（文件寄存器）',8),
('Mitsubishi','L','MC_Protocol','mitsubishi_mc',true,'D','D（数据寄存器）',1),
('Mitsubishi','L','MC_Protocol','mitsubishi_mc',true,'W','W（链接寄存器）',2),
('Mitsubishi','L','MC_Protocol','mitsubishi_mc',true,'X','X（输入）',3),
('Mitsubishi','L','MC_Protocol','mitsubishi_mc',true,'Y','Y（输出）',4),
('Mitsubishi','L','MC_Protocol','mitsubishi_mc',true,'M','M（内部继电器）',5),
('Mitsubishi','FX','MC_Protocol','mitsubishi_mc',true,'D','D（数据寄存器）',1),
('Mitsubishi','FX','MC_Protocol','mitsubishi_mc',true,'X','X（输入）',2),
('Mitsubishi','FX','MC_Protocol','mitsubishi_mc',true,'Y','Y（输出）',3),
('Mitsubishi','FX','MC_Protocol','mitsubishi_mc',true,'M','M（内部继电器）',4),
('Mitsubishi','iQ-R','MC_Protocol','mitsubishi_mc',true,'D','D（数据寄存器）',1),
('Mitsubishi','iQ-R','MC_Protocol','mitsubishi_mc',true,'W','W（链接寄存器）',2),
('Mitsubishi','iQ-R','MC_Protocol','mitsubishi_mc',true,'X','X（输入）',3),
('Mitsubishi','iQ-R','MC_Protocol','mitsubishi_mc',true,'Y','Y（输出）',4),
('Mitsubishi','iQ-R','MC_Protocol','mitsubishi_mc',true,'M','M（内部继电器）',5);

-- Modbus TCP（三菱全系列支持）
INSERT INTO plc_protocol_compat (plc_brand, plc_series, com_type, driver_code, is_default_com_type, register_type, register_type_label, sort_order) VALUES
('Mitsubishi','Q','Modbus_TCP','modbus_tcp',false,'HR','HR（保持寄存器）',1),
('Mitsubishi','Q','Modbus_TCP','modbus_tcp',false,'IR','IR（输入寄存器）',2),
('Mitsubishi','Q','Modbus_TCP','modbus_tcp',false,'CR','CR（线圈）',3),
('Mitsubishi','L','Modbus_TCP','modbus_tcp',false,'HR','HR（保持寄存器）',1),
('Mitsubishi','FX','Modbus_TCP','modbus_tcp',false,'HR','HR（保持寄存器）',1);

-- GOT 透传（本质是 MC 协议透传）
INSERT INTO plc_protocol_compat (plc_brand, plc_series, com_type, driver_code, is_default_com_type, register_type, register_type_label, sort_order) VALUES
('Mitsubishi','Q','GOT','mitsubishi_mc',false,'D','D（数据寄存器）',1),
('Mitsubishi','Q','GOT','mitsubishi_mc',false,'M','M（内部继电器）',2),
('Mitsubishi','L','GOT','mitsubishi_mc',false,'D','D（数据寄存器）',1);

-- RS-232C（串口透传，默认使用 mitsubishi_mc_serial）
INSERT INTO plc_protocol_compat (plc_brand, plc_series, com_type, driver_code, is_default_com_type, register_type, register_type_label, sort_order) VALUES
('Mitsubishi','Q','PLC_RS232C','mitsubishi_mc_serial',false,'D','D（数据寄存器）',1),
('Mitsubishi','FX','PLC_RS232C','mitsubishi_mc_serial',false,'D','D（数据寄存器）',1);

-- ========== 西门子 Siemens ==========
INSERT INTO plc_protocol_compat (plc_brand, plc_series, com_type, driver_code, is_default_com_type, register_type, register_type_label, sort_order) VALUES
('Siemens','S7-1200','Modbus_TCP','modbus_tcp',true,'HR','HR（保持寄存器）',1),
('Siemens','S7-1200','Modbus_TCP','modbus_tcp',true,'IR','IR（输入寄存器）',2),
('Siemens','S7-1200','Modbus_TCP','modbus_tcp',true,'CR','CR（线圈）',3),
('Siemens','S7-1500','Modbus_TCP','modbus_tcp',true,'HR','HR（保持寄存器）',1),
('Siemens','S7-1500','Modbus_TCP','modbus_tcp',true,'IR','IR（输入寄存器）',2),
('Siemens','S7-1500','Modbus_TCP','modbus_tcp',true,'CR','CR（线圈）',3),
('Siemens','S7-300/400','Modbus_TCP','modbus_tcp',true,'HR','HR（保持寄存器）',1),
('Siemens','S7-200 Smart','Modbus_TCP','modbus_tcp',true,'HR','HR（保持寄存器）',1);

-- RS-232C（西门子 PPI/MPI、欧姆龙 Host Link，当前没有对应驱动，标记为 UNKNOWN）
INSERT INTO plc_protocol_compat (plc_brand, plc_series, com_type, driver_code, is_default_com_type, register_type, register_type_label, sort_order) VALUES
('Siemens','S7-1200','PLC_RS232C','UNKNOWN',false,'HR','HR（保持寄存器）',1),
('Siemens','S7-300/400','PLC_RS232C','UNKNOWN',false,'HR','HR（保持寄存器）',1);

-- ========== 欧姆龙 Omron ==========
INSERT INTO plc_protocol_compat (plc_brand, plc_series, com_type, driver_code, is_default_com_type, register_type, register_type_label, sort_order) VALUES
('Omron','CJ','Modbus_TCP','modbus_tcp',true,'HR','HR（保持寄存器）',1),
('Omron','CJ','Modbus_TCP','modbus_tcp',true,'IR','IR（输入寄存器）',2),
('Omron','CS','Modbus_TCP','modbus_tcp',true,'HR','HR（保持寄存器）',1),
('Omron','CP','Modbus_TCP','modbus_tcp',true,'HR','HR（保持寄存器）',1),
('Omron','NX','Modbus_TCP','modbus_tcp',true,'HR','HR（保持寄存器）',1),
('Omron','CJ','PLC_RS232C','UNKNOWN',false,'HR','HR（保持寄存器）',1);

-- ========== 基恩士 Keyence ==========
INSERT INTO plc_protocol_compat (plc_brand, plc_series, com_type, driver_code, is_default_com_type, register_type, register_type_label, sort_order) VALUES
('Keyence','KV-8000','Modbus_TCP','modbus_tcp',true,'HR','HR（保持寄存器）',1),
('Keyence','KV-8000','Modbus_TCP','modbus_tcp',true,'IR','IR（输入寄存器）',2),
('Keyence','KV-7500','Modbus_TCP','modbus_tcp',true,'HR','HR（保持寄存器）',1),
('Keyence','KV-5500','Modbus_TCP','modbus_tcp',true,'HR','HR（保持寄存器）',1);

-- 索引：加速按品牌/系列/通信方式查找驱动
CREATE INDEX idx_plc_protocol_compat_brand_series_com ON plc_protocol_compat (plc_brand, plc_series, com_type);
