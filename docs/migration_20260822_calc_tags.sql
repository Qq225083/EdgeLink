-- ============================================================
-- 计算点位（派生点位）：plc_tag 加 calc_op / calc_source_ids
-- 背景：支持"某点位 = 同设备其他点位的 和/平均/最大/最小"。
--       calc_op 非空即为计算点位（不参与驱动读取，寄存器字段存占位 'CALC'），
--       值在边缘数据管道按 calc_source_ids 求值后走同一输出管道。
-- 约束（后端校验保证）：源点位必须同设备、非计算点位（禁链式）；
--       计算点位所在设备至少要有 1 个启用采集点位（否则没有采集轮次驱动求值）。
-- ============================================================
ALTER TABLE plc_tag
    ADD COLUMN calc_op VARCHAR(16) NULL COMMENT '计算算子：sum/avg/min/max；NULL=采集点位' AFTER word_order,
    ADD COLUMN calc_source_ids VARCHAR(500) NULL COMMENT '计算来源点位ID列表（JSON数组，仅限同设备采集点位）' AFTER calc_op;
