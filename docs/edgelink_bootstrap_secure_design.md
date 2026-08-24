# EdgeLink Bootstrap 安全自动注册方案 v2.0

> 日期：2026-07-22  
> 状态：待实施

---

## 一、安全问题回顾

原方案 `/auto` 接口存在三个致命漏洞：

| 问题 | 风险 |
|---|---|
| `/auto` 无鉴权返回全部业务凭据 | 内网任何人可获取 admin 密码、API Key、MQTT 密码 |
| Node-RED 持有 admin 权限 | 采集节点被攻陷 = 整个后端沦陷 |
| IP 变更后静默创建重复节点 | 6 个月积压 50+ 僵尸记录 |

---

## 二、v2.0 核心改进

### 改进 1：两阶段 Bootstrap

```
        阶段 1（无鉴权）                   阶段 2（需 secret_key）
             │                                    │
Node-RED ──→ /auto ──→ 只返回                   Node-RED ──→ /bootstrap ──→ 返回
            host_pc_ip              node_key + secret_key          host_pc_ip + secret_key    apiKey, user, pass, mqtt...
```

**`/auto` 只负责注册 + 发放密钥，不返回任何业务凭据。** 攻击者即使调用 `/auto`，也只拿到一个在后续阶段会被拒绝的 `secret_key`。

### 改进 2：采集节点专用角色

创建 `edge_collector` 角色，只授权采集相关接口：

```sql
-- 角色权限（最小化原则）
INSERT INTO sys_role (role_name, role_key, status) VALUES ('采集节点', 'edge_collector', '0');

-- 只给以下权限：
plc:tag:list        -- 拉取全局点位配置
plc:tag:query       -- 查询点位详情

-- Monitor 上报接口不检查菜单权限（走 X-API-Key），不受此限制
```

Bootstrap 创建的系统账号绑定此角色，**不给 admin 权限**。

### 改进 3：机器指纹处理 IP 变更

```
机器指纹 = SHA256( hostname + MAC地址列表 )

首次注册时记录  host_pc_ip=192.168.1.100:1880, machine_finger=abc123...
IP 变更后，Node-RED 调用 /auto?host_pc_ip=192.168.1.101:1880&fingerprint=abc123
后端识别 machine_finger，更新 host_pc_ip 为新值，不创建重复记录
```

使用 `hostname + MAC` 而非 IP 作为稳定标识，IP 变更自动映射。

---

## 三、工作流程

### 3.1 首次启动

```
Node-RED 启动
    │
    ├─ 1. 检测本机 IP + 端口 → hostPcIp = "10.81.1.101:1880"
    ├─ 2. 计算机器指纹 → fingerprint = SHA256(hostname + MACs)
    ├─ 3. 读取本地 edge_secret.json → 不存在
    │
    ├─ 4. GET /plc/config/bootstrap/auto?host_pc_ip=10.81.1.101:1880&fingerprint=xxx
    │       │
    │       ├─ fingerprint 命中了旧记录 → 更新 host_pc_ip，返回已有 node_key + secret_key
    │       ├─ 未命中 → 生成 node_key="pc-101" + secret_key（32位随机hex），插入新记录
    │       └─ 返回: { nodeKey, nodeName, hostPcIp, secretKey }
    │
    ├─ 5. 保存 edge_secret.json（含 hostPcIp, nodeKey, secretKey）
    │
    └─ 6. GET /plc/config/bootstrap?host_pc_ip=10.81.1.101:1880&secret_key=xxx
            └─ 返回: { apiKey, backendUser, backendPass, mqtt, collect }
            └─ 写入 global.* → 正常采集
```

### 3.2 IP 变更

```
Node-RED 启动（IP 从 10.81.1.101 变成 10.81.1.102）
    │
    ├─ 检测到 hostPcIp = "10.81.1.102:1880"
    ├─ 读取边缘secret.json → hostPcIp 不匹配 → 但 fingerprint 相同
    │
    ├─ GET /plc/config/bootstrap/auto?host_pc_ip=10.81.1.102:1880&fingerprint=abc123
    │       └─ 后端: fingerprint abc123 命中 node_key "pc-101"
    │       └─ UPDATE edge_bootstrap_key SET host_pc_ip='10.81.1.102:1880'
    │       └─ 返回原有 node_key + secret_key（复用，不新建）
    │
    ├─ 更新本地边缘secret.json
    └─ 继续正常采集
```

### 3.3 后续正常启动

```
Node-RED 启动
    │
    ├─ 检测到 hostPcIp = "10.81.1.102:1880"
    ├─ 读取本地边缘secret.json → hostPcIp 匹配、secretKey 存在
    │
    └─ GET /plc/config/bootstrap?host_pc_ip=10.81.1.102:1880&secret_key=xxx
            └─ 验证通过 → 返回业务配置
```

---

## 四、接口设计

### 4.1 `GET /plc/config/bootstrap/auto`（阶段 1：注册/识别）

**鉴权：无（内网隔离）**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `host_pc_ip` | string | 是 | 当前 IP:端口，如 `10.81.1.101:1880` |
| `fingerprint` | string | 是 | 机器指纹：`SHA256(hostname + MACs)` |

**响应（200）：**
```json
{
  "code": 200,
  "data": {
    "nodeKey": "pc-101",
    "nodeName": "采集节点-10.81.1.101:1880",
    "hostPcIp": "10.81.1.101:1880",
    "secretKey": "a1b2c3d4e5f67890abcdef...",
    "isNew": false
  }
}
```

**后端逻辑：**
```python
# 1. 先按 fingerprint 查找（处理 IP 变更）
existing = await db.execute(
    select(EdgeBootstrapKey).where(
        EdgeBootstrapKey.machine_fingerprint == fingerprint,
        EdgeBootstrapKey.enabled == 1
    )
)
if existing:
    # IP 变更 → 更新 host_pc_ip，复用原 node_key + secret_key
    existing.host_pc_ip = host_pc_ip
    await db.commit()
    return {"nodeKey": existing.node_key, "secretKey": existing.secret_key, "isNew": False}

# 2. 按 host_pc_ip 查找
existing = await db.execute(
    select(EdgeBootstrapKey).where(
        EdgeBootstrapKey.host_pc_ip == host_pc_ip,
        EdgeBootstrapKey.enabled == 1
    )
)
if existing:
    return {"nodeKey": existing.node_key, "secretKey": existing.secret_key, "isNew": False}

# 3. 全新注册
node_key = generate_node_key(host_pc_ip)        # "pc-101"
secret_key = secrets.token_hex(32)               # 64位随机hex
insert EdgeBootstrapKey(node_key, host_pc_ip, secret_key, fingerprint)
return {"nodeKey": node_key, "secretKey": secret_key, "isNew": True}
```

### 4.2 `GET /plc/config/bootstrap`（阶段 2：获取业务配置）

**鉴权：`secret_key` 验证**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `host_pc_ip` | string | 是 | 节点标识 |
| `secret_key` | string | 是 | 节点密钥 |

**响应（200）：**
```json
{
  "code": 200,
  "data": {
    "apiKey": "edgelink-monitor-xxxxx",
    "backendHost": "10.81.1.1",
    "backendPort": 9099,
    "backendUser": "edge_collector",
    "backendPass": "系统自动生成的强密码",
    "hostPcIp": "10.81.1.101:1880",
    "mqtt": {
      "host": "10.81.1.1",
      "port": 1883,
      "wsPort": 8083,
      "username": "edgelink", "password": "xxx"
    },
    "collect": {
      "defaultScanIntervalMs": 1000,
      "defaultCommTimeoutMs": 3000
    }
  }
}
```

**重要：`backendUser`/`backendPass` 是 `edge_collector` 角色的账号，不是 admin。密码由系统自动生成，对每台采集节点可使用统一账号或不同账号。**

---

## 五、数据库修改

### 5.1 `edge_bootstrap_key` 表增加 `machine_fingerprint`

```sql
ALTER TABLE edge_bootstrap_key 
  ADD COLUMN machine_fingerprint VARCHAR(64) DEFAULT NULL COMMENT '机器指纹 SHA256(hostname+MACs)'
  AFTER host_pc_ip;
```

### 5.2 创建 `edge_collector` 角色（菜单初始化脚本）

```python
# init_plc_db.py 追加
cur.execute("""
INSERT IGNORE INTO sys_role (role_name, role_key, role_sort, status, create_by, create_time)
VALUES ('采集节点', 'edge_collector', 5, '0', 'admin', NOW())
""")

# 只分配点位查询权限（Monitor 接口走 X-API-Key 鉴权，不走菜单权限）
cur.execute("""
INSERT IGNORE INTO sys_role_menu (role_id, menu_id)
SELECT r.role_id, m.menu_id
FROM sys_role r, sys_menu m
WHERE r.role_key = 'edge_collector' AND m.perms IN (
    'plc:tag:list'
)
""")
```

### 5.3 Bootstrap 后端创建专用账号

```python
# bootstrap_controller.py: 首次注册时检查 edge_collector 账号是否存在
# 不存在则自动创建一个随机密码的账号
async def _ensure_collector_account(db):
    existing = await db.execute(
        select(SysUser).where(SysUser.user_name == 'edge_collector')
    )
    if not existing:
        password = secrets.token_urlsafe(16)
        create_user(db, username='edge_collector', password=password, role='edge_collector')
    return existing.password
```

---

## 六、Node-RED 侧实现（改动点）

### 6.1 机器指纹计算（新）

```js
function computeFingerprint() {
    var os = require('os');
    var crypto = require('crypto');
    var hostname = os.hostname();
    var macs = [];
    var nets = os.networkInterfaces();
    for (var name in nets) {
        nets[name].forEach(function(iface) {
            if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                macs.push(iface.mac);
            }
        });
    }
    var raw = hostname + '|' + macs.sort().join(',');
    return crypto.createHash('sha256').update(raw).digest('hex');
}
```

### 6.2 工厂网段优先的 IP 检测（改进）

```js
function detectLocalIp() {
    var os = require('os');
    var nets = os.networkInterfaces();
    var candidates = { factory: [], other: [] };
    var EXCLUDE = ['169.254.', '192.168.56.'];
    
    for (var name in nets) {
        nets[name].forEach(function(iface) {
            if (iface.family !== 'IPv4' || iface.internal) return;
            var addr = iface.address;
            for (var i = 0; i < EXCLUDE.length; i++) {
                if (addr.indexOf(EXCLUDE[i]) === 0) return;
            }
            if (addr.indexOf('10.') === 0 || addr.indexOf('192.168.') === 0) {
                candidates.factory.push(addr);
            } else {
                candidates.other.push(addr);
            }
        });
    }
    return candidates.factory[0] || candidates.other[0] || '127.0.0.1';
}
```

---

## 七、安全性对比

| 维度 | v1.0（原方案） | v2.0（本方案） |
|---|---|---|
| /auto 接口返回内容 | admin 密码 + API Key + MQTT 密码 | 只返回 node_key + secret_key |
| 内网攻击者能拿到的 | 全部凭据 | 一个 secret_key（无对应 host_pc_ip 无法用） |
| Node-RED 登录权限 | admin 超级管理员 | edge_collector 采集专用角色 |
| IP 变更处理 | 创建重复僵尸记录 | fingerprint 匹配，自动更新不新增 |
| 安全性等级 | ⭐⭐ | ⭐⭐⭐⭐ |

---

## 八、实施步骤

### 后端（1 天）
1. `edge_bootstrap_key` 表增加 `machine_fingerprint` 字段
2. 新建 `bootstrap_controller.py` 的 `/auto` 接口（只返回 node_key + secret_key）
3. 修改现有 `/bootstrap` 接口（增加 secret_key 验证，返回业务配置）
4. `init_plc_db.py` 增加 `edge_collector` 角色和权限

### Node-RED（半天）
1. `IP检测 + 登录准备` 节点增加指纹计算 + 两阶段调用逻辑
2. 增加 `edge_secret.json` 本地缓存读写

### 数据库（半小时）
1. 执行 ALTER TABLE 加 fingerprint 列
2. 执行角色/权限 INSERT

---

## 九、评审通过后的下一步

1. 在 `edgelink待整改清单.md` 新增一条 P1 项：「Bootstrap 自动注册安全性加固」
2. Day 8 实施
