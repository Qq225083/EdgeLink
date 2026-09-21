-- ============================================================
-- EdgeLink 存量监控增强 — 2026-09-20 迁移脚本（仅此一个，执行一次即可）
-- 内容：
--   1. site_health_site 新增 last_errors 列（节点 error 日志快照，心跳捎带上报）
--   2. 新建 site_health_flows_upload 表（flows.json 上传档案，每站点保留最近 5 份）
-- 执行环境：MySQL（ruoyi 库）。已有库执行一次；新建库由 create_all 自动包含。
-- ============================================================

ALTER TABLE site_health_site
  ADD COLUMN last_errors TEXT NULL COMMENT '最近错误快照（JSON数组，最多10条 {ts,msg,count}）';

-- 注意：flows.json / error 日志可能含 emoji 等 4 字节字符，必须 utf8mb4（MySQL 默认 utf8 只支持 3 字节，会报 1366）
CREATE TABLE IF NOT EXISTS site_health_flows_upload (
  id          BIGINT       PRIMARY KEY AUTO_INCREMENT COMMENT '档案ID',
  site_id     BIGINT       NOT NULL COMMENT '采集点ID',
  reason      VARCHAR(200) NOT NULL COMMENT '上传原因（节点侧必填）',
  content     LONGTEXT     NOT NULL COMMENT 'flows.json 全文',
  size_bytes  INT          NULL COMMENT '文件大小（字节）',
  sha256      VARCHAR(64)  NULL COMMENT '内容 SHA-256（完整性校验）',
  created_at  DATETIME     NOT NULL COMMENT '上传时间',
  KEY idx_site_created (site_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='存量采集点 flows.json 上传档案';

-- 已执行过旧版本脚本的库（last_errors 列/flows_upload 表已是 utf8）：用下面两句修复
-- ALTER TABLE site_health_site MODIFY last_errors TEXT CHARACTER SET utf8mb4 NULL COMMENT '最近错误快照（JSON数组，最多10条 {ts,msg,count}）';
-- ALTER TABLE site_health_flows_upload CONVERT TO CHARACTER SET utf8mb4;
