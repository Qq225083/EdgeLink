-- ===================================================================
-- EdgeLink 采集节点监控中心 — 数据库建表脚本
-- 数据库: ruoyi (MySQL)
-- 用途: 10台采集PC + 200台PLC 的实时监控
-- ===================================================================

-- ===================================================================
-- 1. 采集节点表（10条记录，手动/自动注册）
-- ===================================================================
CREATE TABLE IF NOT EXISTS nodered_node (
    id              BIGINT PRIMARY KEY AUTO_INCREMENT,
    node_name       VARCHAR(50) NOT NULL COMMENT '节点名称 如PC-01-产线A',
    office_net_ip   VARCHAR(20) COMMENT '办公网IP（NIC1，连接MySQL/上报心跳）',
    indust_net_ip   VARCHAR(20) COMMENT '工业网IP（NIC2，连接PLC）',
    host_pc_ip      VARCHAR(20) COMMENT '= office_net_ip，与plc_device.host_pc_ip对应，用于关联设备',
    status          TINYINT DEFAULT 1 COMMENT '0停用 1启用',
    heartbeat_interval INT DEFAULT 30 COMMENT '心跳间隔（秒）',
    last_heartbeat  DATETIME COMMENT '最后心跳时间',
    remark          VARCHAR(200) COMMENT '备注',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_host_pc_ip (host_pc_ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='采集节点注册表';

-- ===================================================================
-- 2. 心跳日志表（保留7天，定时清理）
-- ===================================================================
CREATE TABLE IF NOT EXISTS nodered_heartbeat_log (
    id              BIGINT PRIMARY KEY AUTO_INCREMENT,
    node_id         BIGINT NOT NULL,
    report_time     DATETIME NOT NULL,
    node_ip         VARCHAR(20) COMMENT '上报时的办公网IP',
    running_flows   INT DEFAULT 0 COMMENT '当前运行流数量',
    memory_usage_mb INT DEFAULT 0 COMMENT '内存占用（MB）',
    INDEX idx_node_time (node_id, report_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='心跳日志（保留7天）';

-- ===================================================================
-- 3. PLC 通信状态表（实时快照，每个 node+device 一条，覆盖更新）
-- ===================================================================
CREATE TABLE IF NOT EXISTS device_comm_status (
    id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
    node_id             BIGINT NOT NULL COMMENT '所属采集节点ID',
    device_id           BIGINT NOT NULL COMMENT 'plc_device.id',
    online              TINYINT DEFAULT 0 COMMENT '0离线 1在线',
    last_success_time   DATETIME COMMENT '最后成功采集时间',
    last_error_time     DATETIME COMMENT '最后错误时间',
    error_msg           VARCHAR(500) COMMENT '最近一次错误信息',
    consecutive_fails   INT DEFAULT 0 COMMENT '连续失败次数（用于判断是否告警）',
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_node_device (node_id, device_id),
    INDEX idx_online (online),
    INDEX idx_device_id (device_id),
    -- 注意：plc_device 采用软删除（del_flag='2'），物理删除极少发生，
    -- 因此外键级联删除主要作为兜底，日常软删除清理由业务层同步 online=0 处理。
    FOREIGN KEY (device_id) REFERENCES plc_device(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PLC通信实时状态';

-- ===================================================================
-- 4. PG 写入监控表（每个节点一条，覆盖更新）
-- ===================================================================
CREATE TABLE IF NOT EXISTS pg_write_status (
    id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
    node_id             BIGINT NOT NULL COMMENT '所属采集节点ID',
    last_write_time     DATETIME COMMENT '最后成功写入PG的时间',
    write_latency_ms    INT DEFAULT 0 COMMENT '最近一次写入延迟（ms）',
    today_write_count   INT DEFAULT 0 COMMENT '今日写入条数',
    error_msg           VARCHAR(500) COMMENT '最近一次错误信息',
    consecutive_fails   INT DEFAULT 0 COMMENT '连续失败次数',
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_node (node_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PG写入实时状态';

-- ===================================================================
-- 5. 告警表（有生命周期：产生→确认→恢复）
-- ===================================================================
CREATE TABLE IF NOT EXISTS monitor_alert (
    id              BIGINT PRIMARY KEY AUTO_INCREMENT,
    alert_type      VARCHAR(30) NOT NULL COMMENT 'NODE_OFFLINE / PLC_OFFLINE / PG_WRITE_LAG',
    severity        TINYINT DEFAULT 2 COMMENT '1严重 2一般 3提示',
    node_id         BIGINT NOT NULL DEFAULT 0 COMMENT '关联采集节点（0=不关联节点）',
    device_id       BIGINT NOT NULL DEFAULT 0 COMMENT '关联PLC设备（0=不关联设备）',
    alert_msg       VARCHAR(500) COMMENT '告警内容',
    status          TINYINT DEFAULT 0 COMMENT '0未处理 1已确认 2已恢复',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at    DATETIME COMMENT '确认时间',
    resolved_at     DATETIME COMMENT '恢复时间',
    UNIQUE KEY uk_alert_dedup (alert_type, node_id, device_id, status),
    INDEX idx_status_time (status, created_at DESC),
    INDEX idx_type (alert_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='监控告警表';

-- ===================================================================
-- 6. 心跳日志清理事件（MySQL Event，每天凌晨删除7天前的日志）
-- ===================================================================
DROP EVENT IF EXISTS clean_heartbeat_log;
CREATE EVENT clean_heartbeat_log
ON SCHEDULE EVERY 1 DAY STARTS CURRENT_TIMESTAMP + INTERVAL 1 DAY
DO DELETE FROM nodered_heartbeat_log WHERE report_time < DATE_SUB(NOW(), INTERVAL 7 DAY);

-- ===================================================================
-- 6b. PG 写入计数按日重置事件（MySQL Event，每天零点清零 today_write_count）
-- ===================================================================
DROP EVENT IF EXISTS reset_pg_write_count_daily;
CREATE EVENT reset_pg_write_count_daily
ON SCHEDULE EVERY 1 DAY STARTS CURRENT_TIMESTAMP + INTERVAL 1 DAY
DO UPDATE pg_write_status SET today_write_count = 0;

-- ===================================================================
-- 7. 节点由心跳自动注册（不再手动插入）
--    Node-RED启动后自动发心跳到 /monitor/heartbeat
--    后端发现新 host_pc_ip 时自动创建 nodered_node 记录
--    如需手动注册，在RuoYi后台操作即可
-- ===================================================================
