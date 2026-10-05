-- 18_migration_20261005_release_deploy_credentials.sql
-- 【MySQL 127.0.0.1:3308/ruoyi 执行】
-- 生成期可选内嵌 MQTT 凭证：不写入 payload（flows.json 保持无密钥），
-- 单独存 deploy_credentials（JSON：{节点id: {字段: 值}}），部署时经 Admin API credentials 对象下发。
ALTER TABLE plc_flow_release
    ADD COLUMN deploy_credentials TEXT NULL COMMENT '部署凭证（JSON，按节点id；仅部署时使用，不进 flows.json）' AFTER deploy_msg;
