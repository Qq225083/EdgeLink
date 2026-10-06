-- 02_menu_site_register.sql
-- 【MySQL 执行】补建菜单：采集点登记（3020）
-- 背景：本地库的 3020 是早期手工建的，从未归档；服务器上缺失该菜单会导致
--       设备管理页「登记」按钮跳转无效（路由不存在）。
-- 幂等：INSERT IGNORE；若服务器上 3020 被其他菜单占用，先 SELECT 确认再改 id。
-- 菜单位置：EdgeLink系统(2083) → 采集配置(2046) → 采集点登记(3020)，排在首位。
-- 生效方式：执行后用户重新登录（动态路由在登录时构建）。
--
-- 验证：SELECT * FROM sys_menu WHERE menu_id=3020;
INSERT IGNORE INTO sys_menu
    (menu_id, menu_name, parent_id, order_num, path, component, query, is_frame, is_cache, menu_type, visible, status, perms, icon, create_by, create_time, remark)
VALUES
    (3020, '采集点登记', 2046, 0, 'site-register', 'plc/siteRegister/index', NULL, 1, 0, 'C', '0', '0', 'plc:bootstrap-key:add', 'el-icon-plus', 'admin', NOW(), '采集点登记（含健康监控档案联动），工作流第一步');

-- 若服务器上 admin 之外的角色也需要看到，按角色补授权（role_id 按实际改）：
-- INSERT IGNORE INTO sys_role_menu (role_id, menu_id) VALUES (2, 3020);
