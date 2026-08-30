-- 存量采集点监控：site_health_site 表新增 node_port 列
-- 用途：同一 IP 部署多个 Node-RED 实例（不同端口，如 8000/8001）时区分实例。
--       登记页手动填写端口，心跳上报时自动回填。
-- 执行环境：MySQL（.env.dev DB_PORT=3308，DB_DATABASE=ruoyi）
-- 仅对已有库执行一次；新建库由 create_all 自动创建该列，无需执行。

ALTER TABLE `site_health_site`
  ADD COLUMN `node_port` INT NULL COMMENT 'Node-RED 监听端口（登记时手动填写，心跳上报自动回填）' AFTER `report_ip`;
