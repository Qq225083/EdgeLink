-- ============================================================
-- 过渡版 C 方案收尾 — 采集点台账回填（2026-09-30，幂等）
-- 背景：设备页左面板数据源切换为 site_health_site（唯一真相源）。
--       历史 bootstrap_key 采集点若未联动登记过，需补建 site_health_site 行，
--       否则切换后从面板消失。
-- 规则：
--   - 按 办公网IP+端口 判重（含 NULL 端口的安全等于），已存在则跳过；
--   - 有启用设备的采集点标 source='config'，纯监控点标 'register'；
--   - site_key_hash 填随机占位（这些点未曾上报，Key 不可知；如需上报走采集监控页重置密钥）。
-- ============================================================

INSERT INTO site_health_site
  (site_key_hash, office_ip, indust_ip, site_name, building, floor, process_stage, node_port, status, source)
SELECT
  SHA2(CONCAT(b.id, RAND(), NOW(6)), 256),
  SUBSTRING_INDEX(b.host_pc_ip, ':', 1),
  b.indust_ip,
  COALESCE(b.node_name, b.node_key),
  b.building,
  b.floor,
  b.process_stage,
  IF(b.host_pc_ip LIKE '%:%', CAST(SUBSTRING_INDEX(b.host_pc_ip, ':', -1) AS UNSIGNED), NULL),
  1,
  IF(EXISTS(SELECT 1 FROM plc_device d WHERE d.host_pc_ip = b.host_pc_ip AND d.del_flag = '0'), 'config', 'register')
FROM edge_bootstrap_key b
WHERE b.host_pc_ip IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM site_health_site s
    WHERE s.office_ip = SUBSTRING_INDEX(b.host_pc_ip, ':', 1)
      AND (s.node_port <=> IF(b.host_pc_ip LIKE '%:%', CAST(SUBSTRING_INDEX(b.host_pc_ip, ':', -1) AS UNSIGNED), NULL))
  );

-- 验证：
-- SELECT id, site_name, office_ip, node_port, source FROM site_health_site;
