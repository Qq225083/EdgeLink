-- 16_migration_20261004_fix_release_status.sql
-- 【MySQL 127.0.0.1:3308/ruoyi 执行】
-- 修复：历史部署只置位不复位，导致同一现场多个版本同时显示"已部署"。
-- 语义应为"一现场最多一个已部署版本"——保留每个现场最新一条已部署，其余复位为草稿。
UPDATE plc_flow_release r
LEFT JOIN (
    SELECT site_id, MAX(id) AS keep_id
    FROM plc_flow_release
    WHERE status = '1'
    GROUP BY site_id
) k ON r.site_id = k.site_id AND r.id = k.keep_id
SET r.status = '0'
WHERE r.status = '1' AND k.keep_id IS NULL;

-- 验证：应每个现场最多一行
-- SELECT site_id, COUNT(*) FROM plc_flow_release WHERE status='1' GROUP BY site_id HAVING COUNT(*)>1;
