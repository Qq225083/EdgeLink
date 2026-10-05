-- ============================================================
-- 过渡版 — 点位名称 → 点位ID（2026-10-01，幂等）
-- 背景：tag_name 列语义变更——原「点位名称」（人可读名称）改为「点位ID」（业务标识，
--       纯数字，写入 plc_data_log.tag_id 的 BIGINT 列）；原人可读名称挪到 description（备注）。
--       方案：复用 tag_name 列，无新增列、无类型变更，仅同步列注释。
--       存量活跃点位 tag_name 已是纯数字（100/101/12341），无需数据迁移。
-- ============================================================

ALTER TABLE plc_tag
    MODIFY COLUMN tag_name    VARCHAR(100) NOT NULL COMMENT '点位ID（业务标识，写入 plc_data_log.tag_id）',
    MODIFY COLUMN description TEXT         DEFAULT NULL COMMENT '备注（点位名称/描述）';

-- 验证：SHOW FULL COLUMNS FROM plc_tag WHERE Field IN ('tag_name','description');
