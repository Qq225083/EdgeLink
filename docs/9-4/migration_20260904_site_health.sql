-- ============================================================
-- EdgeLink 存量监控 — 2026-09-04 迁移脚本（仅此一个，执行一次即可）
-- 内容：
--   1. site_health_site 新增 栋别/楼层/工程 三列（采集场所拆分，支撑精确统计）
-- 执行环境：MySQL（ruoyi 库）。已有库执行一次；新建库由 create_all 自动包含。
-- ============================================================

ALTER TABLE site_health_site
  ADD COLUMN building       VARCHAR(50) NULL COMMENT '栋别' AFTER site_name,
  ADD COLUMN floor          VARCHAR(50) NULL COMMENT '楼层' AFTER building,
  ADD COLUMN process_stage  VARCHAR(50) NULL COMMENT '工程' AFTER floor;

-- 存量数据处理：三列允许为 NULL（历史数据不强制补全），
-- 前端编辑时会按新的必填规则强制补全。
