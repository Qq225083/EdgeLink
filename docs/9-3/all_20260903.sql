-- ============================================================
-- EdgeLink 2026-09-03/04 变更 — 合一迁移脚本（只需执行这一个文件）
-- 内容：
--   1. edge_bootstrap_key 新增 last_heartbeat 列（Bootstrap v3.0 /auto 激活记录）
--   2. 「采集配置」下新增「采集点登记」菜单
-- 执行环境：MySQL（ruoyi 库）。已有库执行一次；幂等说明见各段注释。
-- ============================================================

-- ---------- 1. edge_bootstrap_key 补列（若列已存在会报 duplicate column，忽略即可）----------
ALTER TABLE edge_bootstrap_key
  ADD COLUMN last_heartbeat DATETIME NULL COMMENT '最后激活/心跳时间（/auto 校验通过时更新）' AFTER enabled;

-- ---------- 1b. edge_bootstrap_key 位置三列（采集点登记页 栋别/楼层/工程）----------
ALTER TABLE edge_bootstrap_key
  ADD COLUMN building      VARCHAR(50) NULL COMMENT '栋别' AFTER host_pc_ip,
  ADD COLUMN floor         VARCHAR(50) NULL COMMENT '楼层' AFTER building,
  ADD COLUMN process_stage VARCHAR(50) NULL COMMENT '工程' AFTER floor;

-- ---------- 1c. 采集点工业网 IP + PLC PC 侧源端口（防火墙严格环境）----------
ALTER TABLE edge_bootstrap_key
  ADD COLUMN indust_ip VARCHAR(20) NULL COMMENT '工业网IP（采集点固定工业网卡地址）' AFTER host_pc_ip;

ALTER TABLE plc_device
  ADD COLUMN local_port INT NULL COMMENT 'PC侧源端口（防火墙严格环境固定源端口用；留空系统自动分配）' AFTER plc_port;

-- ---------- 2. 菜单：采集点登记（采集配置 2046 下，幂等可重复执行）----------
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3020, '采集点登记', 2046, 5, 'site-register', 'plc/siteRegister/index', 'plc:bootstrap-key:add', 'el-icon-plus', 'C', '0', '0', 'admin', NOW(), 'admin', NOW(), '登记采集点（Node-RED 采集 PC）并生成一次性密钥，现场填密钥完成绑定')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    perms = VALUES(perms),
    icon = VALUES(icon),
    remark = VALUES(remark);
