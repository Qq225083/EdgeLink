-- ============================================================
-- EdgeLink 部署中心 — 补丁：交付物增加原始文件名列
-- 用途：下载时用原始文件名（用户友好），存盘名继续用时间戳防冲突
-- 执行环境：MySQL（ruoyi 库），幂等可重复执行
-- ============================================================

-- 1. 加列（已有库执行一次；新建库由 create_all 自动包含）
ALTER TABLE edgelink_download_item
  ADD COLUMN origin_name VARCHAR(255) NULL COMMENT '原始文件名（上传时的文件名，用于下载展示）' AFTER file_name;

-- 2. 存量数据回填：从存盘名提取原始文件名（去掉时间戳前缀和子目录）
UPDATE edgelink_download_item
SET origin_name = SUBSTRING_INDEX(file_name, '/', -1)
WHERE origin_name IS NULL;
