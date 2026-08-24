-- migration_20260726_node_health.sql
-- #88: nodered_node 增加节点健康指标列（当前内存/流数/PG统计/spool积压）
-- MySQL 5.7+ / PostgreSQL 通用（NUMERIC 在 MySQL 中等价 DECIMAL，均可存 BIGINT 范围）

ALTER TABLE nodered_node
  ADD COLUMN running_flows INT NULL COMMENT '运行流数量（最近一次心跳上报）' AFTER last_heartbeat,
  ADD COLUMN memory_usage_mb INT NULL COMMENT '内存占用MB（最近一次心跳上报）' AFTER running_flows,
  ADD COLUMN pg_success_count BIGINT NULL COMMENT 'PG累计写入成功条数（边缘累计值）' AFTER memory_usage_mb,
  ADD COLUMN pg_fail_count BIGINT NULL COMMENT 'PG累计写入失败条数（边缘累计值）' AFTER pg_success_count,
  ADD COLUMN spool_bytes BIGINT NULL COMMENT '磁盘spool积压字节数（#82，0=无积压）' AFTER pg_fail_count;
