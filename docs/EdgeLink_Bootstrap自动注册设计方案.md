# EdgeLink Node-RED Bootstrap 自动注册设计方案

> 版本：v1.0  
> 日期：2026-07-22  
> 作者：Claude  
> 状态：待评审

---

## 一、背景与目标

### 1.1 当前痛点

当前 EdgeLink 系统新增 Node-RED 采集节点时，需要人工修改每台 PC 的 `settings.js`，配置 `edge_bootstrapKey`、`edge_bootstrapSecret`、`edge_hostPcIp`、`edge_nodeId` 等参数。当采集节点数量达到 50-100 台时，逐台配置的工作量巨大，且容易出错。

### 1.2 设计目标

实现 Node-RED 采集节点的**零配置自动注册**：

1. Node-RED 启动时自动检测本机 IP 和实际监听端口
2. 自动调用后端 `/plc/config/bootstrap/auto` 接口注册或获取配置
3. 无需在 `settings.js` 中配置任何节点标识参数
4. 新增 PC 时，Node-RED 启动后自动完成注册，无需人工干预

### 1.3 适用范围

- 单 PC 单 Node-RED 实例
- 单 PC 多 Node-RED 实例（不同端口）
- 多 PC 多 Node-RED 实例（不同 IP）

---

## 二、核心设计

### 2.1 核心思想

**Node-RED 启动时，自动检测本机 IP 和实际监听端口，用 `IP:端口` 作为唯一标识调用后端 Bootstrap 接口，实现自动注册和配置获取。**

### 2.2 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 节点标识 | `IP:端口` | 天然唯一，无需人工分配 |
| 端口获取 | `process.env.PORT` 或 `uiPort` | Node-RED 自己知道实际监听端口 |
| IP 检测 | 自动检测非虚拟网卡 IPv4 地址 | 排除 Docker/VirtualBox/169.254 网段 |
| 注册方式 | 后端自动注册（不存在时） | 零配置，新增 PC 自动完成 |
| 密钥管理 | 首次注册生成，后续本地保存 | 平衡安全性与便利性 |
| 安全性 | 内网环境，无额外鉴权 | 用户明确要求简化 |

---

## 三、工作流程

### 3.1 首次启动流程（新节点）

```
Node-RED 启动
    ↓
自动检测本机 IP（如 192.168.0.179）
    ↓
自动获取实际监听端口（如 1880）
    ↓
组合 hostPcIp = "192.168.0.179:1880"
    ↓
调用 GET /plc/config/bootstrap/auto?host_pc_ip=192.168.0.179:1880
    ↓
后端查询 edge_bootstrap_key 表
    ↓
记录不存在 → 自动注册新节点
    ↓
生成 node_key（如 pc-192168000179-1880）
    ↓
生成 secret_key（随机 32 位 hex）
    ↓
返回完整配置（含 secret_key）
    ↓
Node-RED 保存 secret_key 到本地文件（edge_secret.json）
    ↓
写入 global.set('edge_*')
    ↓
正常采集
```

### 3.2 后续启动流程（已注册节点）

```
Node-RED 启动
    ↓
读取本地文件 edge_secret.json
    ↓
获取 hostPcIp 和 secretKey
    ↓
调用 GET /plc/config/bootstrap?host_pc_ip=xxx&secret_key=xxx
    ↓
后端验证 secret_key
    ↓
返回完整配置
    ↓
写入 global.set('edge_*')
    ↓
正常采集
```

### 3.3 配置更新流程

```
后端修改配置（如 MQTT 密码）
    ↓
发布中心发布 CONFIG_REFRESH
    ↓
Node-RED 收到通知
    ↓
重新调用 /plc/config/bootstrap
    ↓
获取最新配置
    ↓
更新 global.set('edge_*')
    ↓
更新本地 edge_secret.json
    ↓
继续采集
```

---

## 四、接口设计

### 4.1 自动注册接口

**URL**：`GET /plc/config/bootstrap/auto`

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `host_pc_ip` | string | 是 | 节点标识（IP:端口），如 `192.168.0.179:1880` |

**响应**：

```json
{
  "code": 200,
  "msg": "操作成功",
  "data": {
    "nodeKey": "pc-192168000179-1880",
    "nodeName": "采集节点-192.168.0.179:1880",
    "hostPcIp": "192.168.0.179:1880",
    "secretKey": "a1b2c3d4e5f6...",
    "backendHost": "192.168.1.10",
    "backendPort": 9099,
    "apiKey": "xxx",
    "backendUser": "admin",
    "backendPass": "***",
    "mqtt": {
      "host": "192.168.1.10",
      "port": 1883,
      "wsPort": 8083,
      "username": "edgelink",
      "password": "xxx"
    },
    "collect": {
      "defaultScanIntervalMs": 1000,
      "defaultCommTimeoutMs": 3000,
      "defaultRetryCount": 2,
      "defaultRetryIntervalMs": 500
    }
  }
}
```

**逻辑**：
1. 按 `host_pc_ip` 查询 `edge_bootstrap_key` 表
2. 如果存在且 `enabled=1`：返回配置
3. 如果不存在：
   - 生成 `node_key`（格式：`pc-{ip数字}-{port}`）
   - 生成 `secret_key`（32 位随机 hex）
   - 插入新记录
   - 返回配置（含 `secret_key`）

### 4.2 已注册节点配置获取接口

**URL**：`GET /plc/config/bootstrap`

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `host_pc_ip` | string | 是 | 节点标识（IP:端口） |
| `secret_key` | string | 是 | 节点密钥 |

**响应**：同 4.1，但不返回 `secret_key`（已验证）。

**逻辑**：
1. 按 `host_pc_ip` 查询 `edge_bootstrap_key` 表
2. 验证 `secret_key` 匹配且 `enabled=1`
3. 返回配置

---

## 五、数据结构

### 5.1 `edge_bootstrap_key` 表（已有）

```sql
CREATE TABLE IF NOT EXISTS edge_bootstrap_key (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    node_key VARCHAR(64) NOT NULL UNIQUE COMMENT '节点标识（如 pc-001）',
    node_name VARCHAR(100) COMMENT '节点名称',
    host_pc_ip VARCHAR(50) UNIQUE COMMENT '节点标识（IP:端口，必须唯一）',
    secret_key VARCHAR(64) NOT NULL COMMENT '初始接入密钥',
    enabled TINYINT(1) DEFAULT 1 COMMENT '是否启用（0停用 1启用）',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_node_key (node_key),
    INDEX idx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='边缘节点初始接入密钥表';
```

### 5.2 本地缓存文件 `edge_secret.json`

Node-RED 本地保存，路径：`D:/nodered/data/edge_secret.json`（或用户目录）

```json
{
  "hostPcIp": "192.168.0.179:1880",
  "secretKey": "a1b2c3d4e5f6...",
  "nodeKey": "pc-192168000179-1880",
  "lastUpdate": "2026-07-22T10:00:00.000Z"
}
```

---

## 六、Node-RED 侧实现

### 6.1 IP 检测逻辑

```javascript
function detectLocalIp() {
    var os = global.get('os');
    if (!os) return '127.0.0.1';
    
    var nets = os.networkInterfaces();
    var VIRTUAL_PREFIXES = ['169.254.', '172.16.', '192.168.56.'];
    
    for (var name in nets) {
        if (!nets.hasOwnProperty(name)) continue;
        var iface = nets[name];
        for (var i = 0; i < iface.length; i++) {
            var netInfo = iface[i];
            if (netInfo.family !== 'IPv4' || netInfo.internal) continue;
            var addr = netInfo.address;
            var isVirtual = false;
            for (var j = 0; j < VIRTUAL_PREFIXES.length; j++) {
                if (addr.startsWith(VIRTUAL_PREFIXES[j])) {
                    isVirtual = true;
                    break;
                }
            }
            if (!isVirtual) return addr;
        }
    }
    return '127.0.0.1';
}
```

### 6.2 端口获取逻辑

```javascript
function getActualPort() {
    // 优先从环境变量获取
    if (process.env.PORT) return parseInt(process.env.PORT, 10);
    // 其次从 settings.js 的 uiPort 获取
    var uiPort = global.get('uiPort');
    if (uiPort) return parseInt(uiPort, 10);
    // 默认 1880
    return 1880;
}
```

### 6.3 本地缓存读写

```javascript
var fs = global.get('fs');
var path = global.get('path');

var SECRET_FILE = path.join(global.get('userDir') || '.', 'edge_secret.json');

function readLocalSecret() {
    try {
        if (fs.existsSync(SECRET_FILE)) {
            var data = fs.readFileSync(SECRET_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {}
    return null;
}

function writeLocalSecret(secret) {
    try {
        fs.writeFileSync(SECRET_FILE, JSON.stringify(secret, null, 2));
    } catch (e) {}
}
```

### 6.4 首次启动流程

```javascript
var detectedIp = detectLocalIp();
var actualPort = getActualPort();
var hostPcIp = detectedIp + ':' + actualPort;

// 先读本地缓存
var localSecret = readLocalSecret();
if (localSecret && localSecret.hostPcIp === hostPcIp && localSecret.secretKey) {
    // 已注册，直接获取配置
    fetchConfigBySecret(hostPcIp, localSecret.secretKey);
} else {
    // 未注册，自动注册
    fetchConfigByAuto(hostPcIp);
}
```

---

## 七、安全性设计

### 7.1 安全边界

- **内网环境**：Node-RED 和后端部署在同一内网，不暴露到公网
- **无额外鉴权**：`/auto` 接口不鉴权，依赖内网隔离
- **secret_key 保护**：`secret_key` 只用于后续配置获取，不用于数据上报

### 7.2 风险与缓解

| 风险 | 缓解措施 |
|---|---|
| 内网其他人伪造 IP 注册 | 内网环境可信，不额外处理 |
| `secret_key` 泄露 | 只影响单个节点，可单独禁用 |
| 中间人攻击 | 内网环境，风险低；生产可启用 HTTPS |

---

## 八、边界情况处理

### 8.1 多网卡环境

- 优先选择非虚拟网卡、非 169.254/172.16/192.168.56 网段的 IPv4 地址
- 如果检测到多个有效 IP，取第一个
- 支持通过 `edge_preferredIp` 人工指定（可选）

### 8.2 端口冲突

- 同一 IP 下，`host_pc_ip` 必须唯一（数据库唯一约束）
- 如果 Node-RED 实际端口与已注册端口冲突，后端返回错误，Node-RED 提示更换端口

### 8.3 后端不可用

- 首次启动时后端不可用：Node-RED 报错退出，提示检查后端连接
- 后续启动时后端不可用：使用本地缓存配置继续采集

### 8.4 IP 变更

- 如果 PC 的 IP 变更，Node-RED 会检测到新 IP，自动注册为新节点
- 旧节点记录保留，可在「边缘节点管理」页面禁用

---

## 九、实施步骤

### 9.1 后端

1. 新增 `/plc/config/bootstrap/auto` 接口（`bootstrap_controller.py`）
2. 新增 `node_key` 生成逻辑（`pc-{ip数字}-{port}`）
3. 新增 `secret_key` 生成逻辑

### 9.2 Node-RED

1. `sf-config-manager Step 1` 增加 IP 检测和端口获取
2. 增加本地缓存读写逻辑
3. 修改启动流程：先读本地缓存，未命中则自动注册

### 9.3 数据库

1. 确认 `edge_bootstrap_key.host_pc_ip` 唯一约束
2. 无需新增表

### 9.4 前端

1. 「边缘节点管理」页面支持查看自动注册的节点
2. 支持禁用/启用节点

---

## 十、与当前方案对比

| 维度 | 当前方案（手动配置） | 新方案（自动注册） |
|---|---|---|
| 新增 PC 工作量 | 每台都要改 settings.js | 零配置 |
| 节点标识 | 人工分配 `node_key` | 自动用 `IP:端口` |
| 密钥管理 | 人工从页面获取 | 自动生成，本地保存 |
| 多实例支持 | 人工区分端口 | 自动获取实际端口 |
| 出错概率 | 高（手动配置易错） | 低（自动检测） |
| 安全性 | 节点级 secret_key | 节点级 secret_key |
| 适用规模 | 10-20 台 | 50-100+ 台 |

---

## 十一、风险与限制

1. **IP 检测准确性**：多网卡、VPN、容器环境可能检测到错误 IP，需要人工干预
2. **安全性**：`/auto` 接口无鉴权，内网任何人可注册节点，需要内网隔离
3. **IP 变更**：PC 的 IP 变更后，会注册为新节点，旧节点需要手动清理
4. **端口冲突**：同一 IP 下端口必须唯一，需要 Node-RED 启动时确保端口不冲突

---

## 十二、评审问题

请评审以下方面：

1. **架构合理性**：自动注册方案是否优于手动配置方案？
2. **安全性**：无鉴权的 `/auto` 接口在内网环境是否可接受？
3. **边界情况**：多网卡、IP 变更、端口冲突的处理是否完善？
4. **实施复杂度**：与当前手动配置方案相比，实施难度是否可控？
5. **扩展性**：未来支持 100+ 节点时，是否会出现性能或管理瓶颈？

---

**评审后请反馈：是否同意按此方案实施，或有修改建议。**
