-- ============================================================
-- 发布即版本模型：已发布配置快照表
-- 背景：此前边缘 30s 兜底轮询直接读数据库实时表，导致"保存即生效"，
--       与发布中心"保存≠发布"的设计意图冲突。
-- 本表是边缘节点的唯一配置拉取源：只有点击发布后，配置才固化为新版本快照。
-- 单行全局快照（多节点规模小，边缘本地按 host_pc_ip 过滤，与现状一致）。
-- ============================================================
CREATE TABLE IF NOT EXISTS plc_config_snapshot (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键',
  version INT NOT NULL DEFAULT 1 COMMENT '版本号（每次发布+1）',
  payload MEDIUMTEXT NOT NULL COMMENT '快照内容：JSON数组，元素结构与 /plc/tag/global/list 响应行一致',
  published_by VARCHAR(64) DEFAULT '' COMMENT '发布人',
  published_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '发布时间',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='已发布配置快照（发布即版本：边缘唯一拉取源）';
