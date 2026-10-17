
-- ============================================================================
-- 第 4 段：site_health_error_log 异常履历表（新增）
-- 说明：存量采集点异常从"只留最新快照"改为"逐条履历，保留 7 天"。
--      节点 1.1.0+ 上报的 errors 已带 ts，后端改为逐条插入本表；
--      每天凌晨 3:30 与心跳履历同批清理 7 天前记录。
-- 验证：SELECT COUNT(*) FROM site_health_error_log;
-- ============================================================================
CREATE TABLE IF NOT EXISTS site_health_error_log (
    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '日志ID',
    site_id BIGINT NOT NULL COMMENT '采集点ID',
    error_time VARCHAR(32) NOT NULL COMMENT '异常时间（节点上报 ts 原文）',
    msg VARCHAR(500) NOT NULL COMMENT '异常内容',
    count INT DEFAULT 1 COMMENT '节点侧去重计数',
    create_time DATETIME NULL COMMENT '入库时间',
    PRIMARY KEY (id),
    KEY ix_error_log_site_time (site_id, error_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='存量采集点异常履历（保留7天）';

-- ============================================================================
-- 第 5 段：site_health_site 增加 teams_webhook（Teams 断线通知的 webhook 地址）
-- 说明：采集点登记时可录入 Teams Incoming Webhook，离线区间接口（-edge）随响应带出，
--      Teams 通知流通过 {{teamsWebhook}} 渲染使用，无需在 flow 里写死地址。
-- 验证：SELECT id, site_name, teams_webhook FROM site_health_site;
-- ============================================================================
ALTER TABLE site_health_site
    ADD COLUMN teams_webhook VARCHAR(500) NULL COMMENT 'Teams Incoming Webhook 地址（断线通知用）' AFTER contact;
