-- ========================================
-- EdgeLink v2.0 监控表唯一约束迁移
-- 适用：MySQL / PostgreSQL
-- 日期：2026-06-18
-- 目的：修复 upsert 竞态条件（B1）
-- ========================================

-- 1. device_comm_status: (node_id, device_id) 唯一
--    确保同一节点+同一设备只有一条通信状态记录
ALTER TABLE device_comm_status
  ADD CONSTRAINT uq_device_comm_node_device UNIQUE (node_id, device_id);

-- 2. pg_write_status: node_id 唯一
--    确保每个节点只有一条PG写入状态记录
ALTER TABLE pg_write_status
  ADD CONSTRAINT uq_pg_write_status_node_id UNIQUE (node_id);

-- 3. nodered_node: host_pc_ip 唯一
--    确保每个办公网IP只注册一个采集节点
ALTER TABLE nodered_node
  ADD CONSTRAINT uq_nodered_node_host_pc_ip UNIQUE (host_pc_ip);

-- ========================================
-- 兼容 PostgreSQL 版本 (替换上方 MySQL 语法)
-- ========================================
-- ALTER TABLE device_comm_status ADD CONSTRAINT uq_device_comm_node_device UNIQUE (node_id, device_id);
-- ALTER TABLE pg_write_status ADD CONSTRAINT uq_pg_write_status_node_id UNIQUE (node_id);
-- ALTER TABLE nodered_node ADD CONSTRAINT uq_nodered_node_host_pc_ip UNIQUE (host_pc_ip);
