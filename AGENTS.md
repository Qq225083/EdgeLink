# EdgeLink 项目记忆（AGENTS.md）

> 供 AI 助手快速进入状态的项目事实库。更新纪律：结构/约定变化时同步本文件。

## 仓库布局（repo root = RuoYi-Vue-FastAPI/）

- `ruoyi-fastapi-backend/` — FastAPI 后端（MySQL: 127.0.0.1:3308/ruoyi，模块含 module_plc、module_site_health、module_task）
- `ruoyi-fastapi-frontend/` — Vue2 + Element-UI 前端
- `packages/` — 自研 Node-RED 节点包（edgelink-modbus/pg/s7/site-health、mitsubishi 等）
- `docs/` — 设计文档与迁移 SQL（site_health_*、menu 迁移、v13_refactor_plan.md 等）
- `v13/` — V13 重构工作区（lib + 壳 + 测试 + 工具，见下）
- `edge/nodered/` — Node-RED 运行目录的**仓库快照（滞后，勿当基准）**；live 在 `D:\nodered\data\flows.json`
- `tmp_v13_analysis/`（frontend 下）— V12 巨兽 function 原始副本 + 各步 flows 基准（对拍用）

## V12 采集架构（生产在跑）

后端配置驱动：Node-RED 侧 config-manager 拉快照（`/plc/config/snapshot/list`，发布即版本）→ 调度器 → driverCode 分流 → 协议节点（MC/Modbus）→ 数据管道 → MQTT（实时）+ PG 批量（磁盘 spool 兜底）。JWT + API-Key 双凭证；kill switch 后端可停用节点。

## MC 读取节点多机隔离设计（v1.4.4+，领导问答用）

包：`node-red-contrib-mitsubishi`（live 在 `D:\nodered - 副本\node-red-contrib-mitsubishi`）。
- **连接池按 host:port 分键**（CONN_POOL）——每台 PLC 一条独立 TCP 连接；
- **每台 PLC 独立轮次闸**（IN_FLIGHT）——上轮未完新轮快速失败，不积压；
- **单请求超时 + 队列 >20 熔断**，超时/重试均为设备级配置；
- **mc.groupTags 块读合并**（960 字 span 聚类）；
- 结论：**一台 PLC 卡死只影响自己**；唯一共享弱点是进程级崩溃（新旧架构相同），靠 site-health 监控兜底。
- 演示方案见 `docs/demo_mc_isolation.md`。

## site-health 存量采集点监控（已上 GitHub main）

后端 `module_site_health` + 前端 `plc/siteHealth/{register,monitor}` + 节点包 `packages/node-red-contrib-edgelink-site-health`（当前 v1.0.6）。
要点：一次性 Key（SHA-256 无盐存储）+ **IP+端口双绑定**（ip_mismatch/port_mismatch 拒报）+ 双层限流 + 履历 7 天清理（分批删除）；节点端 Key 走 credential，invalid_key 终止、disabled/不符 300s 低频重探自愈。
菜单：EdgeLink(2083) 下二级目录「存量监控」(3000) → 采集登记(3001)/采集监控(3002) + F 按钮 采集编辑(3003)/采集删除(3004)。

## V13 重构（结构完成，待真机对拍）

- 4 个巨兽 function（535/403/327/252 行）→ 薄壳 + `v13/lib/` 11 个模块（httpClient/logger/stateStore/configCache/netUtils/bootstrap/tagConfig/retryPolicy/transform/reportFilter/calcTags/commState）→ 再画布级拆分为 3 条流水线（数据管道 9 节点 / sf-monitor 6 节点 / sf-config-manager 7 节点）。
- **纪律**：lib 永不碰 node（send/status 壳层显式处理）；stateStore 底层键名保持 edge_* 原样；kill switch 缓存只走同步 fs；重构期发现疑似 bug 只记录不修改。
- 测试：`cd v13 && node --test test/`（104 用例全绿为准入）。
- 工具：`v13/tools/patch_*.js`（壳写回 flows.json）、`split_*.js`（画布拆分）、`resync_shells.js`（内容同步）、`export_*.js`（导出快照/可导入 flow）。
- 记录在案未修的现网怪癖：retryState.attempt 只增不减；protocolParams 单 try 连坐；FX 系列地址字母剥除；心跳超时原版双重收尾（V13 已自然修复）。

## 操作约定

- 后端改动需重启生效；菜单 SQL 改动后用户重新登录生效；
- D 盘 live flows.json 修改前必备份（baseline_*/flows.json.bak-*）；
- git 提交/推送前必须给用户过目文件清单；
- 日企现场，MC 协议为主，S7 暂缓。
