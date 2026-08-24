-- migration_20260719_bootstrap.sql
-- Day 7 Bootstrap 配置下发：边缘节点初始接入密钥表
-- 适用：MySQL 5.7，数据库 ruoyi

USE ruoyi;

-- ===================================================================
-- 1. 创建 edge_bootstrap_key 表
-- ===================================================================
CREATE TABLE IF NOT EXISTS edge_bootstrap_key (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    node_key VARCHAR(64) NOT NULL UNIQUE COMMENT '节点标识（如 pc-001）',
    node_name VARCHAR(100) COMMENT '节点名称',
    host_pc_ip VARCHAR(50) COMMENT '预设的节点标识（IP:端口）',
    secret_key VARCHAR(64) NOT NULL COMMENT '初始接入密钥',
    enabled TINYINT(1) DEFAULT 1 COMMENT '是否启用（0停用 1启用）',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_node_key (node_key),
    INDEX idx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='边缘节点初始接入密钥表';

-- ===================================================================
-- 2. 插入示例节点（请根据实际环境修改）
-- ===================================================================
INSERT IGNORE INTO edge_bootstrap_key (node_key, node_name, host_pc_ip, secret_key, enabled) VALUES
('pc-001', '默认采集节点-001', '192.168.1.3:1880', 'dev-bootstrap-secret-001', 1);

-- ===================================================================
-- 3. 验证
-- ===================================================================
DESCRIBE edge_bootstrap_key;
SELECT * FROM edge_bootstrap_key;
