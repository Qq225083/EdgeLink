-- ============================================================================
-- 00_run_all.sql — EdgeLink 全量 SQL（合并版，MySQL 主库）
-- ============================================================================
-- 用法：整体复制粘贴到 SQL 客户端（DBeaver/Navicat）执行，或：
--   mysql -h <主机> -P 3308 -u root -p ruoyi < 10-8/00_run_all.sql
--
-- 说明：
--   1. 内容为 9-28/01-18 + 10-8/01-02 的全部 SQL 按序合并（已内联，无需 source）；
--   2. 9-28/06 的品牌 INSERT 段已由 10-8/01 全量快照覆盖，合并时省略以防重复行；
--      10-8/03 与 9-28/07 内容相同，合并版只保留一份（在 07 段）；
--   3. 【例外】9-28/14 是 PostgreSQL 建表（plc_data_log），不在此文件——
--      请到 PG 库单独执行 9-28/14_pg_create_plc_data_log.sql；
--   4. 在全新库上按序执行即可；在已部分执行过的库上重跑，个别段落可能报
--      列已存在/重复键之类错误——跳过该段继续即可（最终状态由 01 快照兜底）；
--   5. 菜单类变更执行后，用户需重新登录生效。
-- ============================================================================


-- ==========================================================================
-- 9-28/01 生成器建表 + 菜单
-- ==========================================================================

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


-- ==========================================================================
-- 9-28/02 菜单隐藏与排序
-- ==========================================================================

-- ============================================================
-- EdgeLink 过渡版 — 菜单隐藏（系统级，2026-09-28 初版，09-30 修订，幂等可重复执行）
-- 隐藏 V12/V13/V14 体系菜单，一线只保留过渡版工作面：
--   保留：PLC设备管理/数据点表/节点监控/存量监控/流程版本/采集点登记(3020)
-- visible='1' = 隐藏（与库内 2086 可视化、2087 点检 同一隐藏方式）
-- ============================================================

UPDATE sys_menu SET visible = '1' WHERE menu_id IN (
    2067,  -- 边缘节点管理：C 方案后左面板改读 site_health_site，本页回归隐藏（V12/V14 激活凭证）
    2091,  -- 发布与履历（V12 配置发布中心，生成版不消费快照）
    2074,  -- 驱动管理（V12 协议 schema 维护，一线不需要）
    -- 3010 部署中心已于 09-30 恢复：其下是下载中心/交付维护（安装包上传下载），过渡版需要
    3102   -- 部署履历（M3 部署服务上线前为空表，届时恢复）
);

-- ============================================================
-- 恢复语句（需要时手动执行）：
-- UPDATE sys_menu SET visible = '0' WHERE menu_id IN (2067, 2091, 2074, 3010, 3102);
-- ============================================================

-- 2026-09-30 追加：修改履历(2081)从 V12「发布与履历」移出，挂到「采集配置」(2046) 下单独放出
-- （记录配置修改审计，与采集体系版本无关，过渡版仍需要；2091 保持隐藏）
UPDATE sys_menu SET parent_id = 2046, visible = '0', order_num = 4 WHERE menu_id = 2081;

-- 2026-09-30 追加2：菜单语义修正——3100「流程发布」更名「发布与履历」，修改履历(2081)移入其下
-- （覆盖上一条 2081→2046 的移动；履历类入口集中在 3100：流程版本/部署履历/修改履历）
UPDATE sys_menu SET menu_name = '发布与履历' WHERE menu_id = 3100;
UPDATE sys_menu SET parent_id = 3100, order_num = 3 WHERE menu_id = 2081;

-- 2026-09-30 追加3：采集点登记(3020)提为「采集配置」首位（登记是工作流第一步）
UPDATE sys_menu SET order_num = 0 WHERE menu_id = 3020;


-- ==========================================================================
-- 9-28/03 MC 协议参数非必填
-- ==========================================================================

-- ============================================================
-- 过渡版 — mitsubishi_mc 驱动 schema 修正（2026-09-29，幂等可重复执行）
-- 内容：protocol（传输协议）/ commCode（通信数据代码）改为非必填——
--   为空时生成器按默认 TCP/binary 处理（生成器已接管这两个字段进连接节点）。
-- 说明：config_schema 是 JSON 列，fields 数组顺序当前为
--   [mcFrame, protocol, commCode, stationNo, networkNo, plcPort]，
--   即 protocol=fields[1]、commCode=fields[2]。执行后请用下方 SELECT 验证。
-- ============================================================

UPDATE plc_driver
SET config_schema = JSON_SET(
    config_schema,
    '$.fields[1].required', CAST('false' AS JSON),
    '$.fields[2].required', CAST('false' AS JSON)
)
WHERE driver_code = 'mitsubishi_mc';

-- 验证（应输出 protocol:false / commCode:false）：
-- SELECT driver_code,
--   JSON_EXTRACT(config_schema, '$.fields[1].name'), JSON_EXTRACT(config_schema, '$.fields[1].required'),
--   JSON_EXTRACT(config_schema, '$.fields[2].name'), JSON_EXTRACT(config_schema, '$.fields[2].required')
-- FROM plc_driver WHERE driver_code = 'mitsubishi_mc';


-- ==========================================================================
-- 9-28/04 MC schema v2（社区节点配置面）
-- ==========================================================================

-- ============================================================
-- 过渡版 — mitsubishi_mc 驱动 schema 面向社区节点配置面（2026-09-29，幂等）
-- 内容：
--   1. 新增 plcType（Q/L/R/FX 下拉）与 octalInputOutput（X/Y 八进制开关）两个可选字段
--      —— 对应社区节点 MC Protocol Connection 的真实配置面；
--   2. protocol / commCode 已为非必填（见 migration_20260929_mc_schema_optional.sql），
--      本脚本整体重写 fields 以固化最终形态；
--   3. schema_version 1 → 2。
-- 约束：平铺字段名（mcFrame/stationNo/networkNo/plcPort）不变——前端平铺逻辑、
--       V12 快照、生成器三处引用。新字段落 protocol_params，生成器已消费。
-- ============================================================

UPDATE plc_driver
SET config_schema = '{
  "fields": [
    {"name": "plcType", "type": "select", "label": "PLC 类型", "options": ["Q", "L", "R", "FX"], "default": "Q", "required": false},
    {"name": "mcFrame", "type": "select", "label": "帧格式", "options": ["3E", "4E"], "default": "3E", "required": true},
    {"name": "protocol", "type": "select", "label": "传输协议", "options": ["TCP", "UDP"], "default": "TCP", "required": false},
    {"name": "commCode", "type": "select", "label": "通信数据代码", "options": ["binary", "ascii"], "default": "binary", "required": false},
    {"name": "stationNo", "type": "number", "label": "站号", "default": 0, "min": 0, "max": 255, "required": true},
    {"name": "networkNo", "type": "number", "label": "网络号", "default": 0, "min": 0, "max": 255, "required": true},
    {"name": "plcPort", "type": "number", "label": "PLC 端口", "default": 5007, "min": 1, "max": 65535, "required": true},
    {"name": "octalInputOutput", "type": "select", "label": "X/Y 八进制（FX 系列）", "options": ["false", "true"], "default": "false", "required": false}
  ]
}',
schema_version = 2
WHERE driver_code = 'mitsubishi_mc';

-- 验证：
-- SELECT driver_code, schema_version, JSON_EXTRACT(config_schema,'$.fields[0].name') FROM plc_driver WHERE driver_code='mitsubishi_mc';


-- ==========================================================================
-- 9-28/05 触发方式存量修正
-- ==========================================================================

-- ============================================================
-- 过渡版 — 触发方式存量修正（2026-09-29，幂等可重复执行）
-- 内容：trigger_kind=0（握手触发，规划中未实现）的存量设备改为 1（固定周期）。
-- 背景：0 是历史默认值且在前端已禁用，编辑时回显禁用项造成误解。
-- ============================================================

UPDATE plc_device SET trigger_kind = 1 WHERE trigger_kind = 0 AND del_flag = '0';

-- 验证（应返回 0 行）：
-- SELECT id, device_name, trigger_kind FROM plc_device WHERE trigger_kind = 0 AND del_flag = '0';


-- ==========================================================================
-- 9-28/06 驱动停用 + 品牌扩展（INSERT 段已由 01 快照覆盖）
-- ==========================================================================

-- ============================================================
-- 过渡版 — 协议配置清理与品牌扩展（2026-09-29）
-- 内容：
--   1. plc_driver：停用生成版跑不了的驱动（MC串口透传、S7）
--   2. plc_protocol_compat：删除 V12 遗物 GOT 通信方式
--   3. 新增基恩士（KV 系列，SLMP/MC 协议 → mitsubishi_mc 驱动，生成器零改动）
--   4. 新增汇川（H5U/AM600/EASY，Modbus_TCP → modbus_tcp 驱动；
--      注意：Modbus 支路构造器完成前，汇川设备生成时会跳过并告警）
-- 说明：兼容表无状态列，GOT 行直接删除（无设备使用 GOT，已确认）。
-- ============================================================

-- 1. 停用生成版不支持的驱动
UPDATE plc_driver SET enabled = 0 WHERE driver_code IN ('mitsubishi_mc_serial', 'siemens_s7');

-- 2. 删除 V12 遗物 GOT 通信方式
DELETE FROM plc_protocol_compat WHERE com_type = 'GOT';

-- 3. 基恩士 KV 系列（SLMP 兼容 MC 协议；软元件映射：DM→D，W→W，X/Y/M/R 同名）
-- （本文件的 INSERT 部分已由 10-8/01 全量快照覆盖，此处省略以防重复行）


-- ==========================================================================
-- 9-28/07 兼容表清理（RS232C/S7）
-- ==========================================================================

-- ============================================================
-- 过渡版 — 协议兼容表一致性清理（2026-09-29 追加，幂等）
-- 内容：
--   1. 删除 PLC_RS232C 行（指向 UNKNOWN 驱动，无实现）
--   2. 删除 Siemens × S7 行（siemens_s7 驱动已停用，S7 业务暂缓）
-- 保留：Omron/Siemens × Modbus_TCP 行（modbus_tcp 启用中，支路构造器完成后可用）
-- ============================================================

DELETE FROM plc_protocol_compat WHERE com_type = 'PLC_RS232C' OR driver_code = 'UNKNOWN';
DELETE FROM plc_protocol_compat WHERE driver_code = 'siemens_s7';

-- 验证：
-- SELECT plc_brand, plc_series, com_type, driver_code FROM plc_protocol_compat
--  WHERE driver_code IN ('UNKNOWN','siemens_s7');  -- 应返回 0 行


-- ==========================================================================
-- 9-28/08 site_health_site 来源字段
-- ==========================================================================

-- ============================================================
-- 过渡版 — site_health_site 增加来源字段（2026-09-30，执行一次）
-- 背景：合并登记后，该表住着两类对象——纯监控点（3001 单独登记）与
--       采集点（3020 采集配置联动创建）。source 字段区分之。
-- 存量行全部为 3001 登记，回填 'register'。
-- ============================================================

ALTER TABLE site_health_site
  ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'register'
  COMMENT '来源：register=存量监控单独登记（纯监控点） config=采集配置联动登记（采集点）' AFTER status;

-- 存量行显式回填（与 DEFAULT 同值，仅为语义明确）
UPDATE site_health_site SET source = 'register' WHERE source IS NULL OR source = '';

-- 验证：SELECT id, site_name, source FROM site_health_site;


-- ==========================================================================
-- 9-28/09 采集点台账回填
-- ==========================================================================

-- ============================================================
-- 过渡版 C 方案收尾 — 采集点台账回填（2026-09-30，幂等）
-- 背景：设备页左面板数据源切换为 site_health_site（唯一真相源）。
--       历史 bootstrap_key 采集点若未联动登记过，需补建 site_health_site 行，
--       否则切换后从面板消失。
-- 规则：
--   - 按 办公网IP+端口 判重（含 NULL 端口的安全等于），已存在则跳过；
--   - 有启用设备的采集点标 source='config'，纯监控点标 'register'；
--   - site_key_hash 填随机占位（这些点未曾上报，Key 不可知；如需上报走采集监控页重置密钥）。
-- ============================================================

INSERT INTO site_health_site
  (site_key_hash, office_ip, indust_ip, site_name, building, floor, process_stage, node_port, status, source)
SELECT
  SHA2(CONCAT(b.id, RAND(), NOW(6)), 256),
  SUBSTRING_INDEX(b.host_pc_ip, ':', 1),
  b.indust_ip,
  COALESCE(b.node_name, b.node_key),
  b.building,
  b.floor,
  b.process_stage,
  IF(b.host_pc_ip LIKE '%:%', CAST(SUBSTRING_INDEX(b.host_pc_ip, ':', -1) AS UNSIGNED), NULL),
  1,
  IF(EXISTS(SELECT 1 FROM plc_device d WHERE d.host_pc_ip = b.host_pc_ip AND d.del_flag = '0'), 'config', 'register')
FROM edge_bootstrap_key b
WHERE b.host_pc_ip IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM site_health_site s
    WHERE s.office_ip = SUBSTRING_INDEX(b.host_pc_ip, ':', 1)
      AND (s.node_port <=> IF(b.host_pc_ip LIKE '%:%', CAST(SUBSTRING_INDEX(b.host_pc_ip, ':', -1) AS UNSIGNED), NULL))
  );

-- 验证：
-- SELECT id, site_name, office_ip, node_port, source FROM site_health_site;


-- ==========================================================================
-- 9-28/10 恢复部署中心菜单
-- ==========================================================================

-- ============================================================
-- 过渡版 — 恢复「部署中心」菜单（2026-09-30，幂等可重复执行）
-- 背景：02 隐藏脚本误伤——3010 部署中心下是下载中心/交付维护
--       （安装包上传下载），过渡版现场交付需要，恢复显示。
-- 配套：02_hide_legacy_menus_20260928.sql 的隐藏列表已同步移除 3010。
-- ============================================================

UPDATE sys_menu SET visible = '0' WHERE menu_id = 3010;

-- 验证：SELECT menu_id, menu_name, visible FROM sys_menu WHERE menu_id = 3010;
-- 应为 visible = 0（显示）


-- ==========================================================================
-- 9-28/11 存量站点来源纠正
-- ==========================================================================

-- ============================================================
-- 过渡版 — 存量站点来源纠正（2026-09-30，幂等可重复执行）
-- 背景：09 回填只覆盖新建行；此前已存在、且名下已有启用设备的站点
--       仍是 register（如「二厂3楼」带设备49）。本脚本把这类存量站点
--       纠正为 config（有启用设备 = 采集点）。
-- 审计备注：此 UPDATE 当日为直接执行，漏写归档，后补录于此（review 发现）。
-- ============================================================

UPDATE site_health_site s
SET source = 'config'
WHERE source = 'register'
  AND EXISTS (
    SELECT 1 FROM plc_device d
    WHERE d.del_flag = '0'
      AND (d.host_pc_ip = s.office_ip OR d.host_pc_ip = CONCAT(s.office_ip, ':', s.node_port))
  );

-- 验证：SELECT id, site_name, source FROM site_health_site;
-- 有启用设备的站点应为 config，纯监控点为 register


-- ==========================================================================
-- 9-28/12 导入默认死区清理
-- ==========================================================================

-- ============================================================
-- 过渡版 — 清理导入默认死区残留（2026-09-30，幂等）
-- 背景：tag_service 导入服务在死区列缺省时默认写 1000（V12 时代默认），
--       经新模板（无死区列）导入的点位全部被污染为 1000.0，
--       触发生成器"死区未生效"误导性 warning。服务默认已改为 0，
--       本脚本清理存量污染行（过渡版不消费死区，归零无副作用）。
-- ============================================================

UPDATE plc_tag SET report_deadband_ms = 0 WHERE report_deadband_ms = 1000 AND del_flag = '0';

-- 验证：SELECT id, tag_name, report_deadband_ms FROM plc_tag WHERE report_deadband_ms > 0;


-- ==========================================================================
-- 9-28/13 点位 id 字段更名
-- ==========================================================================

-- ============================================================
-- 过渡版 — 点位名称 → 点位ID（2026-10-01，幂等）
-- 背景：tag_name 列语义变更——原「点位名称」（人可读名称）改为「点位ID」（业务标识，
--       纯数字，写入 plc_data_log.tag_id 的 BIGINT 列）；原人可读名称挪到 description（备注）。
--       方案：复用 tag_name 列，无新增列、无类型变更，仅同步列注释。
--       存量活跃点位 tag_name 已是纯数字（100/101/12341），无需数据迁移。
-- ============================================================

ALTER TABLE plc_tag
    MODIFY COLUMN tag_name    VARCHAR(100) NOT NULL COMMENT '点位ID（业务标识，写入 plc_data_log.tag_id）',
    MODIFY COLUMN description TEXT         DEFAULT NULL COMMENT '备注（点位名称/描述）';

-- 验证：SHOW FULL COLUMNS FROM plc_tag WHERE Field IN ('tag_name','description');


-- ==========================================================================
-- 9-28/15 release 部署字段
-- ==========================================================================

-- 15_migration_20261003_release_deploy_columns.sql
-- 【MySQL 127.0.0.1:3308/ruoyi 执行】
-- Admin API 自动部署：release 表记录部署时间/操作人/结果摘要（含边缘节点包版本留痕）
ALTER TABLE plc_flow_release
    ADD COLUMN deploy_time DATETIME NULL COMMENT '最近一次部署到边缘的时间' AFTER status,
    ADD COLUMN deploy_by   VARCHAR(64) NULL COMMENT '部署操作人' AFTER deploy_time,
    ADD COLUMN deploy_msg  VARCHAR(500) NULL COMMENT '部署结果摘要（边缘节点包版本留痕等）' AFTER deploy_by;


-- ==========================================================================
-- 9-28/16 已部署标记修复
-- ==========================================================================

-- 16_migration_20261004_fix_release_status.sql
-- 【MySQL 127.0.0.1:3308/ruoyi 执行】
-- 修复：历史部署只置位不复位，导致同一现场多个版本同时显示"已部署"。
-- 语义应为"一现场最多一个已部署版本"——保留每个现场最新一条已部署，其余复位为草稿。
UPDATE plc_flow_release r
LEFT JOIN (
    SELECT site_id, MAX(id) AS keep_id
    FROM plc_flow_release
    WHERE status = '1'
    GROUP BY site_id
) k ON r.site_id = k.site_id AND r.id = k.keep_id
SET r.status = '0'
WHERE r.status = '1' AND k.keep_id IS NULL;

-- 验证：应每个现场最多一行
-- SELECT site_id, COUNT(*) FROM plc_flow_release WHERE status='1' GROUP BY site_id HAVING COUNT(*)>1;


-- ==========================================================================
-- 9-28/17 画布快照表
-- ==========================================================================

-- 17_migration_20261004_canvas_snapshot.sql
-- 【MySQL 127.0.0.1:3308/ruoyi 执行】
-- 边缘画布快照表：部署后自动归档 + 手动备份，覆盖误删/换机恢复场景。
-- 注意：payload 含边缘完整 flows（含用户自定义标签页；PG 密码在该包为明文字段），
--      本表按敏感数据对待，下载权限受 flow:release:download 管控。
CREATE TABLE IF NOT EXISTS plc_flow_canvas_snapshot (
    id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
    site_id     BIGINT       NOT NULL COMMENT '采集点ID（site_health_site.id）',
    release_id  BIGINT       NULL COMMENT '关联流程版本ID（部署归档时填；手动备份为空）',
    rev         VARCHAR(64)  NULL COMMENT '边缘 flow rev（Admin API v2）',
    node_count  INT          DEFAULT 0 COMMENT '节点总数',
    payload     MEDIUMTEXT   NOT NULL COMMENT '边缘完整 flows.json（含用户自定义标签页）',
    source      CHAR(10)     NOT NULL DEFAULT 'deploy' COMMENT '来源（deploy部署后自动/manual手动备份）',
    create_by   VARCHAR(64)  NULL COMMENT '操作人',
    create_time DATETIME     NULL COMMENT '归档时间',
    PRIMARY KEY (id),
    KEY ix_canvas_snap_site (site_id),
    KEY ix_canvas_snap_time (create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='边缘画布快照表（部署归档+手动备份，每现场保留最近20份）';


-- ==========================================================================
-- 9-28/18 部署凭证列
-- ==========================================================================

-- 18_migration_20261005_release_deploy_credentials.sql
-- 【MySQL 127.0.0.1:3308/ruoyi 执行】
-- 生成期可选内嵌 MQTT 凭证：不写入 payload（flows.json 保持无密钥），
-- 单独存 deploy_credentials（JSON：{节点id: {字段: 值}}），部署时经 Admin API credentials 对象下发。
ALTER TABLE plc_flow_release
    ADD COLUMN deploy_credentials TEXT NULL COMMENT '部署凭证（JSON，按节点id；仅部署时使用，不进 flows.json）' AFTER deploy_msg;


-- ==========================================================================
-- 10-8/01 兼容表全量快照（最终状态）
-- ==========================================================================

-- 01_protocol_compat_full_backup.sql
-- 【MySQL 执行】PLC 品牌/系列/通信方式/寄存器类型兼容表全量备份（plc_protocol_compat，共 74 行）
-- 背景：本表数据是多次现场操作直接入库的，此前未归档任何 SQL；本文件为全量快照。
-- 幂等：INSERT IGNORE，重复执行安全。换库/重建时先确保表存在（后端启动会自动建表）。
--
-- 验证：SELECT plc_brand, COUNT(*) FROM plc_protocol_compat GROUP BY plc_brand;
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('1', 'Mitsubishi', 'Q', 'MC_Protocol', '1', 'D', 'D（数据寄存器）', '1', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('2', 'Mitsubishi', 'Q', 'MC_Protocol', '1', 'W', 'W（链接寄存器）', '2', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('3', 'Mitsubishi', 'Q', 'MC_Protocol', '1', 'X', 'X（输入）', '3', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('4', 'Mitsubishi', 'Q', 'MC_Protocol', '1', 'Y', 'Y（输出）', '4', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('5', 'Mitsubishi', 'Q', 'MC_Protocol', '1', 'M', 'M（内部继电器）', '5', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('6', 'Mitsubishi', 'Q', 'MC_Protocol', '1', 'L', 'L（锁存继电器）', '6', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('7', 'Mitsubishi', 'Q', 'MC_Protocol', '1', 'B', 'B（链接继电器）', '7', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('8', 'Mitsubishi', 'Q', 'MC_Protocol', '1', 'R', 'R（文件寄存器）', '8', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('9', 'Mitsubishi', 'L', 'MC_Protocol', '1', 'D', 'D（数据寄存器）', '1', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('10', 'Mitsubishi', 'L', 'MC_Protocol', '1', 'W', 'W（链接寄存器）', '2', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('11', 'Mitsubishi', 'L', 'MC_Protocol', '1', 'X', 'X（输入）', '3', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('12', 'Mitsubishi', 'L', 'MC_Protocol', '1', 'Y', 'Y（输出）', '4', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('13', 'Mitsubishi', 'L', 'MC_Protocol', '1', 'M', 'M（内部继电器）', '5', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('14', 'Mitsubishi', 'FX', 'MC_Protocol', '1', 'D', 'D（数据寄存器）', '1', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('15', 'Mitsubishi', 'FX', 'MC_Protocol', '1', 'X', 'X（输入）', '2', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('16', 'Mitsubishi', 'FX', 'MC_Protocol', '1', 'Y', 'Y（输出）', '3', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('17', 'Mitsubishi', 'FX', 'MC_Protocol', '1', 'M', 'M（内部继电器）', '4', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('18', 'Mitsubishi', 'iQ-R', 'MC_Protocol', '1', 'D', 'D（数据寄存器）', '1', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('19', 'Mitsubishi', 'iQ-R', 'MC_Protocol', '1', 'W', 'W（链接寄存器）', '2', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('20', 'Mitsubishi', 'iQ-R', 'MC_Protocol', '1', 'X', 'X（输入）', '3', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('21', 'Mitsubishi', 'iQ-R', 'MC_Protocol', '1', 'Y', 'Y（输出）', '4', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('22', 'Mitsubishi', 'iQ-R', 'MC_Protocol', '1', 'M', 'M（内部继电器）', '5', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('23', 'Mitsubishi', 'Q', 'Modbus_TCP', '0', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('24', 'Mitsubishi', 'Q', 'Modbus_TCP', '0', 'IR', 'IR（输入寄存器）', '2', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('25', 'Mitsubishi', 'Q', 'Modbus_TCP', '0', 'CR', 'CR（线圈）', '3', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('26', 'Mitsubishi', 'L', 'Modbus_TCP', '0', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('27', 'Mitsubishi', 'FX', 'Modbus_TCP', '0', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('33', 'Siemens', 'S7-1200', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('34', 'Siemens', 'S7-1200', 'Modbus_TCP', '1', 'IR', 'IR（输入寄存器）', '2', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('35', 'Siemens', 'S7-1200', 'Modbus_TCP', '1', 'CR', 'CR（线圈）', '3', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('36', 'Siemens', 'S7-1500', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('37', 'Siemens', 'S7-1500', 'Modbus_TCP', '1', 'IR', 'IR（输入寄存器）', '2', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('38', 'Siemens', 'S7-1500', 'Modbus_TCP', '1', 'CR', 'CR（线圈）', '3', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('39', 'Siemens', 'S7-300/400', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('40', 'Siemens', 'S7-200 Smart', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('43', 'Omron', 'CJ', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('44', 'Omron', 'CJ', 'Modbus_TCP', '1', 'IR', 'IR（输入寄存器）', '2', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('45', 'Omron', 'CS', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('46', 'Omron', 'CP', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('47', 'Omron', 'NX', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('49', 'Keyence', 'KV-8000', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('50', 'Keyence', 'KV-8000', 'Modbus_TCP', '1', 'IR', 'IR（输入寄存器）', '2', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('51', 'Keyence', 'KV-7500', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('52', 'Keyence', 'KV-5500', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('124', 'Keyence', 'KV-8000', 'MC_Protocol', '1', 'D', 'D（数据寄存器，基恩士 DM）', '1', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('125', 'Keyence', 'KV-8000', 'MC_Protocol', '1', 'W', 'W（链接寄存器）', '2', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('126', 'Keyence', 'KV-8000', 'MC_Protocol', '1', 'X', 'X（输入）', '3', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('127', 'Keyence', 'KV-8000', 'MC_Protocol', '1', 'Y', 'Y（输出）', '4', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('128', 'Keyence', 'KV-8000', 'MC_Protocol', '1', 'M', 'M（内部继电器）', '5', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('129', 'Keyence', 'KV-8000', 'MC_Protocol', '1', 'R', 'R（文件寄存器）', '6', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('130', 'Keyence', 'KV-7000', 'MC_Protocol', '1', 'D', 'D（数据寄存器，基恩士 DM）', '1', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('131', 'Keyence', 'KV-7000', 'MC_Protocol', '1', 'W', 'W（链接寄存器）', '2', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('132', 'Keyence', 'KV-7000', 'MC_Protocol', '1', 'X', 'X（输入）', '3', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('133', 'Keyence', 'KV-7000', 'MC_Protocol', '1', 'Y', 'Y（输出）', '4', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('134', 'Keyence', 'KV-7000', 'MC_Protocol', '1', 'M', 'M（内部继电器）', '5', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('135', 'Keyence', 'KV-7000', 'MC_Protocol', '1', 'R', 'R（文件寄存器）', '6', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('136', 'Keyence', 'KV-5000', 'MC_Protocol', '1', 'D', 'D（数据寄存器，基恩士 DM）', '1', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('137', 'Keyence', 'KV-5000', 'MC_Protocol', '1', 'W', 'W（链接寄存器）', '2', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('138', 'Keyence', 'KV-5000', 'MC_Protocol', '1', 'X', 'X（输入）', '3', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('139', 'Keyence', 'KV-5000', 'MC_Protocol', '1', 'Y', 'Y（输出）', '4', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('140', 'Keyence', 'KV-5000', 'MC_Protocol', '1', 'M', 'M（内部继电器）', '5', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('141', 'Keyence', 'KV-5000', 'MC_Protocol', '1', 'R', 'R（文件寄存器）', '6', 'mitsubishi_mc');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('142', 'Inovance', 'H5U', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('143', 'Inovance', 'H5U', 'Modbus_TCP', '1', 'IR', 'IR（输入寄存器）', '2', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('144', 'Inovance', 'H5U', 'Modbus_TCP', '1', 'CR', 'CR（线圈）', '3', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('145', 'Inovance', 'H5U', 'Modbus_TCP', '1', 'DISCRETE', 'DISCRETE（离散输入）', '4', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('146', 'Inovance', 'AM600', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('147', 'Inovance', 'AM600', 'Modbus_TCP', '1', 'IR', 'IR（输入寄存器）', '2', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('148', 'Inovance', 'AM600', 'Modbus_TCP', '1', 'CR', 'CR（线圈）', '3', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('149', 'Inovance', 'AM600', 'Modbus_TCP', '1', 'DISCRETE', 'DISCRETE（离散输入）', '4', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('150', 'Inovance', 'EASY', 'Modbus_TCP', '1', 'HR', 'HR（保持寄存器）', '1', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('151', 'Inovance', 'EASY', 'Modbus_TCP', '1', 'IR', 'IR（输入寄存器）', '2', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('152', 'Inovance', 'EASY', 'Modbus_TCP', '1', 'CR', 'CR（线圈）', '3', 'modbus_tcp');
INSERT IGNORE INTO plc_protocol_compat (id, plc_brand, plc_series, com_type, is_default_com_type, register_type, register_type_label, sort_order, driver_code) VALUES ('153', 'Inovance', 'EASY', 'Modbus_TCP', '1', 'DISCRETE', 'DISCRETE（离散输入）', '4', 'modbus_tcp');


-- ==========================================================================
-- 10-8/02 采集点登记菜单
-- ==========================================================================

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
