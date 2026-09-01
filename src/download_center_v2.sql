-- ============================================================
-- EdgeLink 部署中心（节点与文档下载）— 交付物表建表 + 种子数据
-- 执行环境：MySQL（ruoyi 库），幂等可重复执行
-- 日期：2026-08-30
-- 说明：
--   1. edgelink_download_item 为交付物清单表（替代 manifest.json 作为数据源）；
--   2. 后端启动时 create_all 也会自动建表，本脚本用于手工建库/存量部署；
--   3. 种子数据：存量监控节点包（已就位文件 packages/node-red-contrib-edgelink-site-health.zip）。
-- ============================================================

CREATE TABLE IF NOT EXISTS edgelink_download_item (
    id            BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '交付物ID',
    group_key     VARCHAR(30) NOT NULL COMMENT '类别：packages自研节点包 / nodered-full完整部署包 / nodered-inc增量部署包 / docs文档手册',
    name          VARCHAR(100) NOT NULL COMMENT '交付物名称',
    version       VARCHAR(20) COMMENT '版本号',
    file_name     VARCHAR(255) NOT NULL COMMENT '磁盘文件名（相对 downloads 目录的路径，含子目录）',
    size_bytes    BIGINT DEFAULT 0 COMMENT '文件大小（字节）',
    description   VARCHAR(500) COMMENT '描述',
    tags          VARCHAR(200) COMMENT '标签（逗号分隔）',
    status        SMALLINT DEFAULT 1 COMMENT '0下架 1上架（下载中心只显示上架）',
    create_by     VARCHAR(64) COMMENT '创建者',
    create_time   DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_by     VARCHAR(64) COMMENT '更新者',
    update_time   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    remark        VARCHAR(200) COMMENT '备注',
    KEY ix_edgelink_download_item_group (group_key, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='EdgeLink 部署中心交付物表';

-- 种子数据：存量监控节点包（幂等：按 file_name 判重）
INSERT INTO edgelink_download_item (group_key, name, version, file_name, size_bytes, description, tags, status, create_by, remark)
SELECT 'packages', '存量监控节点包', '1.0.6', 'packages/node-red-contrib-edgelink-site-health.zip', 8448,
       '下载后解压到 Node-RED 的 node_modules 目录，重启即可自动识别加载。',
       'Node-RED ≥1.0,零依赖', 1, 'admin', '初始交付物'
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM edgelink_download_item WHERE file_name = 'packages/node-red-contrib-edgelink-site-health.zip'
);
