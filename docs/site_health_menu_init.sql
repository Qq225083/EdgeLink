-- ============================================================
-- EdgeLink 边缘智联系统 — 存量采集点监控 菜单初始化脚本
-- 用法：部署「存量采集点监控」功能时执行一次（幂等，可重复执行）
-- 说明：二级目录「存量采集点监控」挂在 EdgeLink 系统目录（menu_id=2083）下，
--       与「连接配置」(2046) 同级；下设采集点登记 / 采集点监控两个页面。
--       老版 Node-RED 心跳上报监控，与 V12 采集体系完全独立。
-- 注意：历史版本曾把本目录放在顶级（parent_id=0），本脚本会将其归位到 2083 下。
--       非超管角色若之前授过权，目录归位后需在角色管理中重新勾选本目录。
-- ============================================================

-- 二级目录：存量采集点监控（EdgeLink 2083 下，与「连接配置」同级，order_num 4 插在其后）
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3000, '存量采集点监控', 2083, 4, 'site-health', NULL, 'el-icon-monitor', 'M', '0', '0', 'admin', NOW(), 'admin', NOW(), '老版 Node-RED 采集程序心跳/内存健康监控（与 V12 采集体系完全独立）')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    icon = VALUES(icon),
    remark = VALUES(remark);

-- 子菜单：采集点登记（情报登录，生成一次性密钥）
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3001, '采集点登记', 3000, 1, 'register', 'plc/siteHealth/register/index', 'site:health:add', 'el-icon-edit-outline', 'C', '0', '0', 'admin', NOW(), 'admin', NOW(), '登记旧版采集点情报，生成仅显示一次的密钥 Key')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    perms = VALUES(perms),
    icon = VALUES(icon);

-- 子菜单：采集点监控（一览卡片 + 当前信息 + 心跳履历）
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3002, '采集点监控', 3000, 2, 'monitor', 'plc/siteHealth/monitor/index', 'site:health:list', 'el-icon-view', 'C', '0', '0', 'admin', NOW(), 'admin', NOW(), '一览卡片查看各采集点在线状态、内存/流/版本指标与心跳履历，修改/重置密钥/启停/删除')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    perms = VALUES(perms),
    icon = VALUES(icon);

-- 按钮权限：编辑（修改情报/重置密钥/启停）、删除。挂在「采集点监控」菜单下，
-- 供非超管角色授权使用（超管 *:*:* 天然放行，无需勾选）。
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3003, '采集点编辑', 3002, 1, '', NULL, 'site:health:edit', '#', 'F', '0', '0', 'admin', NOW(), 'admin', NOW(), '修改情报 / 重置密钥 / 启用 / 停用')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    perms = VALUES(perms);

INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3004, '采集点删除', 3002, 2, '', NULL, 'site:health:remove', '#', 'F', '0', '0', 'admin', NOW(), 'admin', NOW(), '删除采集点及其心跳履历')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    perms = VALUES(perms);
