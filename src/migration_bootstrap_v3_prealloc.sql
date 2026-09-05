-- ============================================================
-- EdgeLink 边缘节点 Bootstrap v3.0 — 预分配模式迁移
-- 变更：edge_bootstrap_key 表新增 last_heartbeat 列（/auto 激活成功时更新）
-- 执行环境：MySQL（ruoyi 库）。已有库执行一次；新建库由 create_all 自动包含。
-- ============================================================

ALTER TABLE edge_bootstrap_key
  ADD COLUMN last_heartbeat DATETIME NULL COMMENT '最后激活/心跳时间（/auto 校验通过时更新）' AFTER enabled;
