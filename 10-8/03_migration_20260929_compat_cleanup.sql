-- ============================================================
-- 过渡版 — 协议兼容表一致性清理（2026-09-29 追加，幂等）
-- 内容：
--   1. 删除 PLC_RS232C 行（指向 UNKNOWN 驱动，无实现）
--   2. 删除 Siemens × S7 行（siemens_s7 驱动已停用，S7 业务暂缓）
-- 保留：Omron/Siemens × Modbus_TCP 行（modbus_tcp 启用中，支路构造器完成后可用）
-- ============================================================

DELETE FROM plc_protocol_compat WHERE com_type = 'PLC_RS232C' OR driver_code = 'UNKNOWN';
DELETE FROM plc_protocol_compat WHERE driver_code = 'siemens_s7';

-- 验证：
-- SELECT plc_brand, plc_series, com_type, driver_code FROM plc_protocol_compat
--  WHERE driver_code IN ('UNKNOWN','siemens_s7');  -- 应返回 0 行
