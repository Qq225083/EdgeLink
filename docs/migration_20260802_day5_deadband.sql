-- ============================================================================
-- EdgeLink Day5 迁移：死区列类型与语义统一（P1-1）
-- 适用：从 2026-07-27 之前的库结构升级（report_deadband_ms INT 默认 1000）
-- 说明：dev 库（ruoyi@127.0.0.1:3308）已于 2026-08-02 直接执行过下列语句；
--       本文件用于其他环境（试运行/生产）重放。执行前请备份。
-- ============================================================================

-- 1) 列类型 INT → FLOAT，默认值 1000 → 0，注释更正（旧注释误写"ms"）
ALTER TABLE plc_tag
  MODIFY COLUMN report_deadband_ms FLOAT NOT NULL DEFAULT 0
  COMMENT '变化上报死区（数值，工程单位），0=每次上报';

-- 2) 存量迁移：默认垃圾值 1000 → 0
--    依据：1000 是 ms 语义时代的默认值；在数值语义下 1000 会吞掉几乎全部变化
--    （PG 实证：deadband=1000 点位数据密度约为 deadband=0 的一半）
UPDATE plc_tag SET report_deadband_ms = 0 WHERE report_deadband_ms = 1000;

-- 3) 验收查询
-- SELECT report_deadband_ms, COUNT(*) FROM plc_tag GROUP BY report_deadband_ms;
-- SHOW COLUMNS FROM plc_tag LIKE 'report_deadband_ms';  -- 期望 float, default 0
