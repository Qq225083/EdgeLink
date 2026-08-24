# SCADA 专家评审：EdgeLink 系统架构

> 评审视角：传统 SCADA 系统（WinCC / IFIX / Ignition / KingSCADA）vs EdgeLink  
> 评审标准：Purdue 模型、ISA-95 层级、工业采集最佳实践

---

## 一、Purdue 模型对照

传统 Purdue 模型把工业系统分为 5 层：

```
Level 4: ERP/MES  ──→ 不需要（你们直接发PG数据库）
Level 3: SCADA    ──→ RuoYi（配置管理 + Web UI）  ← 你们自研了
Level 2: 采集前端  ──→ Node-RED（运行在10台PC上）   ← 你们用开源实现
Level 1: PLC/DCS  ──→ 三菱PLC（100台）
Level 0: 现场设备  ──→ 传感器/执行器
```

**评价：架构正确。** Level 3（配置管理）和 Level 2（采集执行）的分离是成熟的工业设计。传统 SCADA 也是这个模型——工程站做配置，运行时做采集。

## 二、逐项评分

### 2.1 配置管理体系 ⭐⭐⭐⭐⭐

**传统 SCADA 怎么做：**
- WinCC：TIA Portal 工程 → 下载到运行站，改配置要重新编译下载
- IFIX：iFIX WorkSpace 改标签 → 保存 .SCU 文件，改配置有时要重启驱动
- Ignition：Tag Browser 在线改，立即生效（这是少数做得好的）

**EdgeLink 怎么做：**
- Web 表单改配置 → MySQL → Node-RED 30秒内自动拉取生效
- 软删除、启停开关、克隆设备、Excel 批量导入
- 改设备 IP、改采集周期、设备从 PC1 迁移到 PC2——全部在线完成

**专家评价：优于传统 SCADA。** 传统 SCADA 的配置变更往往需要"工程模式→修改→下载→重启"，EdgeLink 实现了纯在线热更新。这实际上是借鉴了 Ignition 的优秀设计理念（中心化配置 + 边缘执行），用开源组件实现了类似效果。

### 2.2 分布式采集架构 ⭐⭐⭐⭐

**设计：**
- 10 台采集 PC，每台负责 10 台 PLC
- `host_pc_ip` 字段标记设备归属
- Node-RED 启动时自动检测本机双网卡 IP
- 同一份 flow 部署到 10 台 PC，零修改

**专家评价：方向正确，但有一个工业场景缺失——冗余。**

传统 SCADA 中，采集节点通常是冗余对（Primary/Standby）。如果 PC1 宕机：
- 当前设计：PLC 1~10 停止采集，直到手动把 `host_pc_ip` 改到其他 PC
- 工业要求：PC2 自动接管 PLC 1~10 的采集任务

**建议：Phase 2 考虑「冷备」方案——在 Node-RED flow 中加入心跳检测，如果某台 PC 超过 N 秒未上报心跳，相邻 PC 自动接管其设备。不需要双机热备那么复杂，冷备 + RuoYi 手动切换已经覆盖 90% 场景。**

### 2.3 数据库设计 ⭐⭐⭐⭐⭐

**两级状态体系（status + del_flag）的设计非常工业：**

| 操作 | 传统 SCADA | EdgeLink |
|------|-----------|---------|
| 暂停采集 | 禁用驱动/删 Tag | `status='1'`，数据保留 |
| 删除设备 | 删 Tag（可能连带删历史数据） | `del_flag='2'`，配置可恢复 |
| 误删恢复 | 找备份 → 导入 | 改 `del_flag='0'` |

**索引设计也到位：** `idx_tag_device_status (device_id, status, del_flag)` 是典型的覆盖索引，Node-RED 的 `JOIN WHERE status='0' AND del_flag='0'` 查询只扫描索引不读表。

**唯一不足：缺少采集历史表。** 当前设计只存配置，不存采集数据。工业 SCADA 的核心是 Historian——你需要一张 `plc_data_log` 表来存储每次采集的原始值。

### 2.4 协议支持 ⭐⭐⭐

**已支持：** MC Protocol（三菱）、Modbus TCP（待接入）、PostgreSQL（数据存储）

**SCADA 视角的缺口：**

| 协议 | 重要程度 | 现状 |
|------|---------|------|
| OPC UA | ⭐⭐⭐⭐⭐ | 未支持。这是工业 4.0 的标准协议，西门子/倍福/罗克韦尔都支持 |
| MQTT + Sparkplug B | ⭐⭐⭐⭐ | 未支持。IoT 场景和 Ignition 都用这个 |
| Siemens S7 | ⭐⭐⭐ | 未支持。工厂里西门子 PLC 也很常见 |
| MC Protocol | ⭐⭐⭐ | 已支持 ✅ |

**建议：至少加 OPC UA 节点（`node-red-contrib-opcua`），这是未来工业通信的方向。** MC Protocol 只覆盖三菱生态，OPC UA 覆盖全品牌。

### 2.5 采集调度 ⭐⭐⭐

**当前设计：**
- 每 30 秒刷新配置
- 每 1 秒触发采集调度器
- 每个设备独立 `scan_interval_ms`

**SCADA 专家指出的问题：**

传统 SCADA 的采集不是"按间隔轮询"，而是**"按相位调度"**。举个例子：

```
100 台 PLC，每台 scan_interval_ms=1000

错误做法（你们的当前设计）：
  T=0:    同时触发 100 台 PLC 的采集  ← 网络风暴！
  T=1000: 同时触发 100 台 PLC 的采集  ← 再次风暴

正确做法（SCADA 相位调度）：
  T=0:    PLC 1
  T=10:   PLC 2
  T=20:   PLC 3
  ...
  T=990:  PLC 100
  T=1000: PLC 1（新一轮）
```

你们的 10 台 PC 每台只采 10 台 PLC，单台压力不大。但 `scan-controller` 当前是一次性遍历所有匹配设备和点位，生成 N 条消息一起发出去。**建议加入简单的交错（stagger）：`setTimeout(() => send(msg), index * 10)`**，避免同一时刻大量 MC Protocol 请求。

### 2.6 安全与审计 ⭐⭐⭐⭐

**做对了的事：**
- JWT 认证 + 8 权限码 RBAC
- 操作审计日志（`sys_oper_log`）
- 软删除（不可逆操作有后悔药）

**SCADA 视角的缺口：**
- Node-RED 本身无认证（`:1880` 任何人能打开）。如果办公网有未授权访问风险，建议开启 Node-RED 的 `adminAuth`
- `plc_device` 和 `plc_tag` 表没有「变更日志」——审计日志记录了"谁改了设备"，但没记录"改之前是什么值、改之后是什么值"。这在合规审计（如 FDA 21 CFR Part 11）中是必须的

### 2.7 数据质量 ⭐⭐

**SCADA 对数据质量有严格的要求：**

| 质量属性 | 说明 | 当前状态 |
|---------|------|---------|
| Timestamp | 数据产生的时间戳 | ✅ `new Date().toISOString()` |
| Quality | GOOD/BAD/UNCERTAIN | ⚠️ 只有字符串标记，无 OPC 标准质量码 |
| 超时处理 | 读不到数据时标记 BAD | ❌ 未实现 |
| 重试机制 | 失败后重试 N 次 | ✅ `retry_count` 字段存在，但 flow 里未用 |
| 数据缓冲 | 网络中断时本地缓存 | ❌ 未实现 |

**建议：**
1. 数据质量至少用三个状态：`GOOD`（正常）、`BAD_DEVICE`（设备无响应）、`BAD_TIMEOUT`（超时）、`UNCERTAIN`（初始值/替换值）
2. 在 `scan-controller` 中加入超时检测：如果 MC Read 超过 `comm_timeout_ms` 无响应，标记 `quality='BAD_TIMEOUT'` 并重试

### 2.8 工程化成熟度 ⭐⭐⭐⭐⭐

**这是你们的强项。** 传统 SCADA 部署：

```
WinCC:  装 SQL Server → 装 WinCC Runtime → 导入工程 → 配网络 → 启动 → 祈祷别报错
IFIX:   装 iFIX → 装驱动 → 导入 .SCU → 配 DCOM → 启动 → 调试 DCOM 权限问题
```

**你们的部署：**

```
PC 1~10: 拷贝 D:\nodered → 导入同一份 flow → 启动 → RuoYi 填 host_pc_ip → 完成
```

**评价：部署复杂度比传统 SCADA 低一个数量级。** 这是 Node-RED 作为采集前端的天然优势——它本来就是为边缘计算设计的轻量运行时。

---

## 三、传统 SCADA vs EdgeLink 对照表

| 维度 | WinCC / IFIX | Ignition | EdgeLink |
|------|-------------|----------|---------|
| 配置方式 | 工程站 → 下载 | Web 在线改 | Web 在线改 ✅ |
| 采集冗余 | 双机热备 | 双机热备 | ❌ 未实现 |
| 协议支持 | 全（西门子生态） | 全（OPC UA） | 仅三菱+Modbus ⚠️ |
| 部署复杂度 | 高（装一堆依赖） | 中（Java+模块） | 低（拷文件夹） ✅ |
| 权限审计 | 有 | 有 | 有 ✅ |
| 配置热更新 | 部分支持 | 支持 | 支持 ✅ |
| 相位调度 | 有 | 有 | ❌ 未实现 |
| 数据质量码 | OPC 标准 | OPC 标准 | 自定义简单标记 ⚠️ |
| 历史数据 | 内置 Historian | 内置 | ❌ 未实现 |
| 告警引擎 | 内置 | 内置 | ❌ 未实现 |
| 授权费用 | 数万~数十万 | 按 Tag 收费 | 开源免费 ✅ |

---

## 四、最要紧的 4 个待改进项（排序）

| 优先级 | 项 | 为什么重要 | 工作量 |
|--------|-----|----------|--------|
| **P0** | 采集历史存储 | 没有历史数据就不叫 SCADA | 1天（建表 + Node-RED 写 PG） |
| **P1** | OPC UA 支持 | 只支持三菱是致命短板，工厂不可能全是三菱 | 30分钟（装 `node-red-contrib-opcua`） |
| **P1** | 数据质量码 | 没有 BAD quality，系统不知道数据是否可信 | 2小时（scan-controller 加超时+标记） |
| **P2** | 相位调度/交错采集 | 100台PLC同时发请求会堵 | 1小时（加 stagger） |

---

## 五、总结

> **作为 SCADA 专家，我的评价是：你用 5,100 行代码 + 3 个开源组件，做到了传统 SCADA 80% 的核心能力，而且在这 3 个方面反超了传统方案——配置热更新（比 WinCC 强）、部署复杂度（比 IFIX 强）、成本（不要钱）。**

> **但要成为真正的 SCADA，还缺 4 样东西：历史数据存储、OPC UA 协议、标准数据质量码、相位调度。这 4 样加起来不到 3 天工作量。**

> **评分：核心骨架 85 分，工业完整性 65 分。方向完全正确，继续补协议和 Historian。**
