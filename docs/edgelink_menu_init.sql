-- ============================================================
-- EdgeLink 边缘智联系统 — 菜单初始化脚本
-- 用法：首次部署或菜单丢失时执行此脚本
-- 注意：menu_id 为固定值（与已有数据一致），INSERT 时检查冲突
-- ============================================================

-- 父菜单：连接配置
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (2046, '连接配置', 0, 2, 'link', NULL, 'component', 'M', '0', '0', 'admin', NOW(), 'admin', NOW(), 'EdgeLink PLC 设备与监控入口')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    icon = VALUES(icon),
    remark = VALUES(remark);

-- 子菜单：PLC设备管理
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (2047, 'PLC设备管理', 2046, 1, 'plc/device', 'plc/device/index', 'plc:device:list', 'el-icon-cpu', 'C', '0', '0', 'admin', NOW(), 'admin', NOW(), '管理 PLC 设备及采集点位')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    perms = VALUES(perms),
    icon = VALUES(icon);

-- 子菜单：数据点表
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (2056, '数据点表', 2046, 2, 'plc/tag', 'plc/tag/index', 'plc:tag:list', 'el-icon-collection-tag', 'C', '0', '0', 'admin', NOW(), 'admin', NOW(), '跨设备全局点位查询与批量管理')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    perms = VALUES(perms),
    icon = VALUES(icon);

-- 子菜单：节点监控
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (2062, '节点监控', 2046, 3, 'plc/monitor', 'plc/monitor/index', 'monitor:center:list', 'el-icon-s-platform', 'C', '0', '0', 'admin', NOW(), 'admin', NOW(), '采集节点 KPI 仪表盘与实时告警')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    perms = VALUES(perms),
    icon = VALUES(icon);
