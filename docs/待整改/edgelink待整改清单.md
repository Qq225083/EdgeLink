# EdgeLink 待整改清单（总清单）

> 本文件为 EdgeLink 系统唯一的投产前整改总清单，合并了代码审查问题与 `EdgeLink_投产前整改清单.md` 中的跟踪项。  
> 后续只维护这一份清单，原 `EdgeLink_投产前整改清单.md` 不再更新。  
> 创建/更新时间：2026-07-19

## 状态说明

- **未修复**：问题尚未修改
- **已经修复待验证**：代码已修改，但尚未完成验证
- **已验证**：已修复并验证通过

## 标签说明

| 标签 | 含义 |
|:---|:---|
| 安全基线 | JWT、API Key、MQTT、Node-RED 凭据、默认口令等 |
| 配置下发 | 配置发布中心、MQTT 刷新、Node-RED 拉取、过滤逻辑 |
| 协议参数 | byte_order/word_order/bit_offset、protocol_params |
| 数据类型 | UINT16/UINT32/BOOL/DOUBLE 等类型支持 |
| 监控告警 | device_comm_status、KPI、告警去重、离线判定 |
| 数据库 | 外键、约束、hypertable、索引、字段语义 |
| 前端表单 | 表单字段、校验、缓存、状态同步 |
| 边缘节点 | Node-RED 流程、连接池、全局状态 |
| 工程化 | Dockerfile、拼写、重复代码、测试、定时器清理 |

---

## 🔴 P0 — 阻塞投产

| 序号 | 标签 | 严重度 | 问题标题 | 涉及文件 | 现象/风险 | 修复建议 | 状态 | 修复人 | 修复日期 | 验证人 | 验证日期 |
|---:|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| 1 | 安全基线 | 🔴 P0 | `JWT_SECRET_KEY` 硬编码为默认值 | `ruoyi-fastapi-backend/config/env.py:42` | 源码中固定 `jwt_secret_key`；任何人拿到源码即可伪造 JWT，越权访问所有受保护接口。 | 改为 `Field(..., min_length=32)`，仅允许从环境变量读取；启动时未配置则报错退出。 | 已经修复待验证 | Claude | 2026-07-21 | | |
| 2 | 安全基线 | 🔴 P0 | `MONITOR_API_KEY` 生产环境必填但 `.env.prod` 缺失 | `ruoyi-fastapi-backend/.env.prod`<br>`ruoyi-fastapi-backend/config/env.py:28` | `monitor_api_key` 在 `config/env.py` 中已改为必填字段（P1-2 已修），但 `.env.prod` 文件本身仍未配置 `MONITOR_API_KEY`，生产启动会直接失败。 | 在 `.env.prod` 中补充 `MONITOR_API_KEY=$(openssl rand -hex 32)`；并在部署文档中说明生成方式。 | 已经修复待验证 | Claude | 2026-07-21 | | |
| 3 | 安全基线 | 🔴 P0 | Node-RED 流文件硬编码后端登录凭据与 API Key | `docs/V12/edgelink_v12_main_flow.json`（`sf-config-manager` / `sf-local-api`） | 默认 `admin/***`、`***`；未覆盖则任何人可登录后端并调用监控 API。 | 删除所有默认值；`sf-config-manager`/`sf-local-api`/`JWT解析`/`心跳上报` 全部改为从 `settings.js` 或环境变量读取，缺失时报错退出。 | 已经修复待验证 | Claude | 2026-07-21 | | |
| 4 | 安全基线 | 🔴 P0 | PostgreSQL 密码明文写入流文件 | `docs/V12/edgelink_v12_main_flow.json`（`edgelink-pg-config` 节点） | 密码 `***` 直接硬编码在 JSON 中，进入版本控制即泄露。 | `edgelink-pg-config` 节点改为优先从节点配置读取，为空时从 `global.get('edge_pgPassword')` 读取；`settings.js` 统一配置。 | 已经修复待验证 | Claude | 2026-07-21 | | |
| 5 | 安全基线 | 🔴 P0 | 前端 MQTT 使用弱默认凭据且明文传输 | `ruoyi-fastapi-frontend/src/views/plc/monitor/index.vue:151-153` | `MQTT_USERNAME='web_sub'`、`MQTT_PASSWORD='web_pass'`、`ws://127.0.0.1:8083/mqtt`；未配置时回退到公开凭据，数据可被窃听。 | 删除默认值；未配置时页面显示「MQTT 配置缺失」错误提示，不自动连接。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 6 | 配置下发 | 🔴 P0 | 配置下发已改为手动发布模式，需补充发布中心页面与影响范围预览 | `ruoyi-fastapi-backend/module_plc/service/config_publish_service.py`<br>`module_plc/controller/config_publish_controller.py`<br>`module_plc/entity/do/publish_log_do.py`<br>`src/views/plc/publish/index.vue` | 已改为「保存+手动发布」：新增 `/plc/config/publish` 接口，点击发布后通过 MQTT 推送 `CONFIG_REFRESH`；保存设备/点位不自动下发。当前缺少发布中心页面、影响范围预览、发布记录。 | 完善前端「配置发布中心」页面：展示待发布设备/点位、影响范围、发布按钮；后端补充 `plc_publish_log` 发布记录与 `lastPublishTime`。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 7 | 协议参数 | 🔴 P0 | 前端点位表单缺少 `byte_order`/`word_order`/`bit_offset`，Node-RED 未消费协议参数 | `ruoyi-fastapi-frontend/src/views/plc/device/index.vue:352-446`<br>`ruoyi-fastapi-backend/module_plc/entity/do/tag_do.py`<br>`module_plc/entity/vo/tag_vo.py`<br>`module_plc/service/tag_service.py`<br>`docs/V12/edgelink_v12_main_flow.json` | 后端 DO/VO/Service/DAO 已支持 `byte_order`/`word_order`/`bit_offset` 的存储、校验、导入、导出、批量更新；前端表单已增加输入项；Node-RED `cm-discover` 已把这些字段透传到 `edge_tagConfigs` 和调度器。 | Day 2：前端表单补充字段；Day 4：Node-RED `cm-discover` 读取并透传 `byteOrder`/`wordOrder`/`bitOffset`。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 8 | 数据类型 | 🔴 P0 | Modbus 常用数据类型 `UINT16/UINT32/BOOL` 不支持 | `ruoyi-fastapi-backend/module_plc/entity/do/tag_do.py:24`<br>`tag_vo.py:19`<br>`service/tag_service.py:27`<br>`frontend/src/views/plc/device/index.vue:367-375` | 后端 `VALID_DATA_TYPES` 已扩展为 `INT16/INT32/FLOAT/BIT/UINT16/UINT32/BOOL/DOUBLE`，导入模板、导出、批量更新校验均已支持；前端下拉仍缺少 `UINT16/UINT32/BOOL/DOUBLE` 选项。 | Day 2：扩展前端 `dataType` 下拉选项；Node-RED 解析侧同步验证。 | 已经修复待验证 | Claude | 2026-07-19 | | |

---

## 🟡 P1 — 高风险

| 序号 | 标签 | 严重度 | 问题标题 | 涉及文件 | 现象/风险 | 修复建议 | 状态 | 修复人 | 修复日期 | 验证人 | 验证日期 |
|---:|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| 9 | 配置下发<br>监控告警 | 🟡 P1 | 设备停用/软删除后边缘继续采集，KPI 仍可能计入在线设备 | `ruoyi-fastapi-backend/module_plc/service/device_service.py:290-444`<br>`module_plc/dao/monitor_dao.py` | 仅更新 DB，未通知边缘；已停用设备仍被 Node-RED 轮询。KPI 在线数曾因软删除未过滤而虚高（P0-4 已修）。 | 手动发布模式下，用户发布配置后 Node-RED 重新拉取，自然移除停用/删除设备；同时在 Service 层调用发布时记录变更。 | 已经修复待验证 | Claude | 2026-07-18 | | |
| 10 | 配置下发<br>监控告警 | 🟡 P1 | 点位停用/删除未同步清理通信状态或 KPI | `ruoyi-fastapi-backend/module_plc/service/tag_service.py:133-234`<br>`docs/V12/edgelink_v12_main_flow.json` | 仅更新 `status`/`del_flag`，未触发 `device_comm_status` 刷新或配置刷新；Node-RED 拉取全局点位时不过滤 `status`，停用点位仍被采集。 | 点位停用/删除后检查设备下是否还有启用点位，无则标记 `DeviceCommStatus.online=0`；Node-RED 拉取 URL 增加 `status=0` 过滤，只获取启用点位；纳入手动发布。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 11 | 监控告警 | 🟡 P1 | 监控节点列表 GET 接口具有写副作用 | `ruoyi-fastapi-backend/module_plc/service/monitor_service.py:111-116` | `get_node_list` 调用 `clean_orphan_device_comm` 和 `_sync_nodes_from_devices`，并发查询触发 INSERT/DELETE。 | 将同步逻辑移到后台定时任务 `sync_nodes_from_devices_task` 和 `clean_orphan_device_comm_task`；GET 只读。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 12 | 监控告警 | 🟡 P1 | 通信状态在线判定存在两套逻辑 | `ruoyi-fastapi-backend/module_plc/dao/monitor_dao.py:354-368` 与 `:660-714` | 一处要求连续失败 3 次才 offline，另一处按 `last_success_time > 90s` 判定；状态可能反复横跳。 | 统一以时间阈值（90 秒无成功通信）判定 online 状态，`consecutive_fails` 仅用于触发告警。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 13 | 监控告警 | 🟡 P1 | `monitor_alert` 唯一约束包含可变 `status` | `ruoyi-fastapi-backend/module_plc/entity/do/monitor_do.py:81`<br>`docs/monitor_center.sql:85` | 同一节点/设备/类型可同时存在多条不同 status 记录，恢复后再次故障可能重复告警。 | 唯一约束改为 `(alert_type, node_id, device_id)`，通过状态字段控制生命周期；已清理重复数据。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 14 | 前端表单 | 🟡 P1 | 设备详情硬编码最多返回 100 条点位 | `ruoyi-fastapi-backend/module_plc/service/device_service.py:461-463` | `TagPageQueryModel(page_size=100)`，单设备超过 100 点位时前端无法查看完整列表。 | 使用无限制查询或透传分页参数。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 15 | 前端表单 | 🟡 P1 | 批量导入点位未做同设备内重名校验 | `ruoyi-fastapi-backend/module_plc/service/tag_service.py:357-440` | 仅校验必填字段和数据类型，未检查 `(device_id, tag_name)` 唯一性；易产生脏数据或批量 INSERT 报错。 | 批量插入前按设备去重并查询 DB 已存在名称。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 16 | 配置下发<br>边缘节点 | 🟡 P1 | Node-RED 配置管理器 API 失败仍标记就绪 | `docs/V12/edgelink_v12_main_flow.json`（`sf-config-manager`） | `/plc/tag/global/list` 非 200 或超时后 `edge_configReady` 仍置 `true`；边缘用旧/空配置继续采集。 | 失败时保持原状态并进入重试，不强制置 `true`。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 17 | 配置下发<br>边缘节点 | 🟡 P1 | `CONFIG_REFRESH` 广播过滤弱，可能引发刷新风暴 | `docs/V12/edgelink_v12_main_flow.json`（`过滤本机CONFIG_REFRESH`）<br>`module_plc/mqtt/mqtt_consumer.py`<br>`module_plc/service/config_publish_service.py` | 当 `host_pc_ip` 为空时所有节点都刷新；`myIp` 失败时回退 `127.0.0.1`，多机共用。 | 广播必须携带 `node_id`，节点只响应自己的 `node_id`；后端发布时按 `host_pc_ip` 查询 `nodered_node.id` 并传入通知。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 18 | 配置下发<br>边缘节点 | 🟡 P1 | 设备状态过滤条件与注释语义相反 | `docs/V12/edgelink_v12_main_flow.json`（`cm-discover`） | 注释“仅启用设备”，但条件 `String(dev.status) !== '0'` 实际保留 `status=0`；取决于后端语义可能过滤错误。 | 经核实，`status='0'` 表示启用，逻辑本身正确，属于误报。已增加全局配置 `edge_enabledStatus` 作为增强。 | 已验证 — 无需修复 | Claude | 2026-07-19 | | |
| 19 | 监控告警<br>边缘节点 | 🟡 P1 | 软删除/停用后边缘未清理 `edge_commStatus` | `docs/V12/edgelink_v12_main_flow.json`（`cleanupStaleData`） | 清理了 `historyData` 和 `lastGoodTags`，但未清理 `edge_commStatus`/`edge_commPending`；心跳仍上报旧状态。 | 在 `cleanupStaleData` 中同步清理 `edge_commStatus` 和 `edge_commPending` 中已不存在设备的条目。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 20 | 数据库 | 🟡 P1 | `device_comm_status` 无外键级联删除 | `docs/monitor_center.sql:41-54` | 表未建立到 `plc_device` 的外键；设备删除后留下僵尸通信状态。 | 已添加 `FOREIGN KEY (device_id) REFERENCES plc_device(id) ON DELETE CASCADE`；业务层软删除时同步 `online=0`。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 21 | 数据库 | 🟡 P1 | 数据质量码类型/语义不一致 | `docs/V12/plc_data_log.sql:18`<br>`edgelink_v12_main_flow.json`（`数据管道处理`） | SQL 注释要求 `quality` 为 `GOOD/BAD/UNCERTAIN` 字符串，但流程发送 `0/1/2` 整数。 | Node-RED 数据管道已统一为字符串质量码，`PG格式转换` 节点直接传递字符串，不再转回整数。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 22 | 数据库 | 🟡 P1 | `plc_data_log` hypertable/压缩/保留策略被注释 | `docs/V12/plc_data_log.sql:39-59` | 若 DBA 未手动执行，历史表将无限增长，查询性能随时间急剧下降。 | 已取消注释，启用 hypertable、压缩策略（7 天）和保留策略（30 天），仅在 PostgreSQL + TimescaleDB 环境下执行。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 23 | 安全基线 | 🟡 P1 | `.env.dev` 使用弱密钥和弱数据库密码 | `ruoyi-fastapi-backend/.env.dev` | `MONITOR_API_KEY='***'`、`DB_PASSWORD='***'`，且 `JWT_SECRET_KEY` 与源码默认值相同。 | 开发环境也使用强随机密码；提供 `.env.example` 占位符。 | 已经修复待验证 | Claude | 2026-07-21 | | |
| 24 | 安全基线 | 🟡 P1 | 数据库密码在源码中硬编码默认值 | `ruoyi-fastapi-backend/config/env.py:53-58` | `db_username='root'`、`db_password='mysqlroot'`；环境变量遗漏时自动使用默认凭据。 | `db_password` 设为 `Field(...)`，不提供默认值。 | 已经修复待验证 | Claude | 2026-07-21 | | |
| 25 | 安全基线 | 🟡 P1 | MQTT 凭据允许空值且未做校验 | `ruoyi-fastapi-backend/config/env.py:30-34`<br>`module_plc/mqtt/mqtt_consumer.py` | `mqtt_username=''`、`mqtt_password=''`；EMQX 开启认证时失败，未开启时未授权。 | 生产环境（`app_env=prod`）启动时强制校验 `mqtt_username` 非空，否则记录错误并拒绝启动 MQTT 通知器。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 26 | 安全基线 | 🟡 P1 | `APP_ENV` 未设置时默认加载 `.env.dev` | `ruoyi-fastapi-backend/config/env.py:230-241` | 未设置 `APP_ENV` 时回退到 `.env.dev`，可能把开发配置带进生产。 | 未指定时抛出异常，或默认不加载任何环境文件。 | 已经修复待验证 | Claude | 2026-07-21 | | |
| 27 | 工程化 | 🟡 P1 | APScheduler 事件监听器静默吞掉写入异常 | `ruoyi-fastapi-backend/config/get_scheduler.py:356-365` | `except Exception: pass` 隐藏任务日志写入失败。 | 至少记录 `logger.exception('任务日志写入失败')`。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 28 | 工程化 | 🟡 P1 | 内置监控任务未做分布式锁保护 | `ruoyi-fastapi-backend/config/get_scheduler.py:150-193` | `check_offline_*_task` 多实例部署时会重复扫描、重复告警。 | 增加基于 Redis 的分布式锁，或限制单实例运行。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 29 | 边缘节点 | 🟡 P1 | MQTT 发布时不校验实际连接状态 | `ruoyi-fastapi-backend/module_plc/mqtt/mqtt_consumer.py:159-168` | 仅检查 `self._running`，未检查 `client.is_connected()`；断线时消息丢失。 | 发布前确认 `client.is_connected()`，未连接时跳过并记录警告。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 30 | 协议参数 | 🟡 P1 | `report_deadband_ms` 前后端语义不一致 | 前端 `device/index.vue:425-428`<br>后端 `tag_do.py/tag_vo.py`<br>Node-RED 流程 | 前端标签“变化死区”单位 ms；后端字段名暗示时间；Node-RED 实际按数值绝对差比较。 | 统一为数值死区语义：Node-RED `sf-data-processor` 中 `deadband` 按 `abs(eng - prev) < deadband` 比较；建议后续把字段名改为 `report_deadband` 去除 ms 误导。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 31 | 边缘节点 | 🟡 P1 | IP 检测过度排除虚拟/容器网段 | `docs/V12/edgelink_v12_main_flow.json`（`IP检测 + 登录准备`） | 把 `172.16/12`、Docker/Hyper-V、VirtualBox 网段全部排除，回退 `127.0.0.1`，多机注册冲突。 | 提供可配置优先网段/接口名；默认不全部排除 172.16/12。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 32 | 监控告警 | 🟡 P1 | `/monitor/alerts` 的 `limit` 参数无上限，可拉取全表导致 OOM | `module_plc/controller/monitor_controller.py` | 未限制 `limit` 大小，恶意请求可一次性拉取全量告警，导致后端内存耗尽。 | 限制 `limit` 在 1~500 之间。 | 已经修复待验证 | Claude | 2026-07-18 | | |
| 33 | 前端表单 | 🟡 P1 | 设备/点位状态切换接口未校验状态枚举，可写入任意字符串 | `module_plc/controller/device_controller.py`<br>`tag_controller.py` | 状态字段可写入非法值，导致数据库状态语义混乱。 | 在 Service 层校验只允许 `0/1`。 | 已经修复待验证 | Claude | 2026-07-18 | | |
| 34 | 监控告警 | 🟡 P1 | 监控中心 `plcList` 字段混用 snake_case | `module_plc/dao/monitor_dao.py`<br>`src/views/plc/monitor/index.vue` | 前后端字段命名不一致，前端需要额外映射或解析失败。 | 统一为 camelCase。 | 已经修复待验证 | Claude | 2026-07-18 | | |
| 35 | 监控告警 | 🟡 P1 | 告警列表 `device_name` 恒为空 | `module_plc/service/monitor_service.py` | 告警列表未 JOIN `plc_device` 回填设备名称，运维人员无法定位设备。 | 告警查询时通过 `get_devices_by_ids` 批量回填 `device_name`。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 36 | 前端表单 | 🟡 P1 | Node-RED 拉取 `page_size=50000` 无上界，万级点位时后端内存/CPU 飙升 | `module_plc/entity/vo/tag_vo.py` | 分页参数无上限，边缘拉取全量点位时后端可能 OOM。 | 限制 `page_size` 最大 5000 或分块拉取。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 37 | 前端表单 | 🟡 P1 | 全局点位页寄存器筛选值域与后端不一致，Modbus 类型无法筛选 | `src/views/plc/tag/index.vue` | 前端下拉值与后端枚举不匹配，导致筛选无结果。 | 前后端对齐寄存器类型枚举值。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 38 | 协议参数 | 🟡 P1 | 量程映射（slope_offset）前后端实现不一致，Node-RED 仅做线性 y=ax+b | `module_plc/service/tag_service.py`<br>`docs/V12/edgelink_v12_main_flow.json` | 后端 `slope_offset` 为量程映射 `(raw-min)/(max-min)×(engMax-engMin)+engMin`，Node-RED 此前误按线性 y=a·x+b 处理。 | Node-RED `sf-data-processor` 已改为与后端一致的量程映射算法；`cm-discover` 已透传 `rawValueMin/Max`、`engValueMin/Max`。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 39 | 监控告警 | 🟡 P1 | 心跳上报未校验 `host_pc_ip`，可能创建异常节点记录 | `module_plc/controller/monitor_controller.py` | 非法/空 `host_pc_ip` 被写入 `nodered_node`，造成监控节点混乱。 | 增加 IP 格式校验和合法性检查。 | 已经修复待验证 | Claude | 2026-07-25 | | |

---

## 🟢 P2 — 建议优化

| 序号 | 标签 | 严重度 | 问题标题 | 涉及文件 | 现象/风险 | 修复建议 | 状态 | 修复人 | 修复日期 | 验证人 | 验证日期 |
|---:|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| 40 | 工程化 | 🟢 P2 | `app_name` 拼写错误 | `ruoyi-fastapi-backend/config/env.py:18` | `RuoYi-FasAPI` 缺少 `t`，影响日志/Swagger。 | 改为 `RuoYi-FastAPI`。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 41 | 工程化 | 🟢 P2 | APScheduler 参数名拼写错误 | `ruoyi-fastapi-backend/config/get_scheduler.py:121` | `max_instance` 应为 `max_instances`，并发控制不生效。 | 改为 `max_instances`。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 42 | 边缘节点 | 🟢 P2 | `MQTTNotifier` 重连策略无指数退避 | `ruoyi-fastapi-backend/module_plc/mqtt/mqtt_consumer.py:62-65` | 固定 5 秒重连，网络长期故障时产生日志洪峰并压垮 Broker。 | 实现指数退避或设置最大重连次数。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 43 | 工程化 | 🟢 P2 | 全局配置在模块导入时实例化 | `ruoyi-fastapi-backend/config/env.py:244-257` | 导入即触发文件读取、Pydantic 校验，单元测试难以 Mock。 | 采用延迟加载或工厂函数。 | 未修复 | | | | |
| 44 | 工程化 | 🟢 P2 | `monitor_task` 异常捕获范围过大 | `ruoyi-fastapi-backend/module_task/monitor_task.py:46-48`、`:80-82`、`:96-98` | `except Exception` 隐藏数据库连接错误等。 | 区分可恢复与不可恢复异常。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 45 | 工程化 | 🟢 P2 | `Dockerfile` 使用 `COPY . .` | `ruoyi-fastapi-backend/Dockerfile.my:5`<br>`Dockerfile.pg:5` | 可能把 `.env*`、密钥等打包进镜像。 | 添加 `.dockerignore`；使用多阶段构建。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 46 | 工程化 | 🟢 P2 | `Dockerfile` 缺少健康检查 | `ruoyi-fastapi-backend/Dockerfile.my:11`<br>`Dockerfile.pg:11` | 无 `HEALTHCHECK`；固定使用清华镜像源。 | 添加 `HEALTHCHECK`；固定依赖哈希。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 47 | 工程化 | 🟢 P2 | `protocol_compat_controller` 依赖注入方式不一致 | `ruoyi-fastapi-backend/module_plc/controller/protocol_compat_controller.py:21` | 使用 `get_db` 而非项目统一的 `DBSessionDependency`；鉴权问题（P1-1）已单独修复。 | 改为 `Annotated[AsyncSession, DBSessionDependency()]`。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 48 | 工程化 | 🟢 P2 | 新增设备时 `mes_ip` 重复校验 | `ruoyi-fastapi-backend/module_plc/service/device_service.py:166-171` | 同一段代码出现两次。 | 删除重复块。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 49 | 监控告警 | 🟢 P2 | 监控页告警计数只增不减 | `ruoyi-fastapi-frontend/src/views/plc/monitor/index.vue:462`、`494`、`586-589` | 收到告警时本地计数加 1，确认后仅重新拉取 KPI；多用户/漏刷新时计数漂移。 | 确认后本地递减，或完全以服务端 KPI 为准。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 50 | 监控告警 | 🟢 P2 | 监控页 MQTT 已连接时仍每 10 秒全量轮询 | `ruoyi-fastapi-frontend/src/views/plc/monitor/index.vue:199`、`526-560` | 即使 MQTT 实时推送，仍持续 `getNodeList()` 全量 HTTP 查询。 | MQTT 在线时只轮询 KPI 和告警；节点列表增量更新。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 51 | 前端表单 | 🟢 P2 | 导入点位未做文件校验 | `ruoyi-fastapi-frontend/src/views/plc/device/index.vue:1055-1066` | 无大小、扩展名、行数校验。 | 增加 `file.size` 上限、扩展名校验、行数提示。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 52 | 前端表单 | 🟢 P2 | 克隆设备时 `deviceCode` 缺少前端校验 | `ruoyi-fastapi-frontend/src/views/plc/device/index.vue:486-491` | `cloneRules` 只校验 `deviceName` 和 `plcIp`。 | 增加 `deviceCode` 必填规则。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 53 | 前端表单 | 🟢 P2 | 编辑点位 API 失败无反馈 | `ruoyi-fastapi-frontend/src/views/plc/device/index.vue:959-970` | `getTag(row.id).then(...)` 缺少 `.catch`。 | 增加 `.catch` 错误提示。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 54 | 前端表单 | 🟢 P2 | 表单定时器未在组件销毁时清理 | `ruoyi-fastapi-frontend/src/views/plc/device/index.vue:748-752` | `this._queryTimer` 未在 `beforeDestroy` 中清理。 | 增加 `beforeDestroy` 清理定时器。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 55 | 前端表单 | 🟢 P2 | MQTT 客户端未显式启用重连自动订阅 | `ruoyi-fastapi-frontend/src/utils/mqttClient.js:64-71` | 未设置 `resubscribe: true`。 | 显式配置 `resubscribe: true`。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 56 | 数据库 | 🟢 P2 | `pg_write_status.today_write_count` 无按日重置 | `docs/V12/monitor_center.sql:59-69` | 缺少零点清零机制。 | 已增加 MySQL Event `reset_pg_write_count_daily`，每天零点清零 `today_write_count`。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 57 | 数据库 | 🟢 P2 | 心跳日志清理 Event 时间写死 | `docs/V12/monitor_center.sql:93-96` | `STARTS '2026-06-08 03:00:00'`。 | 已改为 `CURRENT_TIMESTAMP + INTERVAL 1 DAY`，不再写死日期。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 58 | 数据库 | 🟢 P2 | 复合索引缺失 | `module_plc/entity/do/device_do.py`<br>`tag_do.py` | 高频查询未覆盖索引，随着数据量增长性能下降。 | 已补充 `idx_plc_device_del_status_host` 和 `idx_plc_tag_device_status_del` 复合索引。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 59 | 数据库 | 🟢 P2 | `nodered_node` IP 字段长度 20 与 `plc_device` 50 不一致，不支持 IPv6 | `docs/monitor_center.sql`<br>`module_plc/entity/do/monitor_do.py` | IPv6 地址或长域名无法存储。 | `nodered_node.host_pc_ip` 已改为 `VARCHAR(50)`，`office_net_ip` 和 `indust_net_ip` 统一为 `VARCHAR(50)`。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 60 | 前端表单 | 🟢 P2 | 前端协议配置 localStorage 缓存 24h，后端修改后前端长时间陈旧 | `src/views/plc/device/index.vue` | 协议配置缓存过久，后端修改后前端仍使用旧配置。 | 缩短缓存时间或增加缓存失效/刷新机制。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 61 | 协议参数 | 🟢 P2 | `TagBatchUpdateModel` 缺少协议字段 | `module_plc/entity/vo/tag_vo.py`<br>`module_plc/service/tag_service.py` | 批量更新点位时无法修改协议参数。 | 已补充 `bit_offset`/`byte_order`/`word_order`/`protocol_params` 字段，并在 `batch_update_tag_services` 中处理。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 62 | 工程化 | 🟢 P2 | 导入文件一次性读入内存 | `module_plc/controller/tag_controller.py` | 大文件导入时后端内存占用高。 | 改为流式读取或分片处理。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 63 | 工程化 | 🟢 P2 | 克隆设备点位上限 9999 | `module_plc/service/device_service.py` | 硬编码上限，大量点位克隆受限。 | 参数化或按需动态限制。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 64 | 监控告警 | 🟢 P2 | Controller 层重复调用 `_sync_nodes_from_devices` | `module_plc/controller/monitor_controller.py` | 与 Service 层逻辑重复，增加不必要的 DB 操作。 | 移除 Controller 层重复调用，统一在 Service 处理。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 65 | 工程化 | 🟢 P2 | 导入返回 `success_count` 取 `len(valid_tags)` 而非 DAO 真实写入数 | `module_plc/service/tag_service.py` | 导入结果可能不准确，误导用户。 | 以 DAO 实际写入/更新行数为准。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 66 | 边缘节点 | 🟢 P2 | `mqttClient.js` clientId 用 `Math.random()` 拼接 | `src/utils/mqttClient.js` | 随机 clientId 可能导致重复连接或难以追踪。 | 使用带用户/会话标识的稳定 clientId。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 67 | 前端表单 | 🟢 P2 | 前端 `backupPcIp` 无格式校验 | `src/views/plc/device/index.vue` | 备份 IP 可输入任意字符串，导致配置错误。 | 增加 IP 格式校验。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 68 | 监控告警 | 🟢 P2 | `confirm_alert` 可将已恢复告警重新置为已确认 | `module_plc/dao/monitor_dao.py` | 已恢复告警不应再被确认，状态流转不合理。 | 限制确认操作只对 `status=0`（未处理）告警生效，已恢复（2）不可再确认。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 69 | 边缘节点 | 🟢 P2 | `data-processor` 在 `DEBUG` 定义前引用它 | `docs/V12/edgelink_v12_main_flow.json`（`数据管道处理`） | `procGuard` 分支中 `DEBUG` 被提前使用，调试日志不打印。 | 将 `var DEBUG = ...` 移到 `procGuard` 检查之前。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 70 | 配置下发 | 🟢 P2 | 配置发布中心：发布配置按钮权限与 device/tag 页面按钮重复 | 前端配置发布中心页面 | 已统一入口：从 `src/views/plc/device/index.vue` 和 `src/views/plc/tag/index.vue` 移除了发布按钮，从 `src/api/plc/device.js` 和 `tag.js` 移除了 `publishConfig` 导出，发布动作集中到配置发布中心页面。 | 验证 device/tag 页面不再存在发布入口，且发布中心页面功能完整。 | 已经修复待验证 | Claude | 2026-07-18 | | |
| 71 | 配置下发 | 🟢 P2 | 配置发布中心：`plc:publish:edit` 权限未在菜单初始化中注册（已修复） | `docs/edgelink_menu_init.sql` 或相关菜单初始化脚本 | 发布功能对应的权限标识未注册，导致权限控制失效。 | 已在菜单初始化中注册 `plc:publish:edit` 权限。 | 已经修复待验证 | Claude | 2026-07-18 | | |

---

## 🟡 P1 — 动态驱动架构（可插拔驱动）

| 序号 | 标签 | 严重度 | 问题标题 | 涉及文件 | 现象/风险 | 修复建议 | 状态 | 修复人 | 修复日期 | 验证人 | 验证日期 |
|---:|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| 72 | 架构 | 🟡 P1 | 设备表缺少 `driver_code` 字段，驱动映射依赖 `com_type` 隐式推断 | `module_plc/entity/do/device_do.py`<br>`module_plc/entity/vo/device_vo.py` | 当前设备只通过 `com_type`（MC_Protocol/Modbus_TCP/GOT/PLC_RS232C）推断驱动，但未来一个通信方式可能对应多个驱动（如以太网可能是 S7 或 Modbus），扩展性差。 | 在 `plc_device` 表、`PlcDevice` DO、`PlcDeviceModel` VO 中新增 `driver_code` 字段；根据 `plc_protocol_compat` 映射为设备赋值。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 73 | 架构 | 🟡 P1 | 缺少 `plc_driver` 驱动元数据表 | 新建 `docs/plc_driver.sql`<br>`docs/migration_20260719_driver_code.sql`<br>`module_plc/entity/do/driver_do.py` | 没有驱动能力描述表，前端无法动态渲染驱动参数，Node-RED 无法统一分发驱动。 | 新建 `plc_driver` 表：`driver_code`、`driver_name`、`node_red_node_type`、`config_schema`、`register_types`、`data_types`、`address_pattern`、`bit_offset_supported`、`byte_order_supported`、`word_order_supported`、`enabled`；新增迁移脚本。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 74 | 架构 | 🟡 P1 | `plc_protocol_compat` 表缺少 `driver_code` 关联 | `docs/plc_protocol_compat.sql`<br>`docs/migration_20260719_driver_code.sql`<br>`module_plc/entity/do/protocol_compat_do.py` | 品牌→系列→通信方式无法直接映射到 Node-RED 驱动节点，需要前端/后端硬编码映射。 | 给 `plc_protocol_compat` 增加 `driver_code` 字段；每条品牌/系列/通信方式记录明确对应一个驱动；兼容历史数据的迁移脚本。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 75 | 架构 | 🟡 P1 | 后端缺少 `/plc/driver/list` 和 `/plc/driver/{driver_code}/schema` 接口 | 新增 `module_plc/controller/driver_controller.py`<br>`module_plc/service/driver_service.py` | 前端当前依赖 `protocol_compat_controller` 返回的级联数据，只能支持固定的品牌/系列/寄存器结构，无法动态扩展新驱动。 | 新增驱动控制器：返回所有驱动列表、驱动 schema（配置参数、寄存器类型、数据类型、地址正则），供前端动态渲染；自动注册路由。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 76 | 前端表单 | 🟡 P1 | 前端设备表单未按驱动 schema 动态渲染协议参数 | `src/views/plc/device/index.vue` | 当前 `mcFrame`/`stationNo`/`networkNo` 是写死的，增加新驱动（如 S7 的 rack/slot、Modbus 的 unit_id）需要改前端代码。 | 根据 `/plc/driver/{driver_code}/schema` 返回的 `config_schema`，动态生成设备表单中的协议参数输入项。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 77 | 前端表单 | 🟡 P1 | 前端点位表单未按驱动能力过滤寄存器类型和数据类型 | `src/views/plc/device/index.vue` 点位弹窗 | 当前寄存器类型和数据类型与驱动能力无关，可能配置出“三菱 X 寄存器选 INT32”这种错误。 | 根据驱动 schema 中 `register_types` 和 `data_types`，按所选寄存器类型动态过滤数据类型；按驱动能力显示/隐藏 `bitOffset`/`byteOrder`/`wordOrder`。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 78 | 配置下发 | 🟡 P1 | 配置下发 payload 未包含 `driverCode` 和 `driverConfig` | `module_plc/service/config_publish_service.py`<br>`module_plc/mqtt/mqtt_consumer.py` | Node-RED 动态驱动需要知道每个设备用哪个驱动以及驱动参数，当前 payload 缺少 `driverCode`。 | 设备配置发布列表与 MQTT 刷新通知均增加 `driverCode` 和 `driverConfig`；Node-RED 读取后用对应驱动节点实例化。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 79 | 边缘节点 | 🟡 P1 | Node-RED `config-manager` 未根据 `driverCode` 分发到对应驱动节点 | `docs/V12/edgelink_v12_main_flow.json`（调度器 / `driverCode分流`） | 当前调度器硬编码 `comType` 分流，新增驱动需要改流程。 | 调度器 payload 已携带 `driverCode`/`driverConfig`；`driverCode分流` 节点已按 `driverCode` 前缀路由到 `mitsubishi-read`/`modbus-read`，未知驱动记录警告并丢弃。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 80 | 前端表单 | 🟡 P1 | 动态驱动表单非平铺字段（如 Modbus unitId、S7 rack/slot）提交时被 Pydantic 静默丢弃 | `src/views/plc/device/index.vue`<br>`module_plc/entity/vo/device_vo.py` | 前端按驱动 schema 动态渲染的 `unitId`/`rack`/`slot` 等字段不在 `PlcDeviceModel` 平铺列中，submitForm 直接提交后会被 Pydantic 丢弃，导致 Modbus/S7 设备配置丢失。 | 提交前将非平铺字段收集到 `form.protocolParams`；加载驱动 schema 时区分平铺/非平铺默认值；编辑时把 `protocolParams` 展开回表单。 | 已经修复待验证 | Claude | 2026-07-19 | | |
| 81 | 边缘节点 | 🟡 P1 | 一台 PC 多开 Node-RED 时 `host_pc_ip` 冲突，设备归属与配置发布错乱 | `module_plc/entity/do/device_do.py`<br>`module_plc/entity/do/monitor_do.py`<br>`src/views/plc/device/index.vue`<br>`docs/V12/edgelink_v12_main_flow.json` | 当前 `host_pc_ip` 为纯 IP，一台 PC 跑多个 Node-RED 实例时 IP 相同，导致设备归属和配置发布无法区分实例。 | `host_pc_ip` 支持 `IP:端口` 格式（如 `10.81.1.100:1881`）；Node-RED 优先读取 `edge_hostPcIp` 环境变量；数据库字段长度统一为 50；前端校验支持可选端口。 | 已经修复待验证 | Claude | 2026-07-19 | | |

---

## 🔵 SCADA 级风险（投产后评估，不阻塞既有 10 天计划）

> 以下风险由 SCADA 专家视角识别，属于工业级产品化增强项。  
> **建议在 10 天核心整改完成、系统预投产验证通过后，再按业务优先级排期处理。**

| 序号 | 标签 | 严重度 | 问题标题 | 涉及文件 | 现象/风险 | 修复建议 | 状态 | 修复人 | 修复日期 | 验证人 | 验证日期 |
|---:|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| 82 | 边缘节点 | 🔴 P0 | PG 写入失败时 Node-RED 本地无磁盘缓冲，数据丢失风险 | `docs/V12/edgelink_v12_main_flow.json`（`sf-pg-writer`） | 当前「采集 → MQTT → PG」推送模式，PG 长期失败时数据在 Node-RED 内存中积压，最终 OOM 或丢失。 | 增加本地磁盘缓冲（SQLite/LevelDB），PG 恢复后批量补传；或引入 Kafka/Pulsar 作为中间缓冲层。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 83 | 边缘节点 | 🔴 P0 | Node-RED 实例无 failover 机制，单点故障导致采集中断 | `docs/V12/edgelink_v12_main_flow.json`（调度器 / `sf-monitor`） | 高频实例崩溃后，该设备采集完全中断，无自动切换机制。 | 主备实例心跳互备，主实例离线时备实例自动接管设备；或引入 Keepalived/VRRP 虚拟 IP 漂移。 | 未修复 | | | | |
| 84 | 边缘节点 | 🔴 P0 | 多实例部署无时钟同步机制，数据时间戳可能混乱 | `docs/V12/edgelink_v12_main_flow.json`（`sf-data-processor`） | 各 Node-RED 实例系统时间可能不同步，导致数据时间戳混乱、告警误判、历史数据排序错误。 | 强制 NTP 同步所有采集节点；或后端在接收数据时统一覆盖时间戳。 | 未修复 | | | | |
| 85 | 边缘节点 | 🟡 P1 | MQTT 消息洪峰无背压控制，高频采集可能压垮 EMQX | `docs/V12/edgelink_v12_main_flow.json`（`sf-data-processor` / MQTT out） | 高频采集（0.5s × 1000 点位）产生大量 MQTT 消息，可能压垮 EMQX 或导致前端 WebSocket 卡顿。 | EMQX 速率限制 + Node-RED 端批量聚合（如 5s 聚合一次）；或启用 MQTT QoS 0 + 保留消息减少重复。 | 未修复 | | | | |
| 86 | 工程化 | 🟡 P1 | Node-RED 流程与配置无版本管理，无法回滚 | `docs/V12/edgelink_v12_main_flow.json`<br>`D:/nodered/data/settings.js` | `flows.json` 和 `settings.js` 分散在各 PC 上，没有集中版本控制，修改后无法快速回滚。 | 流程文件纳入 Git 管理；settings.js 模板化 + 配置中心下发；每次部署生成版本快照。 | 未修复 | | | | |
| 87 | 边缘节点 | 🟡 P1 | 新增驱动需重启 Node-RED 实例，采集中断 | `D:/nodered/node-red-contrib-*/` | 安装新 npm 驱动节点必须重启 Node-RED，导致该实例负责的所有设备采集中断。 | 驱动节点热加载机制；或蓝绿部署（新实例启动后再切流量）；或按驱动类型预分配实例。 | 未修复 | | | | |
| 88 | 监控告警 | 🟡 P1 | Node-RED 实例本身无健康监控（内存/CPU/句柄） | `module_plc/service/monitor_service.py`<br>`docs/V12/edgelink_v12_main_flow.json`（`sf-monitor`） | 只监控 PLC 通信状态，不监控 Node-RED 进程内存、CPU、句柄数，实例泄漏或崩溃前无预警。 | 实例自监控上报（内存/CPU/句柄/队列深度），超阈值时告警并自动重启；纳入监控中心 KPI。 | 已经修复待验证 | Claude | 2026-07-26 | | |
| 89 | 监控告警 | 🟡 P1 | 主备切换期间可能产生重复采集数据 | `module_plc/service/device_service.py`<br>`docs/V12/edgelink_v12_main_flow.json` | 主备 PC 同时采集同一台 PLC（切换期间），会产生重复数据，影响历史统计和告警。 | 切换时加入「静默期」（如 10s 内只读不写）；或基于 `(device_id, tag_id, ts)` 唯一约束去重。 | 未修复 | | | | |
| 92 | 配置下发 | 🟡 P1 | 多采集 PC 配置分散管理，每台需单独维护环境变量 | `D:/nodered/data/settings.js`<br>`module_plc/controller/bootstrap_controller.py`<br>`module_plc/entity/do/bootstrap_key_do.py`<br>`docs/V12/edgelink_v12_main_flow.json` | 当前 MQTT 凭据、API Key、后端地址等配置分散在各 Node-RED PC 的 `settings.js` 或环境变量中，配置变更需逐台修改，运维成本高。 | 新增 `/plc/config/bootstrap` 接口：Node-RED 首次启动时用 `node_key` + `secret_key` 拉取完整配置；后续配置变更通过发布中心统一下发；新增 `edge_bootstrap_key` 表管理节点密钥。 | 已经修复待验证 | Claude | 2026-07-21 | | |

---

## 🟣 产品化增强（页面化需求，不阻塞既有 10 天计划）

> 以下需求为页面化功能增强，提升运维可观测性。  
> **建议在 10 天核心整改完成、系统预投产验证通过后，与第 11 天驱动管理页面一起排期。**

| 序号 | 标签 | 严重度 | 问题标题 | 涉及文件 | 现象/风险 | 修复建议 | 状态 | 修复人 | 修复日期 | 验证人 | 验证日期 |
|---:|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| 90 | 配置下发 | 🟢 P2 | 发布履历页面缺失，无法追溯每次配置下发的历史记录 | `module_plc/entity/do/publish_log_do.py`<br>`src/views/plc/publish/index.vue` | 当前 `plc_publish_log` 已记录发布日志，但前端无页面展示，运维无法查看每次发布的时间、发布人、影响范围、成功/失败详情。 | 新增「发布履历」页面：列表展示 `plc_publish_log` 记录，支持按时间/发布人/设备筛选；点击查看详情（发布设备列表、节点列表、MQTT 通知结果）。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 91 | 前端表单 | 🟢 P2 | 修改履历页面缺失，设备/点位变更无法审计追溯 | 新建 `module_plc/entity/do/change_log_do.py`<br>`module_plc/service/change_log_service.py`<br>`src/views/plc/change-log/index.vue` | 当前设备/点位的新增、修改、停用、删除操作只写数据库，无操作日志表，无法回答「谁在什么时间改了哪台设备的哪个字段」。 | 新增 `plc_change_log` 表：记录操作类型（add/update/disable/delete）、操作人、变更对象（设备/点位）、变更前后值 JSON；新增「修改履历」页面，支持按对象/操作人/时间筛选。 | 已经修复待验证 | Claude | 2026-07-25 | | |
| 93 | 配置下发 | 🟢 P2 | 边缘节点管理页面缺失，无法维护 `edge_bootstrap_key` 节点密钥 | `module_plc/controller/bootstrap_key_controller.py`<br>`src/views/plc/bootstrap-key/index.vue` | 当前 `edge_bootstrap_key` 表已创建，但前端无页面管理节点密钥，运维无法新增/禁用/重置节点。 | 新增「边缘节点管理」页面：列表展示节点标识/名称/地址/状态；支持新增、编辑、禁用/启用、重新生成密钥、删除；`host_pc_ip` 增加唯一性约束。 | 已经修复待验证 | Claude | 2026-07-21 | | |
| 94 | 协议参数 | 🟡 P1 | `triggerKind` 前端可设但 Node-RED 不消费，变化触发/握手触发无效 | `src/views/plc/device/index.vue`<br>`docs/V12/edgelink_v12_main_flow.json`（调度器 / `sf-data-processor`） | 前端可选择 0=握手/1=固定周期/2=变化触发，但 Node-RED 调度器和数据管道均未根据 `triggerKind` 做区分，用户设置无效。 | `sf-data-processor` 增加 `triggerKind=2` 变化检测；前端下拉改为「固定周期（当前支持）」，0/2 选项禁用并标注「规划中」。 | 已经修复待验证 | Claude | 2026-07-21 | | |
| 95 | 前端表单 | 🟡 P1 | `scanIntervalMs` 前端无下限，但 Node-RED 调度器锁死 1s | `src/views/plc/device/index.vue` | 前端 `el-input-number` 无 `min` 限制，用户可填 100ms/500ms，但 Node-RED 调度器由 1 秒 inject 驱动，实际最低 1 秒，用户误以为设了高频采集。 | 前端增加 `:min="1000"` 并提示「当前最低 1000ms（1秒），亚秒级采集规划中」。 | 已经修复待验证 | Claude | 2026-07-21 | | |
| 96 | 工程化 | 🟢 P2 | `isFirstRun` 在 `sf-config-manager Step 1` 中重复声明 | `docs/V12/edgelink_v12_main_flow.json`（`IP检测 + 登录准备`） | `isFirstRun` 在第 28 行和第 92 行各声明一次，虽不影响功能但易造成混淆。 | 删除第 92 行的重复声明。 | 已经修复待验证 | Claude | 2026-07-21 | | |
| 97 | 边缘节点 | 🟡 P1 | Node-RED 无本地配置缓存，后端崩溃时重启无法继续采集 | `docs/V12/edgelink_v12_main_flow.json`（`sf-config-manager`） | 当前 Node-RED 配置完全依赖后端实时拉取，后端崩溃时如果 Node-RED 重启，无法获取配置导致采集停止。 | Node-RED 拉取配置成功后缓存到本地文件（如 `edge_config_cache.json`）；启动时先读缓存，后端不可用则用缓存配置继续采集；配置更新时同步刷新缓存。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 98 | 配置下发 | 🟡 P1 | Bootstrap 自动注册 v2.0：Node-RED 零配置自动注册与两阶段配置下发 | `module_plc/controller/bootstrap_controller.py`<br>`module_plc/entity/do/bootstrap_key_do.py`<br>`docs/V12/edgelink_v12_main_flow.json`<br>`init_plc_db.py` | 当前 Node-RED 需手动配置 `edge_bootstrapKey`/`edge_bootstrapSecret`/`edge_hostPcIp`，新增 PC 时需逐台修改 `settings.js`；且 `/auto` 接口返回全部业务凭据，Node-RED 持有 admin 权限，IP 变更创建僵尸记录。 | 两阶段 Bootstrap：`/auto` 只返回 `node_key` + `secret_key`，`/bootstrap` 用 `secret_key` 获取业务配置；创建 `edge_collector` 专用角色（无 admin 权限）；`machine_fingerprint` 处理 IP 变更自动映射；Node-RED 自动检测 IP 和端口，零配置启动。数据库部分已完成（`machine_fingerprint` 字段、`edge_collector` 角色和权限），接口和 Node-RED 两阶段调用已完成。 | 已经修复待验证 | Claude | 2026-07-22 | | |
| 99 | 工程化 | 🟢 P2 | 驱动管理页面缺失，无法 Web 端维护 `plc_driver` 和 `plc_protocol_compat` | `module_plc/controller/driver_admin_controller.py`<br>`module_plc/controller/protocol_compat_admin_controller.py`<br>`src/views/plc/driver/index.vue` | 当前 `plc_driver` 和 `plc_protocol_compat` 表已创建，但前端无页面管理，新增驱动或映射需直接操作数据库。 | 新增「驱动管理」页面：列表展示驱动编码/名称/节点类型/能力标识/状态；支持新增、编辑、删除、启用禁用；新增「协议兼容映射」维护接口和页面；JSON schema 校验、唯一性校验、设备引用检查。 | 已经修复待验证 | Claude | 2026-07-22 | | |

---

## 修复状态统计

- 未修复：7 / 99
- 已经修复待验证：91 / 99
- 已验证：1 / 99

---

## 说明

1. **编号统一**：全部使用连续序号 1~79，不再使用 P0-x/P1-x/P2-x 混合格式。
2. **状态同步**：已将 `EdgeLink_投产前整改清单.md` 中 ✅ 的项同步到本清单，状态均为「已经修复待验证」，但经核对后 #2、#47 仍实际未修复，已改回「未修复」。
3. **Day 1 修复进展（2026-07-19）**：
   - #7：后端已支持 `byte_order`/`word_order`/`bit_offset`，前端表单待 Day 2 补充
   - #8：后端已支持 `UINT16/UINT32/BOOL/DOUBLE`，前端下拉待 Day 2 补充
   - #61：`TagBatchUpdateModel` 已补充协议参数字段并接入批量更新逻辑
   - #72：`PlcDevice` DO 与 `PlcDeviceModel` VO 已新增 `driver_code` 字段
   - #73：已新建 `plc_driver` 元数据表、`PlcDriver` DO 与历史迁移脚本
   - #74：`plc_protocol_compat` 表与 DO 已新增 `driver_code` 字段并初始化映射
   - #75：已新增 `/plc/driver/list` 与 `/plc/driver/{driver_code}/schema` 接口并注册路由
   - #78：`config_publish_service` 与 MQTT 通知已携带 `driverCode`/`driverConfig`
4. **Day 1 新增范围（2026-07-19）**：
   - 新增 #72~#79 动态驱动架构相关项，包含 `driver_code` 字段、`plc_driver` 元数据表、驱动 schema API、前端动态表单、配置下发 payload、Node-RED 动态分发。
5. **Day 2 修复进展（2026-07-19）**：
   - #7：前端点位表单已增加 `byteOrder`/`wordOrder`/`bitOffset` 输入项，按驱动能力动态显示
   - #8：前端 `dataType` 下拉已扩展 `UINT16`/`UINT32`/`BOOL`/`DOUBLE`
   - #37：全局点位页寄存器筛选值域已对齐后端（增加 Modbus HR/IR/CR/COIL/DISCRETE）
   - #51：点位导入已增加文件大小（≤10MB）与扩展名校验
   - #52：克隆设备表单已增加 `deviceCode` 必填校验
   - #53：编辑点位接口已增加 `.catch` 错误提示
   - #54：设备列表查询定时器已在 `beforeDestroy` 中清理
   - #55：`mqttClient.js` 已启用 `resubscribe: true`
   - #67：备份 IP 已增加 IP 格式校验
   - #76：设备表单已按驱动 schema 动态渲染协议参数（mcFrame/unitId/serialPort 等）
   - #77：点位表单已按驱动 schema 过滤寄存器类型和数据类型
5. **Day 3 修复进展（2026-07-19）**：
   - #6：配置发布中心页面已可用，支持待发布设备列表、影响范围预览、发布选中/全部；后端新增 `plc_publish_log` 记录 `lastPublishTime`
   - #17：`CONFIG_REFRESH` 广播已改为按 `node_id` 精确过滤，缺失时回退 `host_pc_ip`；后端发布时按 `nodered_node` 映射真实 `node_id`
   - #80：修复动态驱动表单非平铺字段（Modbus `unitId`、S7 `rack/slot` 等）被 Pydantic 静默丢弃的关键 bug
6. **Day 4 修复进展（2026-07-19）**：
   - #7：Node-RED `cm-discover` 已透传 `byteOrder`/`wordOrder`/`bitOffset`/量程参数
   - #16：`sf-config-manager` API 失败不再错误设置 `edge_configReady=true`
   - #30：统一 `deadband` 为数值死区语义
   - #38：`slope_offset` 量程映射与后端对齐
   - #79：调度器 payload 携带 `driverCode`/`driverConfig`，`driverCode分流` 节点按驱动编码路由
   - #81：`host_pc_ip` 支持 `IP:端口` 格式，解决一台 PC 多开 Node-RED 实例冲突
7. **SCADA 级风险（2026-07-19 新增）**：
   - 新增 #82~#89 共 8 项工业级产品化风险，涵盖数据缓冲、failover、时钟同步、背压控制、版本管理、热更新、健康监控、主备去重。
   - **这些项不阻塞既有 10 天计划**，建议在 10 天核心整改完成、系统预投产验证通过后，再按业务优先级排期处理。
8. **新增项**：合并了原 `EdgeLink_投产前整改清单.md` 中未在本清单中体现的项，以及用户新增的「配置发布中心」相关项（#70、#71）。
9. **标签使用**：用「标签」列标识每项所属主题，便于按主题分天处理和测试。
10. **特别注意**：#2 和 #47 的问题标题和修复动作已经更新，避免明天验证时出现误判。
11. **迁移脚本**：已有数据库实例需执行 `docs/migration_20260719_driver_code.sql` 以补充 `driver_code` 列与 `plc_driver` 表；执行 `docs/migration_20260719_host_pc_ip_port.sql` 以支持 `IP:端口` 格式。

