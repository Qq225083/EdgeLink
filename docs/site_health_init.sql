-- ===================================================================
-- EdgeLink 存量采集点监控（site-health）— 建表脚本
-- 数据库: ruoyi (MySQL)
-- 用途: 旧版 Node-RED 采集点的登记信息 + 心跳履历
-- 说明:
--   1. 新建库：后端启动时 create_all 会自动建表，本脚本可不必执行；
--      如需手工建表（或不启动后端先备库），执行本脚本即可，幂等。
--   2. 已有旧表（无 node_port 列）的库：不要执行本脚本，
--      改执行 docs/migration_site_health_node_port.sql 补列。
-- ===================================================================

-- ===================================================================
-- 1. 采集点登记表（密钥仅存 SHA-256 哈希，明文仅登记/重置时返回一次）
-- ===================================================================
CREATE TABLE IF NOT EXISTS site_health_site (
    id                BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '采集点ID',
    site_key_hash     VARCHAR(64) NOT NULL COMMENT '密钥哈希（明文仅创建/重置时返回一次）',
    office_ip         VARCHAR(20) NOT NULL COMMENT '办公网IP',
    indust_ip         VARCHAR(20) COMMENT '工业网IP',
    site_name         VARCHAR(100) NOT NULL COMMENT '采集场所',
    contact           VARCHAR(50) COMMENT '联系人',
    remark            VARCHAR(200) COMMENT '采集备注',
    node_port         INT COMMENT 'Node-RED 监听端口（办公网IP+端口唯一标识采集点；登记必填，存量空行由心跳回填）',
    heartbeat_interval INT DEFAULT 30 COMMENT '心跳间隔秒（节点上报，10-180）',
    status            SMALLINT DEFAULT 1 COMMENT '0停用 1启用',
    last_heartbeat    DATETIME COMMENT '最后心跳时间',
    report_ip         VARCHAR(50) COMMENT '最近上报来源IP',
    memory_rss_mb     INT COMMENT 'Node进程内存占用MB',
    memory_total_mb   INT COMMENT '整机总内存MB',
    memory_free_mb    INT COMMENT '整机空闲内存MB',
    running_flows     INT COMMENT '运行流数量',
    node_red_version  VARCHAR(20) COMMENT 'Node-RED版本',
    uptime_sec        BIGINT COMMENT 'Node-RED运行时长秒',
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE KEY uk_site_key_hash (site_key_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='存量采集点登记表';

-- ===================================================================
-- 2. 心跳履历表（保留7天，内置任务每天 03:30 清理）
-- ===================================================================
CREATE TABLE IF NOT EXISTS site_health_heartbeat_log (
    id                BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '日志ID',
    site_id           BIGINT NOT NULL COMMENT '采集点ID',
    report_time       DATETIME NOT NULL COMMENT '上报时间',
    report_ip         VARCHAR(50) COMMENT '上报来源IP',
    memory_rss_mb     INT DEFAULT 0 COMMENT 'Node进程内存占用MB',
    memory_total_mb   INT DEFAULT 0 COMMENT '整机总内存MB',
    memory_free_mb    INT DEFAULT 0 COMMENT '整机空闲内存MB',
    running_flows     INT DEFAULT 0 COMMENT '运行流数量',
    node_red_version  VARCHAR(20) COMMENT 'Node-RED版本',
    uptime_sec        BIGINT DEFAULT 0 COMMENT 'Node-RED运行时长秒',
    KEY ix_site_health_heartbeat_log_site_id (site_id),
    KEY ix_site_health_heartbeat_log_report_time (report_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='存量采集点心跳履历';
