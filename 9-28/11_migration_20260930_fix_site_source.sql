-- ============================================================
-- 过渡版 — 存量站点来源纠正（2026-09-30，幂等可重复执行）
-- 背景：09 回填只覆盖新建行；此前已存在、且名下已有启用设备的站点
--       仍是 register（如「二厂3楼」带设备49）。本脚本把这类存量站点
--       纠正为 config（有启用设备 = 采集点）。
-- 审计备注：此 UPDATE 当日为直接执行，漏写归档，后补录于此（review 发现）。
-- ============================================================

UPDATE site_health_site s
SET source = 'config'
WHERE source = 'register'
  AND EXISTS (
    SELECT 1 FROM plc_device d
    WHERE d.del_flag = '0'
      AND (d.host_pc_ip = s.office_ip OR d.host_pc_ip = CONCAT(s.office_ip, ':', s.node_port))
  );

-- 验证：SELECT id, site_name, source FROM site_health_site;
-- 有启用设备的站点应为 config，纯监控点为 register
