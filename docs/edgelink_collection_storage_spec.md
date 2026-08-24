# EdgeLink 采集与存储架构说明书

> 版本：v5-fixed | 日期：2026-06-24 | 目标读者：AI 审阅 / 后端开发者

---

## 一、系统概览

EdgeLink 是工业物联网边缘计算平台。本文档描述其核心链路——从 PLC 数据采集到 PostgreSQL 时序存储。

```
PLC (MC协议) → Node-RED 采集Flow → MQTT(EMQX) → Node-RED Writer Flow → PostgreSQL
                  ↑ 每台工控机一份          ↑ 每台工控机可选
```

---

## 二、采集 Flow（nodered_mc_simulator_multidev_flow.json）

### 2.1 架构

```
inj-init(2s) → fn-init → http-login → fn-config → [mqtt-init, fn-build-reg-list]
inj-config-refresh(5min) → fn-init
inj-hb(30s) → fn-hb → [mqtt-hb, fn-init(reauth)]
inj-scan(1s) → fn-build-reg-list → fn-mc-reader → fn-parse → [mqtt-data, fn-init(reauth)]
inj-pg(30s) → fn-pg → fn-init(reauth)
```

### 2.2 核心节点职责

| 节点 | 功能 |
|------|------|
| `fn-init` | IP 检测、JWT 登录、区分首次/刷新/401重登三种路径 |
| `fn-config` | 拉取全局点位 API → 按 hostPcIp 筛选本机设备 → 反查 nodeId → 存 mcSim_devices |
| `fn-build-reg-list` | 读 mcSim_devices → 按 triggerKind 过滤 → 标记 driverType → 产出 msg.devices |
| `fn-mc-reader` | 驱动路由器：按 comType 分发到 driverMCProtocol 或 driverModbusTCP；5台并发 |
| `fn-parse` | 解析 MC 响应 → 按 tag 配置换算 slope/offset → HTTP 上报设备状态 → MQTT 推送数据 |
| `fn-hb` | 30s 心跳，上报节点在线状态 + 设备列表 |
| `fn-pg` | 30s PG 写入状态统计上报 |

### 2.3 触发模式（triggerKind）

| 值 | 模式 | 实现 |
|----|------|------|
| 1 | 固定周期 | inj-scan 每秒注入，不过滤 |
| 0 | 握手触发 | MQTT 订阅 `edgelink/trigger/scan/#` → 设 mcSim_handshakeFlags → fn-build-reg-list 消费 flag |
| 2 | 变化触发 | 比对 mcSim_lastGoodTags 与 mcSim_triggerLastRaw，值未变则跳过；每 5s 强制读一次兜底 |

### 2.4 协议可插拔

- `fn-build-reg-list` 维护 `DRIVER_REGISTRY`（comType → driverType 映射）
- `fn-mc-reader` 维护 `DRIVERS`（comType → 驱动函数）
- 新增协议只需：注册 driverType + 实现 driver 函数（实现 `connect → read → parse → done` 接口）
- `fn-config` / `fn-hb` / `fn-parse` / `fn-pg` 不随协议变化

### 2.5 MC 协议驱动

- 3E 帧（21 字节）+ 4E 帧（26 字节，含 Serial 4B + Reserved 1B）
- 寄存器类型：D/W/X/Y/M/L/B/R，X/Y 八进制地址
- 稀疏点位智能分组：同类型地址间隔 ≤20 的归为一组，分组串行读，同组共享 TCP 连接
- 并发调度：CONCURRENCY=5，每批 5 台设备同时读

### 2.6 关键全局变量

| 变量 | 用途 |
|------|------|
| `mcSim_devices` | 本机管理的设备列表 |
| `mcSim_tagConfigs` | {deviceId: [tags]} |
| `mcSim_nodeId` | 本机节点 ID（由 heartbeat 自动注册） |
| `mcSim_hostPcIp` | 本机办公网 IP |
| `mcSim_lastGoodTags` | 上一轮成功采集值（离线时标记 BAD 继续上报） |
| `mcSim_triggerLastRaw` | 变化触发基准值 |
| `mcSim_writeBuffer` | Writer Flow 共享的写入缓冲 |

---

## 三、写入 Flow（nodered_writer_proxy_v5_fixed.json）

### 3.1 架构

```
edgelink/data/# → fn-buffer-v5f(入缓冲+去重) → [1s定时] fn-pg-write-v5f(批量写PG)
```

### 3.2 核心节点职责

| 节点 | 功能 |
|------|------|
| `fn-buffer-v5f` | 解析 MQTT JSON → 去重（与 mcSim_lastWritten 比对） → 本机过滤（只处理匹配 mcSim_nodeId 的数据） → 推入 mcSim_writeBuffer |
| `fn-pg-write-v5f` | 原子取缓冲（retryBuffer + writeBuffer） → 1000 行分批 → 构建参数化 INSERT → pg.Pool 批量写入 |
| `inj-flush` | 每 1s 触发一次刷盘 |

### 3.3 关键设计

**去重（仅写入变化值）**

```javascript
// 比对上轮写入值，完全相同则跳过
var last = lastWritten[nodeId + '_' + deviceId + '_' + tagId];
if (last && String(last.raw) === String(raw) && String(last.eng) === String(eng)) {
    skipped++; return;  // 跳过
}
lastWritten[key] = {raw, eng, q};
rows.push({...});  // 入库
```

**本机过滤（每台 PC 只写自己的数据）**

```javascript
var myNodeId = global.get('mcSim_nodeId') || 0;
if (myNodeId && nodeId !== myNodeId) {
    node.status({text: 'Skip foreign ' + nodeId});
    return null;
}
```

**双缓冲 + 竞态保护**

```
fn-buffer ─写入→ mcSim_writeBuffer   (主缓冲，只被入缓冲写入)
fn-flush  ─失败→ mcSim_retryBuffer   (重试队列，只被 flush 写入)

flush 时原子替换:
  global.set('mcSim_retryBuffer', []);
  global.set('mcSim_writeBuffer', []);
  var batch = retryBuf.concat(mainBuf);
```

**连接池复用**

```javascript
var pool = global.get('mcSim_pgPool');
// 全字段对比，配置变了自动销毁重建
if (pool && JSON.stringify(currentOpts) !== JSON.stringify(wanted)) {
    pool.end(); pool = null;
}
if (!pool) pool = new pg.Pool(wanted);
```

**防御性设计**

| 保护 | 实现 |
|------|------|
| 写缓冲溢出 | 超 5 万行丢弃最旧 5000 行 |
| 重试队列溢出 | 超 2 万行丢弃最旧，保留最新 2 万 |
| 忙锁死锁 | 10s 超时 setTimeout 兜底释放 |
| undefined 占位符 | `v === undefined ? null : v` |
| PG 直连不可用 | 静默返回，MQTT 侧 EMQX 持久化兜底 |

---

## 四、后端接口依赖

### 4.1 采集 Flow 依赖

| 接口 | 用途 | 调用方 |
|------|------|--------|
| `POST /login` | 获取 JWT | fn-init → http-login |
| `GET /plc/tag/global/list` | 全局点位（含设备字段） | fn-config |
| `POST /monitor/heartbeat` | 心跳 + nodeId 注册 | fn-hb, fn-config(discoverNodeId) |
| `POST /monitor/device-comm` | 设备通信状态上报 | fn-parse |
| `POST /monitor/pg-write` | PG 写入状态上报 | fn-pg |

### 4.2 _GLOBAL_TAG_COLUMNS

后端 `tag_dao.py` 返回的全局点位包含 PlcTag 全部字段 + PlcDevice 关键字段：

```
host_pc_ip, plc_ip, plc_port, com_type, mc_frame, plc_series,
station_no, network_no, scan_interval_ms, comm_timeout_ms,
retry_count, retry_interval_ms, trigger_kind, status (device)
```

PlcTag.status 已被 label('tag_status') 重命名，避免与 PlcDevice.status 列名冲突。

---

## 五、部署拓扑

```
工控机 A (192.168.1.3, NodeId=56)
  ├─ 采集Flow: MC协议读 PLC → MQTT edgelink/data/56/23
  └─ Writer Flow(可选): 订阅 MQTT → 写 PG

工控机 B (192.168.1.4, NodeId=78)  
  ├─ 采集Flow: MC协议读 PLC → MQTT edgelink/data/78/45
  └─ Writer Flow(可选): 订阅 MQTT → 写 PG

中心服务器:
  ├─ EMQX Broker (MQTT 路由 + 持久化)
  ├─ RuoYi 后端 (设备管理 + 点位配置)
  └─ PostgreSQL (时序存储)
```

---

## 六、设计取舍与已知限制

| 取舍 | 原因 |
|------|------|
| 原生 TCP 而非 MC 库 | 零依赖部署，协议仅 21 字节 |
| 并发 5 台而非连接池 | Node-RED 单线程，连接池管理复杂且易出 bug |
| Writer 放每台 PC 而非中心 | 过渡方案——后续 EMQX 商业版桥接替代，零代码迁移 |
| 去重放 Writer 而非采集 | 前端需要实时刷新全部值，PG 只需存变化值 |
| 全局变量而非 context | 跨 Flow 共享缓冲，采集 Flow 和 Writer Flow 在同一 Node-RED 实例 |
| 参数化 INSERT 而非 COPY | pg.Pool 的 query() 天然支持 $N 参数化，COPY 需额外处理 |

---

## 七、待优化项（非紧急）

1. 采集 Flow 的 `fn-build-reg-list` 目前每轮 `JSON.stringify` 比对 Pool 配置（开销可忽略）
2. `mcSim_lastWritten` 只增不删，长期运行可用 LRU 或定时清理
3. Writer Flow 的 MQTT 订阅可改为 `edgelink/data/{nodeId}/#` 在 Broker 层过滤
4. 连接池可用 `pg.Pool` 自带的 idleTimeoutMillis 替代手动的配置变更检测
