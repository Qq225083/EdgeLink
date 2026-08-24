-- ============================================================
-- plc_protocol_compat 种子数据去重 + 唯一键防复发
-- 背景：种子数据被插入两遍（id 1-52 与 53-104 完全重复），
--       导致点位表单「寄存器类型」下拉（brandConfig 回退路径）每项显示两次。
-- 处理：按 (brand, series, com_type, register_type) 保留最小 id，删除其余；
--       再加唯一键，从结构上杜绝再次重复插入。
-- ============================================================

DELETE t FROM plc_protocol_compat t
JOIN (
    SELECT plc_brand, plc_series, com_type, register_type, MIN(id) AS keep_id
    FROM plc_protocol_compat
    GROUP BY plc_brand, plc_series, com_type, register_type
) k ON t.plc_brand = k.plc_brand
   AND t.plc_series = k.plc_series
   AND t.com_type = k.com_type
   AND t.register_type = k.register_type
WHERE t.id > k.keep_id;

ALTER TABLE plc_protocol_compat
    ADD UNIQUE KEY uq_protocol_compat (plc_brand, plc_series, com_type, register_type);
