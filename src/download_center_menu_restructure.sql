-- ============================================================
-- EdgeLink 部署中心 — 菜单调整为「目录 + 双页面」（对齐存量监控风格）
-- 执行环境：MySQL（ruoyi 库），幂等可重复执行
-- 变更：
--   3010 部署中心：C 页面 → M 目录
--   新增 3012 下载中心（C, deploy:center:list, plc/downloadCenter/index）
--   新增 3013 交付维护（C, deploy:center:edit, plc/downloadCenter/admin/index）
--   删除 3011（原 F 占位按钮，权限由 3013 页面菜单承载）
-- ============================================================

-- 3010 升级为目录
UPDATE sys_menu SET menu_type = 'M', component = NULL, perms = NULL, remark = 'EdgeLink 交付物自助下载与维护'
WHERE menu_id = 3010;

-- 子菜单：下载中心
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3012, '下载中心', 3010, 1, 'download', 'plc/downloadCenter/index', 'deploy:center:list', 'el-icon-download', 'C', '0', '0', 'admin', NOW(), 'admin', NOW(), '自研节点包 / 完整部署包 / 增量部署包 / 文档手册自助下载')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    perms = VALUES(perms),
    icon = VALUES(icon),
    remark = VALUES(remark);

-- 子菜单：交付维护
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3013, '交付维护', 3010, 2, 'admin', 'plc/downloadCenter/admin/index', 'deploy:center:edit', 'el-icon-setting', 'C', '0', '0', 'admin', NOW(), 'admin', NOW(), '交付物上传 / 编辑 / 上下架 / 删除')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    perms = VALUES(perms),
    icon = VALUES(icon),
    remark = VALUES(remark);

-- 删除旧的 F 占位按钮（权限改由 3013 页面菜单承载）
DELETE FROM sys_role_menu WHERE menu_id = 3011;
DELETE FROM sys_menu WHERE menu_id = 3011;

-- 回滚：
-- UPDATE sys_menu SET menu_type='C', component='plc/downloadCenter/index', perms='deploy:center:list' WHERE menu_id=3010;
-- DELETE FROM sys_role_menu WHERE menu_id IN (3012, 3013);
-- DELETE FROM sys_menu WHERE menu_id IN (3012, 3013);
