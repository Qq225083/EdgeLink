# EdgeLink 投产前整改清单

> 本文件用于记录 EdgeLink 系统在正式投产前必须完成整改的问题，以及在整改过程中新发现的问题。
> 创建时间：2026-07-18
> 维护方式：每修复一项打勾，新发现问题按 P0/P1/P2 分级追加。

---

## 🔴 P0 — 阻塞投产（必须全部解决）

| 编号 | 问题 | 位置 | 状态 | 修复人 | 修复时间 | 备注 |
|------|------|------|------|--------|----------|------|
| P0-1 | 设备/点位变更无法实时生效，Node-RED 最长 5 分钟后才刷新配置 | `docs/V12/edgelink_v12_main_flow.json` | ✅ 已修复 | Claude | 2026-07-18 | 改为“保存+手动发布”模式：新增 `/plc/config/publish` 接口，Web 端点击发布后通过 MQTT 推送 CONFIG_REFRESH；Node-RED 保留 30s 兜底轮询 |
| P0-2 | Tag 级协议参数（byteOrder/wordOrder/bitOffset）未下发到 Node-RED，Modbus 字节序/MC 位偏移失效 | `docs/V12/edgelink_v12_main_flow.json` | ⬜ 待修复 | | | |
| P0-3 | `report_deadband_ms` 单位语义前后端不一致：后端/前端标为 ms，Node-RED 实际按数值死区处理 | `module_plc/entity/do/tag_do.py`、`src/views/plc/device/index.vue`、`docs/V12/edgelink_v12_main_flow.json` | ⬜ 待修复 | | | |
| P0-4 | 软删除设备后，KPI 仍把该设备计入“在线 PLC 数” | `module_plc/service/device_service.py`、`module_plc/dao/monitor_dao.py` | ✅ 已修复 | Claude | 2026-07-18 | 已同步置 0 comm_status + KPI JOIN 过滤 |
| P0-5 | 停用设备后 5 分钟内仍被采集，且通信状态仍可能显示在线 | `module_plc/service/device_service.py` | ✅ 已修复 | Claude | 2026-07-18 | 已同步置 0 comm_status；配置生效改为手动发布，避免误操作立即影响采集 |

---

## 🟡 P1 — 高风险（建议投产前修复）

| 编号 | 问题 | 位置 | 状态 | 修复人 | 修复时间 | 备注 |
|------|------|------|------|--------|----------|------|
| P1-1 | `protocol_compat_controller` 未鉴权，协议元数据对外暴露 | `module_plc/controller/protocol_compat_controller.py` | ✅ 已修复 | Claude | 2026-07-18 | 已加 PreAuthDependency |
| P1-2 | `MONITOR_API_KEY` 默认空值，导致 API Key 鉴权被跳过 | `config/env.py`、`module_plc/controller/monitor_controller.py` | ✅ 已修复 | Claude | 2026-07-18 | 已改为必填字段 |
| P1-3 | 多处硬编码/默认凭据（Node-RED admin/***、本地 API Key、前端 MQTT 密码、JWT 默认密钥） | `docs/V12/edgelink_v12_main_flow.json`、`src/views/plc/monitor/index.vue`、`config/env.py` | ⬜ 待修复 | | | |
| P1-4 | `/monitor/alerts` 的 `limit` 参数无上限，可拉取全表导致 OOM | `module_plc/controller/monitor_controller.py` | ✅ 已修复 | Claude | 2026-07-18 | 已限制 1-500 |
| P1-5 | 设备/点位状态切换接口未校验状态枚举，可写入任意字符串 | `module_plc/controller/device_controller.py`、`tag_controller.py` | ✅ 已修复 | Claude | 2026-07-18 | 已在 Service 层校验 0/1 |
| P1-6 | 设备详情仅返回前 100 条点位，超限静默缺失 | `module_plc/service/device_service.py` | ⬜ 待修复 | | | |
| P1-7 | Node-RED 拉取 `page_size=50000` 无上界，万级点位时后端内存/CPU 飙升 | `module_plc/entity/vo/tag_vo.py` | ⬜ 待修复 | | | |
| P1-8 | 全局点位页寄存器筛选值域与后端不一致，Modbus 类型无法筛选 | `src/views/plc/tag/index.vue` | ⬜ 待修复 | | | |
| P1-9 | 量程映射（slope_offset）前后端实现不一致，Node-RED 仅做线性 y=ax+b | `module_plc/service/tag_service.py`、`docs/V12/edgelink_v12_main_flow.json` | ⬜ 待修复 | | | |
| P1-10 | 监控中心 `plcList` 字段混用 snake_case | `module_plc/dao/monitor_dao.py`、`src/views/plc/monitor/index.vue` | ✅ 已修复 | Claude | 2026-07-18 | 已统一为 camelCase |
| P1-11 | 数据类型不支持 Modbus unsigned / BOOL | `module_plc/service/tag_service.py` | ⬜ 待修复 | | | |
| P1-12 | 心跳上报未校验 `host_pc_ip`，可能创建异常节点记录 | `module_plc/controller/monitor_controller.py` | ⬜ 待修复 | | | |

---

## 🟢 P2 — 建议优化（可排期）

| 编号 | 问题 | 位置 | 状态 | 修复人 | 修复时间 | 备注 |
|------|------|------|------|--------|----------|------|
| P2-1 | 复合索引缺失 | `module_plc/entity/do/device_do.py`、`tag_do.py` | ⬜ 待修复 | | | |
| P2-2 | `nodered_node` IP 字段长度 20 与 `plc_device` 50 不一致，不支持 IPv6 | `docs/monitor_center.sql`、`module_plc/entity/do/monitor_do.py` | ⬜ 待修复 | | | |
| P2-3 | 前端协议配置 localStorage 缓存 24h，后端修改后前端长时间陈旧 | `src/views/plc/device/index.vue` | ⬜ 待修复 | | | |
| P2-4 | `TagBatchUpdateModel` 缺少协议字段 | `module_plc/entity/vo/tag_vo.py` | ⬜ 待修复 | | | |
| P2-5 | 导入文件一次性读入内存 | `module_plc/controller/tag_controller.py` | ⬜ 待修复 | | | |
| P2-6 | 克隆设备点位上限 9999 | `module_plc/service/device_service.py` | ⬜ 待修复 | | | |
| P2-7 | 告警列表 `device_name` 恒为空 | `module_plc/service/monitor_service.py` | ✅ 已修复 | Claude | 2026-07-18 | 已 JOIN plc_device 回填 |
| P2-8 | Controller 层重复调用 `_sync_nodes_from_devices` | `module_plc/controller/monitor_controller.py` | ⬜ 待修复 | | | |
| P2-9 | 导入返回 `success_count` 取 `len(valid_tags)` 而非 DAO 真实写入数 | `module_plc/service/tag_service.py` | ⬜ 待修复 | | | |
| P2-10 | 设备编辑 Service 中 `mes_ip` 校验重复调用 | `module_plc/service/device_service.py` | ⬜ 待修复 | | | |
| P2-11 | `mqttClient.js` clientId 用 `Math.random()` 拼接 | `src/utils/mqttClient.js` | ⬜ 待修复 | | | |
| P2-12 | 前端 `backupPcIp` 无格式校验 | `src/views/plc/device/index.vue` | ⬜ 待修复 | | | |
| P2-13 | `confirm_alert` 可将已恢复告警重新置为已确认 | `module_plc/dao/monitor_dao.py` | ⬜ 待修复 | | | |

---

## 整改过程中新发现的问题

> 请在下面追加，格式同上。

| 编号 | 问题 | 位置 | 状态 | 修复人 | 修复时间 | 备注 |
|------|------|------|------|--------|----------|------|
| | | | | | | |

---

## 投产判定标准

- [ ] 所有 P0 问题已修复并验证
- [ ] 所有 P1 问题已修复或已接受风险并记录
- [ ] 至少完成 1 次端到端 E2E 测试（设备新增 → Node-RED 采集 → 前端监控）
- [ ] 至少完成 1 次压力测试（≥1000 点位）
- [ ] 生产环境 `.env` 已配置 `MONITOR_API_KEY`、`JWT_SECRET_KEY`、MQTT 凭据
- [ ] Node-RED 流已重新部署且无硬编码凭据
- [ ] 数据库迁移脚本已执行且可回滚

---

## 最近更新

- 2026-07-18：创建清单，完成 P0-1/P0-4/P0-5、P1-1/P1-2/P1-4/P1-5/P1-10、P2-7 修复。
- 2026-07-18：根据用户要求，将 P0-1 的“自动实时下发”改为“保存+手动发布”模式，新增 `/plc/config/publish` 接口与前端发布按钮，降低误操作风险。
