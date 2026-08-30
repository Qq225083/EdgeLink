-- ===================================================================
-- EdgeLink 菜单结构调整（采集配置 / 运行监控 / 发布与履历 三域重组）
-- 执行环境：MySQL（ruoyi 库），幂等可重复执行
-- 日期：2026-08-30
-- 说明：
--   1. 只动 parent_id / order_num / path / visible / menu_name，menu_id 全部不变
--      → 角色授权（sys_role_menu）不受影响，无需重配角色；
--   2. 「日志中心」是发布履历+修改履历的合集页（含两个 tab），
--      原「发布履历」「修改履历」独立菜单改为隐藏（visible='1'）——侧边栏去重，
--      权限串 plc:publish-log:list / plc:change-log:list 仍可被角色勾选授予；
--   3. 「驱动列表查询」F 型按钮从目录层归位到「驱动管理」页面下；
--   4. 可视化/点检的中文 path 改英文（URL 变为 /edgelink/visual、/edgelink/inspect）。
-- 回滚：文末注释里有完整的还原 SQL。
-- ===================================================================

-- ---------- 1. 目录改名 / 新建 ----------
-- 连接配置 → 采集配置（id/path 不变）
UPDATE sys_menu SET menu_name = '采集配置', remark = 'PLC 设备、数据点表、驱动、边缘节点的采集侧配置'
WHERE menu_id = 2046;

-- 高级配置 → 运行监控（原有子菜单迁出，本目录改作监控域）
UPDATE sys_menu SET menu_name = '运行监控', path = 'monitor', icon = 'el-icon-monitor',
       remark = 'V12 节点实时看板 + 存量采集点监控'
WHERE menu_id = 2090;

-- 新建：发布与履历（menu_id=2091）
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (2091, '发布与履历', 2083, 3, 'publish', NULL, 'el-icon-document', 'M', '0', '0', 'admin', NOW(), 'admin', NOW(), '配置发布与变更履历')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    icon = VALUES(icon),
    remark = VALUES(remark);

-- ---------- 2. 采集配置域（2046）----------
UPDATE sys_menu SET parent_id = 2046, order_num = 1 WHERE menu_id = 2047;  -- PLC设备管理
UPDATE sys_menu SET parent_id = 2046, order_num = 2 WHERE menu_id = 2056;  -- 数据点表
UPDATE sys_menu SET parent_id = 2046, order_num = 3 WHERE menu_id = 2074;  -- 驱动管理（自高级配置迁入）
UPDATE sys_menu SET parent_id = 2046, order_num = 4 WHERE menu_id = 2067;  -- 边缘节点管理（自高级配置迁入）
UPDATE sys_menu SET parent_id = 2074, order_num = 1 WHERE menu_id = 2073;  -- 驱动列表查询（F）归位到驱动管理下

-- ---------- 3. 运行监控域（2090）----------
UPDATE sys_menu SET parent_id = 2090, order_num = 1 WHERE menu_id = 2062;  -- 节点监控（不再游离）
-- 注：存量采集点监控(3000) 后于 migration_20260830_site_health_top_level.sql 提到一级目录，本脚本不再动它
UPDATE sys_menu SET order_num = 2 WHERE menu_id = 2090 AND parent_id = 2083;  -- 修正与 2091 的排序重复

-- ---------- 4. 发布与履历域（2091）----------
UPDATE sys_menu SET parent_id = 2091, order_num = 1 WHERE menu_id = 2065;  -- 配置发布中心
UPDATE sys_menu SET parent_id = 2091, order_num = 2 WHERE menu_id = 2088;  -- 日志中心（唯一入口）
UPDATE sys_menu SET parent_id = 2091, order_num = 3, visible = '1' WHERE menu_id = 2079;  -- 发布履历：隐藏，仅保留权限授予
UPDATE sys_menu SET parent_id = 2091, order_num = 4, visible = '1' WHERE menu_id = 2081;  -- 修改履历：隐藏，仅保留权限授予

-- ---------- 5. 中文 path 改英文 ----------
UPDATE sys_menu SET path = 'visual' WHERE menu_id = 2086;   -- 可视化
UPDATE sys_menu SET path = 'inspect' WHERE menu_id = 2087;  -- 点检

-- ===================================================================
-- 回滚 SQL（需要时取消注释执行）：
-- UPDATE sys_menu SET menu_name='连接配置', remark='EdgeLink PLC 设备与监控入口' WHERE menu_id=2046;
-- UPDATE sys_menu SET menu_name='高级配置', path='edgadmin', icon='component' WHERE menu_id=2090;
-- UPDATE sys_menu SET parent_id=2046, order_num=3 WHERE menu_id=2065;
-- UPDATE sys_menu SET parent_id=2046, order_num=4 WHERE menu_id=2088;
-- UPDATE sys_menu SET parent_id=2046, order_num=5 WHERE menu_id=2073;
-- UPDATE sys_menu SET parent_id=2046, order_num=6, visible='0' WHERE menu_id=2079;
-- UPDATE sys_menu SET parent_id=2046, order_num=7, visible='0' WHERE menu_id=2081;
-- UPDATE sys_menu SET parent_id=2083, order_num=2 WHERE menu_id=2062;
-- UPDATE sys_menu SET parent_id=2090, order_num=1 WHERE menu_id=2067;
-- UPDATE sys_menu SET parent_id=2090, order_num=2 WHERE menu_id=2074;
-- UPDATE sys_menu SET parent_id=2083, order_num=4 WHERE menu_id=3000;
-- UPDATE sys_menu SET path='可视化' WHERE menu_id=2086;
-- UPDATE sys_menu SET path='点检' WHERE menu_id=2087;
-- DELETE FROM sys_role_menu WHERE menu_id=2091;
-- DELETE FROM sys_menu WHERE menu_id=2091;
-- ===================================================================
