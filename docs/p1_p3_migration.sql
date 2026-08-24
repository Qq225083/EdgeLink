-- ============================================================
-- P1+P3: 协议可插拔 — 数据库迁移
-- 新增 protocol_params JSON 列 + 点位通用化字段
-- 日期: 2026-06-22
-- ============================================================

-- 1. 设备表: 协议专用参数 JSON 扩展列
ALTER TABLE plc_device
    ADD COLUMN protocol_params JSON NULL
    COMMENT '协议专用参数（Modbus: unit_id/function_code; OPC UA: node_id/namespace_index; S7: rack/slot）'
    AFTER trigger_kind;

-- 2. 点位表: 协议专用参数 JSON 扩展列
ALTER TABLE plc_tag
    ADD COLUMN protocol_params JSON NULL
    COMMENT '协议专用点位参数（function_code/register_kind 等）'
    AFTER quality_enabled;

-- 3. 点位表: 位偏移（BIT 类型点位专用）
ALTER TABLE plc_tag
    ADD COLUMN bit_offset INT NULL
    COMMENT '位偏移（BIT 类型时有效，0-15）'
    AFTER protocol_params;

-- 4. 点位表: 字节序（INT32/FLOAT 跨寄存器时专用）
ALTER TABLE plc_tag
    ADD COLUMN byte_order VARCHAR(10) NULL
    COMMENT '字节序（LITTLE_ENDIAN/BIG_ENDIAN，INT32/FLOAT 时有效）'
    AFTER bit_offset;

-- 5. 点位表: 字序（多寄存器时专用）
ALTER TABLE plc_tag
    ADD COLUMN word_order VARCHAR(10) NULL
    COMMENT '字序（LOW_FIRST/HIGH_FIRST，跨多寄存器时有效）'
    AFTER byte_order;

-- ============================================================
-- 验证
-- ============================================================
-- DESCRIBE plc_device;
-- DESCRIBE plc_tag;
