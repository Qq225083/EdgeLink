-- migration_20260719_day5.sql
-- Day 5 设备/点位状态一致性 + 方案1 IP:端口 数据库变更汇总
-- 适用：MySQL 5.7，数据库 ruoyi
-- 注意：执行前请备份数据库

USE ruoyi;

-- ===================================================================
-- 1. plc_publish_log 表（Day 3 新增，如已存在则跳过）
-- ===================================================================
CREATE TABLE IF NOT EXISTS plc_publish_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    publish_by VARCHAR(64) COMMENT '发布人',
    publish_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '发布时间',
    device_count INT DEFAULT 0 COMMENT '涉及设备数',
    node_count INT DEFAULT 0 COMMENT '涉及采集节点数',
    ip_count INT DEFAULT 0 COMMENT '涉及IP数',
    device_ids JSON COMMENT '发布的设备ID列表',
    remark VARCHAR(500) COMMENT '备注'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PLC配置发布日志表';

-- ===================================================================
-- 2. host_pc_ip 字段长度调整（方案1，支持 IP:端口）
-- ===================================================================
ALTER TABLE plc_device MODIFY COLUMN host_pc_ip VARCHAR(50) DEFAULT NULL COMMENT '主采集节点标识（IP 或 IP:端口，多实例部署时用端口区分）';
ALTER TABLE plc_device MODIFY COLUMN backup_pc_ip VARCHAR(50) DEFAULT NULL COMMENT '备采集节点标识（IP 或 IP:端口，主节点宕机切换）';
ALTER TABLE nodered_node MODIFY COLUMN host_pc_ip VARCHAR(50) COMMENT '=office_net_ip[:port]，与plc_device.host_pc_ip对应';

-- ===================================================================
-- 3. device_comm_status 外键（Day 5 新增）
-- ===================================================================
-- 3.1 先清理孤立记录（避免外键创建失败）
DELETE FROM device_comm_status 
WHERE device_id NOT IN (SELECT id FROM plc_device);

-- 3.2 添加外键（如果已存在会报错，可忽略）
ALTER TABLE device_comm_status 
ADD CONSTRAINT fk_device_comm_device 
FOREIGN KEY (device_id) REFERENCES plc_device(id) ON DELETE CASCADE;

-- ===================================================================
-- 4. 验证
-- ===================================================================
DESCRIBE plc_device;
DESCRIBE nodered_node;
SHOW CREATE TABLE device_comm_status;
SHOW TABLES LIKE 'plc_publish_log';
