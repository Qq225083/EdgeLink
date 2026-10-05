-- ============================================================
-- EdgeLink 过渡版（流程生成器）— 2026-09-28 迁移脚本（仅此一个，执行一次即可）
-- 内容：
--   1. 新建 plc_flow_release（流程版本表）/ plc_flow_deploy_log（部署履历表）
--   2. site_health_site 追加 Node-RED Admin API 凭证两列（部署目标 = 登记的 办公网IP+端口）
--   3. plc_driver 追加生成版节点类型映射两列（配置驱动 → 生成器选节点类型）
--   4. 菜单：EdgeLink(2083) 下新增二级目录「流程发布」(3100) → 流程版本(3101)/部署履历(3102)
--      + F 按钮 生成(3103)/下载(3104)/部署(3105)
-- 执行环境：MySQL（ruoyi 库）。建表幂等；ALTER 列若已存在会报错，请勿重复执行。
-- ============================================================

-- ===================================================================
-- 1. 流程版本表（生成器产物：一现场一版本链，绑定配置快照版本）
-- ===================================================================
CREATE TABLE IF NOT EXISTS plc_flow_release (
    id             BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    site_id        BIGINT NOT NULL COMMENT '目标采集点ID（site_health_site.id）',
    config_version INT NOT NULL COMMENT '生成依据的配置快照版本（plc_config_snapshot.version）',
    version        INT NOT NULL COMMENT '流程版本号（每现场自增，从1开始）',
    payload        MEDIUMTEXT NOT NULL COMMENT '生成的 flows.json 全文（完整目标状态，全量替换语义）',
    sha256         CHAR(64) NOT NULL COMMENT 'payload 内容哈希（幂等：内容不变不重复建版本）',
    device_count   INT DEFAULT 0 COMMENT '包含设备数（PLC 支路数）',
    node_count     INT DEFAULT 0 COMMENT '节点总数（部署性能评估用，警戒值 500）',
    status         CHAR(1) DEFAULT '0' COMMENT '状态（0草稿 1已发布 2归档）',
    remark         VARCHAR(500) COMMENT '备注',
    create_by      VARCHAR(64) COMMENT '创建者',
    create_time    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_by      VARCHAR(64) COMMENT '更新者',
    update_time    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE KEY uk_flow_release_site_version (site_id, version),
    KEY ix_flow_release_site_id (site_id),
    KEY ix_flow_release_config_version (config_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='流程版本表（生成器产物，部署即全量替换目标画布）';

-- ===================================================================
-- 2. 部署履历表（Admin API 推送记录，含 rev 前后值与失败原因）
-- ===================================================================
CREATE TABLE IF NOT EXISTS plc_flow_deploy_log (
    id           BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    release_id   BIGINT NOT NULL COMMENT '流程版本ID（plc_flow_release.id）',
    site_id      BIGINT NOT NULL COMMENT '目标采集点ID（site_health_site.id）',
    target       VARCHAR(64) NOT NULL COMMENT '部署目标（office_ip:node_port）',
    deploy_type  VARCHAR(10) DEFAULT 'nodes' COMMENT '部署类型（nodes增量/full全量）',
    rev_before   VARCHAR(64) COMMENT '部署前目标端 flow rev',
    rev_after    VARCHAR(64) COMMENT '部署后目标端 flow rev',
    result       CHAR(1) NOT NULL COMMENT '结果（0失败 1成功）',
    error_msg    VARCHAR(1000) COMMENT '失败原因（含 409 rev 冲突等）',
    duration_ms  INT COMMENT '部署耗时毫秒',
    create_by    VARCHAR(64) COMMENT '操作人',
    create_time  DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '部署时间',
    KEY ix_flow_deploy_log_release_id (release_id),
    KEY ix_flow_deploy_log_site_id (site_id),
    KEY ix_flow_deploy_log_create_time (create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='流程部署履历表';

-- ===================================================================
-- 3. site_health_site 追加 Admin API 凭证（部署目标鉴权）
--    部署目标地址复用已有 office_ip + node_port，无需新列；
--    密码 AES 加密存储（密钥走后端配置），仅部署服务解密使用。
-- ===================================================================
ALTER TABLE site_health_site
  ADD COLUMN nr_admin_user   VARCHAR(64)  NULL COMMENT 'Node-RED Admin API 用户名（adminAuth）' AFTER node_port,
  ADD COLUMN nr_admin_secret VARCHAR(255) NULL COMMENT 'Node-RED Admin API 密码（AES加密存储，仅部署服务使用）' AFTER nr_admin_user;

-- ===================================================================
-- 4. plc_driver 追加生成版节点类型映射
--    现有 node_red_node_type 列服务 V12/V13 自研节点，不动；
--    gen_* 两列只服务生成器。MC 两值已读社区包源码核实；
--    Modbus 为预填，模板启用前以实际安装包的注册类型名为准。
-- ===================================================================
ALTER TABLE plc_driver
  ADD COLUMN gen_node_type VARCHAR(100) NULL COMMENT '生成版读取节点类型名（社区/核心节点注册名）' AFTER node_red_node_type,
  ADD COLUMN gen_conn_type VARCHAR(100) NULL COMMENT '生成版连接配置节点类型名' AFTER gen_node_type;

UPDATE plc_driver SET gen_node_type = 'MC Read',       gen_conn_type = 'MC Protocol Connection' WHERE driver_code = 'mitsubishi_mc';
UPDATE plc_driver SET gen_node_type = 'modbus-read',   gen_conn_type = 'modbus-client'          WHERE driver_code = 'modbus_tcp';
-- mitsubishi_mc_serial / siemens_s7：过渡版不支持，gen_* 保持 NULL（生成器跳过并告警）

-- ===================================================================
-- 5. 菜单：流程发布（幂等，可重复执行）
--    编号段 3100-3105（已用：2046/2047/2056/2062、2083、3000-3004、3020）
-- ===================================================================

-- 二级目录：流程发布（EdgeLink 2083 下，order_num 5）
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3100, '流程发布', 2083, 5, 'flowgen', NULL, 'el-icon-share', 'M', '0', '0', 'admin', NOW(), 'admin', NOW(), '过渡版：配置生成 Node-RED 流程（纯现成节点），下载/自动部署')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    icon = VALUES(icon),
    remark = VALUES(remark);

-- 子菜单：流程版本（生成/预览/下载/部署/回滚）
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3101, '流程版本', 3100, 1, 'release', 'plc/flowRelease/index', 'flow:release:list', 'el-icon-document', 'C', '0', '0', 'admin', NOW(), 'admin', NOW(), '按采集点生成流程版本，预览/下载 flows.json，一键部署与回滚')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    perms = VALUES(perms),
    icon = VALUES(icon);

-- 子菜单：部署履历
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3102, '部署履历', 3100, 2, 'deployLog', 'plc/flowDeployLog/index', 'flow:deploy:list', 'el-icon-time', 'C', '0', '0', 'admin', NOW(), 'admin', NOW(), 'Admin API 部署记录：目标、rev 前后值、耗时、结果与失败原因')
ON DUPLICATE KEY UPDATE
    menu_name = VALUES(menu_name),
    parent_id = VALUES(parent_id),
    order_num = VALUES(order_num),
    path = VALUES(path),
    component = VALUES(component),
    perms = VALUES(perms),
    icon = VALUES(icon);

-- 按钮权限（挂「流程版本」下，供非超管角色授权）
INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3103, '流程生成', 3101, 1, '', NULL, 'flow:release:generate', '#', 'F', '0', '0', 'admin', NOW(), 'admin', NOW(), '按当前配置快照生成新流程版本')
ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), parent_id = VALUES(parent_id), order_num = VALUES(order_num), perms = VALUES(perms);

INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3104, '流程下载', 3101, 2, '', NULL, 'flow:release:download', '#', 'F', '0', '0', 'admin', NOW(), 'admin', NOW(), '下载 flows.json（手工导入场景）')
ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), parent_id = VALUES(parent_id), order_num = VALUES(order_num), perms = VALUES(perms);

INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, component, perms, icon, menu_type, visible, status, create_by, create_time, update_by, update_time, remark)
VALUES (3105, '流程部署', 3101, 3, '', NULL, 'flow:release:deploy', '#', 'F', '0', '0', 'admin', NOW(), 'admin', NOW(), 'Admin API 推送部署 / 回滚到历史版本')
ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), parent_id = VALUES(parent_id), order_num = VALUES(order_num), perms = VALUES(perms);
