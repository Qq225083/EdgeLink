# EdgeLink — 多PC分布式部署方案

> 最后更新：2026-06-07  
> 场景：10台双网口PC，每台负责采集10台PLC，共100台PLC  
> 核心设计：同一份 Node-RED flow 部署到10台PC，启动时自动识别本机身份，零修改

---

## 一、部署拓扑

```
                        ┌─────────────────────────┐
                        │  RuoYi 服务器 (1台)       │
                        │  管理100台设备 + 5000点位  │
                        │  权限/审计/Web UI         │
                        └────────────┬────────────┘
                                     │ MySQL/PostgreSQL
                        ┌────────────┴──────────────┐
                        │     办公网络 (NIC1)         │
        ┌───────┬───────┼───────┬───────┬──────────┤
        ▼       ▼       ▼       ▼       ▼          ▼
    ┌──────┐┌──────┐┌──────┐     ┌──────┐    ┌──────┐
    │ PC1  ││ PC2  ││ PC3  │ ... │ PC9  │    │ PC10 │
    │NIC1: ││NIC1: ││NIC1: │     │NIC1: │    │NIC1: │
    │.1.1  ││.1.2  ││.1.3  │     │.1.9  │    │.1.10 │
    │NIC2: ││NIC2: ││NIC2: │     │NIC2: │    │NIC2: │
    │PLC网 ││PLC网 ││PLC网 │     │PLC网 │    │PLC网 │
    └──┬───┘└──┬───┘└──┬───┘     └──┬───┘    └──┬───┘
       │ NIC2  │ NIC2  │ NIC2        │ NIC2      │ NIC2
       ▼       ▼       ▼             ▼           ▼
    ┌──────┐┌──────┐┌──────┐     ┌──────┐    ┌──────┐
    │PLC   ││PLC   ││PLC   │     │PLC   │    │PLC   │
    │1~10  ││11~20 ││21~30 │     │81~90 │    │91~100│
    └──────┘└──────┘└──────┘     └──────┘    └──────┘
```

---

## 二、核心设计：`mes_ip` 做设备归属路由

### 2.1 为什么用 `mes_ip` 而不是加新字段

`plc_device` 表已有 `mes_ip` 字段（VARCHAR(50)），原本设计含义是"MES/MDPS 对接 IP"。在实际部署中该字段未使用（全部为 NULL），且工厂没有独立的 MES 服务器——采集后的数据直接发送到上位 PostgreSQL 数据库。

因此直接复用 `mes_ip` 字段，语义重新定义为"**负责采集该 PLC 的 PC 地址**"。无需 ALTER TABLE。

### 2.2 数据配置

在 RuoYi 后台的设备编辑表单中，`mes_ip` 填入对应采集 PC 的办公网 IP：

```
PLC 1~10:  mes_ip = 192.168.1.1    ← 归 PC1 采集
PLC 11~20: mes_ip = 192.168.1.2    ← 归 PC2 采集
PLC 21~30: mes_ip = 192.168.1.3    ← 归 PC3 采集
...
PLC 91~100: mes_ip = 192.168.1.10  ← 归 PC10 采集
```

---

## 三、Node-RED Flow：自动识别本机 IP

### 3.1 双网口识别逻辑

每台 PC 有两个物理网口：

| 网口 | 连接 | IP 示例 | 用途 |
|------|------|---------|------|
| NIC1 | 办公网 | `192.168.1.x` | 访问 MySQL/PG 数据库 |
| NIC2 | PLC 网络 | `10.81.8.x` | 通过 MC Protocol 连接 PLC |

Flow 启动时，自动检测本机所有网络接口，**按网段精确匹配 NIC1 的 IP**：

```javascript
// detect-host-ip 节点的核心逻辑
const os = require('os');
const nets = os.networkInterfaces();

const TARGET_SUBNET = '192.168.1';  // 办公网段

for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
            if (net.address.startsWith(TARGET_SUBNET)) {
                myIP = net.address;  // 匹配到办公网IP
                break;
            }
            if (!myIP) myIP = net.address;  // 兜底：取第一个非虚拟IP
        }
    }
}
```

**为什么不会误识别 NIC2**：NIC2（PLC 网络）的 IP 网段是 `10.x.x.x` 或其他，不匹配 `192.168.1` 前缀，被跳过。虚拟网卡（WSL/Hyper-V）的 `internal` 属性为 true，也被跳过。

### 3.2 自动分流 SQL

识别到本机 IP 后，存入 flow 上下文，SQL 查询自动过滤：

```sql
-- PC1 上执行的 SQL（myIP = 192.168.1.1）
SELECT ...
FROM plc_device d JOIN plc_tag t ON d.id = t.device_id
WHERE d.status = '0' AND d.del_flag = '0'
  AND t.status = '0' AND t.del_flag = '0'
  AND d.com_type = 'MC_Protocol'
  AND d.mes_ip = '192.168.1.1'    -- ← 自动替换为本机IP
ORDER BY d.id, t.sort_order, t.id
```

```sql
-- PC2 上执行的 SQL（myIP = 192.168.1.2）
...
  AND d.mes_ip = '192.168.1.2'    -- ← 同一份flow，不同IP
```

### 3.3 完整 Flow 结构

```
┌─ 启动时一次 ─→ [detect-host-ip] ──────────────────────┐
│   自动检测本机 192.168.1.x，存入 flow.host_pc_ip        │
└────────────────────────────────────────────────────────┘
                            │
┌─ 每30秒 ─→ [SQL: WHERE mes_ip=$host_pc_ip] ─→ [MySQL] ─→ [存flow上下文] ─→ [Debug]
│   动态刷新配置，只拉取归本PC采集的设备+点位               │
└────────────────────────────────────────────────────────┘
                            │
┌─ 每1秒 ─→ [采集调度器] ─→ [模拟PLC生成器] ─→ [数据格式化] ─→ [Debug]
│   按每个设备的 scan_interval_ms 独立调度                  │
│   真实PLC上线后替换为 [MC Read] 节点                      │
└────────────────────────────────────────────────────────┘

┌─ GET /api/plc/data ─→ [返回本PC负责的设备列表+点位统计] ─→ [HTTP Response]
```

**10 台 PC 导入完全相同的 flow JSON，零手动修改。**

---

## 四、设备迁移：无需碰 flow

场景：PLC5 需要从 PC1 迁移到 PC2 采集。

| 步骤 | 操作 | 对 Node-RED 的影响 |
|------|------|-------------------|
| 1 | RuoYi → 设备管理 → PLC5 → 编辑 | — |
| 2 | `mes_ip` 从 `192.168.1.1` 改为 `192.168.1.2` | — |
| 3 | 保存 | PC1 下次刷新(≤30s)：自动停止采集 PLC5 |
| 4 | — | PC2 下次刷新(≤30s)：自动开始采集 PLC5 |

**不需要 SSH 到任何 PC、不需要改 flow、不需要 Deploy。**

---

## 五、新增 PC 的部署步骤

新加第 11 台 PC（192.168.1.11），负责 PLC 101~110：

```
1. 硬件接线:
   NIC1 → 办公网交换机
   NIC2 → PLC 网络交换机

2. 拷贝 D:\nodered 到新PC（或重新安装 Node.js + npm install）

3. 导入同一份 nodered_plc_full_flow.json

4. 双击启动（自动检测本机IP = 192.168.1.11）

5. RuoYi 后台: PLC 101~110 的 mes_ip 填入 192.168.1.11

6. 完成 — 30秒内新PC开始采集
```

---

## 六、与上一版 flow 的差异

| 节点 | 旧版 | 新版 |
|------|------|------|
| 启动 | 无 | **新增** `detect-host-ip`：自动检测本机办公网 IP |
| SQL 过滤 | `WHERE ... AND d.com_type = 'MC_Protocol'` | **加了** `AND d.mes_ip = '${myIP}'` |
| 设备归属 | 无 | 通过 `plc_device.mes_ip` 标记归属 PC |
| 多PC部署 | 需要手动改 10 份 flow 的 IP | **同一份 flow，零修改** |

### SQL 变化对照

```diff
- AND d.com_type = 'MC_Protocol'
+ AND d.com_type = 'MC_Protocol'
+ AND d.mes_ip = '${myIP}'
```

其中 `myIP` 由 `detect-host-ip` 节点在启动时自动获取并存入 `flow.host_pc_ip`。

---

## 七、待验证点（请测评 AI 关注）

1. **双网口识别可靠性**：Windows 上 `os.networkInterfaces()` 返回的接口名称和顺序在不同 PC 上是否一致？NIC1 是否始终能被 `192.168.1` 前缀匹配到？

2. **IP 变更场景**：如果 PC 的 NIC1 IP 因 DHCP 更换（如从 192.168.1.5 变成 192.168.1.50），Node-RED 需要重启才能重新检测。是否需要在 flow 中加入定期刷新本机 IP 的机制？或者生产环境建议 NIC1 使用静态 IP？

3. **mes_ip 语义复用**：用 `mes_ip` 做"采集 PC 归属"在语义上是否会造成混淆？是否值得加一个独立字段 `host_pc_ip` 来明确含义？

4. **`mes_ip` 为空的历史数据**：如果某 PLC 的 `mes_ip = NULL`，SQL 中 `d.mes_ip = '192.168.1.1'` 不会匹配到它，该设备不会被采集——这是期望行为。但需要确保新增设备时前端提醒填写此字段。

5. **SQL 注入风险**：`d.mes_ip = '${myIP}'` 中 `myIP` 来自 `os.networkInterfaces()` 的返回值，是系统 API 提供的 IP 地址字符串（如 `192.168.1.1`），不是用户输入。但仍是模板字符串拼接。是否需要改为参数化查询？
