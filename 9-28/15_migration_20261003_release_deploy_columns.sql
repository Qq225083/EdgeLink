-- 15_migration_20261003_release_deploy_columns.sql
-- 【MySQL 127.0.0.1:3308/ruoyi 执行】
-- Admin API 自动部署：release 表记录部署时间/操作人/结果摘要（含边缘节点包版本留痕）
ALTER TABLE plc_flow_release
    ADD COLUMN deploy_time DATETIME NULL COMMENT '最近一次部署到边缘的时间' AFTER status,
    ADD COLUMN deploy_by   VARCHAR(64) NULL COMMENT '部署操作人' AFTER deploy_time,
    ADD COLUMN deploy_msg  VARCHAR(500) NULL COMMENT '部署结果摘要（边缘节点包版本留痕等）' AFTER deploy_by;
