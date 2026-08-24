-- migration_20260719_host_pc_ip_port.sql
-- 目标：支持 host_pc_ip 存储 IP:端口 格式，用于一台 PC 多开 Node-RED 实例
-- 适用：MySQL 5.7，数据库 ruoyi

USE ruoyi;

-- 1. plc_device.host_pc_ip 确保为 VARCHAR(50)
ALTER TABLE plc_device MODIFY COLUMN host_pc_ip VARCHAR(50) DEFAULT NULL COMMENT '主采集节点标识（IP 或 IP:端口，多实例部署时用端口区分）';

-- 2. plc_device.backup_pc_ip 确保为 VARCHAR(50)
ALTER TABLE plc_device MODIFY COLUMN backup_pc_ip VARCHAR(50) DEFAULT NULL COMMENT '备采集节点标识（IP 或 IP:端口，主节点宕机切换）';

-- 3. nodered_node.host_pc_ip 从 VARCHAR(20) 改为 VARCHAR(50)
ALTER TABLE nodered_node MODIFY COLUMN host_pc_ip VARCHAR(50) COMMENT '=office_net_ip[:port]，与plc_device.host_pc_ip对应';

-- 4. 验证
DESCRIBE plc_device;
DESCRIBE nodered_node;
