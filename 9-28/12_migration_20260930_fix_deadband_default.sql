-- ============================================================
-- 过渡版 — 清理导入默认死区残留（2026-09-30，幂等）
-- 背景：tag_service 导入服务在死区列缺省时默认写 1000（V12 时代默认），
--       经新模板（无死区列）导入的点位全部被污染为 1000.0，
--       触发生成器"死区未生效"误导性 warning。服务默认已改为 0，
--       本脚本清理存量污染行（过渡版不消费死区，归零无副作用）。
-- ============================================================

UPDATE plc_tag SET report_deadband_ms = 0 WHERE report_deadband_ms = 1000 AND del_flag = '0';

-- 验证：SELECT id, tag_name, report_deadband_ms FROM plc_tag WHERE report_deadband_ms > 0;
