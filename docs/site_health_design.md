# 存量采集点监控（site-health）模块设计说明

> 用途：本文档供独立评审（AI 或人工）完整理解本模块设计，评估正确性、安全性、并发与协议设计的合理性。
> 范围：后端 `module_site_health` + 前端两个页面（采集点登记 / 采集点监控）+ Node-RED 节点 `node-red-contrib-edgelink-site-health`。

---

## 1. 背景与目标

EdgeLink 同时存在两套采集体系：

- **V12 新体系**：后端配置驱动 + MQTT + JWT 登录，Node-RED 通过 `config-manager` 拉配置。
- **存量旧版 Node-RED**：已在各车间运行的老采集程序，**不做 JWT 登录、不经 MQTT**，无法纳入 V12 的监控。

本模块为「存量采集点」提供一套**完全独立、零侵入**的健康监控：

1. 管理员在前端为每个旧版 Node-RED 采集点**登记情报**，系统生成**一次性密钥（Key）**。
2. 一个轻量 Node-RED 节点（零第三方依赖）定期采集本机运行信息，**HTTP 直连**上报后端。
3. 后端仅凭 Key 校验上报，实时记录心跳/内存/流数/版本/时长。
4. 管理端监控页展示每个采集点的在线状态与指标、心跳履历，支持重置密钥/启停/删除。

核心诉求：**让领导能监控老版采集程序的 Node-RED 是否还活着**，且**不干扰既有采集流**。

---

## 2. 总体架构

```
┌──────────────────────── 管理端（RuoYi Vue 前端） ────────────────────────┐
│  采集点登记页 (register/index.vue)      采集点监控页 (monitor/index.vue)   │
│   ─ 登记情报 → 一次性展示 Key           ─ 列表/履历/重置密钥/启停/删除      │
└──────────────────────┬───────────────────────────────┬──────────────────┘
                       │  JWT + 接口权限                │  JWT + 接口权限
                       ▼                               ▼
        ┌────────────────────────────────────────────────────────────┐
        │           FastAPI 后端  module_site_health                  │
        │  管理路由 (PreAuth)          │   上报路由 (无 JWT，仅 Key+限流)│
        │  /site-health/site ...      │   /site-health/report         │
        └──────────────┬─────────────────────────────▲────────────────┘
                       │ SQLAlchemy(async)            │ Key 校验 + IP/Key 双层限流
                       ▼                              │
        ┌──────────────────────────┐    ┌─────────────┴──────────────┐
        │  MySQL (ruoyi 库)         │    │  旧版 Node-RED              │
        │  site_health_site         │    │  site-health 节点           │
        │  site_health_heartbeat_log│    │  (HTTP 直连，Bearer Key)    │
        └──────────────────────────┘    └────────────────────────────┘
```

**关键解耦点**：上报链路**不依赖** V12 的 `config-manager` / MQTT / JWT，仅凭登记时下发的一次性 Key，零第三方依赖，兼容 Node-RED >= 1.0。

---

## 3. 数据模型（MySQL）

### 3.1 `site_health_site` — 采集点登记表

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT PK | 采集点 ID |
| site_key_hash | VARCHAR(64) UNIQUE | 密钥的 SHA-256 哈希（明文仅创建/重置时返回一次） |
| office_ip | VARCHAR(20) NOT NULL | 办公网 IP |
| indust_ip | VARCHAR(20) NULL | 工业网 IP（选填） |
| site_name | VARCHAR(100) NOT NULL | 采集场所 |
| contact | VARCHAR(50) | 联系人 |
| remark | VARCHAR(200) | 采集备注 |
| **node_port** | INT NULL | Node-RED 监听端口（登记/编辑时 API 层强制必填，办公网 IP+端口唯一；DB 列保持可空以兼容存量数据，心跳上报自动校准） |
| heartbeat_interval | INT DEFAULT 30 | 心跳间隔秒（节点上报，10–180） |
| status | SMALLINT DEFAULT 1 | 0 停用 / 1 启用 |
| last_heartbeat | DATETIME | 最后心跳时间 |
| report_ip | VARCHAR(50) | 最近上报来源 IP（纯 IP，不拼端口） |
| memory_rss_mb / memory_total_mb / memory_free_mb | INT | 最近一次心跳的内存指标 |
| running_flows | INT | 运行流数量 |
| node_red_version | VARCHAR(20) | Node-RED 版本 |
| uptime_sec | BIGINT | Node-RED 运行时长（秒） |
| created_at / updated_at | DATETIME | 时间戳 |

### 3.2 `site_health_heartbeat_log` — 心跳履历表

| 列 | 说明 |
|---|---|
| id | 日志 ID |
| site_id (INDEX) | 采集点 ID |
| report_time (INDEX) | 上报时间 |
| report_ip | 上报来源 IP |
| memory_rss_mb / memory_total_mb / memory_free_mb | 内存指标快照 |
| running_flows / node_red_version / uptime_sec | 其他指标快照 |

> 注意：`create_all` 只会建新表，**不会**给已有库补列/补索引。需手工建库时执行 `docs/site_health_init.sql`（两表合一，幂等）；已有旧表的库执行 `docs/migration_site_health_node_port.sql`（补 `node_port` 列）等迁移脚本。

---

## 4. 后端接口契约

### 4.1 管理端接口（需 JWT `PreAuth` + 接口权限）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/site-health/site` | `site:health:add` | 登记采集点，返回 `{siteId, key}`（key 仅一次） |
| GET | `/site-health/site/list` | `site:health:list` | 分页列表（含在线状态与最新指标），支持 `state` 状态过滤 |
| GET | `/site-health/site/summary` | `site:health:list` | 状态统计（总数/在线/离线/未接入/已停用），供一览卡片 |
| GET | `/site-health/site/{id}/history` | `site:health:list` | 心跳履历（倒序，limit 默认 200、≤500，支持 offset 加载更多） |
| PUT | `/site-health/site/{id}` | `site:health:edit` | 编辑情报字段（IP/端口/场所/联系人/备注），不动密钥，改 IP+端口时查重 |
| PUT | `/site-health/site/{id}/regenerate` | `site:health:edit` | 重置密钥，旧 key 立即失效 |
| PUT | `/site-health/site/{id}/status` | `site:health:edit` | 启停（`enabled` 0/1） |
| DELETE | `/site-health/site/{ids}` | `site:health:remove` | 删除（逗号分隔多 ID，连带履历） |

### 4.2 上报接口（无 JWT，仅 Key + 限流）

`POST /site-health/report`

- **认证**：`Authorization: Bearer <key>`（优先），兼容 query 参数 `?key=...`（保留）。
- **绑定校验**：Key 与登记情报绑定——上报来源 IP 必须等于登记的办公网 IP（或工业网 IP），且节点上报端口（uiPort）与登记端口一致，否则拒绝（防 Key 错配/盗用、登记信息与实际部署脱节）。
- **入参**（query）：`interval, memory_rss_mb, memory_total_mb, memory_free_mb, running_flows, node_red_version, uptime_sec, node_port`。
- **出参**（统一 HTTP 200，业务结果在 `data` 里）：
  - 成功：`{ok: true, disabled: false, site_id: N}`
  - 密钥无效：`{ok: false, disabled: false, reason: "invalid_key"}`
  - 已停用：`{ok: false, disabled: true, reason: "disabled"}`
  - IP 不符：`{ok: false, disabled: false, reason: "ip_mismatch"}`（节点亮红灯停止，需人工核对）
  - 端口不符：`{ok: false, disabled: false, reason: "port_mismatch"}`（登记端口 ≠ 节点 uiPort，同上处理）

> **为何统一 HTTP 200**：项目约定 `ServiceException` → HTTP 200 + `body.code = 500`。因此节点**不能只看 HTTP 状态码**，必须解析 `data.ok / disabled / reason` 才能正确区分「密钥无效」「已停用」「成功」。

### 4.3 限流（内存双层，无外部依赖）

| 维度 | 阈值 | 窗口 | 目的 |
|---|---|---|---|
| 按 IP | 600 次/分 | 60s | 粗防泛洪（高阈值，不误伤同 IP 多实例） |
| 按 Key | 20 次/分 | 60s | 每采集点精确限流（同 IP 多实例互不干扰） |

- 实现：内存字典 `{bucket_key: [timestamps]}`，桶数上限 10000，超限触发全量清理过期条目（防慢内存泄漏）。
- 心跳正常频率 ≤ 6 次/分（最短 10s 间隔），Key 配额 20/分留出重试/突发余量。

### 4.4 密钥生成与校验

- `key = secrets.token_hex(16)`（128-bit 高熵随机）。
- 存储 `sha256(key)`（**无盐**，对高熵随机 token 正确，无需加盐）。
- 明文 key **仅**在登记/重置响应中返回一次。

---

## 5. 前端页面 1：采集点登记（register）

- 路由/菜单：EdgeLink 系统目录（menu_id=2083）下的二级目录「存量监控」（menu_id=3000，与「采集配置」同级）→ `register`（完整 URL `/edgelink/site-health/register`）→ 组件 `plc/siteHealth/register/index`，权限 `site:health:add`。
- **表单字段**：

| 字段 | 必填 | 校验 |
|---|---|---|
| 办公网 IP | ✅ | 严格 IPv4（0–255 四段，前端正则 + 后端 `ipaddress` 双重校验） |
| 工业网 IP | 选填 | 严格 IPv4（同上） |
| **端口** | ✅ | 1–65535 整数（办公网 IP + 端口唯一标识一个采集点，用于区分同 IP 多实例） |
| 采集场所 | ✅ | 非空 |
| 联系人 | 选填 | — |
| 采集备注 | 选填 | textarea，≤200 字 |

- **提交流程**：`POST /site-health/site` → 成功后弹「一次性密钥」对话框（采集点 ID + Key）→ 复制按钮（clipboard API + `execCommand` 回退）→ 关闭后**内存抹除** key（`newKey = ''`）。
- **登记查重**：同一「办公网 IP + 端口」视为同一实例，重复登记直接拒绝（返回已存在的采集点 ID），避免旧 Key 的僵尸行一直显示「未接入」。
- **端口字段语义**：登记时必填 Node-RED 实例端口；节点心跳上报时按 `uiPort` 自动校准（见 §7）。

---

## 6. 前端页面 2：采集点监控（monitor）

- 路由/菜单：EdgeLink 系统目录（menu_id=2083）下的二级目录「存量监控」（menu_id=3000，与「采集配置」同级）→ `monitor`（完整 URL `/edgelink/site-health/monitor`）→ 组件 `plc/siteHealth/monitor/index`，权限 `site:health:list`。
- **一览卡片**：顶部 5 张渐变色 KPI 卡（总数/在线/离线/未接入/已停用，复用 V12 监控页视觉语言），点击卡片即按状态过滤列表，再点一次回到全部；卡片数据来自 `GET /site/summary`。
- **查询**：关键字模糊（采集场所/办公 IP/工业 IP/联系人）。
- **列表列**：勾选、采集场所、办公网 IP、工业网 IP、**端口**、联系人、状态、最近心跳、心跳间隔、进程内存、整机已用、运行流、运行时长、上报 IP。
- **状态标签判定**（优先级从高到低）：
  1. `status === 0` → 「已停用」
  2. `!hasReported`（从未上报）→ 「未接入」
  3. `isOnline` → 「在线」
  4. 否则 → 「离线」

- **在线判定**：`lastHeartbeat` 距今 < `3 × heartbeatInterval`（间隔默认 30s，即 90s 内未上报判离线）。
- **自动刷新**：页面每 30s 静默轮询一次列表（不闪 loading），离开页面自动清理定时器。
- **操作**：查看履历（抽屉）、**修改情报**（对话框，不动密钥）、重置密钥、启停、删除、批量删除。
- **心跳履历抽屉**：上报时间 / 上报 IP / 进程内存 / 整机已用 / 运行流 / 版本 / 运行时长（倒序，每页 200 条，支持「加载更多」翻历史）；**断点自动标红**：相邻两条间隔 > 3×心跳间隔时，较新一条标红并带「断」徽标（期间节点离线/停用/断网），排查断线时段一目了然。

---

## 7. Node-RED 节点（node-red-contrib-edgelink-site-health）

### 7.1 节点配置表单（site-health.html）

| 字段 | 默认 | 说明 |
|---|---|---|
| 名称 | 采集点健康度 | 显示名 |
| 服务器 IP | 必填 | EdgeLink 后端地址（或反代地址） |
| 端口 | 80 | 后端端口 |
| 接口路径前缀 | 空 | 系统在子目录/反代下填前缀（如 `/prod-api`），直连留空 |
| 心跳频率 | 30 | 10–180 秒 |
| 使用 HTTPS | false | 后端 TLS 时勾选（仅支持受信任 CA 证书；自签名证书握手失败会一直退避，改用 HTTP 或系统层信任证书） |
| 密钥 Key | — | **credential** 存储，仅一次显示 |

> Key 走 Node-RED `credentials` 机制，存于 `flows_cred.json`，**不写入** `flows.json`（导出/快照自动脱敏）。

### 7.2 运行时行为（site-health.js，零第三方依赖）

**采集指标（collect）**：

| 指标 | 来源 |
|---|---|
| memory_rss_mb | `process.memoryUsage().rss` |
| memory_total_mb / free_mb | `os.totalmem()` / `os.freemem()` |
| running_flows | `RED.nodes.eachNode` 按 `n.z` 去重计数 |
| node_red_version | `RED.version()` / `RED.settings.version` |
| uptime_sec | `process.uptime()` |
| **node_port** | `RED.settings.uiPort`（多实例区分） |

**上报（send）**：`HTTP POST {basePath}/site-health/report?<指标query>`，`Authorization: Bearer <key>`，超时 5s。

**响应处理（parseResult + handleResponse）**：

| 后端返回 | 节点动作 | 状态灯 |
|---|---|---|
| `data.ok` 且非 invalid_key/disabled | 正常，按 `interval` 排下次 | 🟢 绿 |
| `data.reason === "invalid_key"` 或 HTTP 401/403 | **停止**（重试不会自愈） | 🔴 红 |
| `data.reason === "ip_mismatch"` | 低频重探（300s），服务端改回登记后自动恢复 | 🟡 黄 |
| `data.reason === "port_mismatch"` | 低频重探（300s），同上 | 🟡 黄 |
| `data.disabled === true` | 低频重探（300s），等待前端重新启用 | 🟡 黄 |
| 连接失败 / 服务端异常 / 限流 | 指数退避重试 | 🟡 黄 |

**调度与健壮性**：

- `setTimeout` 链式调度 + `inFlight` 守卫，天然不重叠（不会因响应慢导致心跳并发）。
- 失败退避：`delay = min(300, interval × 2^(连续失败次数−1))`，封顶 5 分钟。
- `on('close')` 清理定时器，避免 redeploy 后心跳翻倍。
- 全部 `try/catch`，异常只走 `node.error/status`，**不向上抛**导致进程崩溃。
- 只读旁观，不触碰既有采集消息流。

### 7.3 安装

```bash
# 在旧版 Node-RED 目录里
npm install /path/to/node-red-contrib-edgelink-site-health
# 或
npm install node-red-contrib-edgelink-site-health-1.0.3.tgz
# 重启 Node-RED 后，左侧「功能」类找到「采集点健康度」节点
```

---

## 8. 关键设计决策与理由

| 决策 | 理由 |
|---|---|
| 上报不走 JWT/MQTT，仅凭 Key | 与 V12 完全解耦，兼容旧版 Node-RED（无登录逻辑） |
| Key 走 Authorization 头 | 不落 URL，避免进入反代访问日志 |
| 统一 HTTP 200 + body 业务码 | 符合 RuoYi 项目既有错误处理约定，节点必须解析 body |
| 双层限流（IP 粗 + Key 精） | 同 IP 多 Node-RED 实例（8000/8001）互不误伤 |
| `node_port` 独立成列 | 区分同 IP 多实例；登记必填（IP+端口唯一），存量行由心跳回填，report_ip 保持纯 IP |
| `basePath` 前缀 | 系统部署在子目录/反代（如 `/prod-api`）时路径可配 |
| 心跳履历 `report_time` 建索引 + 7 天清理 | 履历倒序查询与容量控制 |
| Key 一次性显示 + 内存抹除 | 防止密钥泄露后无法追溯 |

---

## 9. 安全设计

1. 密钥 128-bit 高熵随机，SHA-256 无盐存储（哈希不可逆，无法从库反推明文）。
2. 明文 Key 仅登记/重置时返回一次，前端关闭对话框即抹除内存。
3. 上报接口无登录态，靠 Key 校验 + 双层限流防暴力枚举/泛洪。
4. **Key 与登记情报绑定**：上报来源 IP 必须等于登记的办公网 IP（或工业网 IP），否则拒绝（`ip_mismatch`）；节点上报端口（uiPort）须与登记端口一致，否则拒绝（`port_mismatch`）。防止 Key 错配/盗用到其他机器、登记信息与实际部署脱节导致的数据串台、假在线。
5. 列表接口**永不下发** `siteKeyHash`（`row.pop('siteKeyHash')`）。
6. Node-RED 侧 Key 走 credential 机制，不入 `flows.json`。

---

## 10. 已知边界 / 待评审项

> 以下为**尚未完全收敛**的点，供评审重点把关：

1. ~~**反代下真实 IP**~~：**已确认不适用**。当前部署拓扑中节点**直连后端端口**上报（不经 nginx），`request.client.host` 即采集机真实 IP，IP 绑定与 IP 限流都工作正常；仅若伊前后端管理流量经 nginx。若未来把上报口也挪到反代之后，uvicorn 启动必须加 `--proxy-headers --forwarded-allow-ips <代理IP>`，否则所有上报会因 `ip_mismatch`（§9.4）被拒。
2. **`node_port` 自动回填依赖 `uiPort`**：若各实例 `settings.js` 未设置不同 `uiPort`（或都默认 1880），自动检测返回 0/1880，此时只能依赖登记时**手动填写的端口**来区分实例。
3. **内存限流非分布式**：后端若多进程/多 worker 部署，限流桶按进程独立，阈值会按 worker 数放大。单 worker 部署无影响。
4. **`create_all` 不迁移老表**：新增列/索引需手动执行迁移脚本（`docs/migration_site_health_node_port.sql`）。
5. ~~**心跳日志 7 天清理是否已挂调度**~~：**已接入**。内置任务 `builtin_clean_site_health_heartbeat_logs`（`config/get_scheduler.py:194`，每天 03:30 执行，`module_task/site_health_task.py`），无需额外配置。

---

## 11. 目录清单

| 层 | 位置 |
|---|---|
| 后端实体 | `ruoyi-fastapi-backend/module_site_health/entity/do/site_health_do.py` |
| 后端 VO | `ruoyi-fastapi-backend/module_site_health/entity/vo/site_health_vo.py` |
| 后端 DAO | `ruoyi-fastapi-backend/module_site_health/dao/site_health_dao.py` |
| 后端服务 | `ruoyi-fastapi-backend/module_site_health/service/site_health_service.py` |
| 后端控制层 | `ruoyi-fastapi-backend/module_site_health/controller/site_health_controller.py` |
| 前端登记页 | `ruoyi-fastapi-frontend/src/views/plc/siteHealth/register/index.vue` |
| 前端监控页 | `ruoyi-fastapi-frontend/src/views/plc/siteHealth/monitor/index.vue` |
| 前端 API | `ruoyi-fastapi-frontend/src/api/plc/siteHealth.js` |
| Node-RED 节点 | `packages/node-red-contrib-edgelink-site-health/` |
| 建表脚本（两表合一，手工建库用） | `docs/site_health_init.sql` |
| 菜单初始化（EdgeLink 目录下二级目录「存量监控」+ 两个页面 + 按钮权限） | `docs/site_health_menu_init.sql` |
| 迁移脚本（已有旧表补 `node_port` 列） | `docs/migration_site_health_node_port.sql` |
