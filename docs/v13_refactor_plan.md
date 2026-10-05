# EdgeLink V13 — 巨型 function 拆分方案

> 日期：2026-08-29
> 范围：`D:\nodered\data\flows.json` 中 V12 采集系统的 4 个超长 function
> 前提：V12 已在真机跑通，V13 只做**行为不变**的结构重构（refactor），不改任何采集语义
> v1.1 修订：并入交叉评审结论——风险重估（心跳异步化 中→高、httpClient 极低→低）、
> 新增壳层输出语义硬门槛、golden 语料来源约束、per-module feature flag、缓存读写保持同步的约束说明

---

## 一、现状盘点

### 1.1 四个巨兽（占全部 25 个 function 代码量的 87%）

| function | 位置 | 行数 | 实际职责数 |
|---|---|---|---|
| JWT解析 + nodeId + 点位发现 | sf-config-manager step2 | **535** | 6 |
| 数据管道处理 | sf-data-processor | **403** | 7 |
| IP检测 + 登录准备 | sf-config-manager step1 | **327** | 6 |
| 心跳 + 批量上报 | sf-monitor | **252** | 6 |

其余 21 个 function 全部 ≤55 行，健康，不动。

### 1.2 职责分解（每个 function 实际塞了什么）

**① JWT解析+nodeId+点位发现（535 行）**
1. JWT 解析（~10 行）
2. 本地配置缓存读取（~25 行）
3. `discoverNodeId`：心跳反查 nodeId（HTTP，~50 行）
4. `fetchTagPage`：点位分页拉取 + 200 页熔断（~70 行）
5. `processTagRecords`：**最重的一块（~250 行）**——按设备分组、protocolParams 三层合并（平铺/设备级/点位级）、MC 地址解析（W/B hex、X/Y 按系列 hex/8 进制、其余 10 进制）、计算点位分流、本机+启用过滤、缓存写盘、陈旧状态清理、双输出组装
6. `retryLogin`：登录重试状态机（指数退避 + 防重入，~80 行）

**② 数据管道处理（403 行）**
1. procGuard 防重入锁（~20 行）
2. 失败路径：状态转换 + PLC_OFFLINE 告警 + lastGood BAD 重发节流（~80 行）
3. 成功路径：状态恢复 + 恢复事件（~20 行）
4. 逐点位处理：变换（linear / slope_offset 量程映射）+ 变化触发 + 数值死区 + 质量码归一（~110 行）
5. 计算点位求值（avg/min/max/sum + 独立 lastCalc 判定）（~75 行）
6. lastGoodTags 合并 + 陈旧标记（~20 行）
7. MQTT / PG 双输出组装（~40 行）

**③ IP检测+登录准备（327 行）**
1. 单例锁（60s 过期）（~20 行）
2. 网卡 IP 检测（虚拟网卡过滤）（~55 行）
3. hostPcIp 规范化 + 机器指纹（~25 行）
4. 停用态自愈复查（bootstrap 轮询 + 缓存标记清除）（~50 行）
5. bootstrap 首拉（~75 行）
6. 默认配置 + 30+ 个 edge_* 状态初始化 + 登录请求构造（~70 行）

**④ 心跳+批量上报（252 行）**
1. `pendingOps/tryFinalSend` 手工异步计数器（pendingOps 6 处 / tryFinalSend 11 处）
2. MQTT 心跳组装（~20 行）
3. HTTP 心跳 + 401 检测 + kill switch 比对 + 缓存写回（~60 行）
4. `reportAllDevicesOnline`（~25 行）
5. `consumeDeviceComm` 批量消费（~30 行）
6. `reportPgStats`（~35 行）

### 1.3 横切问题（交叉评审已逐条对真码核实）

| 问题 | 真码实测 | 影响 |
|---|---|---|
| **HTTP 请求模板重复 10 处** | ①4 + ③2 + ④4 = 10 处 `http.request`（比最初估计的 7 还多） | 4 个 function 里约 200 行是同一模式的抄写 |
| **kill switch 缓存读写 5 处** | ①2 + ③2 + ④1 处读写 `edge_config_cache.json` | 停用逻辑改一处要改五处 |
| **edge_* 裸全局键泛滥** | ①28 键/85 处、③47 键/88 处、④27 键/46 处 | 拼写漂移、兜底怪味（如 `edge_nodeId || 999`） |
| **node.send 多输出/多形态** | ①12 次、②3 次、③8 次、④2 次；`[msg,null]` / `[null,msg]` / `[[m1,m2]]` 三种语义并存 | 抽 lib 时槽位/长度搞错是**静默串数据**的 bug |
| **零 async/await/Promise** | 4 个 function 全部纯 callback + setTimeout | ④ 的 async 化是**换并发模型**，不是收口 |
| **状态 100% 在 global** | context.get/set、flow.get/set 全部为 0 | stateStore 只包 global 即是完整模型（见 §二） |
| **node.status 分布** | ②2 次、③1 次、④2 次、①0 次 | 状态灯是壳层侧效应，lib 不许碰（见 §二） |

### 1.4 已存在的 V13 尝试（重要发现）

`D:\nodered\node-red-contrib-edgelink-core` v1.13.0 已有 3 个自定义节点雏形（`config-sync` 291 行 / `data-processor` 66 行 / `heartbeat` 68 行），但：
- **flows.json 里没有使用**（废弃或未完成的尝试）；
- `data-processor` 只有变换+死区，缺计算点位、质量码合并、comm 状态机、PG 记录——**直接换上去会丢功能**。

结论：不能指望这个旧雏形，但包壳可以复用。

---

## 二、拆分策略（推荐路线）

**纯逻辑进 npm lib，function 变薄壳；不为拆而拆，不做 big-bang。**

```
node-red-contrib-edgelink-core （改造为 lib 包，节点最多保留 1~2 个）
  lib/
    httpClient.js     requestJson({method,path,body,timeout,headers}) → Promise   ★ 消除 10 处模板
    logger.js         debug/info/warn 统一 + edge_debug 开关 + per-module 开关（见 §三 feature flag）
    stateStore.js     edge_* 键清单 + 默认值 + get/set 封装                          ★ 收口裸字符串
    netUtils.js       IP 检测 / 机器指纹 / hostPcIp 规范化
    bootstrap.js      bootstrap 拉取 + 停用态复查 + 缓存标记读写（kill switch 唯一入口）
    tagConfig.js      parseTagAddress(regType,addr,series) / mergeProtocolParams / groupByDevice
    transform.js      applyTransform(raw, tag) → {eng, quality}
    reportFilter.js   shouldReport(prev, eng, {deadband, forceInterval, triggerKind}) 
    calcTags.js       evalCalcTags(calcTags, tagValues, lastGood, lastCalc)
    commState.js      transition(prev, result) → {newStatus, events, alarms}
    retryPolicy.js    指数退避状态机（①④ 共用）
```

**注入方式**：沿用现有模式——settings.js `functionGlobalContext` 里 `edgeCore: require('.../lib')`，function 里 `var core = global.get('edgeCore')`。不开 `functionExternalModules`，不改节点结构。

**壳层边界（硬约束，评审新增）**：
- **lib 永远拿不到 `node`**。`node.send` 的输出槽位/数组形态、`node.status`、`node.warn/error` 全部由壳层显式处理；lib 需要表达侧效应时返回结构化结果（如 `{ sends: [...], status: {...}, logs: [...] }`），壳层负责落地。
- ① 的 12 种 send 形态在抽 lib 前先画一张「分支 × 输出槽位」表，壳层按表收口，不允许 lib 里出现裸 `node.send`。
- **stateStore 模型完整性已验证**：4 个 function 的 context/flow 使用为 0，状态全在 global，只包 global.get/set 不漏状态。
- **kill switch 缓存读写保持同步 API**（`readFileSync/writeFileSync`）：Node-RED 单线程事件循环内，同步读-改-写不会交错，**不需要写队列/互斥锁**。禁止在收口时顺手改成 async fs——那才会真正引入竞态。

**为什么不走"全部做成自定义节点"**：自定义节点的价值在于配置 UI 和复用性；这些逻辑是 EdgeLink 业务专用、配置全在后端下发，节点化只多一层 html 维护成本，还会重蹈 edgelink-core 雏形"功能不全没人敢换"的覆辙。lib + 薄壳 function 可以先单测、再对拍、灰度替换，每一步都可回退。

---

## 三、实施顺序（按风险从低到高，每步独立可验证）

> v1.1 风险重估：step 1 极低→**低**（共享热路径）；step 3 拆成 3a/3b，async 化 中→**高**且改为可选。

| 步 | 内容 | 涉及 | 验证方式 | 风险 |
|---|---|---|---|---|
| 1 | `httpClient` + `logger` + `stateStore` | 全部 4 个 function | **逐字节等价**：保留原 timeout 值、同样的 error 回调、header 原样、不引入重试；先一台真机对拍再铺开 | 低（共享最热路径，不等价=全系统抖动） |
| 2 | `transform` + `reportFilter` + `calcTags` + `commState` | ② 403→~50 行 | 对拍：真机录制的 result.payload 逐字节比对（覆盖清单见 §3.2） | 低（纯函数） |
| 3a | kill switch 缓存收口到 bootstrap.js（**保持同步 fs**，串行化天然成立） | ①③④ 的 5 处 | 停用/启用/重启持久化三场景演练 | 低 |
| 3b | （可选，独立任务）④ 心跳并发模型 async/Promise 化 | ④ 252→~60 行 | 心跳接口回归 + 消息时序比对 | **高（零 async 基础上换并发模型，不并入重构主线）** |
| 4 | ③ IP/bootstrap/状态初始化 | ③ 327→~50 行 | 首启/重启/IP 变更/停用自愈四场景 | 中 |
| 5 | ① JWT/nodeId/分页/点位解析/重试状态机；`tagConfig.parseTagAddress` 作**独立交付物**（含表驱动测试矩阵：W/B/X/Y × Q/L/FX/iQ-R） | ① 535→~80 行 | 分页对拍（含 200 页熔断）+ 地址解析矩阵单测 | 较高（唯一"错了不立刻崩、但长期错数据"的规则） |

### 3.1 验收硬门槛（每步必过，评审新增）

1. **壳层输出语义单测**：lib 单测不够——「输出端口数 / null 槽位 / 多消息数组 / node.status」的 bug 全在壳层。4 个壳各配 node-red-node-test-helper 用例，**逐分支断言 node.send 参数形状**（长度、槽位、payload 结构）和 node.status 调用。
2. **feature flag 灰度**：每模块一个开关（`core.flags.transform` 等），每步替换可按 function 秒级回退，不靠"观察 24h"兜底。`edge_debug` 扩展为 per-module 开关。
3. **替换前导出旧 function .bak**（从 D 盘 live flows.json 导，见下）。

### 3.2 golden 语料规则（评审新增）

- **语料只从 D 盘 live 导出**。仓库 `edge/nodered/data/flows.json` 快照是 8/23 的 17 个 function，live 已是 8/29 的 25 个——快照当基准 = 对拍对象是旧的，假绿。
- **覆盖清单**（不许只录 happy path）：离线/质量码 BAD 重发、陈旧 tag 标记、计算点位缺输入、200 页熔断、IP 变更、停用自愈、配置刷新中途 401。
- 分支没覆盖到时逐字节比对是假绿——每条对拍用例标注覆盖的分支编号。

---

## 四、二期任务：可复用节点封装（团队资产）

> 筛选标准：换一个项目/后端/业务仍然有用。V13 重构只选出 2 个达标者，其余模块一律留在 lib 不做节点。
> 依赖关系：两个节点分别包装第 2 步抽出的 `reportFilter.js` / `transform.js`，lib 稳定后才封装，因此排在数据管道重构（第 2 步）完成之后，与第 3~5 步可并行。

### 任务 6：死区上报过滤器节点（`edgelink-report-filter`，价值最高）

- **功能**：按 key（默认 `msg.topic`，可配 JSONata 表达式）独立记忆上次值；`|本次 − 上次| ≥ 死区` 放行，未超死区但距上次上报超过强制周期也放行一次，其余丢弃。
- **面板配置**：死区值、强制周期（ms）、key 表达式、（可选）非数值直接放行开关。
- **内核**：直接调 `lib/reportFilter.js`，节点只是它的 UI 壳——逻辑单测在 lib 层已完成，节点只测面板契约。
- **产出**：`node-red-contrib-edgelink-report-filter` 包（含 html 面板 + README + 示例 flow），先内部 file: 安装使用，稳定后可考虑开源。
- **验证**：对拍数据管道现有行为（死区/强制周期/变化触发三种路径），再独立发布。

### 任务 7：工程量变换节点（`edgelink-value-transform`）

- **功能**：原始值 → 工程量。支持 `linear`（y=a·x+b，slope=0 合法）与 `slope_offset`（量程映射，参数不全时输出原值 + UNCERTAIN）、精度舍入、质量码透传。
- **面板配置**：变换类型、系数/量程参数、精度位数。
- **内核**：直接调 `lib/transform.js`。
- **产出**：`node-red-contrib-edgelink-value-transform` 包。
- **验证**：同任务 6 的对拍策略。

### 明确不做节点化的（防止后续有人再提）

httpClient / logger / stateStore / bootstrap / tagConfig / retryPolicy / commState（看门狗逻辑有价值但业务耦合深，待 lib 稳定后第三期再评估）。

---

## 五、明确不做的事

- 不重写成完整自定义节点包（见 §二 理由）；
- 不动 MC 协议读取节点（`node-red-contrib-mitsubishi` 已独立成包）；
- 不动后端接口契约（本重构对后端零影响）；
- 不顺手"优化逻辑"——重构期发现疑似 bug 只记录不修改，单独立项；
- 不把 kill switch 缓存读写改成 async fs（§二 壳层边界，同步即可串行化）。
