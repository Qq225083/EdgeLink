-- 17_migration_20261004_canvas_snapshot.sql
-- 【MySQL 127.0.0.1:3308/ruoyi 执行】
-- 边缘画布快照表：部署后自动归档 + 手动备份，覆盖误删/换机恢复场景。
-- 注意：payload 含边缘完整 flows（含用户自定义标签页；PG 密码在该包为明文字段），
--      本表按敏感数据对待，下载权限受 flow:release:download 管控。
CREATE TABLE IF NOT EXISTS plc_flow_canvas_snapshot (
    id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
    site_id     BIGINT       NOT NULL COMMENT '采集点ID（site_health_site.id）',
    release_id  BIGINT       NULL COMMENT '关联流程版本ID（部署归档时填；手动备份为空）',
    rev         VARCHAR(64)  NULL COMMENT '边缘 flow rev（Admin API v2）',
    node_count  INT          DEFAULT 0 COMMENT '节点总数',
    payload     MEDIUMTEXT   NOT NULL COMMENT '边缘完整 flows.json（含用户自定义标签页）',
    source      CHAR(10)     NOT NULL DEFAULT 'deploy' COMMENT '来源（deploy部署后自动/manual手动备份）',
    create_by   VARCHAR(64)  NULL COMMENT '操作人',
    create_time DATETIME     NULL COMMENT '归档时间',
    PRIMARY KEY (id),
    KEY ix_canvas_snap_site (site_id),
    KEY ix_canvas_snap_time (create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='边缘画布快照表（部署归档+手动备份，每现场保留最近20份）';
