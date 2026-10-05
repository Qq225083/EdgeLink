# EdgeLink 过渡版（流程生成器）实施计划 — 2026-09-28

> 目标：后端配置 → 生成纯现成节点的 flows.json → 下载 / Admin API 自动部署。
> 约束：采集业务逻辑零自研节点（只用核心节点 + 社区公开节点）；北向契约（MQTT/PG）逐字节不变。
> 终局：V14 数据驱动 flow（本版为合规铺路，部署管道、生成器、对拍体系全部带入 V14）。

## 一、总体架构

```
若伊后端（配置真相源）
  plc_device / plc_tag / plc_driver          ← 现有配置表，不动
  plc_config_snapshot                        ← 发布即版本，生成依据
  [新] module_flowgen
    ├─ 生成器（Jinja2 模板渲染 flows.json）
    └─ 部署服务（Node-RED Admin API 客户端）
        │  ① 下载 flows.json（手工导入，先行落地）
        │  ② POST /flows 自动部署（第二步）
        ▼
边缘 Node-RED（画布 = 完整目标状态，全量替换）
  ├─ GEN_采集_<设备名> × N（一 PLC 一条独立支路）
  └─ GEN_基础设施（site-health 上报节点等固定件）
```

关键模型：**生成的 flow = 该现场画布的完整目标状态**。部署即全量替换（带 rev），不做"合并保留"——生成器管全部，就没有遗漏 tab 的事故。

## 二、生成 flow 画布规范

1. **一 PLC 一条独立支路**：`inject（独立周期）→ MC Read → 契约装配 → filter（死区）→ mqtt out / postgres`；
2. **连接不共享**：每台 PLC 生成独立的 `MC Protocol Connection` config 节点（社区节点内部按 host:port 自建连接池，独立 config 节点 = 独立连接）；
3. **错误分流**：MC Read 设 `errorHandling = output2`（错误走第二输出脚），第二脚接告警支路（template → mqtt out）；支路下游节点由支路级 catch 兜底；
4. **命名即台账**：节点名全部取自配置表（`[冲压线1] MC读取`），tab 名 `GEN_采集_<设备名>`，基础设施 tab 固定名 `GEN_基础设施`；
5. **分组框**：同支路节点圈 group 框并标设备名；设备 > 30 台时一 PLC 一个 tab；
6. **topic 前缀带版本**：`edgelink/gen/data/...`，与在跑的 V12/V13（`edgelink/data/...`）隔离，切流期间可并行对拍；
7. **粒度纪律**：支路到 PLC 级，点位处理在支路内部 JSONata 批量完成——禁止每点位一个节点（500+ 节点会撞部署性能墙）。

## 三、节点选型与版本锁定

| 用途 | 节点 | 版本 | 说明 |
|---|---|---|---|
| MC 读取 | `MC Read`（node-red-contrib-mcprotocol-ind） | 锁定 1.7.5 | 原版 Steve-Mcl 的维护分支 |
| MC 连接 | `MC Protocol Connection`（同上 config 节点） | 同上 | host/port/frame/PLCStation/network/timeout/octalInputOutput |
| Modbus | node-red-contrib-modbus（`modbus-read` + `modbus-client`） | 锁最新 5.x | 过渡版首批不做，模板预留 |
| PG 写库 | node-red-node-postgres | 锁定版本 | 无 spool，断库丢数已知接受 |
| 其余 | inject / change / switch / filter / template / mqtt / catch / group | 核心内置 | — |

边缘镜像 vendor 全部 node_modules，锁定 Node-RED 版本，禁止现场自行装节点。

**已核实的社区 MC 节点事实**（读源码确认，见 `社区MC节点核实记录.md`）：
- 连接池按 host:port 分键（`connection_pool.js`）——独立 config 节点即独立连接；
- 读节点自带 busy 闸（`if (node.busy) return`，丢重复触发）与超时处理（取连接 timeout）；
- 输出 JSON 对象按地址字符串作 key，或 Array；带 `msg.quality` / `msg.isGood`；
- 连接 config 有 `octalInputOutput` 选项——FX 系列 X/Y 八进制地址在**连接级**正确处理，我们记录在案的 V12 怪癖④（字母剥除）在生成版不存在；
- 支持 msg 控制：`topic=connect/disconnect/reinitialize`。

## 四、功能映射（与业务方签字确认）

| 功能 | 过渡版实现 | 状态 |
|---|---|---|
| MC 轮询采集 | inject + MC Read（一 PLC 一支路） | ✅ 保留 |
| 线性换算 y=ax+b | change + JSONata，系数编译期固化 | ✅ 保留且参数可视 |
| 死区过滤 | filter 节点（按 topic 分状态） | ✅ 保留；每点位不同死区→按阈值分组建多个 filter，或降级为设备级统一阈值（**待业务选**） |
| MQTT/PG 双路上报 | mqtt out + postgres | ✅ 保留 |
| 北向契约结构 | 契约装配段（template/JSONata 逐字段映射回 V13 结构，含质量码映射表 `isGood→GOOD/BAD`） | ✅ 必须逐字节等价，对拍验证 |
| 块读合并 | **生成期完成**：生成器把同设备连续同类型地址聚类成块读地址串 | ✅ 从运行期移到编译期 |
| 强制周期补报（report_force_interval_ms） | 无现成语义 | ❌ 丢失（签字确认） |
| 质量码三态 / UNCERTAIN 补标 | 映射为 GOOD/BAD 两态 | ⚠️ 降级（签字确认） |
| 计算点（calc_op） | 无 | ❌ 丢失（签字确认） |
| PG 断库 spool | 无 | ❌ 丢失（签字确认；可选 file 节点补偿流，二期再议） |
| kill switch | 部署服务反向能力兜底（停采 = 推一版停用流） | ⚠️ 语义变化 |
| site-health 上报 | 生成流自带（见下） | ✅ 保留 |

### site-health 节点入生成流的三条铁律
1. 节点 id 确定性生成（`sh_` + site_id 哈希），跨版本不变；
2. Key 字段（credential）在生成 JSON 中**整个属性省略**——运行时按节点 id 保留已录入凭证；
3. 首次部署后人工在编辑器录入一次 Key（后端只存 SHA-256 哈希，拿不出明文，无法自动注入），写进现场 SOP。

## 五、后端改造清单（新模块 module_flowgen）

```
module_flowgen/
  entity/do/    flow_release_do.py / flow_deploy_log_do.py
  entity/vo/    ...
  dao/          ...
  service/
    generator_service.py   # 读快照 → Jinja2 渲染 → 存 plc_flow_release
    deploy_service.py      # Admin API：登录取 token → GET /flows(rev) → POST /flows(rev, nodes)
    templates/             # tab_mc.j2 / branch_mc.j2 / tab_infra.j2（site-health）
  controller/   flowgen_controller.py
```

接口：
- `POST /plc/flowgen/generate`（site_id）→ 生成新版本（绑定当前快照版本，sha256 幂等：内容不变不重复建版本）
- `GET  /plc/flowgen/release/list|{id}` / `GET /plc/flowgen/release/{id}/download`
- `POST /plc/flowgen/deploy`（release_id）→ 部署履历写 plc_flow_deploy_log
- `POST /plc/flowgen/rollback`（site_id, 目标 release_id）→ 重推旧版本
- 部署目标解析：`site_health_site.office_ip : node_port`；Admin 凭证存 site_health_site 新列（AES 加密，见 SQL）

前端（挂 EdgeLink(2083) → 流程发布(3100)）：
- 流程版本页：站点选择、生成、预览（JSON + 支路清单）、下载、部署、回滚；
- 部署履历页：目标、rev 前后值、耗时、结果、失败原因。

## 六、部署服务纪律（Admin API）

1. 目标机必须开 `adminAuth`（凭证由后端加密保管）；
2. 流程：`POST /auth/token` → `GET /flows`（`Node-RED-API-Version: v2`，取 rev）→ `POST /flows`（带 rev + `Node-RED-Deployment-Type: nodes`）；
3. rev 冲突（409）= 有人在编辑器手改过 → 拒绝覆盖，履历记失败原因，人工介入；
4. 失败回滚：重推上一成功版本；
5. 已知代价：每次配置变更 = 一次部署，变更节点短暂重启，filter 死区基线清零引发一波全量重报（告知业务方，避开高峰发版）。

## 七、共存与切换规则

- 同一现场同一时刻只跑一套体系（V12/V13 或生成版），切换是整体切换，禁止双采同一台 PLC；
- 生成版 topic 前缀 `edgelink/gen/`，对拍期双跑时互不污染；
- 状态键零共享：生成版不读写任何 `edge_*` context 键。

## 八、验证方案（准入门槛，不过不上线）

1. **契约对拍**：同一配置分别走 V13 流与生成流，golden 语料喂相同输入，比对 MQTT/PG 输出逐字段等价（复用 v13/test 对拍基建）；
2. **真机并行对拍**：至少一个完整采集周期，覆盖 FX 系列（八进制地址）、异常帧、超时恢复；
3. **隔离压测**：10 台 PLC 中掐死 1 台网线，验证其余 9 台无感（社区节点 busy 闸 + 连接池行为实测）——此结果同时是 V14 复学证据；
4. **断库测试**：确认丢数范围，与业务方确认可接受窗口。

## 九、里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| M1 | 执行 SQL + 后端生成器（MC 单协议）+ 下载 | 可下载 flows.json，手工导入可跑 |
| M2 | 契约对拍全绿 + 真机并行对拍 | 对拍报告 |
| M3 | 部署服务（Admin API）+ 前端两页 | 「发布」按钮闭环 |
| M4 | 现场试点（单现场）+ SOP 定稿 | 试点验收 |
| M5 | Modbus 模板、补偿流（可选）、推广 | — |

## 十、风险清单

| 风险 | 缓解 |
|---|---|
| 社区 MC 节点真机行为差异 | M2 真机对拍为准入；`octalInputOutput` 已覆盖 FX 八进制 |
| 质量码降级破坏下游过滤逻辑 | 契约装配显式映射表 + 下游消费者清单排查 |
| 部署性能墙（500+ 节点） | 支路只到 PLC 级；单现场 PLC 数 >70 走 V14 路线 |
| 过渡版永久化 | V14 复学条件成文（下节），压测数据持续收集 |
| 凭证明文入 flows.json | Key 字段省略铁律；adminAuth 凭证 AES 存库；生成 JSON 不下发任何密钥 |

## 十一、V14 复学条件（成文，触发即拿数据谈）

1. 隔离压测复现"一台卡死连坐"；
2. 断库丢数造成可量化的业务损失；
3. 配置变更频率 × 重报风暴成本超过阈值；
4. 单现场 PLC 数逼近部署性能墙（~70 台）。

## 十二、本目录文件

- `README.md`（本文件）— 实施计划
- `migration_20260928_flowgen.sql` — 建表 + site_health_site 加列 + plc_driver 映射列 + 菜单（幂等，执行一次）
- `社区MC节点核实记录.md` — 社区节点源码核实结论（生成器模板的事实依据）

---

## 十三、M1 实施记录（2026-09-28 完成）

### 交付文件
| 层 | 文件 |
|---|---|
| 后端 | `module_flowgen/entity/do/flowgen_do.py`、`entity/vo/flowgen_vo.py`、`dao/flowgen_dao.py`、`service/flow_builders.py`、`service/generator_service.py`、`controller/flowgen_controller.py`（路由自动注册，order_num=210） |
| 后端改动 | `module_plc/entity/do/driver_do.py` 追加 gen_node_type/gen_conn_type 两列（仅加列，不改行为） |
| 前端 | `src/api/plc/flowRelease.js`、`src/views/plc/flowRelease/index.vue`（对应菜单 3101 的 component 路径） |
| 测试 | `scripts/test_flowgen_smoke.py`（不连库纯构建层断言，9 项全绿） |

### 与计划的有意偏差
1. **Jinja2 → Python dict 构建器**（flow_builders.py 纯函数）：JSON 转义安全 + 可单测，模板即代码；
2. **一 PLC 一个 tab**（不再按 30 台分界切分组框）：生成器逻辑统一，隔离与可读性最强；
3. **死区 = 设备级变化过滤（rbe 整包）**：每点位数值死区纯核心节点做不了，生成时逐点位记 warning，待业务定夺；
4. **PG 支路默认关**（enable_pg=False）：postgres 节点 query/config 字段名待真机验证，验证前不默认产出；
5. **BIT 点位单读不合块**，地址串语法（`D100,A,BIT` 猜测格式）与块读语法均列入 M2 真机验证清单。

### 验证结果
- 后端 8 个 .py 全部 py_compile 通过；controller 导入后路由正确（4 条端点）；
- 冒烟测试全绿：块合并（D100,3 / D110,4 / M200,3,BIT）、id 唯一+wires 闭合、生成确定性（同输入同 id）、FX octalInputOutput、trigger_kind=2 插 rbe、site-health 无 key 字段、JSONata 装配表达式；
- 前端 vue/api 脚本块语法解析通过（未跑完整 build）。

### 下一步（用户操作）
1. 执行 `9-28/migration_20260928_flowgen.sql`；
2. 重启后端 + 前端重新打包，重新登录（菜单生效）；
3. 「EdgeLink → 流程发布 → 流程版本」选采集点生成 → 下载 → 导入 Node-RED 手工验证；
4. 通过后进入 M2（契约对拍 + 真机并行对拍）。

### M1 追加修复（同日第二轮）
1. **join 静默丢轮修复**：每块新增 BAD 装配支路（MC Read 错误脚 → 块级 BAD 标记 → 同样入 join），join 永远收齐块数；超时（2×通信超时）仅作兜底。比 V13 更细：块级 BAD 而非整设备 BAD。
2. **node_id 契约对齐**：报文 node_id 改用 nodered_node.id（原为 site_health_site.id，填错表）；生成时按 host_pc_ip 查注册表，缺则预注册并记 warning。数据 topic 同步改为 {prefix}/data/{node_id}/{device_id}。
3. **心跳支路补回节点监控中心**：基础设施 tab 新增 inject(30s) → http request → 新端点 POST /monitor/heartbeat-edge（仅 X-API-Key，免 JWT——生成版无登录流水线；V12 端点不动）。X-API-Key 默认取后端 AppConfig.monitor_api_key 内嵌（有 warning 提示暴露面），可用生成参数 monitor_api_key 覆盖。

### M1 追加修复（第三轮）：PG 写入计数保留
- **问题**：heartbeat-edge 原本每 30s 把 pg_success_count/pg_fail_count 覆盖回 0。
- **方案**：边缘无状态、事件驱动、服务端累加——
  1. `MonitorDao.upsert_heartbeat` 加 `update_metrics` 参数（默认 True，V12 不变）；heartbeat-edge 传 False，心跳只更新在线状态；
  2. 新端点 `POST /monitor/pg-stat-edge`（仅 X-API-Key）：`UPDATE nodered_node SET pg_success_count=COALESCE+ok` 原子累加；
  3. 生成器 PG 支路（enable_pg=True 时）：PG SQL change 增加 `pg_rows` 留存（postgres 节点会覆盖 payload）；pg 节点成功输出 → 成功计数上报；专属 catch（只圈 pg 节点）→ 失败计数上报。
- **spool 积压**：结构性不存在（生成版无磁盘缓存），0 是真实值，无法也不需要保留。
- 验证：冒烟 11 项全绿；后端重启后 heartbeat-edge / pg-stat-edge 均注册。

### M1 追加（第四轮）：Modbus 支路 + 断线重连 + rbe 修复
1. **rbe 修复（真 bug）**：原监视 payload（含每轮必变的 ts）导致变化触发永远放行；改为装配时输出 changeKey 指纹（tag_id+eng_value+quality），rbe 监视 changeKey。
2. **断线重连支路**：社区 MC 节点的自动重连对物理断连无效（连接池作者注释：旧对象 connect 不恢复，必须 reinitialize）；新增 错误脚 → 限速(15s) → topic=reinitialize → 回接 MC Read 的支路。
3. **Modbus 支路**（node-red-contrib-modbus）：modbus-read 自带走时轮询（rateUnit ms 原生亚秒）、emptyMsgOnFail + 「读取失败?」switch 分流 BAD 支路、reconnectOnTimeout 内建重连；块合并按功能码+连续地址（上限 120）；多字类型（INT32/FLOAT/DOUBLE 等）需 buffer-parser，过渡版拦截跳过并告警。
4. 生成器按 gen_node_type 分发（MC Read / modbus-read），未实现驱动安全跳过并告警。
5. 品牌扩展：基恩士（SLMP→MC 零开发）、汇川/欧姆龙/西门子（Modbus）已入 protocol_compat；GOT/PLC_RS232C/UNKNOWN/siemens_s7 行已清理。

---

## 十四、已知债登记

### 债1：采集点双表生命周期不同步（2026-09-30 记录）
- **背景**：采集点台账存于两张表——`bootstrap_key`（设备页左面板/2067 管理页）与 `site_health_site`（健康监控/生成器匹配）。
- **现状**：09-30 已实现「一次登记、双表落库」（创建对齐）；bootstrap Key 生成但不展示（生成版无运行时用途）。
- **残留**：编辑不同步（2067 改栋/楼/工程不会影响 site_health_site，反之亦然）；删除留孤儿（2067 删点后监控页留死行，3002 删点后左面板留死节点）；名称可分叉。
- **运维纪律（过渡期内）**：改/删采集点时两边页面各操作一次。
- **终局（V14 复学时再动）**：site_health_site 升级为唯一采集点表，设备页左面板改读它，bootstrap_key 退化为纯激活凭证表或废弃；kill switch 语义随 V14 一并重做。

---

## 十五、SQL 命名规约（服务器执行顺序）

SQL 文件统一 `NN_名称_日期.sql` 格式，**按序号升序执行**（序号即执行顺序）：

| 序号 | 文件 | 内容 |
|---|---|---|
| 01 | migration_20260928_flowgen.sql | 生成器建表 + Admin 凭证列 + 驱动映射列 + 流程发布菜单 |
| 02 | hide_legacy_menus_20260928.sql | 菜单隐藏 + 2081 履历移动 + 3020 排序（含 09-30 三次追加） |
| 03 | migration_20260929_mc_schema_optional.sql | MC 协议参数非必填 |
| 04 | migration_20260929_mc_schema_community.sql | MC schema v2（社区节点配置面） |
| 05 | migration_20260929_trigger_kind_fix.sql | 触发方式存量修正 |
| 06 | migration_20260929_brand_extend.sql | 基恩士/汇川品牌扩展 |
| 07 | migration_20260929_compat_cleanup.sql | 兼容表清理（GOT/RS232C/S7） |
| 08 | migration_20260930_site_source.sql | site_health_site 来源字段 |
| 09 | migration_20260930_site_backfill.sql | 采集点台账回填 |
| 10 | migration_20260930_restore_deploy_center.sql | 恢复「部署中心」菜单（下载中心/交付维护） |
| 11 | migration_20260930_fix_site_source.sql | 存量站点来源纠正（有设备的 register→config） |
| 12 | migration_20260930_fix_deadband_default.sql | 清理导入默认死区残留（1000→0） |
| 13 | migration_20261001_tag_id_rename.sql | 点位 id 字段更名 |
| 14 | 14_pg_create_plc_data_log.sql | 【PostgreSQL 库执行】PG 目标表建表 + register_type 补列 |
| 15 | 15_migration_20261003_release_deploy_columns.sql | release 表加部署字段（deploy_time/deploy_by/deploy_msg） |
| 16 | 16_migration_20261004_fix_release_status.sql | 修复多版本同挂"已部署"（一现场只留最新一条已部署） |
| 17 | 17_migration_20261004_canvas_snapshot.sql | 边缘画布快照表（部署自动归档+手动备份，每现场留 20 份） |
| 18 | 18_migration_20261005_release_deploy_credentials.sql | release 表加 deploy_credentials（MQTT 凭证走部署通道，不进 flows.json） |

**后续新增 SQL 按此规约**：取当前最大序号 +1，写清内容/影响/验证语句。

### M1 追加（第五轮）：评审 A 组修复（2026-09-30，依据第三方评审报告）
- **A1** Modbus 失败分流：非法规则名 isempty → null/empty/else 三路（本机 10-switch.js 验证）；
- **A2** PG：config 字段 db→database；query 改 mustache '{{{msg.topic}}}'（该包不读 msg.topic 本体）；
- **A3** MC 好路 quality：isGood 从未被节点转发（read.js:139 仅注释）→ 写死 GOOD；
- **A4** BIT 地址串：M200,3,BIT → M200.3（库正则严格匹配）；
- **A5** 确认边缘 vendored 为原版 mcprotocol@1.2.1（非 -ind），文档已更正；
- **C3** 通信状态上报挪到契约装配处聚合（每轮一次，任一块 BAD 即离线）；
- **C4** inject repeat 不再取整（支持小数秒）；
- **C6** PG 专属 catch 与 api_key 解耦（无 key 时走告警链）；
- 冒烟测试断言同步修正（含删除把 A4 错误语法固化下来的那条）；评审 B 组（失败分支契约差异）维持记录不动。

### M1 追加（第六轮）：OPT-01/05 修复（2026-09-30，探针实证驱动）
- **OPT-01 多字类型**：块读地址串改用库类型名前缀（DDINT200,2 / DFLOAT110,2 / DREAL…），库直接返回解析值（探针实测），read.js 输出 key 保持字地址兼容现有装配；INT16/UINT16 维持原样；
- **OPT-05 部分**：BIT 连读合并（同寄存器类型连续位合并为 M200.3,N），单点 M200.3 保持；
- 验证：冒烟新增 2 组断言全绿；lint 仅剩 2 个已知 modbus 待装包项。

### M1 追加（第七轮）：OPT-04 点位缺失判 UNCERTAIN（2026-09-30）
- MC/Modbus 两条装配表达式：取值带 $exists 存在性判断，查不到 key → raw/eng 置 null、quality=UNCERTAIN（对齐 V13 三态语义）；
- UNCERTAIN 不计入设备级 comm 的 BAD 统计——个别点缺失不放大为设备离线；
- 附带收益：OPT-01/03 一旦真机出问题，症状从"点位静默消失"变成"UNCERTAIN 可见"——M2 排障有信号了。

### M1 追加（第八轮）：运维闭环取舍（2026-09-30）
- **OPT-08 部署回执**：心跳 URL 带 flow_version（生成期占位符 __FLOWVER__ 参与哈希、落库前替换真版本，幂等不受影响），heartbeat-edge 接收并写入 nodered_node.config_version；
- **OPT-13 版本留痕**：GENERATOR_VERSION 常量 → release.remark 前缀（gen:vX.Y.Z）+ 基础设施 tab 注释节点；
- **OPT-07 kill switch：用户裁决取消**（停采=推停用流的等价路径已存在；闸/链路/全局上下文的复杂度换不来收益）。已实现的闸与链路全部回滚，heartbeat-edge 的 disabled 下发保留（无害且与 V12 同语义）。
