-- ============================================================
-- EdgeLink 部署中心 — 演示种子数据（可选执行）
-- 用途：让内网/新环境的部署中心立刻有 4 类演示交付物（配合 downloads/ 目录里的同名文件）
-- 幂等：按 file_name 判重；文件未随 SQL 分发（在 ruoyi-fastapi-backend/downloads/ 里，需手动拷贝）
-- ============================================================

INSERT INTO edgelink_download_item (group_key, name, version, file_name, origin_name, size_bytes, description, tags, status, create_by, remark)
SELECT * FROM (
    SELECT 'nodered-full' AS group_key, 'EdgeLink 完整部署包（演示）' AS name, '13.0.0' AS version,
           'full/edgelink-nodered-full-v13.zip' AS file_name, 'edgelink-nodered-full-v13.zip' AS origin_name,
           23629 AS size_bytes, '下载后解压到 D 盘，运行 init 脚本即可启动完整采集系统。' AS description,
           '解压即用,Windows' AS tags, 1 AS status, 'admin' AS create_by, '演示数据' AS remark
    UNION ALL
    SELECT 'nodered-inc', 'EdgeLink 增量部署包（演示）', '13.0.0', 'inc/edgelink-nodered-inc-v13.zip', 'edgelink-nodered-inc-v13.zip',
           25240, '适用于已安装 Node-RED 的机器，复制到指定路径后重启生效。', '增量安装', 1, 'admin', '演示数据'
    UNION ALL
    SELECT 'docs', 'EdgeLink 部署中心设计说明', '1.0', 'docs/EdgeLink部署中心设计说明.md', 'EdgeLink部署中心设计说明.md',
           5344, '部署中心模块的前后端设计文档。', '设计文档', 1, 'admin', '演示数据'
    UNION ALL
    SELECT 'docs', 'EdgeLink 存量监控设计说明', '1.0', 'docs/EdgeLink存量监控设计说明.md', 'EdgeLink存量监控设计说明.md',
           19325, '存量监控模块的完整设计说明（架构/接口/安全）。', '设计文档', 1, 'admin', '演示数据'
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM edgelink_download_item d WHERE d.file_name = seed.file_name);
