# EdgeLink 边缘智联系统 — 完整技术规格文档

> 版本：v2.0 | 日期：2026-06-10 | 目标读者：AI 测评 / 技术评审 / 新成员入职  
> 项目路径：`C:\Users\admin\Desktop\RuoYi-Vue-FastAPI`  
> 后端：`ruoyi-fastapi-backend`（FastAPI 0.125 + SQLAlchemy 2.0 async + Pydantic v2）  
> 前端：`ruoyi-fastapi-frontend`（Vue 2.6 + Element UI 2.15 + Axios）

---

## 一、系统概述

EdgeLink 是一个工业物联网边缘计算平台，替代传统 Excel VBA 方案，为工厂现场的 PLC 设备提供**配置管理**、**数据采集**、**数据清洗**和**运行监控**能力。

### 1.1 三重身份

| 角色 | 系统提供 |
|------|----------|
| **PLC 台账系统** | 设备档案管理、点位表维护、Excel 导入导出、名称/编号唯一性校验 |
| **采集管理后台** | 多 PC 分布式采集、每设备独立采集周期、Node-RED 自动发现、心跳监控 |
| **数据清洗管道** | 数值换算(linear/slope_offset)、防抖去重、PC 本地时间戳、GOOD/BAD/UNCERTAIN 质量码 |

### 1.2 核心架构

```
┌──────────────────────────────────────────┐
│           RuoYi Web 管理系统               │  ← Level 3: 配置管理
│  PLC设备管理 / 数据点表 / 节点监控中心      │
└──────────────┬───────────────────────────┘
               │ MySQL (配置存储)
┌──────────────┴───────────────────────────┐
│         20 台双网口采集 PC                  │  ← Level 2: 采集执行
│  每台运行 Node-RED 4.1.11                 │
│  NIC1(办公网): 连 MySQL, 心跳上报          │
│  NIC2(工业网): 连交换机 → 若干台三菱PLC      │
└──────────────┬───────────────────────────┘
               │ MC Protocol (3E/4E帧)
┌──────────────┴───────────────────────────┐
│         若干台三菱 PLC                     │  ← Level 1: 现场设备
│  Q/L/FX/iQ-R 系列                        │
└──────────────────────────────────────────┘
               │ PostgreSQL (TimescaleDB)
┌──────────────┴───────────────────────────┐
│         时序数据存储 + Grafana 可视化       │  ← 数据消费层
│  plc_data_log (raw_value + eng_value)    │
└──────────────────────────────────────────┘
```

### 1.3 技术栈

| 层 | 技术 |
|----|------|
| 后端框架 | FastAPI 0.125 + SQLAlchemy 2.0 (async) + Pydantic v2 |
| 数据库 | MySQL 5.7+（配置）+ PostgreSQL 14+ / TimescaleDB（时序数据） |
| 缓存 | Redis 6+（JWT token、字典、配置缓存） |
| Excel | 纯 openpyxl（零 pandas/numpy 依赖，适配工厂 Windows 环境） |
| 采集引擎 | Node-RED 4.1.11（`D:\nodered` 便携部署） |
| PLC 协议 | MC Protocol (3E/4E帧) via `node-red-contrib-mcprotocol` |
| 前端 | Vue 2.6 + Element UI 2.15 + Axios |
| 路由发现 | `RouterRegister` 自动扫描 `module_*/controller/*.py` |
| 权限 | JWT + `UserInterfaceAuthDependency('module:action:scope')` |
| 审计 | `@Log(title, business_type)` 装饰器 → `sys_oper_log` |

---

## 二、已完成模块

### 2.1 PLC 设备管理 (`module_plc`)

#### 数据库：2 张表

| 表 | 字段数 | 说明 |
|----|--------|------|
| `plc_device` | 27 | 设备主表（含 `host_pc_ip` 标记归属 PC，`backup_pc_ip` 冗余采集） |
| `plc_tag` | 26 | 点位从表（含换算参数 + 死区配置 + 质量码开关） |

两级状态体系：`status`（启停）+ `del_flag`（软删除），全系统零物理 DELETE。

6 个索引覆盖 Node-RED 高频查询（包括覆盖索引 `idx_tag_device_status`）。

#### plc_device 完整字段（27）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGINT PK | 设备ID |
| device_name | VARCHAR(100) NOT NULL | 设备名称 |
| device_code | VARCHAR(50) | 设备编号（如PLC-Q-01） |
| plc_brand | VARCHAR(50) | PLC品牌（Mitsubishi/Siemens/Omron/Keyence） |
| plc_series | VARCHAR(50) | PLC系列（Q/L/FX/iQ-R） |
| com_type | VARCHAR(50) | 通信方式（MC_Protocol/Modbus_TCP/GOT/PLC_RS232C） |
| plc_ip | VARCHAR(50) NOT NULL | PLC IP地址 |
| host_pc_ip | VARCHAR(50) | 主采集PC办公网IP（标记设备归属） |
| backup_pc_ip | VARCHAR(50) | 备采集PC办公网IP（可选，主PC宕机切换） |
| mes_ip | VARCHAR(50) | MES/MDPS对接IP |
| mes_port | INT | MES/MDPS对接端口 |
| plc_port | INT | PLC通信端口（默认5007） |
| mc_frame | VARCHAR(10) | MC协议帧格式（3E/4E） |
| station_no | INT | 站号（0-255） |
| network_no | INT | 网络号（0-255） |
| scan_interval_ms | INT | 采集周期（毫秒，默认1000） |
| comm_timeout_ms | INT | 通信超时（毫秒，默认3000） |
| retry_count | INT | 失败重试次数（默认2） |
| retry_interval_ms | INT | 重试间隔（毫秒，默认500） |
| trigger_kind | INT | 触发方式（0=握手 1=固定周期 2=变化触发） |
| status | CHAR(1) | 状态（0启用 1停用） |
| create_by/create_time | VARCHAR/DATETIME | 创建审计 |
| update_by/update_time | VARCHAR/DATETIME | 更新审计 |
| remark | VARCHAR(500) | 备注 |
| del_flag | CHAR(1) | 删除标志（0正常 2删除） |

#### plc_tag 完整字段（26）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGINT PK | 点位ID |
| device_id | BIGINT FK | 所属设备ID |
| tag_name | VARCHAR(100) NOT NULL | 点位名称 |
| register_type | VARCHAR(10) NOT NULL | 寄存器类型（D/W/X/Y/M） |
| register_address | VARCHAR(50) NOT NULL | 寄存器地址 |
| data_type | VARCHAR(20) NOT NULL | 数据类型（INT16/INT32/FLOAT/BIT） |
| unit | VARCHAR(20) | 寄存器原始单位 |
| description | TEXT | 点位描述 |
| status | CHAR(1) | 状态（0启用 1停用） |
| sort_order | INT | 排序号 |
| **transform_type** | VARCHAR(20) | **换算类型：none/linear/slope_offset** |
| **transform_slope_a** | FLOAT | **斜率/乘数 a（默认1.0）** |
| **transform_offset_b** | FLOAT | **偏移量 b（默认0.0）** |
| **raw_value_min/max** | FLOAT | **原始值有效范围** |
| **eng_value_min/max** | FLOAT | **工程值范围** |
| **eng_unit** | VARCHAR(20) | **工程单位（如℃、MPa）** |
| **report_deadband_ms** | INT | **变化上报死区（ms，默认1000，0=每次上报）** |
| **report_force_interval_ms** | INT | **强制上报间隔（ms，默认5000，值未变也写一条）** |
| **quality_enabled** | CHAR(1) | **是否启用数据质量码（默认1）** |
| create_by/create_time | VARCHAR/DATETIME | 创建审计 |
| update_by/update_time | VARCHAR/DATETIME | 更新审计 |
| del_flag | CHAR(1) | 删除标志（0正常 2删除） |

#### 换算引擎支持三种模式

```
none:         y = raw                                    — 默认，兼容存量
linear:       y = a × x + b                              — 温度÷10 = 0.1×raw+0
slope_offset: y = (raw-rMin)/(rMax-rMin)×(eMax-eMin)+eMin — 4-20mA量程映射
```

换算参数配置在 `plc_tag` 表中，Node-RED 拉取配置后自动执行，数据清洗管道完全通用。

#### 后端文件结构

```
module_plc/
├── controller/
│   ├── device_controller.py    # 9 endpoints
│   └── tag_controller.py       # 12 endpoints
├── service/
│   ├── device_service.py       # 设备 CRUD + 克隆 + 导出 + 唯一性校验
│   └── tag_service.py          # 点位 CRUD + 导入/导出 + 批量更新 + 换算引擎
├── dao/
│   ├── device_dao.py           # ORM 模式（fetch→setattr→flush）+ 批量操作
│   └── tag_dao.py              # 全局查询含换算字段
└── entity/
    ├── do/device_do.py (27字段), tag_do.py (26字段)
    └── vo/device_vo.py, tag_vo.py (含 TagBatchUpdateModel 支持批量设换算)
```

#### API：21 个端点

| 方法 | 路径 | 功能 | 权限码 |
|------|------|------|--------|
| GET | `/plc/device/list` | 分页查询（5条件筛选，含点位数量） | `plc:device:list` |
| GET | `/plc/device/{id}` | 详情（含点位列表） | `plc:device:list` |
| POST | `/plc/device` | 新增（IP/端口/帧格式校验+名称唯一性） | `plc:device:add` |
| PUT | `/plc/device` | 编辑（名称唯一性排除自身） | `plc:device:edit` |
| PUT | `/plc/device/status/{id}` | 启停切换 | `plc:device:edit` |
| PUT | `/plc/device/disable/{ids}` | 批量停用（批量SQL操作） | `plc:device:remove` |
| DELETE | `/plc/device/{ids}` | 软删除（级联点位，批量操作） | `plc:device:remove` |
| POST | `/plc/device/clone/{id}` | 克隆（设备+全部点位） | `plc:device:add` |
| POST | `/plc/device/export` | Excel 导出（21列含备采集PC IP） | `plc:device:list` |
| GET | `/plc/tag/list/{device_id}` | 按设备分页查询 | `plc:tag:list` |
| GET | `/plc/tag/detail/{id}` | 点位详情 | `plc:tag:list` |
| GET | `/plc/tag/global/list` | 跨设备 JOIN 查询（含换算字段） | `plc:tag:list` |
| POST | `/plc/tag` | 新增（含设备存在性+寄存器/数据类型校验） | `plc:tag:add` |
| PUT | `/plc/tag` | 编辑 | `plc:tag:edit` |
| PUT | `/plc/tag/status/{id}` | 启停切换 | `plc:tag:edit` |
| PUT | `/plc/tag/disable/{ids}` | 批量停用 | `plc:tag:remove` |
| DELETE | `/plc/tag/{ids}` | 批量软删除 | `plc:tag:remove` |
| PUT | `/plc/tag/batch` | 批量更新（含换算参数+死区） | `plc:tag:edit` |
| GET | `/plc/tag/template` | 下载导入模板（13列含换算+死区列） | `plc:tag:add` |
| POST | `/plc/tag/import/{device_id}` | 批量导入（Excel/JSON，逐行校验） | `plc:tag:add` |
| POST | `/plc/tag/export` | 点位导出 Excel（含设备名称） | `plc:tag:list` |

#### 前端：2 个页面

| 页面 | 路径 | 功能 |
|------|------|------|
| PLC设备管理 | `/plc/device` | 5条件搜索、14列表格、3Tab编辑弹窗（基本属性/网络配置/采集参数）、克隆弹窗、备采集PC IP、点位管理嵌套弹窗（2Tab：基本信息+换算配置） |
| 数据点表 | `/plc/tag` | 跨设备5条件搜索、批量修改弹窗（含换算参数+死区）、导出按钮、启停开关 |

#### 联动校验

| 校验 | 场景 | 实现 |
|------|------|------|
| 通信方式 ↔ 字段显隐 | RS-232C 自动隐藏 IP/端口字段 | 前端 `v-show` + 动态 `rules` |
| PLC 系列 ↔ 帧格式兼容 | FX 系列禁用 4E 帧 | 前端 `fxFrameDisabled` + 后端 `_validate_series_frame` |
| 寄存器类型 ↔ 数据类型锁定 | X/Y/M 强制 BIT，D/W 可选 INT16/INT32/FLOAT | 前端 `bitOnly` + `onRegisterTypeChange` |
| 设备名称唯一性 | 新增/编辑时检查 | 后端 `get_device_by_name` + `get_device_by_code` |
| IP 格式 | 所有 IP 输入 | 后端 `ipaddress.ip_address()` |

---

### 2.2 采集节点监控中心 (`module_monitor`)

#### 数据库：5 张表

| 表 | 用途 | 特点 |
|----|------|------|
| `nodered_node` | 采集 PC 注册 | `host_pc_ip` 与 `plc_device.host_pc_ip` 对应 |
| `nodered_heartbeat_log` | 心跳日志 | 每30秒一条，MySQL Event 自动清理（7天） |
| `device_comm_status` | PLC 通信状态 | 每 node+device 一对，覆盖更新（UPSERT） |
| `pg_write_status` | PG 写入状态 | 每 node 一条，覆盖更新 |
| `monitor_alert` | 告警 | 3状态（未处理→已确认→已恢复），同类型自动去重 |

#### 三层监控

```
L1: Node-RED 进程级 — 每30秒心跳 → 超60秒 = 离线
L2: PLC 通信级    — 采集时更新 last_success → 超 scan_interval×3+5s = 离线
L3: 数据库写入级   — PG 写入结果上报，失败即告警
```

#### API：7 个端点

| 方法 | 路径 | 调用方 |
|------|------|--------|
| POST | `/monitor/heartbeat` | Node-RED |
| POST | `/monitor/device-comm` | Node-RED |
| POST | `/monitor/pg-write` | Node-RED |
| GET | `/monitor/kpi` | 前端 |
| GET | `/monitor/nodes` | 前端 |
| GET | `/monitor/alerts` | 前端 |
| PUT | `/monitor/alerts/{id}/confirm` | 前端 |

---

### 2.3 PostgreSQL 时序数据存储

#### `plc_data_log` 表（10 字段）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGSERIAL | 自增主键 |
| device_id | BIGINT | plc_device.id |
| tag_id | BIGINT | plc_tag.id |
| node_id | BIGINT | nodered_node.id |
| **raw_value** | DOUBLE | **PLC 原始值（可追溯重算）** |
| **eng_value** | DOUBLE | **换算后工程值（Grafana 直接用）** |
| **quality** | VARCHAR(10) | **GOOD / BAD / UNCERTAIN** |
| **transform_type** | VARCHAR(20) | **采集时换算类型快照（问题追溯）** |
| ts | TIMESTAMPTZ | PC 本地采集时间（非 PLC 时钟） |
| created_at | TIMESTAMPTZ | 入库时间 |

支持 TimescaleDB hypertable（7天 chunk）+ 自动压缩策略。

#### 数据质量码定义

| 质量码 | 含义 | 触发条件 |
|--------|------|----------|
| GOOD | 正常值 | 通信正常，值在量程范围内，换算成功 |
| BAD | 坏数据 | 通信中断，raw_value 为 null/NaN/undefined |
| UNCERTAIN | 暂时不确定 | 值超出量程范围、换算参数缺失、未知换算类型 |

---

### 2.4 Node-RED 采集引擎

#### Flow 节点清单（39 个节点，8 个分组）

| 分组 | 节点 | 说明 |
|------|------|------|
| **连接配置** | MySQLdatabase (`mysql-config`) | MySQL 连接池 |
| | postgreSQL (`pg-config`) | PG 连接池 |
| **启动初始化** | inject (once) + 5 function + 2 mysql | 检测本机 IP → 反查 nodered_node 确认身份 → 初始化状态缓存 |
| **配置刷新** | inject (30s) + 2 function + 1 mysql | SQL 拉取本机设备+点位（含全部换算/死区参数）→ 按设备分组缓存到 flow |
| **采集调度** | inject (1s) + scan-controller | 按设备 scan_interval_ms 独立调度，每 tick 最多 50 条 |
| **数据源** | mock-data-generator | 模拟 PLC 数据（有真实 PLC 后替换为 mc-read） |
| **清洗管道** | transform-engine → deadband-filter → stamp-timestamp | 换算→防抖→时间戳+质量码 |
| **PG 写入** | build-pg-insert → pg-write → check-pg-result → http-pg-report | 参数化 INSERT → 通知监控中心 |
| **监控上报** | inject (30s) → build-heartbeat → http-heartbeat + report-device-comm | 心跳 + 设备通信状态 |
| **HTTP API** | GET /api/plc/status | 返回采集引擎状态 + 点位最后值 |

#### 数据清洗管道逻辑

```
Step5 换算:     raw → eng = f(transformType, a, b, rMin, rMax, eMin, eMax)
Step6 防抖:     值没变 + 未到forceIntervalMs → 丢弃
Step7 时间戳:   ts = new Date().toISOString() (PC本地时钟)
       质量码:   quality = GOOD/BAD/UNCERTAIN
```

#### 部署方式

```powershell
# Windows 便携部署，不依赖 Docker
D:\nodered\node.exe D:\nodered\node_modules\node-red\red.js --userDir D:\nodered\data
```

同一份 flow JSON 部署 20 台 PC，启动时自动识别本机 IP → 反查 nodered_node 确认身份。设备迁移只需改 MySQL 配置，不改 flow。

---

## 三、关键设计决策

| 决策 | 原因 |
|------|------|
| DO 模型无 `relationship()` | 防 `MissingGreenlet`（async session 跨上下文访问关联对象） |
| `commit()` 前保存 ORM 属性 | commit 后 expire 实例，访问属性触发新 SELECT |
| `edit_*_dao` 用 fetch→setattr→flush | 替代裸 dict 拼 SQL，防止 key 拼错静默失败 |
| LIKE 查询用 `.contains()` | 防 f-string SQL 注入 |
| Controller 静态路由在参数化之前 | Starlette 匹配顺序（`/template` 必须在 `/{id}` 之前） |
| 路由注册 `APIRouterPro` + `RouterRegister` | 新增模块无需改 `server.py` |
| 批量操作使用 `sa_update().where(id.in_(list))` | 替代逐条循环，删 10 个设备从 10×SELECT+20×UPDATE 降为 1×SELECT+2×UPDATE |
| `host_pc_ip` 零硬编码网段 | Node-RED 检测本机所有 IP → MySQL 反查 nodered_node 确认身份 |
| 换算参数存在配置表 | Node-RED 拉取后自动执行，清洗管道完全通用 |
| `raw_value` + `eng_value` 双存 | 原始值可追溯重算，公式改错可恢复 |

---

## 四、安全模型

| 层 | 措施 |
|----|------|
| 认证 | JWT token（Redis 存储） |
| 权限 | RBAC 10 权限码，`UserInterfaceAuthDependency` 逐端点校验 |
| 审计 | `@Log(title, business_type)` → `sys_oper_log` |
| SQL 注入 | 设备查询用 `.contains()` 防注入；Node-RED SQL 拼接处加 IP 正则校验 |
| 软删除 | `del_flag` 两级状态，零物理 DELETE，误删可恢复 |

#### 权限码（10 个）

| 权限码 | 控制范围 |
|--------|----------|
| `plc:device:list` | 设备列表/详情/导出 |
| `plc:device:add` | 新增/克隆设备 |
| `plc:device:edit` | 修改/启停设备 |
| `plc:device:remove` | 停用/删除设备 |
| `plc:tag:list` | 点位列表/详情/全局查询/导出 |
| `plc:tag:add` | 新增/导入/模板下载 |
| `plc:tag:edit` | 修改/启停/批量更新 |
| `plc:tag:remove` | 停用/删除点位 |
| `monitor:center:list` | 监控中心查看 |
| `monitor:center:edit` | 确认告警 |

---

## 五、数据流全链路

```
RuoYi Web 页面                 Node-RED 采集引擎              PostgreSQL
─────────────────           ─────────────────────           ───────────
创建设备+点位                   启动 → 检测本机IP
  ↓                              ↓
INSERT plc_device               反查 nodered_node → 存 nodeId
INSERT plc_tag                   ↓
  ↓                           拉 MySQL 配置 (30s一次)
配置完成                         ↓
                          按设备 scan_interval_ms 调度
                              ↓
                           MC Read / Modbus Read / Mock
                              ↓
                           Step5: 数值换算
                           raw × a + b = eng
                              ↓
                           Step6: 防抖去重
                           值没变→丢弃,超时→强制放行
                              ↓
                           Step7: 时间戳+质量码
                           ts=PC时钟, quality=GOOD/BAD/UNCERTAIN
                              ↓                         ↓
                           INSERT plc_data_log ────────→ PG
                              ↓
                           监控上报 /monitor/*
```

---

## 六、代码总量

| 层 | 文件数 | 行数 |
|----|--------|------|
| 后端 PLC 模块 | 10 | ~2,200 |
| 后端监控模块 | 6 | ~900 |
| 后端工具/框架 | ~15 | ~3,000 |
| 前端页面 | 2 | ~1,100 |
| 前端 API | 3 | ~100 |
| 数据库脚本 | 4 | ~450 |
| Node-RED Flow | 1 (JSON) | 39 节点 |
| 文档 | ~5 | ~2,500 |
| **合计** | **~45** | **~10,000** |

---

## 七、数据库完整表清单

| 数据库 | 表名 | 字段数 | 用途 |
|--------|------|--------|------|
| ruoyi (MySQL) | `plc_device` | 27 | PLC 设备台账 |
| | `plc_tag` | 26 | 采集点位（含换算+死区） |
| | `nodered_node` | 11 | 采集节点注册 |
| | `nodered_heartbeat_log` | 6 | 心跳日志 |
| | `device_comm_status` | 9 | PLC 通信实时状态 |
| | `pg_write_status` | 8 | PG 写入实时状态 |
| | `monitor_alert` | 10 | 告警 |
| ruoyi_pg (PG) | `plc_data_log` | 10 | 采集历史（raw+eng 双值） |

---

## 八、初始化脚本

| 脚本 | 数据库 | 功能 |
|------|--------|------|
| `init_plc_db.py` | MySQL | CREATE TABLE plc_device/plc_tag（含全部字段）+ ALTER TABLE 兼容迁移 + 索引 + 菜单+权限 |
| `init_pg_db.py` | PG | CREATE TABLE plc_data_log + 索引 + TimescaleDB hypertable + 压缩策略 |
| `docs/monitor_center.sql` | MySQL | 监控模块 5 张表（SQLAlchemy auto-create 也会建） |

---

## 九、已知限制（当前版本）

| 项目 | 状态 | 计划 |
|------|------|------|
| 仅支持三菱 MC Protocol | 当前版本 | 架构预留了 `com_type` 扩展点 |
| 无数据可视化看板 | 数据在 PG 中 | Phase 2: Grafana 接入 |
| 无阈值告警 | 只有通信层告警 | Phase 3: 值域告警 |
| 无 MC Write（写 PLC） | 只读采集 | Phase 3 |
| 无 OPC UA 协议 | 仅 MC Protocol | 架构可扩展 |
| 无相位采集调度 | 所有设备同时触发 | 当前 50/tick 限流 |
| Node-RED 重启需重新检测 IP | DHCP 变更不自动处理 | 可加定时检测 |
| 设备详情 page_size=9999 硬上限 | 单设备>9999 点位会截断 | 需改为真正的不分页 |

---

## 十、已修复的关键问题（v1.0 → v2.0）

| 问题 | 修复 |
|------|------|
| DAO 裸 dict 拼 SQL | fetch→setattr→flush 模式 |
| `device_code` 筛选被忽略 | DAO WHERE 补条件 |
| f-string LIKE SQL 注入 | 换 `.contains()` |
| 批量操作 N+1 查询 | 改为 `sa_update().where(id.in_(...))` 批量 SQL |
| 点位导出缺失 | 新增 `POST /plc/tag/export` |
| PG INSERT 只入库最后一条 | 改为数组批量输出 |
| PG INSERT SQL 字符串拼接 | 改为 `$1..$8` 参数化 |
| Node-RED 心跳 localhost 硬编码 | 改为 `flow.get("backend_host")` 可配置 |
| `get_tag_global_list` 缺换算字段 | SELECT 补全 6 个新列 |
| `check-pg-result` 错误判断假逻辑 | 改为 `!msg.error && msg.payload !== null` |
| server.py 路由重复注册 | 删除重复 `auto_register_routers()` |
| 设备名称/编号无唯一性校验 | 新增/编辑时检查 |
| 点位表单无换算配置 | 前端新增"换算配置"Tab |
| 导入模板无换算列 | 模板+6列 |

---

## 十一、测评维度

请测评 AI 关注以下维度：

1. **四层架构合理性**：Controller → Service → DAO → Entity 职责边界
2. **配置-采集分离**：RuoYi 管配置、Node-RED 管执行，改配置不需改 flow
3. **多 PC 分布式设计**：`host_pc_ip` 路由 + 零硬编码身份自动发现
4. **软删除+启停两级状态**：`status` + `del_flag` 独立控制，零物理 DELETE
5. **三层监控体系**：心跳(进程) → 通信(链路) → 写入(数据)
6. **告警生命周期**：产生→确认→恢复，同类型自动去重
7. **数据清洗管道**：换算(3模式)→防抖(变化+强制间隔)→时间戳(PC时钟)→质量码(3值)
8. **双值存储模型**：raw_value(可追溯) + eng_value(可直接消费)
9. **ORM 更新模式**：fetch→setattr→flush 替代裸 dict SQL
10. **前端联动校验**：通信方式→字段显隐、系列→帧格式、寄存器→数据类型
11. **安全**：RBAC、审计日志、`.contains()` 防注入、IP 正则校验
12. **工业场景适配**：纯 openpyxl（免 numpy/pandas）、Windows 便携部署、双网卡自动识别
13. **批量操作优化**：从 N+1 查询改为批量 SQL
