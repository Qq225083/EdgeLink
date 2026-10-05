# EdgeLink 系统评审文档（2026-09-06）

> 用途：供独立评审（AI 或人工）完整理解 EdgeLink 系统的当前真实状态，评估架构正确性、安全性、并发与协议设计的合理性。
> 范围：FastAPI 后端 + Vue2 管理端 + Node-RED 边缘采集体系（V12 生产在跑 / V13 重构中）+ 存量采集点监控 + 接入引导页。
> 说明：本文所有事实均来自 2026-09-03~06 期间的代码走查与真机验证记录，非设计预期。

---

## 1. 系统定位

面向日企工厂现场的工业数据采集平台：

- **V12 新体系**：后端配置驱动，Node-RED 边缘侧拉配置快照 → 调度 → 协议节点（三菱 MC 为主，Modbus/S7 为辅）→ MQTT 实时 + PostgreSQL 批量入库。
- **存量旧版**：各车间已运行的老 Node-RED 采集程序，不做 JWT、不经 MQTT，由 site-health 模块独立监控其死活。
- 管理端基于 RuoYi-Vue（Vue2 + Element-UI），后端基于 RuoYi-Vue-FastAPI（FastAPI + SQLAlchemy async + MySQL）。

## 2. 总体架构

```
管理端 (Vue2)                    边缘采集 PC (Node-RED)
  │  JWT+接口权限                  │
  ▼                              ▼
FastAPI 后端 ◄── /auto 双绑定激活 ── edgelink-bootstrap（引导页/节点）
  │  ▲                             │
  │  └── /plc/config/bootstrap ────┤ 首启拉业务凭据（API-Key/账号/MQTT）
  │  ▲                             │
  │  └── /login → JWT ─────────────┤
  │  ▲                             │
  │  └── /plc/config/snapshot/list ┤ 分页拉配置快照（发布即版本）
  │                                ▼
  │                          调度器 → driverCode 分流 → MC/Modbus/S7 节点
  │                                │
  │                                ▼
  ├── EMQX(MQTT) ◄── 实时数据/心跳/CONFIG_REFRESH 通知
  └── MySQL(配置/台账) + PostgreSQL(采集时序数据，磁盘 spool 兜底)

存量旧 Node-RED ── HTTP 直连 /site-health/report（一次性 Key，无 JWT）──▶ module_site_health
```

关键解耦：存量监控链路与 V12 完全独立；引导页激活链路与采集运行链路解耦（校验失败只阻断采集，不阻断 Node-RED 进程）。

## 3. 边缘采集链路（V12 生产 / V13 重构）

### 3.1 config-manager 流水线（7 节点壳）

1. **①锁+IP检测**：单例锁（60s 过期）防并发重入；办公网 IP 检测（settings.js 注入 > 环境变量 > 自动探测）；hostPcIp 规范化为 IP:端口。
2. **②复查/bootstrap**：首启调 `/plc/config/bootstrap` 拿业务凭据；停用态下低频复查自愈（kill switch 重启持久化路径）。
3. **③JWT解析+缓存**：/login 拿 JWT，缓存复用，401 触发全量重登。
4. **④nodeId反查**：节点注册/反查 nodeId（监控维度主键）。
5. **⑤分页拉取点位**：`/plc/config/snapshot/list` 分页 5000/页，200 页熔断（防后端分页失效导致死循环）。
6. **⑥分组+输出组装**：按设备分组、本机/启用过滤、MC 地址有效性校验、写本地缓存、清理失效残留状态。
7. **⑦登录重试调度**：失败退避重试。

### 3.2 调度与采集

- 调度器直接读 `edge_devices` 全局状态（非消息驱动），按 scanIntervalMs 轮询；连续失败 >3 次指数退避（上限 60s）。
- **MC 节点多机隔离**（node-red-contrib-mitsubishi v1.7.5）：连接池按 host:port:frame:网络号:站号:协议:commCode:**localPort** 分键；每台 PLC 独立在途闸（上轮未完新轮快速失败）；单请求超时 + 队列 >20 熔断；块读合并（960 字 span 聚类）。结论：一台 PLC 卡死只影响自己。
- 数据管道：变换（斜率/偏移）→ 死区过滤 → 计算点位求值（avg/max/min/sum 等，同设备来源，禁链式引用）→ MQTT 实时 + PG 批量（磁盘 spool 兜底防断网丢数据）。

### 3.3 V13 重构（结构完成，待真机对拍）

- 4 个巨兽 function（535/403/327/252 行）→ 薄壳 + `v13/lib/` 11 个纯逻辑模块（httpClient/logger/stateStore/configCache/netUtils/bootstrap/tagConfig/retryPolicy/transform/reportFilter/calcTags/commState）。
- 纪律：lib 永不碰 node 对象；stateStore 底层键名保持 edge_* 原样（43 键注册表，未注册键抛错防拼写漂移）；kill switch 缓存只走同步 fs。
- 测试：`cd v13 && node --test test/`，当前 105 用例全绿（为准入门槛）。

## 4. 接入与激活（Bootstrap v3.0 + 引导页）

- **预分配模式唯一**：管理端登记采集点（办公网IP+端口+工业网IP+栋/楼/工程）→ 生成一次性密钥（SHA-256 哈希存储，明文仅展示一次）。
- **双绑定校验**：`/plc/config/bootstrap/auto` 要求 secretKey 哈希匹配 + 本机IP:端口严格等于登记值，不符记安全日志并中文报错（带预期/实际值）。
- **引导页**（bootstrap 包 v1.1.0）：`http://<本机>:1880/edgelink/guide`，启动脚本自动弹出；状态卡（已激活/采集就绪/采集点）+ 激活表单（必填校验）；通过则写 global（即时生效）+ 落盘 userDir JSON（0600，重启由节点回读）。
- 取值优先级：节点面板 > 引导页落盘 > settings.js/环境变量；密钥只写不读，页面永不回显。
- **设计原则**：校验失败只阻断采集（configReady 门），绝不阻断 Node-RED 进程（后端宕机不能演变成全线停产）。

## 5. 存量采集点监控（site-health v1.0.6）

- 登记发一次性 Key（SHA-256 无盐存储）+ IP+端口双绑定（ip_mismatch/port_mismatch 拒报）。
- 节点零第三方依赖，HTTP 直连 `/site-health/report`（Bearer Key 优先，query 兼容）。
- 双层限流（IP + Key），心跳履历 7 天清理（分批删除）。
- 节点端 invalid_key 终止；disabled/不符 300s 低频重探自愈；**低频重试不写数据库**。
- 管理端：监控页（在线状态/指标/趋势）、履历独立页、重置密钥/启停/删除。

## 6. 安全模型

- 管理端：JWT（PreAuth）+ 接口级权限（UserInterfaceAuthDependency，v-hasPermi 按钮级）。
- 边缘：JWT + API-Key 双凭证；采集账号独立角色（edge_collector，非 admin）；MQTT 边缘/后端账号分离。
- 密钥体系：全部 SHA-256 哈希存储、明文仅创建/重置时返回一次；Node-RED 侧走 credential（flows_cred.json）或 0600 落盘文件，明文不进 flows.json。
- kill switch：管理端停用 → MQTT NODE_STATUS 定向下发（带 node_id 防广播误伤）→ 边缘即停；落盘禁用标记防重启复活；低频复查自愈。
- 限流：/auto、/bootstrap 各 20 次/分钟/IP（内存桶）；site-health 上报双层限流。
- 已知边界：Node-RED 无 adminAuth（内网前提），引导页无登录保护；密钥与办公网 IP:端口 绑定，工业网 IP 目前仅台账未进校验链。

## 7. 数据模型要点（MySQL ruoyi 库）

- `plc_device`（设备：host_pc_ip 绑定采集点、plc_ip/plc_port 目标、local_port PC 源端口选填、mes_ip 自动继承采集点工业网卡 IP、driver_code 驱动分流）
- `plc_tag`（点位：寄存器类型/地址/数据类型/位偏移/字节序/字序/变换/死区/计算点位 calc_op+calc_source_ids）
- `plc_config_snapshot`（发布即版本：单表版本递增，边缘唯一拉取源）
- `edge_bootstrap_key`（采集点密钥：哈希、host_pc_ip 唯一、indust_ip、位置三列、enabled、last_heartbeat、machine_fingerprint）
- `nodered_node` / `nodered_heartbeat_log`（节点注册与心跳）
- `site_health_site` / `site_health_heartbeat_log`（存量监控）
- `sys_download`（下载中心交付物，分段上传）
- 采集时序数据在 PostgreSQL（批量写入 + 磁盘 spool）。

## 8. 近期真 bug 修复实录（评审重点关注区）

1. **`/auto` commit 后访问 ORM 属性 → MissingGreenlet 500**（自上线起成功路径必崩，引导页第一次真实调用才暴露）。修复：commit 前取字段到本地变量。
2. **点位添加 asyncmy「expected tuple, got list」**：VO `calc_source_ids: Any` 收 list，DO 是 String 列，list 直绑 SQL 占位炸驱动。修复：DAO 层统一规整（list→JSON 文本，空数组→NULL），覆盖单增/批量/编辑三路径。
3. **CM 空快照早退**：快照 0 行时直接 return，旧 `edge_devices` 残留导致"全部删除并发布后仍继续采集"。修复：空快照=合法终态，清空配置+缓存+残留状态，调度器自然停摆。
4. **httpAdmin 自定义路由读 body 挂死**：body-parser 已消费流，后挂 'end' 监听永不触发。修复：先看 `req.body`。
5. **detectIp 双网卡同级优先级**：10.* 与 192.168.* 按枚举顺序取先者，可能把工业网卡当办公网。修复：10.* 显式优先（引导页包 + v13 lib 两处）。
6. **ps1 无 BOM 中文注释被 GBK 误读 → 语法解析失败**。教训：Windows ps1 注释纯英文。
7. **Node-RED 双包共存**（install-dir 旧版 + userDir junction 新版）导致节点类型注册竞态、行为随重启飘忽。旧包已移出备份。

## 9. 部署拓扑

- 后端 9099（uvicorn 单实例）；前端 dev 8080 / 生产 dist + nginx 8001 反代（/prod-api → 9099，client_max_body_size 100m 曾因缺配导致上传 413/ERR_ACCESS_DENIED）。
- Node-RED 1880（userDir D:\nodered\data；自研包经 junction/file: 挂载）；EMQX 1883/18083（D:\emqx-5.3.0，无服务自启）。
- MySQL 3308；PostgreSQL 采集库；Redis 6379。
- flows.json 手动修改后，编辑器必须刷新再部署，否则变更被旧画布覆盖（已踩过）。

## 10. 待评审问题

1. **空快照即停采**的语义是否妥当？（后端 bug 导致空快照 vs 合法全删，当前无法区分——是否需要快照签名/最少行数兜底？）
2. 引导页激活写 global 依赖"画布存在 bootstrap 节点实例"，无实例时只能重启生效——这个限制是否可接受？是否应让 flows 直接读落盘文件？
3. 密钥双绑定目前只绑办公网 IP:端口，工业网 IP 仅台账——是否有必要纳入 /auto 校验链？
4. settings.js functionGlobalContext 仍残留 v1.0 手动注入（pc-001 等），与引导页/面板双通道并存——配置源收敛策略？
5. PG 批量写入 + 磁盘 spool 的背压与恢复顺序（当前 spool 重放在新数据之前还是之后？）
6. kill switch 的 MQTT 定向依赖 node_id 反查，反查失败时退化为 host 匹配——残余广播风险是否已闭环？
7. EMQX/后端/Node-RED 均无 Windows 服务自启（重启机器需手动拉起三个进程）——投产前的服务化方案？
8. 下载中心分段上传的断点续传与清理策略是否完备？

---

> 评审时请指出：正确性缺陷、并发/竞态隐患、安全边界漏洞、协议设计不合理处，以及运维可观测性缺口。
