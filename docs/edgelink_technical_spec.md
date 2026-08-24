# EdgeLink 边缘智联系统 — 系统技术式样书

> **版本**：v2.2 | **日期**：2026-06-19 | **文档密级**：内部技术资料  
> **目标读者**：开发工程师、测试工程师、系统集成工程师、甲方技术评审  
> **项目路径**：`C:\Users\admin\Desktop\RuoYi-Vue-FastAPI`  
> **后端**：`ruoyi-fastapi-backend`（FastAPI 0.125 + SQLAlchemy 2.0 Async + Pydantic v2）  
> **前端**：`ruoyi-fastapi-frontend`（Vue 2.6 + Element UI 2.15 + Axios + MQTT.js）  
> **采集引擎**：Node-RED 4.1.11（Windows 便携部署）  
> **消息中间件**：EMQX 5.x（MQTT Broker，办公网部署）

---

## 1. 系统总体式样

### 1.1 系统标识

| 编号 | 项目 | 内容 | 备注 |
|------|------|------|------|
| SYS-001 | 系统名称 | EdgeLink 边缘智联系统 | 英文名：EdgeLink Edge Intelligence System |
| SYS-002 | 系统版本 | v2.0 | Phase 1 已完成并投产 |
| SYS-003 | 目标环境 | Windows 10/11 Pro 64-bit（工控机） | 双网口（NIC1 办公网 + NIC2 工业网） |
| SYS-004 | 开发框架 | RuoYi-Vue-FastAPI | 基于 RuoYi-Vue 扩展 |
| SYS-005 | 系统定位 | 工业物联网边缘计算平台 | 替代 Excel VBA 手动采集方案 |
| SYS-006 | 核心价值 | 配置管理 + 数据采集 + 数据清洗 + 运行监控 | 四合一 |

### 1.2 总体架构（四层架构）

```
┌─────────────────────────────────────────────────────────────────┐
│  第4层  配置管理层（RuoYi Web 管理系统）                           │
│  ┌──────────────────────┐  ┌──────────────────────┐              │
│  │  PLC设备管理          │  │  数据点表（跨设备）    │              │
│  │  /plc/device         │  │  /plc/tag            │              │
│  └──────────────────────┘  └──────────────────────┘              │
│  ┌──────────────────────────────────────────────────┐            │
│  │  采集节点监控中心  /plc/monitor                    │            │
│  │  KPI仪表盘 | 节点列表(含PLC子表) | 实时告警        │            │
│  └──────────────────────────────────────────────────┘            │
│  技术栈：Vue 2.6 + Element UI + Axios + ECharts                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ REST API (JWT + RBAC + @Log 审计)
                           │ 自动路由发现 RouterRegister
┌──────────────────────────┴──────────────────────────────────────┐
│  第3层  数据存储层（双数据库架构）                                  │
│  ┌──────────────────────┐  ┌──────────────────────┐              │
│  │  MySQL 5.7+          │  │  PostgreSQL 14+       │              │
│  │  配置库 ruoyi        │  │  时序库 ruoyi_pg       │              │
│  │  ├ plc_device (27字段)│  │  └ plc_data_log (10字段)│            │
│  │  ├ plc_tag (26字段)   │  │     TimescaleDB hypertable│          │
│  │  ├ nodered_node       │  │     7天chunk + 自动压缩  │          │
│  │  ├ device_comm_status │  │     30天自动归档        │            │
│  │  ├ pg_write_status    │  │                          │            │
│  │  └ monitor_alert      │  │                          │            │
│  └──────────────────────┘  └──────────────────────┘              │
│  中间件：Redis 6+（JWT Token缓存 + 字典缓存 + 配置缓存）           │
└──────────────────────────┬──────────────────────────────────────┘
                           │ NIC1 办公网（192.168.x.x）
                           │ 配置拉取 + 心跳上报 + 数据写入
┌──────────────────────────┴──────────────────────────────────────┐
│  第2层  采集引擎层（N × 台双网口采集 PC）                          │
│  ┌──────────────────────────────────────────────────────┐        │
│  │  Node-RED 4.1.11 (D:\nodered\ 便携部署)               │        │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ │        │
│  │  │启动初始化 │ │配置刷新  │ │采集调度  │ │清洗管道  │ │        │
│  │  │IP检测    │ │30s间隔   │ │1s/tick  │ │换算→防抖 │ │        │
│  │  │身份反查  │ │SQL拉取   │ │50条/tick │ │→时间戳   │ │        │
│  │  └──────────┘ └──────────┘ └──────────┘ └─────────┘ │        │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐  │        │
│  │  │PG写入    │ │监控上报  │ │HTTP API              │  │        │
│  │  │$1..$8    │ │心跳+通信 │ │GET /api/plc/status   │  │        │
│  │  │参数化SQL │ │状态上报  │ │采集引擎运行状态       │  │        │
│  │  └──────────┘ └──────────┘ └──────────────────────┘  │        │
│  └──────────────────────────────────────────────────────┘        │
│  39个节点，8个逻辑分组，零硬编码IP，启动时自动身份发现              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ NIC2 工业网（192.168.100.x/24）
                           │ MC Protocol / Modbus TCP
┌──────────────────────────┴──────────────────────────────────────┐
│  第1层  设备层（现场PLC）                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │三菱 Q系列│ │三菱 L系列│ │三菱 FX系列│ │三菱 iQ-R系列     │   │
│  │MC 3E/4E  │ │MC 3E/4E  │ │MC 3E only│ │MC 3E/4E         │   │
│  │Port 5007 │ │Port 5007 │ │Port 5007 │ │Port 5007        │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
│  目标规模：20台 PLC，10000+ 采集点位                               │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 网络拓扑

```
                          ┌──────────────────┐
                          │   办公网交换机     │
                          │  192.168.1.0/24   │
                          └────────┬─────────┘
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
    ┌──────┴──────┐         ┌──────┴──────┐         ┌──────┴──────┐
    │  工程师PC    │         │  RuoYi服务器  │         │  数据库服务器 │
    │  浏览器访问   │         │  FastAPI:9099 │         │ MySQL:3308  │
    │  /plc/*     │         │               │         │ PG:5432    │
    └─────────────┘         └──────────────┘         └─────────────┘
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
    ┌──────┴──────┐         ┌──────┴──────┐         ┌──────┴──────┐
    │ 采集PC #1    │         │ 采集PC #2    │   ...   │ 采集PC #N    │
    │ NIC1: 办公网 │         │ NIC1: 办公网 │         │ NIC1: 办公网 │
    │ NIC2: 工业网 │         │ NIC2: 工业网 │         │ NIC2: 工业网 │
    │ Node-RED     │         │ Node-RED     │         │ Node-RED     │
    └──────┬───────┘         └──────┬───────┘         └──────┬───────┘
           │                       │                       │
           └───────────────────────┼───────────────────────┘
                                   │
                          ┌────────┴─────────┐
                          │   工业网交换机     │
                          │ 192.168.100.0/24  │
                          └────────┬─────────┘
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
    ┌──────┴──────┐         ┌──────┴──────┐         ┌──────┴──────┐
    │  三菱 PLC   │         │  三菱 PLC    │   ...   │  三菱 PLC   │
    │  Q系列      │         │  FX系列      │         │  iQ-R系列   │
    │ 192.168.100 │         │ 192.168.100  │         │ 192.168.100 │
    └─────────────┘         └─────────────┘         └─────────────┘
```

**隔离策略**：
- **NIC1（办公网）**：连接 MySQL、PostgreSQL、RuoYi 后端，用于配置拉取、心跳上报、时序数据写入
- **NIC2（工业网）**：与 PLC 设备直连，通过 MC Protocol/Modbus TCP 进行数据采集
- **双网不互通**：Windows 防火墙禁止双网卡间 IP 转发，工业网不设默认网关，隔离外部攻击面

### 1.4 技术栈清单及版本锁定

| 编号 | 层级 | 技术组件 | 锁定版本 | 选型理由 |
|------|------|----------|----------|----------|
| TECH-001 | 后端框架 | FastAPI | 0.125.x | 异步原生支持、自动 OpenAPI 文档、类型安全 |
| TECH-002 | ORM | SQLAlchemy | 2.0.x (async) | 异步会话管理、声明式映射、批量操作优化 |
| TECH-003 | 数据校验 | Pydantic | v2.x | 类型安全、camelCase 别名生成、from_attributes |
| TECH-004 | 配置库 | MySQL | 5.7+ / 8.0 | RuoYi 标准配置库，InnoDB 引擎 |
| TECH-005 | 时序库 | PostgreSQL | 14+ | TimescaleDB 2.x 扩展，hypertable 自动分区 |
| TECH-006 | 缓存 | Redis | 6+ | JWT Token 缓存、字典缓存、配置热加载 |
| TECH-007 | 采集引擎 | Node-RED | 4.1.11 | 视觉化流程编排、丰富 PLC 协议节点生态 |
| TECH-008 | MC协议 | node-red-contrib-mcprotocol | 最新 stable | 三菱 MC 3E/4E 帧读写支持 |
| TECH-009 | 前端框架 | Vue | 2.6.x | RuoYi 标准前端，Element UI 组件库 |
| TECH-010 | UI组件库 | Element UI | 2.15.x | 成熟稳定的企业级组件库 |
| TECH-011 | Excel处理 | openpyxl | 最新 stable | 纯 Python 实现，免 numpy/pandas 依赖 |
| TECH-012 | 运行环境 | Python | ≥ 3.9 | Windows 便携部署无需编译 |
| TECH-013 | Node.js | Node.js | ≥ 14.x | Node-RED 运行依赖 |
| TECH-014 | MQTT Broker | EMQX | 5.x | 办公网部署，支持 MQTT over TCP + WebSocket，内置 ACL 权限管理 |
| TECH-015 | 前端 MQTT | mqtt.js | 5.x | 浏览器端 MQTT WebSocket 客户端，替代 setInterval 轮询 |

---

## 2. 功能模块式样

### M01 — 设备管理

| 编号 | 项目 | 内容 |
|------|------|------|
| M01-001 | 功能名称 | PLC 设备台账管理 |
| M01-002 | 功能说明 | 对 PLC 设备基础信息进行增删改查，包含通信协议参数、IP/端口、采集周期等配置。支持按名称（模糊）、编号（精确）、IP（精确）、状态、品牌五种条件组合筛选。支持设备克隆（自动生成带时间戳后缀的编号防冲突）和通信方式切换时站号/网络号重置提示。 |
| M01-003 | 输入 | 设备名称（必填）、设备编号（选填）、PLC品牌（必填，默认Mitsubishi）、PLC系列（必填）、通信方式（必填）、PLC_IP（RS-232C时选填）、PLC端口（默认5007）、帧格式、站号(0-255)、网络号(0-255)、采集周期(ms)、通信超时(ms)、重试次数、重试间隔(ms)、触发方式、状态、备注、主采集PC_IP、备采集PC_IP |
| M01-004 | 输出 | 分页设备列表（含点位数量）、单设备详情（含点位列表）、操作结果消息 |
| M01-005 | 处理逻辑 | **新增**：校验IP格式(`ipaddress.ip_address()`) → 校验端口范围(1-65535) → 校验系列与帧格式兼容性(FX禁止4E) → 校验通信方式与IP必填关系(非RS-232C必须有IP) → 设备名称唯一性校验 → 设备编号唯一性校验 → INSERT → 记录操作日志。**编辑**：先查原设备 → 合并新旧值校验最终态 → 名称唯一性排除自身 → fetch ORM对象 → setattr → flush → commit。**软删除**：批量SQL `UPDATE SET del_flag='2'` → 同时级联软删除点位。**停用**：批量SQL `UPDATE SET status='1'` → 解除PLC_OFFLINE告警。 |
| M01-006 | 异常处理 | IP格式错误 → 400；端口越界 → 400；FX+4E冲突 → 400；名称/编号重复 → 400；设备不存在 → 400；数据库异常 → 500+rollback+logger.exception。前端全局.catch()捕获异常，弹窗显示错误消息，防止Promise悬垂致页面卡死。 |
| M01-007 | 验收标准 | (1) 五种筛选条件组合查询均返回正确结果；(2) 名称/编号唯一性校验生效；(3) FX系列4E帧被正确拦截；(4) 删除设备时点位被级联软删除；(5) 批量操作正常（逗号分隔ID）。 |

### M02 — 点位管理

| 编号 | 项目 | 内容 |
|------|------|------|
| M02-001 | 功能名称 | PLC 采集点位管理 |
| M02-002 | 功能说明 | 对每台 PLC 下的采集点位进行增删改查，包含寄存器类型、寄存器地址、数据类型、换算参数（3种模式）、上报死区/强制间隔、质量码开关。支持按设备视图和跨设备全局视图。 |
| M02-003 | 输入 | 所属设备ID（必填）、点位名称（必填）、寄存器类型（必填，D/W/X/Y/M）、寄存器地址（必填）、数据类型（必填，INT16/INT32/FLOAT/BIT）、单位（选填）、描述（选填）、排序号、换算类型(none/linear/slope_offset)、斜率a、偏移b、原始值范围、工程值范围、工程单位、变化死区(ms)、强制间隔(ms)、质量码开关 |
| M02-004 | 输出 | 分页点位列表（含设备名称JOIN）、单点位详情、导入/导出Excel、批量更新结果 |
| M02-005 | 处理逻辑 | **新增**：校验设备存在性 → 寄存器类型枚举校验 → 数据类型枚举校验 → INSERT。**编辑**：fetch→setattr→flush模式。**导入**：纯openpyxl解析(零pandas) → 中英文表头兼容 → 逐行校验(必填字段+枚举值) → 收集全部valid_tags → 调用batch_add_tags()一次多值INSERT批量写入 → 统一commit；全部失败则rollback。**批量更新**：`sa_update().where(id.in_(list)).values(**dict)` 一次性SQL，支持10个字段批量修改（寄存器类型、数据类型、状态、单位、换算类型、斜率、偏移、工程单位、死区、强制间隔）。**跨设备全局查询**：`PlcTag JOIN PlcDevice` LEFT JOIN → 按设备名+排序号+ID排序。 |
| M02-006 | 异常处理 | 设备不存在 → 400；寄存器/数据类型无效 → 400；必填字段缺失 → 400(导入时记录行号+原因)；导入文件解析失败 → 400；数据库异常 → 500+rollback+logger.exception |
| M02-007 | 验收标准 | (1) X/Y/M类型自动锁定BIT数据类型；(2) 导入模板Excel含下拉校验（寄存器类型、数据类型、换算类型）；(3) 导入返回结构化结果{successCount, failCount, errors: [{row, reason}]}，使用批量INSERT高性能写入；(4) 批量更新一次SQL完成，支持10个字段（寄存器类型/数据类型/状态/单位/换算类型/斜率/偏移/工程单位/死区/强制间隔）；(5) 全局查询正确JOIN设备名称。 |

### M03 — 采集引擎

| 编号 | 项目 | 内容 |
|------|------|------|
| M03-001 | 功能名称 | Node-RED 采集引擎 |
| M03-002 | 功能说明 | 部署于每台采集PC的Node-RED实例，负责从MySQL拉取配置、按设备独立采集周期调度PLC通信、执行数据清洗管道、写入PostgreSQL时序库、上报心跳和通信状态至监控中心。 |
| M03-003 | 输入 | MySQL配置（plc_device + plc_tag，每30s刷新）、PLC原始值（MC Protocol Read / Modbus Read） |
| M03-004 | 输出 | 清洗后工程值 → PostgreSQL plc_data_log、心跳 → /monitor/heartbeat、通信状态 → /monitor/device-comm、PG写入结果 → /monitor/pg-write |
| M03-005 | 处理逻辑 | **启动初始化**：检测本机所有IPv4地址 → MySQL反查nodered_node.host_pc_ip确认身份 → 缓存node_id。**配置刷新(30s)**：SQL `JOIN plc_device+plc_tag WHERE status='0' AND del_flag='0'` → 按device分组缓存到flow上下文。**采集调度(1s tick)**：按device.scan_interval_ms独立判断是否触发，每tick最多50条。**清洗管道**：Step5换算(3模式)→Step6防抖(变化间隔+强制间隔)→Step7时间戳(PC本地时钟)+质量码(GOOD/BAD/UNCERTAIN)。**PG写入**：参数化INSERT `$1..$8` 防SQL注入。**监控上报(30s)**：心跳(host_pc_ip+流量+内存) + 通信状态(每设备超时检测阈值=scan_ms×3+5s)。 |
| M03-006 | 异常处理 | 通信失败→重试(retry_count次,间隔retry_interval_ms)→仍失败→标记离线(BAD)+创建PLC_OFFLINE告警；PG写入失败→创建PG_WRITE_LAG告警；断网→本地缓存(【待甲方确认】是否实现)→恢复后补传；Node-RED重启→自动IP检测重新入网 |
| M03-007 | 验收标准 | (1) 启动后自动识别本机身份无需人工配置；(2) 配置变更30s内生效；(3) 通信失败自动重试(次数和间隔可配置)；(4) 断线3倍扫描周期+5s后标记离线；(5) 连续失败3次置为离线状态。 |

### M04 — 数据存储

| 编号 | 项目 | 内容 |
|------|------|------|
| M04-001 | 功能名称 | 时序数据存储 |
| M04-002 | 功能说明 | 将清洗后的采集数据写入PostgreSQL/TimescaleDB，支持raw_value(可追溯)+eng_value(可直接消费)双值存储，按时间自动分区（hypertable），自动压缩和归档。 |
| M04-003 | 输入 | device_id, tag_id, node_id, raw_value(DOUBLE), eng_value(DOUBLE), quality(GOOD/BAD/UNCERTAIN), transform_type(快照), ts(PC本地时钟) |
| M04-004 | 输出 | 从Node-RED到PG的批量写入结果（成功条数、延迟ms） |
| M04-005 | 处理逻辑 | Node-RED累积采集批次 → 参数化INSERT `($1,$2,$3,$4,$5,$6,$7,$8)` 批量执行 → 上报写入结果至/monitor/pg-write。数据库侧：TimescaleDB hypertable按7天chunk分区 → `add_compression_policy` 7天后自动压缩 → `add_retention_policy` 30天自动删除。支持创建物化视图 `plc_data_log_1min` 做一分钟聚合。 |
| M04-006 | 异常处理 | 写入失败→创建PG_WRITE_LAG告警→上报失败详情；数据库连接断开→Node-RED PostgreSQL节点自动重连；磁盘满→【待甲方确认】告警通知 |
| M04-007 | 验收标准 | (1) Tag_id+ts组合查询<500ms；(2) 7天数据自动压缩生效；(3) 30天数据自动归档（或删除）；(4) raw_value和eng_value同时入库；(5) 质量码正确标记。 |

### M05 — 实时监控

| 编号 | 项目 | 内容 |
|------|------|------|
| M05-001 | 功能名称 | 采集节点监控中心 |
| M05-002 | 功能说明 | 前端Web页面展示所有采集节点的运行状态：KPI仪表盘（在线节点数/PLC数/今日采集量/告警数）、节点列表（含下级PLC通信状态展开表）、实时告警列表、告警确认操作。前端每30秒自动刷新。 |
| M05-003 | 输入 | 用户RBAC权限（monitor:center:list / monitor:center:edit） |
| M05-004 | 输出 | KPI卡片(6项指标)、节点列表(每节点含PLC子表)、告警列表(最近20条)、告警确认结果 |
| M05-005 | 处理逻辑 | **v2.2 MQTT 实时模式**：页面 mounted 时 HTTP GET `/monitor/nodes` 一次性获取全量骨架数据 → MQTT WebSocket 连接 EMQX 订阅 `edgelink/heartbeat/+`(实时心跳)、`edgelink/nodes/+/status`(状态变化含Retain)、`edgelink/alarm/node_offline/+`(离线告警) → 收到心跳即更新对应行 lastHeartbeat/runningFlows/memoryUsageMb → 收到离线告警即弹窗+标记红色。**KPI 前端实时计算**：onlineNodes = nodeList.filter(n=>n.isOnline).length，不再轮询 /monitor/kpi。**降级**：MQTT 断开时显示红色横幅，自动重连。**节点列表**：从plc_device.host_pc_ip派生 → 一次批量JOIN查询所有IP的设备通信状态 → 批量加载PgWriteStatus。**告警**：HTTP 拉取最近20条。**离线检测**：MQTT Last Will（秒级）+ APScheduler后台任务（30s）+ 前端断线横幅（UI级）三层兜底。 |
| M05-006 | 异常处理 | 查询超时→500+前端loading释放；节点无心跳→显示"离线"红色标签；节点名缺失→显示空字符串 |
| M05-007 | 验收标准 | (1) KPI数据准确反映当前状态；(2) 展开节点可看到该节点下所有PLC及通信状态；(3) 告警类型与颜色标签正确映射(NODE_OFFLINE=红, PLC_OFFLINE=橙, PG_WRITE_LAG=蓝)；(4) 告警确认后不再显示在未处理列表中。 |

### M06 — 告警管理

| 编号 | 项目 | 内容 |
|------|------|------|
| M06-001 | 功能名称 | 三层监控告警 |
| M06-002 | 功能说明 | L1 进程级（Node-RED心跳超60s → NODE_OFFLINE告警）、L2 链路级（PLC通信失败 → PLC_OFFLINE告警）、L3 数据级（PG写入失败 → PG_WRITE_LAG告警）。告警生命周期：产生(status=0)→确认(status=1)→恢复(status=2)。同类型+同节点+同设备的告警自动去重不重复创建。 |
| M06-003 | 输入 | 心跳上报、PLC通信状态上报、PG写入状态上报 |
| M06-004 | 输出 | MonitorAlert记录（alert_type, severity, node_id, device_id, alert_msg, status, created_at, confirmed_at, resolved_at） |
| M06-005 | 处理逻辑 | **产生**：create_alert() → SELECT检查同类型未处理告警 → 不存在则INSERT(savepoint+唯一约束双重防并发)。**恢复**：resolve_alert() → UPDATE status=2。**确认**：confirm_alert() → UPDATE status=1。**离线检测（v2.2 MQTT）**：三层兜底— ①MQTT Last Will：Node-RED TCP断开后EMQX自动发布 `edgelink/alarm/node_offline/{id}`，前端秒级弹窗；②APScheduler每30s扫描 last_heartbeat>60s 兜底；③前端MQTT断开后红色横幅。HTTP心跳仅负责更新last_heartbeat和消除告警。 |
| M06-006 | 异常处理 | 并发创建相同告警→savepoint捕获IntegrityError→回退查询已有记录（有唯一约束后双重保护）；MQTT断连→前端自动重连（5s间隔）；数据库异常→500+rollback |
| M06-007 | 验收标准 | (1) 同一节点断线15s内前端弹窗告警；(2) 同一节点60s无HTTP心跳只产生1条DB告警；(3) 告警不重复（唯一约束+savepoint）；(4) Node-RED重启后自动恢复在线状态（Retain消息补全）；(5) 前端刷新页面后立即显示正确状态（Retain消息）。 |

### M07 — 系统配置

| 编号 | 项目 | 内容 |
|------|------|------|
| M07-001 | 功能名称 | 用户权限与系统配置 |
| M07-002 | 功能说明 | 复用RuoYi标准RBAC体系：用户→角色→菜单+权限。PLC模块新增10个权限码。操作审计自动记录到sys_oper_log。系统参数通过RuoYi参数管理模块配置。 |
| M07-003 | 输入 | 用户账号、角色分配、权限码、系统参数 |
| M07-004 | 输出 | 权限校验通过/拒绝、操作日志记录 |
| M07-005 | 处理逻辑 | JWT Token认证 → PreAuthDependency 登录校验 → UserInterfaceAuthDependency('module:action:scope') 逐端点权限校验 → @Log(title, business_type) 审计 → sys_oper_log。 |
| M07-006 | 异常处理 | 未登录 → 401；无权限 → 403；Token过期 → 401 + 引导重新登录 |
| M07-007 | 验收标准 | (1) 管理员可分配PLC模块权限；(2) 无权限用户看不到菜单和按钮；(3) 所有增删改操作记录到sys_oper_log；(4) Token过期自动退出。 |

---

## 3. 通信接口式样

### 3.1 PLC 通信接口

#### 3.1.1 MC Protocol 参数（三菱PLC）

| 编号 | 参数名称 | 说明 | 默认值 | 可选值 |
|------|----------|------|--------|--------|
| MC-001 | 帧格式 (mc_frame) | 3E帧 / 4E帧 | 3E | `3E`, `4E`（FX系列禁4E） |
| MC-002 | 站号 (station_no) | PLC站号 | 0 | 0-255 |
| MC-003 | 网络号 (network_no) | 网络编号 | 0 | 0-255 |
| MC-004 | PLC端口 (plc_port) | MC协议通信端口 | 5007 | 1-65535 |
| MC-005 | 通信超时 (comm_timeout_ms) | 单次通信超时 | 3000ms | 100-30000ms |
| MC-006 | 重试次数 (retry_count) | 失败重试 | 2 | 0-10 |
| MC-007 | 重试间隔 (retry_interval_ms) | 重试间隔 | 500ms | 100-10000ms |
| MC-008 | 寄存器类型 | D/W/X/Y/M | — | — |
| MC-009 | 寄存器地址范围 | — | — | D:0-65535, W:0-1FFF(hex), X:0-1FFF(hex), Y:0-1FFF(hex), M:0-8191 |
| MC-010 | 数据类型 | INT16(1字)/INT32(2字)/FLOAT(2字)/BIT(1位) | — | — |

#### 3.1.2 Modbus TCP 参数（预留扩展）

| 编号 | 参数名称 | 说明 | 默认值 | 可选值 |
|------|----------|------|--------|--------|
| MB-001 | 单元ID (unit_id) | Modbus从站地址 | 1 | 0-247 |
| MB-002 | 功能码 | 读取寄存器类型 | 3 | 1(线圈)/2(离散输入)/3(保持寄存器)/4(输入寄存器) |
| MB-003 | 寄存器地址 | Modbus寄存器偏移 | — | 0-65535 |
| MB-004 | PLC端口 | Modbus TCP端口 | 502 | 1-65535 |
| MB-005 | 数据类型 | INT16/INT32/FLOAT | — | 字节序【待甲方确认】（Big-endian/Little-endian） |

### 3.2 数据库接口

#### 3.2.1 MySQL 配置数据库

| 编号 | 数据库 | 表名 | 字段数 | 用途 | 读写频率 |
|------|--------|------|--------|------|----------|
| DB-001 | ruoyi (MySQL) | plc_device | 27 | PLC设备台账 | 读:高频(Node-RED 30s)+前端分页; 写:低频(人工操作) |
| DB-002 | ruoyi (MySQL) | plc_tag | 26 | 采集点位 | 读:高频(Node-RED 30s一次拉全部配置); 写:低频(人工操作) |
| DB-003 | ruoyi (MySQL) | nodered_node | 11 | 采集节点注册 | 读:高频(心跳+节点列表); 写:中频(心跳自动注册) |
| DB-004 | ruoyi (MySQL) | nodered_heartbeat_log | 6 | 心跳日志 | 只写:每30s×N台; 定时清理:每天凌晨3:00删7天前（应用层APScheduler任务 + MySQL Event双保险） |
| DB-005 | ruoyi (MySQL) | device_comm_status | 9 | PLC通信实时状态 | 读写:高频(每次采集循环更新); UK(node_id,device_id) |
| DB-006 | ruoyi (MySQL) | pg_write_status | 8 | PG写入实时状态 | 读写:高频(每次写入循环更新); UK(node_id) |
| DB-007 | ruoyi (MySQL) | monitor_alert | 10 | 告警 | 读写:中频(状态变化时); UK(alert_type, node_id, device_id, status) |

**连接配置**：

```python
# MySQL 异步连接参数
db_type: mysql
db_host: 127.0.0.1  # 【待甲方确认】生产环境IP
db_port: 3308
db_username: root
db_password: 【待甲方确认】
db_database: ruoyi
pool_size: 15
max_overflow: 20
pool_recycle: 1800s
pool_timeout: 30s
pool_pre_ping: true
```

#### 3.2.2 PostgreSQL 时序数据库

| 编号 | 数据库 | 表名 | 字段数 | 用途 | 读写频率 |
|------|--------|------|--------|------|----------|
| DB-008 | ruoyi_pg (PG) | plc_data_log | 10 | 采集历史数据 | 只写:高频(每采集周期写入); 只读:Grafana查询 |

**plc_data_log 表结构**：

```sql
CREATE TABLE plc_data_log (
    id           BIGSERIAL PRIMARY KEY,
    device_id    BIGINT NOT NULL,
    tag_id       BIGINT NOT NULL,
    node_id      BIGINT NOT NULL,
    raw_value    DOUBLE PRECISION,      -- PLC原始值（可追溯重算）
    eng_value    DOUBLE PRECISION,      -- 换算后工程值（直接消费）
    quality      VARCHAR(10) DEFAULT 'GOOD',  -- GOOD/BAD/UNCERTAIN
    transform_type VARCHAR(20),         -- 采集时换算类型快照（问题追溯用）
    ts           TIMESTAMPTZ NOT NULL,  -- PC本地采集时间
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- TimescaleDB hypertable
SELECT create_hypertable('plc_data_log', 'ts', chunk_time_interval => INTERVAL '7 days');

-- 压缩策略：7天后自动压缩
SELECT add_compression_policy('plc_data_log', INTERVAL '7 days');

-- 保留策略：30天后自动删除
SELECT add_retention_policy('plc_data_log', INTERVAL '30 days');

-- 核心索引
CREATE INDEX idx_log_tag_ts ON plc_data_log (tag_id, ts DESC);
CREATE INDEX idx_log_device_ts ON plc_data_log (device_id, ts DESC);
CREATE INDEX idx_log_quality ON plc_data_log (quality, ts DESC);
```

**连接配置**：

```python
# PostgreSQL 异步连接参数
db_type: postgresql
db_host: 127.0.0.1  # 【待甲方确认】生产环境IP
db_port: 5432
db_username: postgres
db_password: 【待甲方确认】
db_database: ruoyi_pg
```

### 3.3 FastAPI 接口清单

#### 3.3.1 设备管理接口（9个端点，前缀 `/dev-api/plc/device`）

| 编号 | 方法 | 路径 | 权限码 | 说明 |
|------|------|------|--------|------|
| API-001 | GET | `/list` | `plc:device:list` | 分页查询设备列表 |
| API-002 | GET | `/{device_id}` | `plc:device:list` | 查询设备详情（含点位列表） |
| API-003 | POST | `` | `plc:device:add` | 新增PLC设备 |
| API-004 | PUT | `` | `plc:device:edit` | 编辑PLC设备 |
| API-005 | PUT | `/status/{device_id}` | `plc:device:edit` | 切换设备启停状态 |
| API-006 | PUT | `/disable/{device_ids}` | `plc:device:remove` | 批量停用设备 |
| API-007 | DELETE | `/{device_ids}` | `plc:device:remove` | 批量软删除设备（级联点位） |
| API-008 | POST | `/clone/{device_id}` | `plc:device:add` | 克隆设备（含全部点位） |
| API-009 | POST | `/export` | `plc:device:list` | 导出设备列表Excel |

**请求/响应示例**：

```http
GET /dev-api/plc/device/list?deviceName=1号炉&status=0&plcBrand=Mitsubishi&pageNum=1&pageSize=10
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

Response 200:
{
  "code": 200,
  "msg": "操作成功",
  "rows": [
    {
      "id": 1,
      "deviceName": "1号炉PLC",
      "deviceCode": "PLC-Q-01",
      "plcBrand": "Mitsubishi",
      "plcSeries": "Q",
      "comType": "MC_Protocol",
      "plcIp": "192.168.100.10",
      "plcPort": 5007,
      "hostPcIp": "192.168.1.10",
      "backupPcIp": null,
      "mesIp": null,
      "mesPort": 0,
      "mcFrame": "3E",
      "stationNo": 0,
      "networkNo": 0,
      "scanIntervalMs": 1000,
      "commTimeoutMs": 3000,
      "retryCount": 2,
      "retryIntervalMs": 500,
      "triggerKind": 0,
      "status": "0",
      "remark": null,
      "tagCount": 156
    }
  ],
  "total": 1,
  "pageNum": 1,
  "pageSize": 10,
  "hasNext": false
}
```

```http
POST /dev-api/plc/device
Content-Type: application/json
Authorization: Bearer eyJ...
X-API-Key: 【未使用（前端接口）】

Request Body:
{
  "deviceName": "1号炉PLC",
  "deviceCode": "PLC-Q-01",
  "plcBrand": "Mitsubishi",
  "plcSeries": "Q",
  "comType": "MC_Protocol",
  "plcIp": "192.168.100.10",
  "hostPcIp": "192.168.1.10",
  "plcPort": 5007,
  "mcFrame": "3E",
  "stationNo": 0,
  "networkNo": 0,
  "scanIntervalMs": 1000,
  "commTimeoutMs": 3000,
  "retryCount": 2,
  "retryIntervalMs": 500,
  "triggerKind": 0,
  "status": "0"
}

Response 200:
{
  "code": 200,
  "msg": "新增成功"
}
```

#### 3.3.2 点位管理接口（12个端点，前缀 `/dev-api/plc/tag`）

| 编号 | 方法 | 路径 | 权限码 | 说明 |
|------|------|------|--------|------|
| API-010 | GET | `/list/{device_id}` | `plc:tag:list` | 按设备分页查询点位 |
| API-011 | GET | `/detail/{tag_id}` | `plc:tag:list` | 查询单点位详情 |
| API-012 | GET | `/global/list` | `plc:tag:list` | 跨设备全局查询（JOIN设备名） |
| API-013 | POST | `` | `plc:tag:add` | 新增点位 |
| API-014 | PUT | `` | `plc:tag:edit` | 编辑点位 |
| API-015 | PUT | `/status/{tag_id}` | `plc:tag:edit` | 切换点位启停 |
| API-016 | PUT | `/disable/{tag_ids}` | `plc:tag:remove` | 批量停用点位 |
| API-017 | DELETE | `/{tag_ids}` | `plc:tag:remove` | 批量软删除点位 |
| API-018 | PUT | `/batch` | `plc:tag:edit` | 批量更新点位字段 |
| API-019 | GET | `/template` | `plc:tag:add` | 下载导入模板Excel |
| API-020 | POST | `/import/{device_id}` | `plc:tag:add` | 批量导入点位 |
| API-021 | POST | `/export` | `plc:tag:list` | 导出点位列表Excel |

**导入请求/响应示例**：

```http
POST /dev-api/plc/tag/import/1
Content-Type: multipart/form-data
Authorization: Bearer eyJ...

Request: file=点位导入表.xlsx

Response 200:
{
  "code": 200,
  "data": {
    "successCount": 48,
    "failCount": 2,
    "errors": [
      { "row": 5, "reason": "必填字段缺失：点位名称" },
      { "row": 23, "reason": "无效的寄存器类型 \"Z\"" }
    ]
  }
}
```

**批量更新请求示例**：

```http
PUT /dev-api/plc/tag/batch
Content-Type: application/json

Request Body:
{
  "ids": "1,3,5,7,9",
  "registerType": "D",
  "dataType": "INT32",
  "unit": "mm",
  "status": "0",
  "transformType": "linear",
  "transformSlopeA": 0.1,
  "transformOffsetB": 0,
  "engUnit": "℃",
  "reportDeadbandMs": 500,
  "reportForceIntervalMs": 10000
}

Response 200:
{
  "code": 200,
  "msg": "成功更新 5 条点位"
}
```

#### 3.3.3 监控中心接口（7个端点，前缀 `/dev-api/monitor`）

| 编号 | 方法 | 路径 | 鉴权方式 | 调用方 | 说明 |
|------|------|------|----------|--------|------|
| API-022 | POST | `/heartbeat` | JWT + X-API-Key | Node-RED | 心跳上报 |
| API-023 | POST | `/device-comm` | JWT + X-API-Key | Node-RED | PLC通信状态上报 |
| API-024 | POST | `/pg-write` | JWT + X-API-Key | Node-RED | PG写入结果上报 |
| API-025 | GET | `/kpi` | JWT + RBAC | 前端 | KPI仪表盘数据 |
| API-026 | GET | `/nodes` | JWT + RBAC | 前端 | 采集节点列表 |
| API-027 | GET | `/alerts` | JWT + RBAC | 前端 | 告警列表 |
| API-028 | PUT | `/alerts/{alert_id}/confirm` | JWT + RBAC | 前端 | 确认告警 |

**Node-RED 心跳上报示例**：

```http
POST /dev-api/monitor/heartbeat?host_pc_ip=192.168.1.10&node_ip=192.168.1.10&running_flows=12&memory_usage_mb=256
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
X-API-Key: ***

Response 200:
{
  "code": 200,
  "msg": "心跳已接收"
}
```

**Node-RED PLC通信状态上报示例**：

```http
POST /dev-api/monitor/device-comm?node_id=1&device_id=5&success=true
Authorization: Bearer eyJ...
X-API-Key: ***

Response 200:
{
  "code": 200,
  "msg": "通信状态已更新"
}
```

**前端 KPI 响应示例**：

```http
GET /dev-api/monitor/kpi
Authorization: Bearer eyJ...

Response 200:
{
  "code": 200,
  "data": {
    "totalNodes": 5,
    "onlineNodes": 4,
    "totalDevices": 20,
    "onlineDevices": 18,
    "todayCollectCount": 1256430,
    "activeAlerts": 3
  }
}
```

**前端节点列表响应示例**：

```http
GET /dev-api/monitor/nodes
Authorization: Bearer eyJ...

Response 200:
{
  "code": 200,
  "data": [
    {
      "id": 1,
      "nodeName": "PC-192.168.1.10",
      "hostPcIp": "192.168.1.10",
      "officeNetIp": "192.168.1.10",
      "isOnline": true,
      "lastHeartbeat": "2026-06-18T14:30:05",
      "deviceCount": 5,
      "onlineDeviceCount": 5,
      "todayCount": 451230,
      "plcList": [
        {
          "deviceName": "1号炉PLC",
          "plcIp": "192.168.100.10",
          "plcPort": 5007,
          "online": true,
          "lastSuccessTime": "2026-06-18T14:30:04",
          "consecutiveFails": 0,
          "errorMsg": ""
        }
      ]
    }
  ]
}
```

### 3.4 MQTT 实时数据通道（v2.2 新增）

#### 3.4.1 架构概述

采用**双通道过渡策略**：MQTT 负责前端实时推送（秒级感知），HTTP 负责后端存库和自动注册（保留存量逻辑）。

```
Node-RED ─┬─ MQTT (edgelink/heartbeat/{id}) ──→ EMQX ──→ 前端 Vue（实时更新）
          │
          └─ HTTP POST /monitor/heartbeat ──→ FastAPI ──→ MySQL（存库）
```

**EMQX Broker**：部署在办公网服务器，同时监听 TCP 1883（Node-RED）和 WebSocket 8083（前端浏览器）。

#### 3.4.2 MQTT Topic 定义

| Topic | 方向 | QoS | Retain | 说明 |
|-------|------|-----|--------|------|
| `edgelink/heartbeat/{node_id}` | Node-RED → 前端 | 1 | false | 30秒周期心跳，瞬态数据 |
| `edgelink/nodes/{node_id}/status` | Node-RED → 前端 | 1 | **true** | 状态变化时发布，Retain 让新订阅者立即知道当前状态 |
| `edgelink/alarm/node_offline/{node_id}` | EMQX Last Will → 前端 | 1 | **true** | Node-RED 连接 EMQX 时设置的遗嘱，断线后 EMQX 自动发布 |

#### 3.4.3 认证与权限

| 账号 | 角色 | 权限 |
|------|------|------|
| `nodered_pub` | Node-RED 发布者 | publish `edgelink/heartbeat/+`, `edgelink/nodes/+/status`, `edgelink/alarm/node_offline/+` |
| `web_sub` | 前端只读订阅者 | subscribe `edgelink/#`，**禁止** publish |

#### 3.4.4 离线检测三层兜底

```
第1层（秒级）：MQTT Last Will → EMQX 自动检测 TCP 断开（Keep Alive 15s） → 发布离线告警
第2层（30s级）：APScheduler 离线检测任务 → 扫描 last_heartbeat > 60s → 标记离线 + 创建告警
第3层（UI级）：前端 MQTT 断开 → 红色横幅"实时连接已断开"→ 自动重连
```

#### 3.4.5 前端数据流

```
mounted()
  ├─ 1. HTTP GET /monitor/nodes（一次性全量，骨架）
  ├─ 2. HTTP GET /monitor/kpi（设备总数+今日采集量基数）
  ├─ 3. mqtt.connect('ws://EMQX:8083/mqtt')
  ├─ 4. subscribe(['edgelink/heartbeat/+', 'edgelink/nodes/+/status', 'edgelink/alarm/node_offline/+'])
  └─ 5. on('message') → 更新表格行 isOnline/lastHeartbeat/runningFlows/memoryUsageMb
      ├─ heartbeat 消息 → 更新心跳时间 + 在线状态 + 运行信息
      ├─ status 消息 → 更新在线/离线颜色（含 Retain 初始状态）
      └─ alarm 消息 → 标记红色 + Notification 弹窗 + 告警音
```

**KPI 改为前端实时计算**：`onlineNodes = nodeList.filter(n => n.isOnline).length`，不再轮询 `/monitor/kpi`。

#### 3.4.6 边界情况

| 场景 | 行为 |
|------|------|
| Node-RED 启动 | 自动识别身份 → 连 EMQX → 发 online Retain → 前端立刻看到绿色 |
| Node-RED 蓝屏/断网 | TCP 异常关闭 → EMQX Keep Alive 15s 超时 → Last Will 触发 → 前端秒级告警 |
| 前端刷新页面 | HTTP GET 全量 → MQTT Retain status 补全当前状态 |
| EMQX 重启 | Node-RED 自动重连 + 前端自动重连 → Retain 消息重新下发 |
| 前端多标签页 | 每个标签页独立 ClientId（含随机后缀），避免互踢 |
| Node-RED node_id 获取失败 | 只发 HTTP 心跳（含自动注册），不发 MQTT 心跳 |

---

### 3.5 Node-RED 与后端数据交互

#### 3.4.1 配置拉取

```sql
-- Node-RED 每30秒执行此SQL拉取本机负责的设备和点位配置
SELECT d.id, d.device_name, d.device_code, d.plc_ip, d.plc_port,
       d.com_type, d.mc_frame, d.station_no, d.network_no,
       d.scan_interval_ms, d.comm_timeout_ms, d.retry_count,
       d.retry_interval_ms, d.trigger_kind,
       t.id AS tag_id, t.tag_name, t.register_type,
       t.register_address, t.data_type, t.unit, t.sort_order,
       t.transform_type, t.transform_slope_a, t.transform_offset_b,
       t.raw_value_min, t.raw_value_max, t.eng_value_min, t.eng_value_max,
       t.eng_unit, t.report_deadband_ms, t.report_force_interval_ms,
       t.quality_enabled
FROM plc_device d
JOIN plc_tag t ON d.id = t.device_id
WHERE d.host_pc_ip = '${本机检测到的办公网IP}'
  AND d.status = '0' AND d.del_flag = '0'
  AND t.status = '0' AND t.del_flag = '0'
ORDER BY d.id, t.sort_order, t.id
```

#### 3.4.2 心跳机制

| 编号 | 项目 | 内容 |
|------|------|------|
| HB-001 | 心跳间隔 | 30秒 |
| HB-002 | 离线判定 | 超60秒无心跳 |
| HB-003 | 上报参数 | host_pc_ip, node_ip, running_flows, memory_usage_mb |
| HB-004 | 自动注册 | 首次心跳自动在nodered_node创建记录 |
| HB-005 | 告警联动 | 心跳到达自动解除NODE_OFFLINE告警 |
| HB-006 | 离线检测 | 三层兜底：①MQTT Last Will（秒级）②APScheduler后台任务30s（分钟级）③前端断线横幅（UI级） |
| HB-007 | 双通道 | MQTT（前端实时推送）+ HTTP POST（后端存库/自动注册），互为保底 |

---

## 4. 数据式样

### 4.1 配置数据库完整表结构（MySQL）

#### 4.1.1 plc_device（设备主表，27字段）

```sql
CREATE TABLE plc_device (
    id               BIGINT PRIMARY KEY AUTO_INCREMENT  COMMENT '设备ID',
    device_name      VARCHAR(100) NOT NULL              COMMENT '设备名称',
    device_code      VARCHAR(50) DEFAULT NULL           COMMENT '设备编号（如PLC-Q-01）',
    plc_brand        VARCHAR(50) NOT NULL DEFAULT 'Mitsubishi' COMMENT 'PLC品牌',
    plc_series       VARCHAR(50) DEFAULT NULL           COMMENT 'PLC系列（Q/L/FX/iQ-R）',
    com_type         VARCHAR(50) DEFAULT NULL           COMMENT '通信方式（MC_Protocol/Modbus_TCP/GOT/PLC_RS232C）',
    plc_ip           VARCHAR(50) DEFAULT NULL           COMMENT 'PLC IP（RS-232C串口通信时可为空）',
    host_pc_ip       VARCHAR(50) DEFAULT NULL           COMMENT '主采集PC办公网IP（标记设备归属）',
    backup_pc_ip     VARCHAR(50) DEFAULT NULL           COMMENT '备采集PC办公网IP（主PC宕机时自动切换）',
    mes_ip           VARCHAR(50) DEFAULT NULL           COMMENT 'MES/MDPS对接IP',
    mes_port         INT NOT NULL DEFAULT 0             COMMENT 'MES/MDPS对接端口',
    plc_port         INT NOT NULL DEFAULT 5007          COMMENT 'PLC端口号',
    mc_frame         VARCHAR(10) DEFAULT NULL           COMMENT 'MC协议帧格式（3E/4E）',
    station_no       INT NOT NULL DEFAULT 0             COMMENT '站号（0-255）',
    network_no       INT NOT NULL DEFAULT 0             COMMENT '网络号（0-255）',
    scan_interval_ms INT NOT NULL DEFAULT 1000          COMMENT '采集周期（毫秒）',
    comm_timeout_ms  INT NOT NULL DEFAULT 3000          COMMENT '通信超时（毫秒）',
    retry_count      INT NOT NULL DEFAULT 2             COMMENT '失败重试次数',
    retry_interval_ms INT NOT NULL DEFAULT 500          COMMENT '重试间隔（毫秒）',
    trigger_kind     INT NOT NULL DEFAULT 0             COMMENT '触发方式（0=握手 1=固定周期 2=变化触发）',
    status           CHAR(1) NOT NULL DEFAULT '0'       COMMENT '状态（0启用 1停用）',
    create_by        VARCHAR(64) DEFAULT NULL           COMMENT '创建者',
    create_time      DATETIME DEFAULT NULL              COMMENT '创建时间',
    update_by        VARCHAR(64) DEFAULT NULL           COMMENT '更新者',
    update_time      DATETIME DEFAULT NULL              COMMENT '更新时间',
    remark           VARCHAR(500) DEFAULT NULL          COMMENT '备注',
    del_flag         CHAR(1) NOT NULL DEFAULT '0'       COMMENT '删除标志（0正常 2删除）',
    INDEX idx_plc_device_del_flag (del_flag),
    INDEX idx_plc_device_status (status),
    INDEX idx_plc_device_host_pc_ip (host_pc_ip),
    INDEX idx_device_status_del (status, del_flag),
    INDEX idx_device_ip (plc_ip),
    INDEX idx_device_brand (plc_brand)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PLC设备表';
```

#### 4.1.2 plc_tag（点位从表，26字段）

```sql
CREATE TABLE plc_tag (
    id                     BIGINT PRIMARY KEY AUTO_INCREMENT  COMMENT '点位ID',
    device_id              BIGINT NOT NULL                   COMMENT '所属设备ID',
    tag_name               VARCHAR(100) NOT NULL             COMMENT '点位名称',
    register_type          VARCHAR(10) NOT NULL              COMMENT '寄存器类型（D/W/X/Y/M）',
    register_address       VARCHAR(50) NOT NULL              COMMENT '寄存器地址',
    data_type              VARCHAR(20) NOT NULL              COMMENT '数据类型（INT16/INT32/FLOAT/BIT）',
    unit                   VARCHAR(20) DEFAULT NULL          COMMENT '单位（寄存器原始单位）',
    description            TEXT DEFAULT NULL                 COMMENT '点位描述',
    status                 CHAR(1) NOT NULL DEFAULT '0'      COMMENT '状态（0启用 1停用）',
    sort_order             INT NOT NULL DEFAULT 0            COMMENT '排序号',
    -- 换算参数
    transform_type         VARCHAR(20) NOT NULL DEFAULT 'none' COMMENT '换算类型：none/linear/slope_offset',
    transform_slope_a      FLOAT NOT NULL DEFAULT 1.0        COMMENT '斜率/乘数 a',
    transform_offset_b     FLOAT NOT NULL DEFAULT 0.0        COMMENT '偏移量 b',
    raw_value_min          FLOAT DEFAULT NULL                COMMENT '原始值有效范围下限',
    raw_value_max          FLOAT DEFAULT NULL                COMMENT '原始值有效范围上限',
    eng_value_min          FLOAT DEFAULT NULL                COMMENT '工程值下限',
    eng_value_max          FLOAT DEFAULT NULL                COMMENT '工程值上限',
    eng_unit               VARCHAR(20) DEFAULT NULL          COMMENT '工程单位（如℃、MPa）',
    -- 上报策略
    report_deadband_ms     INT NOT NULL DEFAULT 1000         COMMENT '变化上报死区（ms），0=每次上报',
    report_force_interval_ms INT NOT NULL DEFAULT 5000       COMMENT '强制上报间隔（ms）',
    quality_enabled        CHAR(1) NOT NULL DEFAULT '1'      COMMENT '是否启用数据质量码（0关闭 1启用）',
    -- 审计字段
    create_by              VARCHAR(64) DEFAULT NULL          COMMENT '创建者',
    create_time            DATETIME DEFAULT NULL             COMMENT '创建时间',
    update_by              VARCHAR(64) DEFAULT NULL          COMMENT '更新者',
    update_time            DATETIME DEFAULT NULL             COMMENT '更新时间',
    del_flag               CHAR(1) NOT NULL DEFAULT '0'      COMMENT '删除标志（0正常 2删除）',
    FOREIGN KEY (device_id) REFERENCES plc_device(id),
    INDEX idx_plc_tag_device_id (device_id),
    INDEX idx_plc_tag_del_flag (del_flag),
    INDEX idx_plc_tag_status (status),
    INDEX idx_tag_device_id (device_id),
    INDEX idx_tag_status_del (status, del_flag),
    INDEX idx_tag_device_status (device_id, status, del_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PLC采集点位表';
```

#### 4.1.3 监控模块表（5张，详见 docs/monitor_center.sql）

| 表名 | 字段数 | 唯一约束 | 说明 |
|------|--------|----------|------|
| `nodered_node` | 11 | `uq_nodered_node_host_pc_ip (host_pc_ip)` | 采集节点注册 |
| `nodered_heartbeat_log` | 6 | — | 心跳日志（7天自动清理） |
| `device_comm_status` | 9 | `uq_device_comm_node_device (node_id, device_id)` | PLC通信实时状态 |
| `pg_write_status` | 8 | `uq_pg_write_status_node_id (node_id)` | PG写入实时状态 |
| `monitor_alert` | 10 | `uk_alert_dedup (alert_type, node_id, device_id, status)` | 告警（数据库唯一约束+savepoint双层防并发重复） |

### 4.2 时序数据库表结构（PostgreSQL）

见 3.2.2 节 `plc_data_log` 建表语句。

### 4.3 数据字典

#### 4.3.1 设备通信方式 (com_type)

| 枚举值 | 含义 | 需要PLC_IP | 需要站号/网络号 | 需要帧格式 |
|--------|------|-----------|----------------|-----------|
| `MC_Protocol` | 三菱MC协议（以太网） | 是 | 是 | 是 |
| `Modbus_TCP` | Modbus TCP协议 | 是 | 否 | 否 |
| `GOT` | 三菱触摸屏透传 | 是 | 是 | 否 |
| `PLC_RS232C` | RS-232C串口直连 | 否 | 否 | 否 |

#### 4.3.2 PLC品牌 (plc_brand)

| 枚举值 | 系列 | 通信协议 |
|--------|------|----------|
| `Mitsubishi` | Q/L/FX/iQ-R | MC Protocol |
| `Siemens` | — | Modbus TCP |
| `Omron` | — | Modbus TCP |
| `Keyence` | — | Modbus TCP |

#### 4.3.3 寄存器类型 (register_type)

| 枚举值 | 名称 | 地址范围 | 支持数据类型 |
|--------|------|----------|-------------|
| `D` | 数据寄存器 | 0-65535 | INT16, INT32, FLOAT |
| `W` | 链接寄存器 | 0-1FFF(hex) | INT16, INT32, FLOAT |
| `X` | 输入继电器 | 0-1FFF(hex) | BIT |
| `Y` | 输出继电器 | 0-1FFF(hex) | BIT |
| `M` | 中间继电器 | 0-8191 | BIT |

#### 4.3.4 数据类型 (data_type)

| 枚举值 | 位宽 | 字节数 | 说明 |
|--------|------|--------|------|
| `INT16` | 16位 | 2字节（1字） | 有符号整数 |
| `INT32` | 32位 | 4字节（2字） | 有符号长整数 |
| `FLOAT` | 32位 | 4字节（2字） | IEEE 754 单精度浮点 |
| `BIT` | 1位 | — | 位状态（仅X/Y/M寄存器） |

#### 4.3.5 换算类型 (transform_type)

| 枚举值 | 公式 | 说明 |
|--------|------|------|
| `none` | y = raw | 不换算，直接存原始值 |
| `linear` | y = a × x + b | 线性换算（如温度÷10 = 0.1×raw+0） |
| `slope_offset` | y = (raw-rMin)/(rMax-rMin) × (eMax-eMin) + eMin | 量程映射（如4-20mA → 0-100℃） |

#### 4.3.6 质量码 (quality)

| 枚举值 | 含义 | 触发条件 |
|--------|------|----------|
| `GOOD` | 正常值 | 通信正常，值在量程范围内，换算成功 |
| `BAD` | 坏数据 | 通信中断，raw_value为null/NaN/undefined |
| `UNCERTAIN` | 暂时不确定 | 值超出量程范围、换算参数缺失、未知换算类型 |

#### 4.3.7 告警类型 (alert_type)

| 枚举值 | 严重级别 | 含义 | 触发条件 |
|--------|----------|------|----------|
| `NODE_OFFLINE` | 2（一般） | 采集节点离线 | 心跳超60s未到达 |
| `PLC_OFFLINE` | 2（一般） | PLC通信失败 | 采集通信连续失败 |
| `PG_WRITE_LAG` | 2（一般） | PG写入异常 | 数据库写入失败 |

#### 4.3.8 告警状态 (alert.status)

| 值 | 含义 | 说明 |
|----|------|------|
| `0` | 未处理 | 新产生，尚未确认 |
| `1` | 已确认 | 操作员已知，但未恢复 |
| `2` | 已恢复 | 故障恢复，告警自动解除 |

#### 4.3.9 设备/点位操作状态

| 字段 | 值 | 含义 | Node-RED行为 | 前端可见 |
|------|-----|------|-------------|---------|
| `status` | `0` | 启用 | 正常采集 | 可见（绿色开关） |
| `status` | `1` | 停用 | 跳过采集 | 可见（灰色开关） |
| `del_flag` | `0` | 正常 | 纳入配置 | 可见 |
| `del_flag` | `2` | 已删除 | 跳过 | 不可见（过滤） |

#### 4.3.10 触发方式 (trigger_kind)

| 值 | 含义 | 说明 |
|----|------|------|
| `0` | 握手触发 | MES/上位机发送指令触发采集 |
| `1` | 固定周期 | 按scan_interval_ms定时采集 |
| `2` | 变化触发 | 值变化时立即采集 |

### 4.4 数据流图（完整流转）

```
┌──────────────────────────────────────────────────────────────────────────┐
│  第1步：RuoYi Web 配置                                                     │
│  工程师 → 浏览器 → Vue页面 → Axios → FastAPI → MySQL                      │
│  INSERT plc_device (设备名称/IP/端口/系列/帧格式/采集周期...)               │
│  INSERT plc_tag    (寄存器类型/地址/数据类型/换算参数/死区...)               │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ 配置写入 MySQL
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  第2步：Node-RED 配置拉取（每30s）                                         │
│  SELECT d.*, t.* FROM plc_device d JOIN plc_tag t                       │
│  WHERE d.host_pc_ip=${本机IP} AND status='0' AND del_flag='0'           │
│  → 按device分组缓存到flow上下文 → 每个scan_interval_ms单独调度              │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ NIC2 工业网
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  第3步：PLC 数据采集                                                       │
│  MC Protocol Read: 帧格式(mc_frame) + 站号(station_no)                    │
│                    + 网络号(network_no) → 寄存器(register_type+address)     │
│  → 返回 raw_value (INT16/INT32/FLOAT/BIT)                                │
│  通信失败 → 重试(retry_count次，间隔retry_interval_ms) → 仍失败 → offline  │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ raw_value
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  第4步：数据清洗管道                                                       │
│  Step5 换算（compute_from_tag / compute_eng_value 双实现）:               │
│    none:         eng = raw                                              │
│    linear:       eng = a × raw + b                                      │
│    slope_offset: eng = (raw-rMin)/(rMax-rMin) × (eMax-eMin) + eMin     │
│    （参数缺失或范围无效时降级为 UNCERTAIN）                                 │
│  Step6 防抖:                                                             │
│    值未变化 AND 距上次上报 < report_force_interval_ms → 丢弃               │
│    值变化超过deadband OR 距上次上报 >= report_force_interval_ms → 放行     │
│  Step7 时间戳 + 质量码:                                                   │
│    ts = new Date().toISOString() (PC本地时钟)                            │
│    quality = 通信正常+值在量程内+换算成功 → GOOD                          │
│            = 通信中断或值null → BAD                                       │
│            = 超出量程或换算参数缺失 → UNCERTAIN                            │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ {device_id, tag_id, node_id, raw_value,
                           │  eng_value, quality, transform_type, ts}
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  第5步：PostgreSQL 写入                                                    │
│  INSERT INTO plc_data_log (device_id, tag_id, node_id, raw_value,         │
│    eng_value, quality, transform_type, ts)                               │
│  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)  -- 参数化SQL防注入             │
│  → TimescaleDB hypertable (7天chunk) → 7天后自动压缩 → 30天后自动归档     │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ 写入结果
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  第6步：监控上报（双通道：MQTT + HTTP）                                      │
│  ┌─ MQTT 通道（前端实时）────────────────────────────────────────────┐      │
│  │  mqtt out: edgelink/heartbeat/{node_id} → EMQX → 前端             │      │
│  │    → 前端更新表格行 lastHeartbeat / isOnline / runningFlows       │      │
│  │  Last Will: edgelink/alarm/node_offline/{node_id}                 │      │
│  │    → Node-RED TCP断开15s后 EMQX自动发布 → 前端秒级弹窗告警         │      │
│  └──────────────────────────────────────────────────────────────────┘      │
│  ┌─ HTTP 通道（后端持久化）─────────────────────────────────────────┐      │
│  │  POST /monitor/heartbeat   → nodered_node.last_heartbeat UPDATE  │      │
│  │    （心跳到达即解除NODE_OFFLINE告警）                              │      │
│  │  POST /monitor/device-comm → device_comm_status UPSERT           │      │
│  │  POST /monitor/pg-write    → pg_write_status UPSERT              │      │
│  └──────────────────────────────────────────────────────────────────┘      │
│  → 离线检测三层兜底：MQTT Last Will(秒级) + APScheduler(30s级) + 前端横幅   │
│  → 告警生命周期：产生(status=0) → 确认(status=1) → 恢复(status=2)         │
│     monitor_alert UNIQUE约束(alert_type,node_id,device_id,status)防重复  │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ HTTP API (NIC1 办公网)
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  第7步：前端展示                                                           │
│  GET /monitor/kpi   → KPI卡片（在线节点/PLC数、今日采集量、告警数）         │
│  GET /monitor/nodes → 节点列表 + 展开PLC子表（通信状态、最后采集时间）       │
│  GET /monitor/alerts → 实时告警列表（类型标签、确认按钮）                    │
│  [Grafana] → PostgreSQL plc_data_log → 趋势图、柱状图、仪表盘              │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 5. 性能式样

| 编号 | 性能指标 | 目标值 | 测试条件 | 备注 |
|------|----------|--------|----------|------|
| PERF-001 | 最小采集周期 | 100ms | 单设备、单点位 | FX系列建议≥200ms |
| PERF-002 | 默认采集周期 | 1000ms | — | 可配置 |
| PERF-003 | 单Node-RED实例支持PLC数 | 20台 | 每台20-200点位 | 已经过代码审查验证 |
| PERF-004 | 单Node-RED实例支持点位总数 | 10000+ | 20台×500点 | 每tick限流50条（**全局**），当前上限~50点/秒；需MC批量读取+PG批量写入才能突破 |
| PERF-005 | 配置刷新生效延迟 | <30s | Node-RED配置刷新间隔 | 改配置→下次刷新立即生效 |
| PERF-006 | 前端列表查询响应时间 | <2s | 20台设备、10000点位分页 | MySQL COUNT+分页+LIMIT |
| PERF-007 | 告警延迟（MQTT Last Will） | <15s | Keep Alive 15s + Last Will | MQTT通道秒级感知断开 |
| PERF-007a | 告警延迟（APScheduler兜底） | <60s | 定时扫描间隔30s + 60s心跳超时窗口 | 兜底Last Will未触发的极端情况 |
| PERF-016 | 前端状态更新延迟 | <1s | MQTT消息推送 | 替代原来30s轮询，实时感知识别 |
| PERF-008 | 数据压缩启动 | 7天后 | TimescaleDB自动压缩策略 | 压缩比约10:1 |
| PERF-009 | 数据保留期限 | 30天 | 自动归档/删除 | 可调整retention_policy |
| PERF-010 | 数据库连接池 | MySQL:15+20, PG:类似 | Windows工控机 | 避免端口耗尽 |
| PERF-011 | 并发用户数 | 10+ | 同时操作Web管理后台 | — |
| PERF-012 | PG写入吞吐量 | ~50点/秒（当前） | Node-RED 单条INSERT `$1..$8` | ⚠️ 10000点/秒需改造为批量COPY或多值INSERT + MC批量字读取 |
| PERF-013 | 点位批量导入 | ≥500条/秒 | 多值INSERT替代逐条add | 导入1000+点位性能提升5-10倍 ✅ 已实现 |
| PERF-014 | Excel导出 | 分页流式写入 | openpyxl write_only=True + 每批500条 | 设备/点位过万时避免OOM ✅ 已实现 |
| PERF-015 | 节点列表查询 | 1次批量JOIN | get_devices_grouped_by_host_ip() | 消除N×按IP查询的N+1问题 ✅ 已实现 |

---

## 6. 安全与可靠性式样

### 6.1 网络安全

| 编号 | 安全措施 | 实现方式 | 备注 |
|------|----------|----------|------|
| SEC-001 | 双网口物理隔离 | NIC1办公网 + NIC2工业网，Windows防火墙禁止IP转发 | 工业网不设默认网关 |
| SEC-002 | 应用层认证 | JWT Token（HS256，1440分钟过期，Redis缓存） | 所有前端API需携带Bearer Token |
| SEC-003 | Node-RED上报鉴权 | JWT + X-API-Key Header双重验证 | API Key通过.env配置，⚠️ 当前全节点共享同一Key，建议增加定期轮换机制 |
| SEC-004 | RBAC权限控制 | 10个PLC权限码 + RuoYi标准权限体系 | UserInterfaceAuthDependency逐端点校验 |
| SEC-005 | 操作审计 | @Log装饰器 → sys_oper_log（操作人/IP/参数/响应/耗时） | 所有增删改操作全量记录 |
| SEC-010 | 工业网访问控制 | ⚠️ **规划实现**：交换机MAC白名单 + 端口安全 + VLAN隔离 | 当前仅物理隔离，未做二层防护 |
| SEC-011 | Node-RED管理界面认证 | ⚠️ **规划实现**：配置adminAuth（用户名+密码）或防火墙IP白名单 | 当前1880端口无认证，内网任意终端可修改flow |
| SEC-012 | MC协议安全 | ⚠️ 3E/4E帧为明文协议 | 物理隔离为第一道防线；可启用PLC remote_password做第二道防线 |

### 6.2 数据安全

| 编号 | 安全措施 | 实现方式 | 备注 |
|------|----------|----------|------|
| SEC-006 | SQL注入防护 | SQLAlchemy参数化查询 + `.contains()`防f-string注入 | Node-RED侧使用`$1..$8`参数化 |
| SEC-007 | 软删除机制 | `del_flag`（0=正常，2=删除），零物理DELETE | 误删可通过改回del_flag='0'恢复 |
| SEC-008 | 数据库连接加密 | ⚠️ **规划实现**：MySQL/PostgreSQL SSL/TLS | 即使工控内网，建议启用（MySQL: `ssl-ca=/path/ca.pem`，PG: `sslmode=require`）；当前连接字符串未配置SSL参数 |
| SEC-009 | 数据备份 | MySQL每日全量备份(mysqldump) + PostgreSQL连续归档(WAL) | 【待甲方确认】备份策略 |

### 6.3 可靠性

| 编号 | 可靠性措施 | 实现方式 | 备注 |
|------|-----------|----------|------|
| REL-001 | 断线重连 | Node-RED: retry_count次重试，间隔retry_interval_ms | 可配置 |
| REL-002 | 断线缓存 | 【待甲方确认】Node-RED本地文件缓存，恢复后补传 | Phase 2 实现 |
| REL-003 | 主备PC切换 | plc_device.backup_pc_ip标记备采集PC | ⚠️ **规划实现**：Node-RED侧尚无心跳仲裁、设备漂移、双主防冲突逻辑 |
| REL-004 | 数据库连接池预检 | pool_pre_ping=true，取出连接前SELECT 1 | 防止使用MySQL已关闭的僵死连接 |
| REL-005 | 请求去重 | Axios CancelToken，同URL+方法+参数只保留最新请求 | 防止页面频繁切换导致超时 |
| REL-006 | 事务安全 | 所有upsert使用savepoint隔离，防止并发冲突回滚外层事务 | monitor_dao.py savepoint模式 |
| REL-007 | 并发去重 | monitor_alert表UNIQUE约束(alert_type, node_id, device_id, status) 防并发重复告警 | savepoint + IntegrityError双重保护 |
| REL-008 | 数据生命周期 | 心跳日志定时清理任务（APScheduler每天凌晨3:00 + MySQL Event双保险） | 保留7天，防止1亿+条数据膨胀 |
| REL-009 | 后台任务解耦 | 离线检测从心跳接口剥离为独立APScheduler任务，心跳不再触发全表扫描 | 避免N×2次/分钟的全表扫描 |
| REL-010 | MQTT双通道保底 | Node-RED同时发送MQTT+HTTP心跳，MQTT断开时HTTP通道继续存库 | 单通道故障不影响后端数据完整性 |
| REL-011 | MQTT自动重连 | Node-RED mqtt out 节点自动重连 + 前端 mqtt.js reconnectPeriod=5s | 网络抖动后自动恢复，无需人工干预 |
| REL-012 | 异常恢复 | try/except+rollback+logger.exception，保留完整traceback | bare `raise`不丢失调用栈 |

---

## 7. 部署与运维式样

### 7.1 硬件配置要求

| 编号 | 设备类型 | CPU | 内存 | 硬盘 | 网口 |
|------|----------|-----|------|------|------|
| HW-001 | RuoYi服务器 | Intel i5 8代+ | ≥16GB | SSD 256GB+ | 1×千兆（办公网） |
| HW-002 | 数据库服务器 | Intel i5 8代+ | ≥16GB | SSD 512GB+（MySQL）+ HDD 1TB+（PG时序） | 1×千兆（办公网） |
| HW-003 | 采集工控机 | Intel i3 8代+ | ≥8GB | SSD 128GB+ | 2×千兆（NIC1办公网 + NIC2工业网） |
| HW-004 | 工业交换机 | 千兆非网管型 | — | — | 端口数≥PLC数 |

### 7.2 软件安装清单

| 编号 | 软件 | 版本 | 安装位置 | 备注 |
|------|------|------|----------|------|
| SW-001 | Windows OS | 10/11 Pro 64-bit | 全部PC | 关闭自动更新（通过组策略） |
| SW-002 | Python | 3.9+ | RuoYi服务器 | python.org下载，勾选"Add to PATH" |
| SW-003 | Node.js | 14.x LTS | 采集工控机 | nodejs.org下载 |
| SW-004 | Node-RED | 4.1.11 | 采集工控机 `D:\nodered\` | `npm install -g node-red` |
| SW-005 | node-red-contrib-mcprotocol | latest | 采集工控机 | `npm install node-red-contrib-mcprotocol` |
| SW-006 | MySQL | 5.7+ / 8.0 | 数据库服务器 | 端口3308，字符集utf8mb4 |
| SW-007 | PostgreSQL | 14+ | 数据库服务器 | 端口5432，安装TimescaleDB 2.x扩展 |
| SW-008 | Redis | 6+ | RuoYi服务器 | 端口6379 |
| SW-009 | Nginx | 1.20+ | RuoYi服务器（可选） | 前端静态文件 + API反向代理 |

### 7.3 部署步骤

| 编号 | 步骤 | 操作 | 验证方法 |
|------|------|------|----------|
| DEP-001 | 1. 数据库初始化 | 执行`init_plc_db.py`创建MySQL表结构（plc_device, plc_tag, 监控表）| `SHOW TABLES LIKE 'plc%'` |
| DEP-002 | 2. 时序库初始化 | 执行`init_pg_db.py`创建PostgreSQL表结构（plc_data_log + TimescaleDB hypertable）| `\dt plc_data_log` |
| DEP-003 | 3. 菜单与权限初始化 | 执行`docs/edgelink_menu_init.sql`插入RuoYi菜单项，或运行`init_plc_db.py`自动处理 | RuoYi后台→系统管理→菜单管理确认 |
| DEP-004 | 4. 后端部署 | `pip install -r requirements.txt` → 配置`.env.dev`（数据库连接、API Key）→ `python server.py` | 浏览器访问 `http://IP:9099/docs` |
| DEP-005 | 5. 前端部署 | `npm install` → `npm run build:prod` → 复制`dist/`到Nginx目录 | 浏览器访问 `http://IP/` |
| DEP-006 | 6. Node-RED部署 | 复制`nodered_plc_full_flow.json` → 修改`backend_host`为RuoYi服务器IP → 导入Flow | `http://采集PC_IP:1880` |
| DEP-007 | 7. Node-RED启动 | `D:\nodered\node.exe D:\nodered\node_modules\node-red\red.js --userDir D:\nodered\data` | 检查调试面板无错误，心跳日志有响应 |
| DEP-008 | 8. 联调验证 | 在RuoYi前端创建1台测试设备+5个点位 → 等待30s → 检查监控中心是否看到节点上线 | KPI卡片显示节点/设备数 |

### 7.4 日常巡检Checklist

| 编号 | 巡检项 | 频率 | 正常标准 | 异常处理 |
|------|--------|------|----------|----------|
| CHK-001 | 监控中心KPI | 每日 | 在线节点数=采集PC数，告警数=0 | 展开离线节点查看具体离线原因 |
| CHK-002 | MySQL连接池 | 每周 | `SHOW PROCESSLIST` 无大量Sleep连接 | 检查pool_recycle设置 |
| CHK-003 | PostgreSQL磁盘空间 | 每周 | 使用率<80% | 检查压缩策略，调整retention |
| CHK-004 | 采集PC内存 | 每周 | Node-RED进程<2GB | 重启Node-RED进程 |
| CHK-005 | 心跳日志清理 | 每月 | 确认APScheduler任务+MySQL Event均正常执行 | 检查应用日志"清理了"输出 + `SHOW EVENTS` |
| CHK-006 | 操作日志审计 | 每月 | 无异常删除/修改操作 | 检查sys_oper_log |
| CHK-007 | PLC通信成功率 | 实时 | 成功率>99% | 检查网络、PLC状态 |

### 7.5 故障排查手册

| 编号 | 故障现象 | 可能原因 | 排查步骤 | 解决方法 |
|------|----------|----------|----------|----------|
| TBL-001 | 监控中心节点离线 | Node-RED进程崩溃/网络断开 | 1. 登录采集PC检查Node-RED进程 2. ping RuoYi服务器 3. 检查Node-RED调试面板 | 重启Node-RED；检查防火墙；检查API Key |
| TBL-002 | 数据库连接超时 | MySQL连接池耗尽/网络抖动 | 1. `SHOW PROCESSLIST` 2. 检查pool_size配置 3. ping数据库服务器 | 增大pool_size；开启pool_pre_ping |
| TBL-003 | 采集数据缺失 | PLC通信失败/点位被停用 | 1. 检查monitor_alert表PLC_OFFLINE告警 2. 检查plc_tag.status 3. ping PLC IP | 检查网线/交换机/PLC运行状态 |
| TBL-004 | 前端页面空白 | Token过期/权限不足 | 1. 浏览器F12看Network报错 2. 清除Cookie重新登录 | 重新登录；检查用户角色权限 |
| TBL-005 | 导入失败 | Excel格式错误/必填字段缺失 | 1. 检查返回的errors明细 2. 下载标准模板对比 | 修正Excel格式后重新导入 |
| TBL-006 | PG写入失败 | PostgreSQL连接断开/磁盘满 | 1. 检查PostgreSQL服务状态 2. `df -h` 检查磁盘 3. 检查pg_hba.conf | 重启PG服务；清理磁盘；调整retention |
| TBL-007 | 今日采集量为0 | 跨天计数器未清零/Node-RED未上报 | 1. 检查监控中心KPI 2. 检查pg_write_status.last_write_time | 等待下次写入自动更新；检查PG连接 |
| TBL-008 | Node-RED CPU飙高 | 死循环flow / 内存泄漏 / tick过短 | 1. 任务管理器确认Node-RED进程CPU 2. 检查flow中是否有未加delay的循环 3. 检查scan_interval_ms是否过小（建议>=200ms FX系列） | 重启Node-RED；增大scan_interval_ms；增加tick间delay节点 |
| TBL-009 | PG查询缓慢 | hypertable chunk过多 / 缺少索引 / 连接池耗尽 | 1. PG: `SELECT * FROM timescaledb_information.chunks WHERE hypertable_name='plc_data_log'` 2. `EXPLAIN ANALYZE` 慢查询 3. 检查pg_stat_activity连接数 | 手动rechunk；创建缺失索引；增大PG连接池 |
| TBL-010 | 工业网IP冲突 | 新PLC接入时与现有设备IP重复 | 1. 检查PLC面板确认IP 2. 在采集PC上arp -a查看MAC 3. 断网后ping确认唯一性 | 重新规划工业网IP分配表；交换机端口绑定IP+MAC |
| TBL-011 | 告警风暴（同一节点多条重复告警） | monitor_alert唯一约束未建（旧版本） | 1. `SELECT alert_type, COUNT(*) FROM monitor_alert WHERE status=0 GROUP BY alert_type, node_id, device_id` | 升级至v2.1（已加唯一约束+savepoint双重保护） |
| TBL-012 | Redis连接失败 | Redis服务未启动 / 内存满 / 网络断开 | 1. `redis-cli PING` 2. 检查Redis内存使用 3. 检查Redis绑定IP | 重启Redis；清空过期缓存；检查requirepass密码 |
| TBL-013 | Windows防火墙误拦截 | 防火墙规则阻止NIC1→NIC2通信或反向流量 | 1. 临时关闭防火墙测试 2. 检查入站规则是否允许MySQL:3308/PG:5432/Redis:6379/API:9099 | 添加精确的端口级入站规则，保留双网卡IP转发禁用 |
| TBL-014 | TimescaleDB压缩策略失败 | 磁盘空间不足 / 权限不足 / PG版本不兼容 | 1. `SELECT * FROM timescaledb_information.jobs WHERE job_name LIKE '%compression%'` 检查job状态 2. `df -h` 检查磁盘 | 手动 `SELECT compress_chunk(chunk_name)`；清理磁盘；检查pg日志 |

**⚠️ 主备切换（REL-003）当前未实现**：backup_pc_ip 仅为标记字段。部署前需确认——是否在本次交付中实现自动故障切换，还是将此功能排入后续版本。
---

## 8. 验收式样

### 8.1 单元测试验收标准

| 编号 | 测试项 | 测试方法 | 合格标准 |
|------|--------|----------|----------|
| UT-001 | 设备新增→查询→编辑→删除 全流程 | pytest async测试 + 测试数据库 | 4步均返回`code:200`，删除后查询返回空 |
| UT-002 | 设备名称唯一性 | 新增同名设备 | 返回400，message包含"已存在" |
| UT-003 | FX系列+4E帧拦截 | 创建FX系列设备选4E帧 | 前后端双重拦截 |
| UT-004 | 点位寄存器类型校验 | 传入`registerType: "Z"` | 返回400，message包含"无效的寄存器类型" |
| UT-005 | 点位导入解析 | 上传含50条点位+3条错误的Excel | 返回`successCount:47, failCount:3, errors`含行号和原因 |
| UT-006 | 换算引擎 linear | compute_eng_value(100, linear, a=0.1, b=0) | 返回(10.0, 'GOOD') |
| UT-007 | 换算引擎量程校验 | compute_eng_value(999, ..., raw_min=0, raw_max=100) | 返回(None, 'UNCERTAIN') |
| UT-007a | 换算引擎 slope_offset | compute_from_tag(12, 'slope_offset', raw_value_min=4, raw_value_max=20, eng_value_min=0, eng_value_max=100) | 返回(50.0, 'GOOD')，4-20mA量程12mA→50% |
| UT-007b | 换算引擎 slope_offset缺参 | compute_from_tag(12, 'slope_offset') | 返回(12, 'UNCERTAIN')，参数缺失降级 |
| UT-008 | 软删除级联 | 删除设备(device_id=1) | plc_device.del_flag='2' AND plc_tag.del_flag='2'(WHERE device_id=1) |
| UT-009 | savepoint事务隔离 | 并发upsert同一条device_comm_status | 两次调用均成功，无数据丢失 |
| UT-010 | KPI日期过滤 | today_write_count含有昨日数据，last_write_time为昨天 | 昨日数据不被计入today_collect_count |

### 8.2 集成测试验收标准

| 编号 | 测试场景 | 测试条件 | 合格标准 |
|------|----------|----------|----------|
| IT-001 | 20台PLC同时在线采集 | 在RuoYi配置20台设备，每台50-200点位，部署到2台采集PC | 全部设备status=0，监控中心显示20在线 |
| IT-002 | 72小时连续运行无丢数 | 持续运行72小时，每5分钟记录采集量 | 采集量波动<5%，无连续1分钟以上的数据缺失 |
| IT-003 | 配置热更新 | 修改某设备采集周期从1000ms→500ms | Node-RED 30s内生效，实际采集间隔变为~500ms |
| IT-004 | 断网恢复 | 拔掉采集PC工业网网线30s后插回 | 30s内标记PLC离线并创建告警，插回后60s内恢复在线并解除告警 |
| IT-005 | Node-RED重启恢复 | 杀掉Node-RED进程，1分钟后重启 | 重启后自动识别身份，60s内恢复采集 |
| IT-006 | 批量操作稳定性 | 同时勾选100个点位执行批量删除 | 1次SQL完成，<=2s返回结果 |
| IT-007 | 服务器重启恢复 | 重启RuoYi服务器 | 服务启动后前端可访问，采集不受影响（Node-RED独立运行） |
| IT-008 | Excel导入大文件 | 上传含2000条点位的Excel | 逐行校验完毕，返回结构化结果，内存<500MB |

### 8.3 用户验收测试（UAT）场景清单

| 编号 | UAT场景 | 角色 | 操作步骤 | 预期结果 |
|------|---------|------|----------|----------|
| UAT-001 | 新设备入网 | 管理员 | 创建新PLC设备 → 填名称 + IP + 通信参数 → 新增20个点位 → 等待30s | 监控中心看到新设备上线并开始采集 |
| UAT-002 | 设备停用/启用 | 管理员 | 停用某台设备 → 观察采集是否停止 → 重新启用 | 停用后device_comm_status不变(保留数据)，启用后恢复采集 |
| UAT-003 | 批量导入点位 | 操作员 | 下载模板 → 在Excel中填写100个点位 → 上传导入 | 导入结果弹窗显示成功/失败明细 |
| UAT-004 | 批量修改点位 | 操作员 | 跨设备页面勾选30个点位 → 批量修改数据类型为FLOAT | 30条全部更新成功 |
| UAT-005 | 克隆设备 | 管理员 | 选源设备 → 填新名称+新IP → 克隆 | 新设备含全部点位，名称/编号不冲突 |
| UAT-006 | 导出设备列表 | 管理员 | 筛选条件 → 点击导出 | 下载Excel含21列数据 |
| UAT-007 | 告警确认 | 管理员 | 监控中心看到红色告警 → 点击确认 | 告警变为"已确认"状态，从"未处理"列表移除 |
| UAT-008 | 权限验证 | 访客 | 访客账号登录，尝试删除设备 | 删除按钮不可见，API返回403 |
| UAT-009 | 操作审计 | 管理员 | 新增/修改/删除各操作1次 | sys_oper_log中查到对应记录，含操作人+IP+时间 |
| UAT-010 | 系统长期运行 | 管理员 | 观察系统运行1周 | KPI数据趋势正常，无告警风暴，无内存泄漏 |

---

## 附录A：权限码完整清单

| 编号 | 权限码 | 控制范围 | 所属菜单 |
|------|--------|----------|----------|
| PRM-001 | `plc:device:list` | 设备列表/详情/导出 | PLC设备管理 |
| PRM-002 | `plc:device:add` | 新增设备/克隆设备 | PLC设备管理 |
| PRM-003 | `plc:device:edit` | 修改设备/启停切换 | PLC设备管理 |
| PRM-004 | `plc:device:remove` | 停用设备/删除设备 | PLC设备管理 |
| PRM-005 | `plc:tag:list` | 点位列表/详情/全局查询/导出 | 数据点表 |
| PRM-006 | `plc:tag:add` | 新增点位/下载模板/导入 | 数据点表 |
| PRM-007 | `plc:tag:edit` | 修改点位/启停切换/批量更新 | 数据点表 |
| PRM-008 | `plc:tag:remove` | 停用点位/删除点位 | 数据点表 |
| PRM-009 | `monitor:center:list` | 监控中心查看 | 采集节点监控 |
| PRM-010 | `monitor:center:edit` | 确认告警 | 采集节点监控 |

---

## 附录B：环境变量配置清单

| 编号 | 变量名 | 说明 | 默认值 | 生产环境 |
|------|--------|------|--------|----------|
| ENV-001 | `APP_ENV` | 运行环境 | `dev` | `production` |
| ENV-002 | `APP_ROOT_PATH` | API前缀 | `/dev-api` | `/api` |
| ENV-003 | `APP_PORT` | 服务端口 | `9099` | 【待甲方确认】 |
| ENV-004 | `DB_TYPE` | 配置库类型 | `mysql` | `mysql` |
| ENV-005 | `DB_HOST` | 配置库主机 | `127.0.0.1` | 【待甲方确认】 |
| ENV-006 | `DB_PORT` | 配置库端口 | `3308` | 【待甲方确认】 |
| ENV-007 | `DB_PASSWORD` | 配置库密码 | `<强随机>` | 【待甲方确认，需改】 |
| ENV-008 | `JWT_SECRET_KEY` | JWT密钥 | — | 【待甲方确认，需改】 |
| ENV-009 | `MONITOR_API_KEY` | 监控上报API Key | `***` | 【待甲方确认，需改】 |
| ENV-010 | `DB_POOL_SIZE` | 连接池大小 | `15` | 按需调整 |
| ENV-011 | `DB_POOL_TIMEOUT` | 连接等待超时(s) | `30` | 按需调整 |

---

## 附录C：文档修订记录

| 版本 | 日期 | 修订内容 | 代码验证 | 修订人 |
|------|------|----------|----------|--------|
| v1.0 | 2026-06-10 | 初始版本（基于Phase 1完成状态） | — | — |
| v2.0 | 2026-06-18 | 代码审查修复后更新：新增savepoint事务隔离、API Key鉴权、KPI日期过滤、前端错误处理、批量查询优化 | — | EdgeLink开发团队 |
| v2.1 | 2026-06-18 | 代码审查18项修复（详见下方明细），标✅的已落地代码 | 见【验证状态】列 | EdgeLink开发团队 |
| v2.2 | 2026-06-19 | MQTT心跳改造：①双通道过渡（MQTT前端实时+HTTP后端存库）②EMQX Broker部署+ACL权限 ③前端mqttClient.js封装+mounted订阅替代setInterval轮询 ④Node-RED启动初始化+Last Will遗嘱+Retain状态消息 ⑤APScheduler离线检测三层兜底 ⑥告警延迟从30s降至15s ⑦KPI改为前端实时计算 | ✅ 代码已落地 | EdgeLink开发团队 |

### v2.1 修复明细及验证状态

| # | 修复项 | 涉及文件 | 验证状态 |
|---|--------|---------|----------|
| ① | MonitorAlert唯一约束(防并发重复告警) | `monitor_do.py`, `monitor_dao.py`, `monitor_center.sql` | ✅ 代码已落地 |
| ② | 离线检测剥离为独立后台任务 | `monitor_service.py`, `module_task/monitor_task.py`, `get_scheduler.py` | ✅ 代码已落地 |
| ③ | 心跳日志定时清理 | `monitor_dao.py`, `module_task/monitor_task.py` | ✅ 代码已落地 |
| ④ | VO层字段默认值补全 | `device_vo.py`, `tag_vo.py` | ✅ 代码已落地 |
| ⑤ | 批量导入改为多值INSERT | `tag_dao.py`, `tag_service.py` | ✅ 代码已落地 |
| ⑥ | 前端批量修改补全10字段 | `tag/index.vue` | ✅ 代码已落地 |
| ⑦ | 前端表单.catch()错误处理 | `device/index.vue` | ✅ 代码已落地 |
| ⑧ | 导出分页流式写入 | `device_service.py`, `tag_service.py` | ✅ 代码已落地 |
| ⑨ | N+1查询优化为批量JOIN | `monitor_dao.py`, `monitor_service.py` | ✅ 代码已落地 |
| ⑩ | compute_from_tag实现slope_offset | `tag_service.py` | ✅ 代码已落地 |
| ⑪ | 高频字段数据库索引 | `device_do.py`, `tag_do.py` | ✅ 代码已落地（ORM层，需执行migration建到DB） |
| ⑫ | 克隆编号增加时间戳后缀 | `device/index.vue` | ✅ 代码已落地 |
| ⑬ | 通信方式切换增加重置提示 | `device/index.vue` | ✅ 代码已落地 |
| ⚠️ | 主备切换(backup_pc_ip) | 未实现 | ❌ 仅标记字段，无故障切换逻辑 |
| ⚠️ | PG批量写入(COPY) | 未实现 | ❌ 当前单条INSERT，吞吐~50点/秒 |
| ⚠️ | Node-RED管理界面认证 | 未实现 | ❌ 1880端口无认证 |
| ⚠️ | 工业网交换机MAC白名单 | 未实现 | ❌ 仅物理隔离 |

---

> **文档结束** — 本式样书基于实际代码审查结果编写，所有接口示例均对应实际API响应格式。标记为【待甲方确认】的项目需在部署前与甲方协商确定。
