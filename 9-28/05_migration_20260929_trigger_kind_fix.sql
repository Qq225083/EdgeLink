-- ============================================================
-- 过渡版 — 触发方式存量修正（2026-09-29，幂等可重复执行）
-- 内容：trigger_kind=0（握手触发，规划中未实现）的存量设备改为 1（固定周期）。
-- 背景：0 是历史默认值且在前端已禁用，编辑时回显禁用项造成误解。
-- ============================================================

UPDATE plc_device SET trigger_kind = 1 WHERE trigger_kind = 0 AND del_flag = '0';

-- 验证（应返回 0 行）：
-- SELECT id, device_name, trigger_kind FROM plc_device WHERE trigger_kind = 0 AND del_flag = '0';
