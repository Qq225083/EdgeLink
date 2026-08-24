# EdgeLink MQTT 部署配置指南

> **目标**：将心跳检测从 HTTP 轮询改造为 MQTT 实时推送，实现前端秒级感知节点状态变化。
> **策略**：双通道过渡 — Node-RED 同时发送 MQTT 心跳（前端实时）和 HTTP POST（后端存库/自动注册）。

---

## 1. EMQX Broker 部署与配置

### 1.1 安装 EMQX

```bash
# Windows (PowerShell)
Invoke-WebRequest -Uri https://www.emqx.com/zh/downloads/broker/5.x/emqx-5.x.x-windows-amd64.zip -OutFile emqx.zip
Expand-Archive emqx.zip -DestinationPath C:\
cd C:\emqx\bin
.\emqx start
```

### 1.2 创建 MQTT 认证账号

```bash
# 1. Node-RED 发布账号（可 publish 心跳和状态）
emqx ctl users add nodered_pub <nodered_password>

# 2. 前端只读订阅账号（仅可 subscribe，禁止 publish）
emqx ctl users add web_sub <web_password>
```

### 1.3 ACL 权限规则

```bash
# === Node-RED 发布账号权限 ===

# 允许发布心跳消息
emqx ctl acl add publish nodered_pub edgelink/heartbeat/+ allow

# 允许发布节点状态变化消息（含 Retain）
emqx ctl acl add publish nodered_pub edgelink/nodes/+/status allow

# 允许 Last Will 消息（EMQX 以原客户端身份发布）
emqx ctl acl add publish nodered_pub edgelink/alarm/node_offline/+ allow

# 禁止 nodered_pub 订阅任何主题（安全最小化权限）
emqx ctl acl add subscribe nodered_pub edgelink/# deny


# === 前端只读账号权限 ===

# 允许订阅所有 edgelink 主题
emqx ctl acl add subscribe web_sub edgelink/# allow

# 禁止前端发布任何消息（防止浏览器 Console 伪造心跳）
emqx ctl acl add publish web_sub edgelink/# deny
```

### 1.4 WebSocket 监听器配置（前端连接用）

```bash
# 在 emqx.conf 中或通过 Dashboard 启用 WebSocket 监听器
# listeners.ws.default {
#   bind = "0.0.0.0:8083"
#   max_connections = 1024
# }
```

**CORS 配置**（防止前端浏览器跨域错误）：
```bash
emqx ctl conf set listeners.ws.default.websocket.check_origin_enable false
# 或生产环境指定精确 Origin：
# emqx ctl conf set listeners.ws.default.websocket.check_origins "http://192.168.1.100,http://localhost:8080"
```

### 1.5 验证 EMQX 运行正常

```bash
# 检查服务状态
emqx ctl status

# 使用 MQTTX 或 mosquitto 客户端测试
mosquitto_sub -h 127.0.0.1 -p 1883 -u web_sub -P <web_password> -t 'edgelink/#' -v
```

---

## 2. 环境变量清单

### 2.1 后端 .env.dev 新增项

```ini
# -------- MQTT Broker（EMQX）--------
# MQTT 服务端 IP
MQTT_HOST = '127.0.0.1'
# MQTT TCP 端口（Node-RED 连接用）
MQTT_PORT = 1883
# MQTT WebSocket 端口（前端浏览器连接用）
MQTT_WS_PORT = 8083
# MQTT 用户名（后端可选订阅用，第一步可不配）
MQTT_USERNAME = ''
# MQTT 密码
MQTT_PASSWORD = ''
```

### 2.2 Node-RED 环境变量（在 Node-RED 启动脚本或 settings.js 中设置）

```javascript
// Node-RED settings.js 的 functionGlobalContext 或 Windows 环境变量

// 方式1：Windows 系统环境变量（推荐）
// EDGELINK_MQTT_HOST = 192.168.1.100
// EDGELINK_MQTT_PORT = 1883
// EDGELINK_MQTT_USERNAME = nodered_pub
// EDGELINK_MQTT_PASSWORD = <nodered_password>
// EDGELINK_BACKEND_HOST = 192.168.1.100
// EDGELINK_BACKEND_PORT = 9099
// EDGELINK_MONITOR_API_KEY = ***
// EDGELINK_JWT_TOKEN = eyJhbGciOiJIUzI1NiIs...
// EDGELINK_NODE_ID = （可选，跳过 MySQL 反查）

// 方式2：在 settings.js 中配置
functionGlobalContext: {
    mqttHost: '192.168.1.100',
    // ...
}
```

### 2.3 前端环境变量（.env.production）

```ini
# MQTT WebSocket 地址
VUE_APP_MQTT_WS_URL = ws://192.168.1.100:8083/mqtt
# MQTT 前端只读账号
VUE_APP_MQTT_USERNAME = web_sub
VUE_APP_MQTT_PASSWORD = <web_password>
```

**注意**：前端 MQTT 功能依赖 CDN 加载的 `mqtt.js`（见 `public/index.html`）：
```html
<script src="https://unpkg.com/mqtt@5.15.1/dist/mqtt.min.js"></script>
```
如果生产环境无法访问外网 CDN，需将此脚本替换为本地部署：下载 `mqtt.min.js` 放置到 `public/static/` 目录，修改 script src 为 `/static/mqtt.min.js`。

---

## 3. Node-RED Flow 配置

### 3.1 节点连接图

```
┌──────────────────────────────────────────────────────────────────────┐
│                        启动初始化流程（执行一次）                       │
│                                                                       │
│  [inject: 启动时] → [function: init] → [mysql: 反查]                  │
│                                          ↓                            │
│                    [function: store node_id to global]                 │
│                          ↓                                            │
│                    [mqtt out: status Retain]                           │
│                    Topic: edgelink/nodes/{id}/status                   │
│                    Payload: {"status":"online"}                        │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                        心跳定时流程（每30秒）                         │
│                                                                       │
│  [inject: 30s interval] → [function: heartbeat]                       │
│                                    │                                  │
│                    ┌───────────────┴───────────────┐                  │
│                    ↓                               ↓                  │
│  [mqtt out: heartbeat]                   [http request: POST]         │
│  Topic: edgelink/heartbeat/{id}          URL: /monitor/heartbeat      │
│  QoS: 1, Retain: false                   Headers: JWT + X-API-Key    │
│  Payload: {node_id, ip, ...}             Params: ?host_pc_ip=...      │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 mqtt out 节点配置

| 参数 | heartbeat 节点 | status/Last Will 节点 |
|------|---------------|----------------------|
| Server | `mqtt://${MQTT_HOST}:${MQTT_PORT}` | （同左，共用同一 broker 配置） |
| Client ID | `edgelink-node-${node_id}-${random}` | （同上，共享连接） |
| Topic | **留空**（由 function 节点的 `msg.topic` 动态设置） | **留空** |
| QoS | 1（由 msg.qos 覆盖） | 1 |
| Retain | false（由 msg.retain 覆盖） | true |
| Username | `nodered_pub` | （同上） |
| Password | `<nodered_password>` | （同上） |
| **Last Will Topic** | — | `edgelink/alarm/node_offline/{node_id}` |
| **Last Will QoS** | — | 1 |
| **Last Will Retain** | — | true |
| **Last Will Payload** | — | `{"node_id":X,"host_pc_ip":"...","alert_type":"NODE_OFFLINE","msg":"采集节点异常断开","ts":"..."}` |
| Keep Alive | 15s | 15s（加速断线检测） |

### 3.3 function 节点代码

- **启动初始化**：见 `docs/nodered_mqtt_init.js`
- **30秒心跳**：见 `docs/nodered_mqtt_heartbeat.js`

---

## 4. MQTT Topic 完整定义

| Topic | 方向 | QoS | Retain | Payload 示例 |
|-------|------|-----|--------|-------------|
| `edgelink/heartbeat/{node_id}` | Node-RED → EMQX → 前端 | 1 | false | `{"node_id":1,"host_pc_ip":"192.168.1.10","node_ip":"192.168.1.10","running_flows":12,"memory_usage_mb":256,"status":"online","ts":"2026-06-19T12:00:00Z"}` |
| `edgelink/nodes/{node_id}/status` | Node-RED → EMQX → 前端 | 1 | **true** | `{"node_id":1,"host_pc_ip":"192.168.1.10","status":"online","ts":"2026-06-19T12:00:00Z"}` |
| `edgelink/alarm/node_offline/{node_id}` | EMQX Last Will → 前端 | 1 | **true** | `{"node_id":1,"host_pc_ip":"192.168.1.10","alert_type":"NODE_OFFLINE","msg":"采集节点异常断开","ts":"2026-06-19T12:00:30Z"}` |

---

## 5. 部署验证步骤

### Step 1: 确认 EMQX 运行

```bash
emqx ctl status
# 预期输出：Node 'emqx@127.0.0.1' is started
```

### Step 2: 确认认证账号已创建

```bash
emqx ctl users list
# 输出应含 nodered_pub 和 web_sub
```

### Step 3: 启动 Node-RED，检查调试面板

```
[EdgeLink-Init] 检测到网卡: 以太网 → 192.168.1.10
[EdgeLink-Init] 选定 hostPcIp: 192.168.1.10
[EdgeLink-Init] 执行 MySQL 反查: SELECT id FROM nodered_node WHERE ...
[EdgeLink-Init] MQTT 状态消息已构建: edgelink/nodes/1/status → {status:online}
MQTT connected (ClientId: edgelink-node-1-x7k2m)
```

### Step 4: 打开前端监控中心，F12 Console

```
[MQTT] 已连接，ClientId: edgelink-web-lx9abc-3d2f71
[MQTT] 已订阅: ['edgelink/heartbeat/+', 'edgelink/nodes/+/status', 'edgelink/alarm/node_offline/+']
[Monitor] MQTT 订阅完成，实时监控已就绪
```

### Step 5: 验证实时更新

1. 等待 30 秒，观察节点列表 `lastHeartbeat` 字段自动更新（无需手动刷新）
2. KPI 卡片"采集节点在线"数字随节点上下线实时变化
3. 标签"MQTT 实时"为绿色

### Step 6: 拔网线测试离线告警

1. 拔掉采集 PC 网线（或停止 Node-RED 进程）
2. **预期**：15 秒内前端弹窗"⚠️ 节点离线告警"，节点变红
3. 插回网线/重启 Node-RED → 自动恢复在线

### Step 7: 验证 Retain 消息

1. 关闭前端页面 → 重新打开
2. 页面应立即显示正确的节点在线/离线颜色（Retain 消息补全状态）

---

## 6. 故障排查

| 现象 | 可能原因 | 排查步骤 |
|------|---------|---------|
| 前端 MQTT 连接失败 | WebSocket 端口未开放 / 防火墙拦截 | 1. `telnet EMQX_IP 8083` 2. 检查 Windows 防火墙入站规则 |
| Node-RED MQTT 连接失败 | EMQX 未启动 / 认证失败 | 1. `emqx ctl status` 2. 检查用户名密码是否正确 |
| 前端收不到心跳 | Topic 权限不足 / 订阅失败 | 1. 用 MQTTX 订阅 `edgelink/#` 验证消息 2. 检查 ACL 规则 |
| 前端红色横幅"实时连接已断开" | WebSocket 断线 | 自动重连中，等待 5 秒即可恢复 |
| Last Will 不触发 | Keep Alive 过长 | 检查 mqtt out 节点 Keep Alive 设为 15s |
| 多标签页同时打开 | ClientId 冲突 | 已解决：每个标签页独立 ClientId（含随机后缀） |
