-- ============================================================
-- 过渡版 — 协议配置清理与品牌扩展（2026-09-29）
-- 内容：
--   1. plc_driver：停用生成版跑不了的驱动（MC串口透传、S7）
--   2. plc_protocol_compat：删除 V12 遗物 GOT 通信方式
--   3. 新增基恩士（KV 系列，SLMP/MC 协议 → mitsubishi_mc 驱动，生成器零改动）
--   4. 新增汇川（H5U/AM600/EASY，Modbus_TCP → modbus_tcp 驱动；
--      注意：Modbus 支路构造器完成前，汇川设备生成时会跳过并告警）
-- 说明：兼容表无状态列，GOT 行直接删除（无设备使用 GOT，已确认）。
-- ============================================================

-- 1. 停用生成版不支持的驱动
UPDATE plc_driver SET enabled = 0 WHERE driver_code IN ('mitsubishi_mc_serial', 'siemens_s7');

-- 2. 删除 V12 遗物 GOT 通信方式
DELETE FROM plc_protocol_compat WHERE com_type = 'GOT';

-- 3. 基恩士 KV 系列（SLMP 兼容 MC 协议；软元件映射：DM→D，W→W，X/Y/M/R 同名）
INSERT INTO plc_protocol_compat (plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES
('Keyence', 'KV-8000', 'MC_Protocol', 1, 'D', 'D（数据寄存器，基恩士 DM）', 1, 'mitsubishi_mc'),
('Keyence', 'KV-8000', 'MC_Protocol', 1, 'W', 'W（链接寄存器）', 2, 'mitsubishi_mc'),
('Keyence', 'KV-8000', 'MC_Protocol', 1, 'X', 'X（输入）', 3, 'mitsubishi_mc'),
('Keyence', 'KV-8000', 'MC_Protocol', 1, 'Y', 'Y（输出）', 4, 'mitsubishi_mc'),
('Keyence', 'KV-8000', 'MC_Protocol', 1, 'M', 'M（内部继电器）', 5, 'mitsubishi_mc'),
('Keyence', 'KV-8000', 'MC_Protocol', 1, 'R', 'R（文件寄存器）', 6, 'mitsubishi_mc'),
('Keyence', 'KV-7000', 'MC_Protocol', 1, 'D', 'D（数据寄存器，基恩士 DM）', 1, 'mitsubishi_mc'),
('Keyence', 'KV-7000', 'MC_Protocol', 1, 'W', 'W（链接寄存器）', 2, 'mitsubishi_mc'),
('Keyence', 'KV-7000', 'MC_Protocol', 1, 'X', 'X（输入）', 3, 'mitsubishi_mc'),
('Keyence', 'KV-7000', 'MC_Protocol', 1, 'Y', 'Y（输出）', 4, 'mitsubishi_mc'),
('Keyence', 'KV-7000', 'MC_Protocol', 1, 'M', 'M（内部继电器）', 5, 'mitsubishi_mc'),
('Keyence', 'KV-7000', 'MC_Protocol', 1, 'R', 'R（文件寄存器）', 6, 'mitsubishi_mc'),
('Keyence', 'KV-5000', 'MC_Protocol', 1, 'D', 'D（数据寄存器，基恩士 DM）', 1, 'mitsubishi_mc'),
('Keyence', 'KV-5000', 'MC_Protocol', 1, 'W', 'W（链接寄存器）', 2, 'mitsubishi_mc'),
('Keyence', 'KV-5000', 'MC_Protocol', 1, 'X', 'X（输入）', 3, 'mitsubishi_mc'),
('Keyence', 'KV-5000', 'MC_Protocol', 1, 'Y', 'Y（输出）', 4, 'mitsubishi_mc'),
('Keyence', 'KV-5000', 'MC_Protocol', 1, 'M', 'M（内部继电器）', 5, 'mitsubishi_mc'),
('Keyence', 'KV-5000', 'MC_Protocol', 1, 'R', 'R（文件寄存器）', 6, 'mitsubishi_mc');

-- 4. 汇川（以太网口原生 Modbus TCP；注意其地址区域非标准 Modbus，点位地址按汇川手册填）
INSERT INTO plc_protocol_compat (plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES
('Inovance', 'H5U', 'Modbus_TCP', 1, 'HR', 'HR（保持寄存器）', 1, 'modbus_tcp'),
('Inovance', 'H5U', 'Modbus_TCP', 1, 'IR', 'IR（输入寄存器）', 2, 'modbus_tcp'),
('Inovance', 'H5U', 'Modbus_TCP', 1, 'CR', 'CR（线圈）', 3, 'modbus_tcp'),
('Inovance', 'H5U', 'Modbus_TCP', 1, 'DISCRETE', 'DISCRETE（离散输入）', 4, 'modbus_tcp'),
('Inovance', 'AM600', 'Modbus_TCP', 1, 'HR', 'HR（保持寄存器）', 1, 'modbus_tcp'),
('Inovance', 'AM600', 'Modbus_TCP', 1, 'IR', 'IR（输入寄存器）', 2, 'modbus_tcp'),
('Inovance', 'AM600', 'Modbus_TCP', 1, 'CR', 'CR（线圈）', 3, 'modbus_tcp'),
('Inovance', 'AM600', 'Modbus_TCP', 1, 'DISCRETE', 'DISCRETE（离散输入）', 4, 'modbus_tcp'),
('Inovance', 'EASY', 'Modbus_TCP', 1, 'HR', 'HR（保持寄存器）', 1, 'modbus_tcp'),
('Inovance', 'EASY', 'Modbus_TCP', 1, 'IR', 'IR（输入寄存器）', 2, 'modbus_tcp'),
('Inovance', 'EASY', 'Modbus_TCP', 1, 'CR', 'CR（线圈）', 3, 'modbus_tcp'),
('Inovance', 'EASY', 'Modbus_TCP', 1, 'DISCRETE', 'DISCRETE（离散输入）', 4, 'modbus_tcp');
