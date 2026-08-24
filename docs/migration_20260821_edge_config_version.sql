-- ============================================================
-- nodered_node 增加「边缘已应用配置快照版本」列
-- 背景：发布中心第 4 卡需要对比「边缘已应用版本 vs 最新发布版本」，
--       边缘 CM 拉取 /plc/config/snapshot/list 时记录 snapshotVersion，
--       随 30s 心跳（/monitor/heartbeat?config_version=N）上报并落库。
-- 兼容性：旧边缘不上报该参数 → 列保持 NULL，前端显示「版本未上报」。
-- ============================================================
ALTER TABLE nodered_node
    ADD COLUMN config_version INT NULL COMMENT '边缘已应用的配置快照版本（心跳上报）' AFTER spool_bytes;
