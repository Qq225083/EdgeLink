-- ============================================================
-- EdgeLink 边缘智联系统 — 部署中心（节点与文档下载）菜单初始化脚本
-- 用法：部署「部署中心」功能时执行一次（幂等，可重复执行）
-- 说明：挂在 EdgeLink 系统目录（menu_id=2083）下，与「采集配置」同级；
--       页面提供自研节点包 / 完整部署包 / 增量部署包 / 文档手册的自助下载。
-- ============================================================

-- 页面：部署中心
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3010, '部署中心', 2083, 5, 'deploy-center', 'plc/downloadCenter/index', 'deploy:center:list', 'el-icon-download', 'C', '0', '0', 'admin', NOW(), 'admin', NOW(), 'EdgeLink 交付物自助下载：自研节点包 / 完整部署包 / 增量部署包 / 文档手册')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    perms = VALUES(perms),
    icon = VALUES(icon),
    remark = VALUES(remark);

-- 按钮权限：交付物维护（上传/编辑 manifest，后续实现后再启用）
-- 现在先登记占位，页面实现后把 perms 挂到后端接口上即可
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3011, '交付物维护', 3010, 1, '', NULL, 'deploy:center:edit', '#', 'F', '0', '0', 'admin', NOW(), 'admin', NOW(), '上传/编辑交付物清单（预留）')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    perms = VALUES(perms);
