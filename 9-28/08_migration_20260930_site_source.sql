-- ============================================================
-- 过渡版 — site_health_site 增加来源字段（2026-09-30，执行一次）
-- 背景：合并登记后，该表住着两类对象——纯监控点（3001 单独登记）与
--       采集点（3020 采集配置联动创建）。source 字段区分之。
-- 存量行全部为 3001 登记，回填 'register'。
-- ============================================================

ALTER TABLE site_health_site
  ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'register'
  COMMENT '来源：register=存量监控单独登记（纯监控点） config=采集配置联动登记（采集点）' AFTER status;

-- 存量行显式回填（与 DEFAULT 同值，仅为语义明确）
UPDATE site_health_site SET source = 'register' WHERE source IS NULL OR source = '';

-- 验证：SELECT id, site_name, source FROM site_health_site;
