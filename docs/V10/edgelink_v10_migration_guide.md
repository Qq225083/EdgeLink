# EdgeLink v9.1 → v10 迁移指南

## 变更概述

v9.1 的 50 节点单体 Flow 拆分为 **6 个子 Flow + 1 个主编排 Flow**。
两个版本使用不同全局变量前缀，**可同时部署，互不干扰**。

## 文件清单

| 文件 | 用途 |
|------|------|
| `edgelink_v10_sf_config_manager.json` | 子Flow: 配置管理中心 |
| `edgelink_v10_sf_mc_driver.json` | 子Flow: MC协议驱动 |
| `edgelink_v10_sf_modbus_driver.json` | 子Flow: Modbus TCP驱动 |
| `edgelink_v10_sf_data_processor.json` | 子Flow: 数据管道 |
| `edgelink_v10_sf_pg_writer.json` | 子Flow: PG异步写入 |
| `edgelink_v10_sf_monitor.json` | 子Flow: 监控与心跳 |
| `edgelink_v10_main_flow_phase3.json` | 主编排Flow (完整版) |

## 全局变量映射

| v9.1 (`mcSim_`) | v10 (`edge_`) | 说明 |
|---|---|---|
| `mcSim_jwtToken` | `edge_jwt` | JWT Token |
| `mcSim_nodeId` | `edge_nodeId` | 采集节点ID |
| `mcSim_devices` | `edge_devices` | 设备列表 |
| `mcSim_tagConfigs` | `edge_tagConfigs` | 点位配置 {deviceId: [tags]} |
| `mcSim_hostPcIp` | `edge_hostPcIp` | 本机IP |
| `mcSim_configReady` | `edge_configReady` | 配置就绪标志 |
| `mcSim_devCommStatus` | `edge_commStatus` | 通信状态 {deviceId: {consecutiveFails, lastState}} |
| `mcSim_lastGoodTags` | `edge_lastGoodTags` | 最后好值 |
| `mcSim_handshakeFlags` | `edge_handshakeFlags` | 握手触发标记 |
| `mcSim_historyData` | `edge_historyData` | 历史缓存 |
| `mcSim_recentAlerts` | `edge_recentAlerts` | 最近告警 |
| `mcSim_lastAlarmTime` | `edge_lastAlarmTime` | 告警抑制时间 |
| `mcSim_triggerLastRaw` | `edge_triggerLastRaw` | 变化触发上次值 |
| `mcSim_triggerForceTimes` | `edge_triggerForceTimes` | 变化触发强制时间 |
| `mcSim_reauthInProgress` | `edge_reauthInProgress` | 重登进行中 |
| `mcSim_pgSuccessCount` | `edge_pg_success_count` | PG累计写入数 |
| `mcSim_debug` | `edge_debug` | 调试开关 |
| `mcSim_backendHost` | `edge_backendHost` | 后端地址 |
| `mcSim_backendPort` | `edge_backendPort` | 后端端口 |
| `mcSim_apiKey` | `edge_apiKey` | API Key |
| `mcSim_simulationMode` | `edge_simulationMode` | 模拟模式 |
| — | `edge_commPending` | ⭐新增: device-comm事件缓冲 |
| — | `edge_pg_queue` | ⭐新增: PG写入队列 |
| — | `edge_pg_writing` | ⭐新增: PG写入锁 |
| — | `edge_config_manager_lock` | ⭐新增: 配置管理器单例锁 |
| — | `edge_mc_driver_lock` | ⭐新增: MC驱动单例锁 |
| — | `edge_modbus_driver_lock` | ⭐新增: Modbus驱动单例锁 |

## MQTT Topic 变更

| v9.1 Topic | v10 Topic |
|---|---|
| `edgelink/nodes/{nid}/status` | `edgelink-v10/nodes/{nid}/status` |
| `edgelink/heartbeat/{nid}` | `edgelink-v10/heartbeat/{nid}` |
| `edgelink/data/{nid}/{did}` | `edgelink-v10/data/{nid}/{did}` |
| `edgelink/alarm/plc_offline/{did}` | `edgelink-v10/alarm/plc_offline/{did}` |
| `edgelink/trigger/scan/#` | `edgelink-v10/trigger/scan/#` |

## HTTP API 端点变更

v10 本地监控 API 加 `/api/v10/` 前缀：

| v9.1 | v10 |
|---|---|
| `GET /api/monitor/status` | `GET /api/v10/monitor/status` |
| `GET /api/monitor/device/:id` | `GET /api/v10/monitor/device/:id` |
| `GET /api/monitor/alerts` | `GET /api/v10/monitor/alerts` |
| `GET /api/monitor/history/:did/:tid` | `GET /api/v10/monitor/history/:did/:tid` |
| `POST /api/monitor/alarms/clear` | `POST /api/v10/monitor/alarms/clear` |
| `POST /api/monitor/config/refresh` | `POST /api/v10/monitor/config/refresh` |

## 部署步骤

### Step 1: 配置 functionGlobalContext (settings.js)

```javascript
functionGlobalContext: {
    // 基础模块 (必需)
    http: require('http'),
    net: require('net'),
    os: require('os'),
    process: process,

    // v10 默认配置 (可选，有默认值)
    edge_backendUser: 'admin',
    edge_backendPass: '***',
    edge_apiKey: '***',
    edge_backendHost: '127.0.0.1',
    edge_backendPort: 9099,
    edge_debug: true,
    edge_simulationMode: true,

    // PG配置 (可选，仅 sf-pg-writer 使用)
    // edge_pgHost: '127.0.0.1',
    // edge_pgPort: 5432,
    // edge_pgDatabase: 'postgres',
    // edge_pgUser: 'postgres',
    // edge_pgPassword: 'postgres',

    // 自定义驱动注册表 (可选)
    // edge_driverRegistry: { 'MC_Protocol': 'driver-mc-protocol', 'Modbus_TCP': 'driver-modbus-tcp' }
}
```

### Step 2: 导入子 Flow

按顺序导入 6 个子 Flow JSON 文件：
1. Node-RED → Import → 选择 `edgelink_v10_sf_config_manager.json` → Import
2. 重复以上步骤导入其余 5 个子 Flow
3. 检查 Subflow 面板确认 6 个子 Flow 已注册

### Step 3: 导入主 Flow

1. Import → 选择 `edgelink_v10_main_flow_phase3.json` → Import
2. 确认 MQTT broker 配置节点已关联到所有 mqtt-out/mqtt-in 节点

### Step 4: 验证部署

1. **Phase 1a 先验证**: 导入 `edgelink_v10_main_flow_phase1a.json`（硬编码设备，不依赖后端）
   - 部署后观察 Debug 面板
   - 验证 MC 驱动模拟模式输出格式
   - 验证数据管道 MQTT topic 和 PG 记录格式

2. **Phase 1c 验证**: 导入 `edgelink_v10_main_flow_phase1c.json`（需要后端）
   - 验证 sf-config-manager 能登录后端
   - 验证 edge_devices 数组正确填充
   - 验证调度器正确过滤和输出

3. **Phase 3 完整验证**:
   - 全部 6 子 Flow + 主 Flow 部署
   - 检查 MQTT 消息: `edgelink-v10/nodes/+/status`, `edgelink-v10/heartbeat/+`, `edgelink-v10/data/+/+`
   - 检查 HTTP API: `GET http://127.0.0.1:1880/api/v10/monitor/status`

### Step 5: 下线 v9.1

验证 v10 稳定运行后：
1. 在 Node-RED 中禁用 v9.1 的 tab
2. 观察一段时间确认无异常
3. 导出 v9.1 备份后删除

## 共存测试

v9.1 和 v10 使用不同前缀，可同时运行：

```bash
# 测试 v9.1 状态
curl http://127.0.0.1:1880/api/monitor/status

# 测试 v10 状态
curl http://127.0.0.1:1880/api/v10/monitor/status
```

## 回滚步骤

1. Node-RED → 禁用 v10 tab
2. 重新启用 v9.1 tab
3. Deploy
4. 两个版本共享同一 MQTT broker 和后端 API，无数据冲突

## v10 新增功能

| 功能 | 说明 |
|------|------|
| **死区过滤 (Deadband)** | sf-data-processor 中按 `deadband` 字段过滤，减少 70% 无效 MQTT |
| **Modbus 字节序** | ABCD/BADC/CDAB/DCBA，由 `protocolParams.byteOrder` 控制 |
| **单例锁** | 所有子 Flow 60s 过期单例锁，防重复部署 |
| **事件驱动 PG 写入** | sf-pg-writer 收到数据立即写入，非定时器轮询 |
| **自适应批量** | PG 写入批量根据队列深度和延迟动态调整 (50-500条) |
| **device-comm 仅状态变化上报** | 在线↔离线切换时才推入 edge_commPending，30s 批量消费 |
| **接口契约标准化** | 每个子 Flow 输入/输出格式明确，可独立 mock 测试 |

## v10 架构优势

| v9.1 | v10 |
|------|-----|
| 50 节点单体 Flow | 6 子Flow + 1 主编排 |
| 900+ 行单文件 | 每子Flow ≤ 300 行 |
| 修改需整体重新部署 | 子Flow 独立部署 |
| 调试靠 console.log | Debug 节点可插入子Flow 内部 |
| 新增协议需改动多处 | 注册新子Flow + router 加映射 |
| 全局变量 `mcSim_` 散落 | `edge_` 前缀 + 所有权明确 |
| 无接口文档 | 契约标准化 (见子Flow info) |
| — | 7 子Flow + sf-local-api (HTTP 端点独立) |
| — | Modbus FLOAT32/INT32 支持 |

## 已知技术债务 (Phase 2 修复)

| # | 问题 | 影响 | 修复方向 |
|---|------|------|----------|
| 4 | 驱动子Flow 内部是巨型单 Function (~300行) | 无法在帧构造/拆包阶段插 Debug 节点，排查效率低 | 拆为 split→帧构造→tcp→拆包→join 多节点 |
| 6 | Modbus FLOAT32 未充分测试 | 现场变频器等 32 位设备待验证 | 需要真实 Modbus 设备回归测试 |
| 9 | sf-local-api http-in 节点全局注册 | 拖出多个实例部署时报路由冲突 | 文档已标明"只能拖1个实例" |
| 10 | 模拟模式 Modbus 位元件仍生成 0~65535 | 联调体验不完美 | 增加 BOOL 数据类型支持 |

## PG 写入器依赖

`sf-pg-writer` 需要 `pg` 模块 (node-postgres)：

```bash
cd ~/.node-red
npm install pg
```

settings.js:
```javascript
functionGlobalContext: {
    pg: require('pg'),    // ← 必需
    // 可选: 覆盖 PG 连接参数
    // edge_pgHost: '127.0.0.1',
    // edge_pgPort: 5432,
    // edge_pgDatabase: 'edgelink',
    // edge_pgUser: 'postgres',
    // edge_pgPassword: 'dss@2025',
}
```

如不需要 PG 写入，`sf-pg-writer` 会自动跳过 (开发模式，只累加计数)。
