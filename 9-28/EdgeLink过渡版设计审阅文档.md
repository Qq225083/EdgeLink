# EdgeLink 过渡版 设计审阅文档

> 用途：供第三方 AI / 工程师审阅 EdgeLink 过渡版（配置驱动的 Node-RED 流程生成方案）的架构与实现。
> 日期：2026-09-30。本文档自包含，无需前置上下文。
> 审阅请求见文末「九、请审阅者重点回答」。

---

## 一、项目背景与约束

EdgeLink 是一个工业数据采集系统：车间边缘侧用 Node-RED 采集 PLC（三菱 MC 为主，扩展 Modbus/基恩士 SLMP），后端 FastAPI + MySQL 集中管控，前端 Vue2 + Element-UI（RuoYi 脚手架），时序数据落 PostgreSQL。

**演进史**：V12（Node-RED 巨型 function 流，生产在跑）→ V13（lib+壳重构完成）→ V14（自研节点产品化，因领导不接受自研节点而暂停）→ **过渡版（本次审阅对象）**：后端配置驱动生成纯现成节点的 flows.json，下载/部署到边缘。

**硬性约束**：
1. 采集业务逻辑零自研节点（只用 Node-RED 核心节点 + flows.nodered.org 公开社区节点）——政治约束，不可协商；
2. 北向契约（MQTT topic/payload、PG 表结构）与 V12/V13 逐字节一致——下游无感；
3. 与 V12/V13 存量现场共存，同一现场同一时刻只跑一套。

**业务场景**：日企工厂，MC 协议为主；现场有 汇川（Modbus TCP）、基恩士（SLMP/MC 兼容）。

---

## 二、架构总览

```
若伊后端（配置真相源：plc_device / plc_tag / plc_driver）
  └─ module_flowgen 生成器：读配置 → Python 构建器 → flows.json（完整目标画布）
       ├─ plc_flow_release（版本表：payload + sha256 幂等 + 绑定配置快照版本）
       └─ 下载（当前）/ Admin API 自动部署（M3 未做）
            ↓
边缘 Node-RED（生成物 = 完整画布，全量替换语义）
  ├─ GEN_采集_<设备名> × N（一 PLC 一个 tab 一条支路）
  └─ GEN_基础设施（site-health 上报 + 心跳）
```

**核心模型**：生成的 flow = 该现场画布的**完整目标状态**，部署即全量替换（Admin API `POST /flows` + rev 乐观锁 + `nodes` 增量部署），不做局部合并。

---

## 三、关键设计决策

### 3.1 配置即流程（代码生成 vs 数据驱动）
- 配置编译进 flow（coefficients、地址、周期全部编译期固化）；
- 改配置 = 重新生成 + 部署（有短暂中断 + 状态清零代价，已记录在案）；
- 对比 V13 的数据驱动（快照拉取零部署）是 deliberate trade-off：换取零自研节点。

### 3.2 确定性节点 id
所有节点 id = sha1(site_id:角色:device_id...)[:16]。同一现场重复生成 id 不变 → credential（site-health Key、MQTT/PG 密码）按 id 存活，部署不丢；sha256 内容幂等防重复建版。

### 3.3 社区节点选型（已读源码核实）
- MC：`node-red-contrib-mcprotocol-ind`（节点类型 `MC Read` / `MC Protocol Connection`）；
- Modbus：`node-red-contrib-modbus`（`modbus-read` / `modbus-client`）；
- 写库：`node-red-node-postgres`；
- 监控：`node-red-contrib-edgelink-site-health`（自研基础设施组件，不参与采集逻辑）。

### 3.4 隔离模型
一 PLC = 独立 tab + 独立连接 config 节点（社区 MC 节点内部按 host:port 建连接池）+ 独立轮询 + busy 闸 + 支路级 catch。目标："一台 PLC 卡死只影响自己"。

---

## 四、生成 flow 的支路结构（核心审阅对象）

每台设备 tab 内（MC 支路为例）：

```
inject(周期) → MC Read×K块（块读合并：生成期聚类，上限480寄存器）
                 ├─ 输出1 → 块内装配(JSONata，逐点位 tag_id/raw/eng/quality) → join(多块时) → 契约装配 → [rbe 变化触发] → 空轮过滤 → MQTT + PG
                 └─ 输出2(错误) → 坏块标BAD(quality=BAD，同样入 join，保证 join 收齐)
                                → 告警限速(30s/条) → 告警报文 → MQTT 告警
                                → 重连限速(15s) → topic=reinitialize → 回接 MC Read（断线重连）
```

Modbus 支路差异：modbus-read 自走时轮询（rate/rateUnit 原生毫秒）、失败检测靠 emptyMsgOnFail + 「读取失败?」switch 分流 BAD、重连用 client 内建 reconnectOnTimeout。

**关键机制**：
- **BAD 兜底块**：读失败的块产出全 BAD 点位数组照常入 join——保证 join 永不缺块（消除"某块失败整轮静默丢失"）；
- **变化触发**：装配时输出 changeKey 指纹（tag_id+eng_value+quality，不含 ts），rbe 节点监视 changeKey（监视 payload 会因 ts 每轮必变而失效——评审中抓到的真 bug，已修）；
- **契约装配**：JSONata 把社区节点输出逐字段映射回 V13 MQTT payload 结构（node_id/device_id/values[]/quality/ts 等）；
- **亚秒轮询**：<1000ms 用 inject 一次性 + delay 自循环（自背压）；
- **告警/重连双限速**：delay 节点 rate 模式（1条/30s、1次/15s，drop）。

**画布美术层**：三色分组框（蓝=采集装配/绿=上报计数/红=告警异常）+ 顶部信息注释（设备名/IP/周期/点位数/"画布只读"提示）+ 基础设施 tab credential 录入指引。

---

## 五、监控闭环（边缘→后端上报）

全部为 http request 节点 + 后端免 JWT 专用端点（仅 X-API-Key）：

| 通道 | 端点 | 内容 |
|---|---|---|
| 心跳 | `POST /monitor/heartbeat-edge`（30s） | 维持 nodered_node 在线状态（不触碰指标字段） |
| PG 计数 | `POST /monitor/pg-stat-edge`（事件驱动） | ok/fail 条数服务端原子累加 |
| 逐台通信状态 | `POST /monitor/device-comm-edge`（读取支路直报） | 读成功=在线/读失败=离线（与 PG 解耦——PG 写失败不连累在线状态） |

site-health 节点独立上报进程级监控（内存/版本/运行流数/错误日志）。

---

## 六、安全设计

- 生成 JSON **不含任何 credential 值**：site-health Key、MQTT/PG 密码均为 credential 类型，导入后编辑器录入一次，靠确定性节点 id 跨部署存活；
- **例外**：X-API-Key 明文嵌入 http 节点（监控上报用）——与 bootstrap.json 同等暴露面，生成结果带 warning 提示；
- 密钥存储：后端只存 SHA-256 哈希，明文仅登记时返回一次；
- 边缘 Node-RED adminAuth 待开启（部署服务 M3 前置）。

---

## 七、已签字确认的降级项（过渡版不实现）

1. 每点位数值死区（只有设备级变化过滤）；
2. 强制周期补报；
3. 计算点（sum/avg/min/max 派生点）；
4. PG 断库 spool 磁盘缓存（用失败计数代偿）；
5. 质量码三态 → GOOD/BAD 两态；
6. kill switch（停采 = 推停用流，M3 后）；
7. S7 协议（业务暂缓）。

前端对应字段已隐藏（死区/强制间隔/计算点入口），防"配了不生效"误导。

---

## 八、已知风险与技术债（诚实清单）

| # | 风险/债 | 状态 |
|---|---|---|
| 1 | postgres 节点 msg.topic 查询机制未真机验证（enable_pg 默认关） | 待 M2 |
| 2 | BIT 点位地址串语法（`M100,3,BIT`）为推测 | 待 M2 |
| 3 | Modbus 支路未真机验证（emptyMsgOnFail/rateUnit=ms 文档级信任） | 待 M2 |
| 4 | 社区 MC 节点输出 key 规则（D100 / D100.A 十六进制位号）读源码推断 | 部分已验证（模拟器块读已通） |
| 5 | 采集点双表（bootstrap_key/site_health_site）生命周期改/删不同步 | 记录在案，V14 台账合一 |
| 6 | 并发点"生成"撞唯一键可能 500 | 低概率未处理 |
| 7 | 重连支路对"单次读取超时"也会触发重建（pin2 不区分超时/断连） | 15s 限速控制代价 |
| 8 | 编辑器导入是"追加"非"替换"：部署前需手动删旧 tab 防双采 | 现场 SOP 待写 |
| 9 | MC/Modbus 两支路构造器约 70% 重复代码 | 第三个协议进来前抽公共骨架 |

---

## 九、请审阅者重点回答

1. **架构层面**：配置即代码生成（vs 数据驱动）的取舍在你的经验里是否成立？有没有我们没看到的结构性风险？
2. **Node-RED 细节**：生成的 flow 结构（join 计数聚合、rbe 监视 changeKey、delay 自循环、限速模式）有无语义错误或性能陷阱？
3. **安全**：X-API-Key 嵌入 flows.json + credential 录入模型，有无更好的方案？
4. **生产就绪度**：基于第八节的清单，你认为还有哪些必须上生产前验证/修复的项？
5. **演进路径**：过渡版 → V14（数据驱动 + 自研节点复学）的路径设计是否合理？复学条件（隔离压测连坐证据/断库丢数量化/配置变更成本/单现场规模墙）是否完备？

---

## 附：相关文件

- 实施计划与变更记录：`9-28/README.md`（含冒烟测试 17 项清单）
- 社区 MC 节点源码核实：`9-28/社区MC节点核实记录.md`
- SQL 迁移（编号 01-11，按序执行）：`9-28/*.sql`
- 生成器源码：`ruoyi-fastapi-backend/module_flowgen/`（service/flow_builders.py 为纯函数构建器，service/generator_service.py 为编排）
- 冒烟测试：`ruoyi-fastapi-backend/scripts/test_flowgen_smoke.py`
