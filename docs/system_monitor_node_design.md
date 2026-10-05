# Node-RED System Monitor Node — 通用版设计文档

> 版本：v1.1-draft（基于 v1.0-draft 评审意见修订）
> 日期：2026-08-29
> 定位：开源通用版，npm 包名 `node-red-contrib-system-monitor`

---

## 一、设计目标与原则

一句话：一个开箱即用、可插拔上报的 Node-RED 系统健康监控节点。新手拖进来连 inject 就能拿到数据；要远程上报就在面板里勾一下，不写代码。

| 原则 | 说明 |
|------|------|
| 分层解耦 | 采集引擎与上报适配器完全分离 |
| 默认可用 | 默认只开「输出 msg + 内存 + 流程数」，零配置出数据 |
| 可插拔上报 | 输出 msg / HTTP / MQTT，可并行多路 |
| 安全可选 | HMAC 签名可选；密钥走 credentials，支持 `${ENV_VAR}` |
| 零侵入 | 独立节点，只读 runtime，不触碰业务消息流 |
| 兼容降级 | 目标 Node-RED ≥ 2.2 / Node.js ≥ 14；拿不到的能力静默省略该字段，不报错 |

---

## 二、架构

```
┌────────────────────────────────────────────────┐
│  采集引擎（固定核心，纯函数式 collect()）        │
│   · 版本/时长/主机   · 内存（进程+整机）         │
│   · CPU（采样差值）  · 运行流数（z 去重）        │
│   · 节点红色状态计数（node-status 事件订阅）     │
│   · 事件循环延迟（perf_hooks，可选）             │
└──────────────┬─────────────────────────────────┘
               │ MonitorData（统一数据结构）
               ▼
┌────────────────────────────────────────────────┐
│  上报适配器（可插拔，统一接口 send(data, ctx)）  │
│   [☑] msg 输出   [ ] HTTP   [ ] MQTT           │
│   并行执行、独立成败、互不阻塞                   │
└────────────────────────────────────────────────┘
```

关键调度纪律（继承 EdgeLink 版已验证的做法）：

- **链式 `setTimeout` + `inFlight` 守卫**，任何情况下不存在两次并发上报；重试占用的时间不叠加触发。
- `on('close')` 清理定时器与事件订阅，redeploy 不泄漏、不翻倍。
- 全部异常 `try/catch` 收口到 `node.error` / `node.status`，**不向上抛**。

---

## 三、采集引擎

### 3.1 数据项

| 数据项 | 字段 | 来源 | 默认可选 |
|--------|------|------|----------|
| Node-RED 版本 | `nodered.version` | `RED.version()`，fallback `RED.settings.version` | 固定 |
| Node-RED 运行时长 | `nodered.uptime_sec` | `process.uptime()` | 固定 |
| Node.js 版本 | `nodered.node_version` | `process.version` | 固定 |
| 主机名 | `system.hostname` | `os.hostname()` | 固定 |
| 操作系统 | `system.platform` | `os.platform()` | 固定 |
| 系统运行时长 | `system.uptime_sec` | `os.uptime()` | 固定 |
| 进程 RSS 内存 | `memory.rss_mb` | `process.memoryUsage().rss` | ☑ 默认开 |
| 进程堆内存 | `memory.heap_used_mb` | `process.memoryUsage().heapUsed` | ☑ 默认开 |
| 整机总内存 | `memory.total_mb` | `os.totalmem()` | ☑ 默认开 |
| 整机空闲内存 | `memory.free_mb` | `os.freemem()` | ☑ 默认开 |
| CPU 使用率 | `cpu.usage_percent` | `os.cpus()` 两次采样差值 | ☑ 默认关（有 1s 采样延迟） |
| 运行流数量 | `flows.running` | `RED.nodes.eachNode` 按 `n.z` 去重 | ☑ 默认开 |
| 红色状态节点数 | `nodes.error_count` | `RED.events.on('node-status')` 事件累计 | ☑ 默认开 |
| 事件循环延迟 | `eventloop.lag_ms` | `perf_hooks.monitorEventLoopDelay().mean` | ☑ 默认关 |

### 3.2 采集实现要点（修正 v1.0-draft 的错误）

**运行流数量** — 用公开 runtime API，不用内部 `RED.runtime._`：

```javascript
function countRunningFlows() {
  const flows = {};
  try {
    RED.nodes.eachNode(n => { if (n && n.z) flows[n.z] = true; });
  } catch (e) { /* 降级：缺该字段 */ }
  return Object.keys(flows).length;
}
```

**红色状态节点数** — 运行态红状态是事件，不是节点属性（节点对象上**没有** `.error`；`.dirty` 是编辑器概念）：

```javascript
// 节点构造时订阅，close 时退订；维护一张 nodeId → 是否有红色状态 的表
const errorNodes = new Set();
const onStatus = ({ id, status }) => {
  if (status && status.fill === 'red') errorNodes.add(id);
  else errorNodes.delete(id);
};
RED.events.on('node-status', onStatus);
// collect 时：error_count = errorNodes.size
// 降级：RED.events 不存在（极老版本）→ 不输出 nodes 字段
```

> 明确放弃 v1.0-draft 里的 `flows.total / active / disabled` 三项：启用/禁用状态公开 API 拿不到，只能走内部 API（版本间不稳定）或 admin `/flows`（要鉴权）。留一个算不准的字段不如不留。

**CPU 使用率** — 采样差值法（两次 `os.cpus()` 快照，间隔 1000ms）。不阻塞事件循环，但会让 collect 异步延迟约 1 秒。**只有勾选 CPU 时才执行采样**，其余数据立即返回：

```javascript
async function collect() {
  const data = collectSync();                    // 全部同步指标
  if (config.collectCpu) {
    data.cpu = { usage_percent: await sampleCpu(1000) };
  }
  return data;
}
```

**事件循环延迟** — `perf_hooks.monitorEventLoopDelay()`（Node ≥ 12），`typeof` 守卫，不支持就省略。

### 3.3 触发方式

| 方式 | 说明 |
|------|------|
| 定时触发 | `interval` 10–1800 秒，默认 30；部署后 1 秒首报便于现场确认 |
| inject 触发 | 节点始终带输入端，收到任意 msg 立即采集上报一次（与定时并存） |

---

## 四、上报适配器

### 4.1 统一接口

```javascript
/**
 * 适配器上下文：让适配器能写状态灯和日志，而不持有 node 引用
 * ctx = { status(obj), error(msg), log(msg) }
 */
async function send(data: MonitorData, ctx: AdapterContext): Promise<{ ok: boolean, detail?: string }>
```

适配器是纯函数模块，注册进内部数组；面板勾选哪些就启用哪些。**并行执行、独立成败**：`Promise.allSettled`，任一失败不影响其他；节点状态灯取最差结果（任一失败 → 黄灯 + 失败的适配器名；全成功 → 绿灯）。

遥测数据天然幂等，**不做事务/补偿**：失败就丢，等下个周期。每个适配器内部只做有限重试（见 4.3），重试时间计入本周期，`inFlight` 保证不重叠。

### 4.2 适配器 A：输出 msg（默认开）

- 配置：`outputProperty`，默认 `payload`。
- 输出结构：

```json
{
  "topic": "system-monitor",
  "payload": {
    "report": { "nodered": {}, "system": {}, "memory": {}, "flows": {}, "nodes": {} },
    "timestamp": "2026-08-29T08:46:00.000Z",
    "node_id": "line-a-pc01"
  }
}
```

> `_msgid` 由 runtime 自动生成，不出现在文档示例里。

### 4.3 适配器 B：HTTP 上报

| 配置项 | 默认 | 说明 |
|--------|------|------|
| url | 必填 | 完整 URL，http/https 都支持 |
| method | POST | POST / PUT |
| headers | `{}` | 自定义头（key-value 编辑） |
| timeout | 5000ms | — |
| retryCount | 2 | 失败重试次数（指数退避，封顶 30s） |

- 零第三方依赖：Node 内置 `http`/`https` 模块。
- **body 一次定稿**：`const body = JSON.stringify(envelope)`，发送与签名用同一个字符串（见 §5）。
- 2xx 视为成功，其余状态码视为失败进入重试。
- HTTPS 使用系统 CA 库；自签名证书场景提供「跳过证书校验」显式开关（默认关，UI 上带安全提示）。

### 4.4 适配器 C：MQTT 上报

**复用核心 MQTT 节点的 broker 配置**，不引入 mqtt.js 依赖：

```javascript
// registerType defaults 里声明共享 config node
defaults: {
  broker: { value: '', type: 'mqtt-broker' },   // 复用内置连接
  mqttTopic: { value: 'nodered/monitor' },
  mqttQos: { value: '0' },
  mqttRetain: { value: false }
}
// 运行时：const conn = RED.nodes.getNode(config.broker); conn.client.publish(...)
```

用户在面板里直接选已有的 broker 配置（或新建），连接管理、断线重连全部由核心 MQTT config node 负责。

### 4.5 v2.0 扩展：第三方适配器

不用 `RED.plugins`（那是运行时插件机制，不是干这个的）。本包暴露自己的 registry：

```javascript
// 第三方包：require('node-red-contrib-system-monitor').registerAdapter(...)
module.exports.registerAdapter = (name, { configSchema, validate, send }) => { /* ... */ };
```

v1.0 只定义接口、不实现动态加载。

---

## 五、安全机制（可选）

### 5.1 HMAC 签名（修正版）

配置：`enableSignature`（默认关）、`secretKey`（credential 存储）、算法固定 HMAC-SHA256（v1.0 不提供算法选项，减少误配面）。

**签名覆盖 body 原文，杜绝跨语言序列化歧义**：

```javascript
const body = JSON.stringify(envelope);           // 一次定稿，收发同一串
const sig = crypto.createHmac('sha256', secretKey)
                  .update(envelope.timestamp + '\n' + body)   // timestamp 用信封里的同一 ISO 字符串
                  .digest('hex');
// 签名放请求头 X-Signature / X-Timestamp，不进 body（body 保持纯数据）
```

服务端验签（必须 `timingSafeEqual`，禁止 `===`）：

```python
expected = hmac.new(key, f"{ts}\n{raw_body}".encode(), hashlib.sha256).hexdigest()
ok = hmac.compare_digest(expected, request.headers['X-Signature'])
```

### 5.2 防重放

- 服务端校验 `X-Timestamp` 与本地时间偏差 ≤ ±300 秒；
- 服务端缓存近 5 分钟 `(node_id, timestamp)` 组合，重复即拒。

### 5.3 密钥与传输

- `secretKey` 走 credentials（`flows_cred.json`），不进 `flows.json`，导出脱敏；
- 支持 `${ENV_VAR}` 引用环境变量；
- **文档明确威胁模型**：HMAC 保完整性不保密，公网传输必须叠加 HTTPS；未启用签名时上报可被伪造，node_id 只是标识、不是凭证。

---

## 六、配置面板

分三段，高级段默认折叠：

```
┌─ 基本 ────────────────────────────────
│ 节点标识 nodeId   [________________]
│ 触发方式          [定时触发 ▾]  间隔 [30] 秒
│ 采集内容          ☑内存 ☑流程 ☐CPU ☐事件循环 ☑节点错误
├─ 上报方式 ────────────────────────────
│ ☑ 输出到下游 msg
│ ☐ HTTP 上报      （勾选展开 url/method/headers/超时/重试）
│ ☐ MQTT 上报      （勾选展开 broker/topic/qos/retain）
├─ 安全（高级，默认折叠）────────────────
│ ☐ 启用 HMAC-SHA256 签名
│   密钥 [************]（credential）
└──────────────────────────────────────
```

默认态（只勾 msg + 内存 + 流程）拖进来连 inject 即可用——这是「新手友好」的验收标准。

---

## 七、输出 Schema（修订）

```json
{
  "report": {
    "nodered": { "version": "4.1.11", "uptime_sec": 86400, "node_version": "v18.20.8" },
    "system": { "hostname": "line-a-pc01", "platform": "win32", "uptime_sec": 1209600 },
    "memory": { "rss_mb": 89.5, "heap_used_mb": 45.2, "total_mb": 16384, "free_mb": 4096 },
    "cpu": { "usage_percent": 12.5 },
    "flows": { "running": 12 },
    "nodes": { "error_count": 0 },
    "eventloop": { "lag_ms": 3.2 }
  },
  "timestamp": "2026-08-29T08:46:00.000Z",
  "node_id": "line-a-pc01"
}
```

- `timestamp` 全文档只有 ISO 8601 一种格式，签名也用它（修正 v1.0-draft 的 ISO/epoch 双格式矛盾）；
- 未启用的采集项对应字段**整体省略**，不输出 `null`；
- 签名不放 body，放 HTTP 头（见 §5.1）。

---

## 八、与 EdgeLink 专有版的关系

**专有版 npm 依赖开源核心，不 fork**：

```
node-red-contrib-system-monitor        (开源，本包)
   ↑ dependencies
node-red-contrib-edgelink-monitor      (专有)
   · 复用采集引擎（require 进来直接调 collect）
   · 叠加 EdgeLink 专有适配器：密钥-IP 绑定、配置下发、远程诊断、运转履历
```

专有价值在适配器和平台侧（后端、权限、审计），不在采集引擎——开源出去不会侵蚀商业价值，反而替专有版做社区验证。禁止两边各改一套采集代码。

---

## 九、发布计划

| 版本 | 内容 |
|------|------|
| v0.1.0 | 采集引擎 + msg 输出 + 单测 |
| v0.2.0 | + HTTP 适配器 + HMAC 签名 + mock server 示例 |
| v0.3.0 | + MQTT 适配器（broker 复用）+ 面板折叠优化 |
| v1.0.0 | 稳定版：中英文 README、JSON Schema 文件、集成测试 |
| v1.1.0 | 事件触发（节点变红立即上报一次） |
| v2.0.0 | 第三方适配器 registry |

开源清单：GitHub 仓库、npm 名 `node-red-contrib-system-monitor`、Apache-2.0、示例 flow + mock 验签服务器（Node 和 Python 各一份，直接验证 §5 的跨语言验签）。

---

## 十、相对 v1.0-draft 的修订记录

| # | 修订 | 原因 |
|---|------|------|
| 1 | 运行流数改 `eachNode` z 去重；红色状态数改 `node-status` 事件订阅 | 原方案的 API 是内部存储态，`n.error` 不存在，`error_count` 恒为 0 |
| 2 | 删除 `flows.total/active/disabled` | 公开 API 拿不到，不留假指标 |
| 3 | 签名改为「body 原文 + 统一 ISO 时间戳」，签名走 HTTP 头，验签用 `timingSafeEqual` | 原方案双时间戳格式 + `JSON.stringify` 跨语言不一致 + `===` 时序攻击 |
| 4 | MQTT 改为复用 `mqtt-broker` config node | 「复用连接池（如可能）」是确定可行的标准做法，不用引依赖 |
| 5 | 明确链式调度 + inFlight 守卫，重试不重叠 | 原方案未定义重试与定时的重叠行为 |
| 6 | CPU 采样改为勾选才执行 | 不为没开的功能付 1 秒延迟 |
| 7 | 新增数据项：Node.js 版本、整机内存、系统时长、事件循环延迟；删 `heap_total` | 排障价值更高；`heap_total` 无意义（V8 按需申请） |
| 8 | 适配器接口加 `ctx`（status/error/log） | 适配器要写状态灯和日志，纯 `send(data)` 不够 |
| 9 | v2.0 扩展机制改为自己包的 registry，不用 `RED.plugins` | `RED.plugins` 是运行时插件机制，用途不符 |
| 10 | 双轨策略改为「专有版 npm 依赖开源核心」，禁止 fork | 避免维护两套采集代码 |
