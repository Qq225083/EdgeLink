# EdgeLink 项目记忆（AGENTS.md）

> 供 AI 助手快速进入状态的项目事实库。更新纪律：结构/约定变化时同步本文件。

## 仓库布局（repo root = RuoYi-Vue-FastAPI/）

- `ruoyi-fastapi-backend/` — FastAPI 后端（MySQL: 127.0.0.1:3308/ruoyi，模块含 module_plc、module_site_health、module_task）
- `ruoyi-fastapi-frontend/` — Vue2 + Element-UI 前端
- `packages/` — 自研 Node-RED 节点包（edgelink-modbus/pg/s7/site-health/bootstrap/change-filter、mitsubishi 等）
  - `node-red-contrib-edgelink-change-filter`（v1.0.0）— 存量老流改造用：change-filter（数组记录按唯一键逐字段对比，只输出变化项，闭包存基准、死区阈值、超时清理）+ change-to-sql（diff 按映射表展开为逐点位写库载荷，映射支持设备专属+"*"回落；输出格式可选 sql=msg.query 通用 pg 执行节点 / rows=payload.rows 直连 edgelink-pg-store 吃 spool 断库缓存）。用于替代前辈 function 里"flow context 存旧值→数组索引对齐→拼 SQL"的写法（首轮崩吞数据、循环越界等坑）。注意：node-red 需列入 devDependencies 否则 test-helper 找不到运行时。
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

后端 `module_site_health` + 前端 `plc/siteHealth/{register,monitor}` + 节点包 `packages/node-red-contrib-edgelink-site-health`（当前 v1.1.1）。
要点：一次性 Key（SHA-256 无盐存储）+ **IP+端口双绑定**（ip_mismatch/port_mismatch 拒报）+ 双层限流 + 履历 7 天清理（分批删除）；节点端 Key 走 credential，invalid_key 终止、disabled/不符 300s 低频重探自愈。
菜单：EdgeLink(2083) 下二级目录「存量监控」(3000) → 采集登记(3001)/采集监控(3002) + F 按钮 采集编辑(3003)/采集删除(3004)。
**v1.1.0（09-20，docs/9-20）**：调色板「存量监控」分类三件套——site-health-server（共享 config 节点，Key 集中维护；site-health 未引用时回落旧字段零迁移）+ site-health（新增 error 日志随心跳上报：RED.log.addHandler 只收 error/fatal、环形缓冲 20×500 字、POST body 增量、成功才清除；v1.1.1 同 msg 去重计数 count 防刷屏挤掉其它错误；后端存 site.last_errors 快照，监控页「最近报错」列+次数列）+ site-flows-upload（按钮弹窗必填原因 → admin 接口触发 → flows.json 上传，10MB 上限 + SHA-256 复核 + 5 次/小时限流；存 site_health_flows_upload 表 LONGTEXT、写入同事务裁剪留最近 5 份；下载接口 media_type 必须 octet-stream 否则前端 blobValidate 误判；**两表/列必须 utf8mb4**（flows.json 与 error 日志含 emoji，默认 utf8 报 1366，模型已加 mysql_charset））。httpAdmin 自定义路由读 body 要做 req.body 兜底（老版本无 body-parser）。
**致命坑（v1.1.2 修复，21:44 真机崩过一次）**：`RED.log.addHandler` 收的是 **EventEmitter**——运行时对每条日志调 `handler.emit('log', msg)`，传普通函数会在下一条日志时抛 `handler.emit is not a function` 崩掉整个 Node-RED。正确姿势：`new EventEmitter()` + `emitter.on('log', fn)` 再 addHandler(emitter)。单元 mock 测不出来（mock 直接调函数），必须打真实 @node-red/util log 模块验证。
**采集边界（09-21 真机验证）**：**被 Catch 节点处理的 error 不进日志管道**（Node-RED 原生"已处理不再记录"行为），site-health 采集不到这类错误——演练流千万别带 catch，有 catch 的现场流程其错误去向以 catch 下游为准。

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

## edgelink-bootstrap 接入包（v1.2.1，面板部署即激活）

- 包：`packages/node-red-contrib-edgelink-bootstrap`；live 副本 `D:\nodered - 副本\node-red-contrib-edgelink-bootstrap`，junction 挂到 `D:\nodered\data\node_modules\`（旧 v1.0.0 备份已于 09-19 删除，全机仅此一份）。
- **v1.2.0（09-19，用户评审定论）**：保持 /auto 严格绑定（密钥+IP:端口），**删掉首启引导页**，激活收进节点面板——面板填「后端地址+端口+密钥」部署即调 /auto：成功→绿点+落盘 0600；被拒→红灯显示后端中文原因+300s 重探；网络不可达→60s 重试。start-nodered.ps1 不再弹引导页。
- **v1.2.1（09-19，用户实测发现）**：拒答真正停采——校验通过前不写 global；后端明确拒答时清配置+断凭据（configReady/devices/tagConfigs/jwt/账密/apiKey），CM 下周期自动完整重激活；category 从 config 改 function（config 类不进左侧面板）。
- 取值优先级：节点面板 > 落盘文件 > settings.js/环境变量；密钥只写不读。
- ps1 注释必须纯英文（无 BOM 中文会被 GBK 误读解析炸）；httpAdmin 路由读 body 要先看 `req.body`（v1.2.0 起无 httpAdmin 路由，此坑封存）。
- 后端 `/auto` 曾有的 MissingGreenlet bug 已修（commit 前取字段）。
