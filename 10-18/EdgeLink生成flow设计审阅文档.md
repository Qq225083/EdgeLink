# EdgeLink 生成 Flow 设计审阅文档

> 供其他 AI/工程师审阅使用。本文只描述**当前真实实现**，不把规划当成果。
> 基准：2026-10-18，当前最新发布 v74（release id=78，1 台设备 39 个节点），生成器 v1.1.1。

## 1. 系统目标与硬约束

- 目标：后端配置（PLC 设备/点位/采集点）→ 生成纯社区节点的 Node-RED flows.json → Admin API 部署到边缘。
- 硬约束：**不使用自研节点**，只使用社区/核心节点；生成页视为"编译产物"，禁止手改。
- 每条 PLC 一条独立 tab + 独立 MC 连接（一机一连接池），基础设施单独一个 tab。
- 当前已落地能力：生成、合并部署、漂移检测、回滚、画布快照、PG 多目标写库、异常履历、离线区间、Teams 断线通知。

## 2. 总体架构

```
RuoYi 后端配置（设备/点位/采集点）
        ↓ generate()
生成器 module_flowgen
        ↓ flows.json（版本链 plc_flow_release）
Admin API（merge 部署）
        ↓
边缘 Node-RED
        ↓
MC/Modbus 采集 → 块内装配 → join → 契约装配
        ↓
MQTT / PG / 通信状态上报 / link out / Teams
```

### 关键实现文件
- `ruoyi-fastapi-backend/module_flowgen/service/generator_service.py`：取数、校验、块合并、支路组装、版本落库。
- `ruoyi-fastapi-backend/module_flowgen/service/flow_builders.py`：节点生成器、JSONata 表达式、PG SQL。
- `ruoyi-fastapi-backend/module_flowgen/service/deploy_service.py`：合并部署、漂移检测、版本留痕、部署预览、快照。
- `ruoyi-fastapi-backend/module_site_health/`：心跳/异常履历/离线区间/站点配置。
- `ruoyi-fastapi-backend/module_plc/controller/monitor_controller.py`：心跳、PG 计数、离线区间 edge 接口。

## 3. 当前生成 Flow 结构

以 v74 为例：

- tab：`GEN_采集_123` + `基础设施`。
- MC 地址：`D100,4`（D100~D103，含空洞容忍的块读合并）。
- MQTT：`edgelink/gen/data/66/49`、`edgelink/gen/alarm/plc_offline/49`。
- PG：`INSERT INTO public.plc_data_log (...)`，支持多目标、列子集、模式/表可配。
- 不再有显式 `reinitialize` 重连支路，重连交给 MC 包连接池自动处理。

### 设备支路节点顺序
```
inject → MC Read（每块） → 块内装配 / 失败标BAD → join → 契约装配
       → 有值才报 → MQTT / PG / 通信状态上报 / link out
```

### 基础设施 tab
- site-health-server 共享配置（Key 一次录入）；
- site-health 健康上报、flows-upload 上传；
- MQTT broker、PG 配置节点；
- 心跳（30s，带 flow_version 回执）。

## 4. 数据契约

### MQTT 报文（values[] 结构）
```json
{
  "node_id": 66,
  "device_id": 49,
  "device_name": "123",
  "host_pc_ip": "192.168.0.179:1880",
  "ts": "2026-10-18T01:00:00.000Z",
  "value_count": 3,
  "values": [
    {
      "tag_id": 92,
      "tag_address": "100",
      "tag_name": "温度1",
      "raw_value": 5771,
      "register_type": "D",
      "eng_value": 57.71,
      "unit": "℃",
      "quality": "GOOD",
      "ts": "2026-10-18T01:00:00Z"
    }
  ],
  "quality": "GOOD"
}
```

### BAD 语义
- 某块读取失败时，不是静默丢轮，而是生成一块全 BAD 空值（raw/eng=null），保证 join 永远收得齐块数。
- `comm_expr` 目前只以 `quality="BAD"` 判离线，**不统计 UNCERTAIN**（见风险 R1）。

### PG 写库
- 默认插入列：`device_id, tag_id, node_id, raw_value, eng_value, quality, transform_type, ts`。
- 支持手动扩展：`tag_name / tag_address / register_type / unit`；`device_name / host_pc_ip` 目前没有映射。
- `created_at` 由数据库 `DEFAULT now()` 填充。
- 多目标：每个目标独立 库/模式/表/列子集，SQL 在契约装配时生成 `pg_sql_i`。

## 5. 关键算法与设计

### 5.1 块读合并（含空洞容忍）
- 同寄存器类型、地址连续或间隙≤`block_gap` 字时合并为一块；
- 空洞多读回后丢弃，避免跳址点位生成几百个 MC Read；
- 多块间用 join 合并，BIT 连读用 `M200.3,4` 形式。

### 5.2 亚秒采集
- inject 最低 1s，<1s 用 `inject(once) + delay 自循环`，周期=管道耗时+延迟，自带背压。

### 5.3 变化触发
- rbe 监视 `changeKey`（tag_id/eng_value/quality 投影，不含 ts），避免 payload 含 ts 导致永远放行。

### 5.4 确定性 id
- 节点 id = sha1(site_id:角色:device_id...)[:16]；
- 用于 credential 存活、合并部署、漂移检测、link out 连线存活。

### 5.5 PG SQL 生成
- 字符串字段用 `$replace(..., "'", "''")` 转义；
- BIT 布尔值归一为 1/0，避免写入 double precision 报错；
- 必填列 device_id/tag_id/quality 强制包含。

## 6. 部署、版本与快照

### 合并部署
- 默认只替换生成 tab（按确定性 id + 历史 GEN_ 前缀清理）；
- 用户自建 tab 不动；
- 带 rev 的 v2 安全部署，409 冲突即报。

### 漂移检测
- 只在生成范围比对；
- 归一化剔除：g、x/y、分组 w/h、*FieldType、空串/None、布尔字符串、数字字符串、credential 占位、PG 明文凭证、debug.active、link out.links。

### 回滚与快照
- 回滚=以历史内容生成新版本（版本链只前进）；
- 部署成功后自动归档完整边缘画布快照，每现场 20 份，也可手动备份；
- 快照包含用户自定义 tab，恢复时不能只依赖 release（release 只含生成页）。

## 7. 监控与异常履历

- 心跳：30s 上报，90s 无心跳判离线；
- 离线区间：相邻心跳间隔 > 3×心跳间隔 记为一段离线，带恢复时间和疑似重启；
- 异常履历：节点 errors 逐条入库，保留 7 天，可分页/时间筛选；
- 当前离线判定用未筛选最新心跳，停用站点不误报为离线；
- Teams 断线通知：断线开始/恢复各发一次，首次启动不补报历史，离线不足 60s 防抖，webhook 为空自动跳过。

## 8. 重连与异常处理

- MC 连接池在 error/close 后自动重连（固定约 1s 重试，不是退避）；
- 已删除显式 `reinitialize` 支路（该指令在 1.2.1 中不存在）；
- 手动 `connect` 指令有效但通常不必要；
- `connectionCleanup` 的 error 监听保留已修复，避免 ETIMEDOUT 变 uncaughtException。

## 9. 安全现状

- MQTT 凭证走 `deploy_credentials`，部署时经 Admin API credentials 对象下发，**不写入 flows.json**；
- PG 密码：该节点包是明文普通字段，会出现在 flows.json/快照/版本链里，属于敏感数据；
- X-API-Key 目前是全局单密钥；
- Node-RED Admin API 未启用 adminAuth；
- 快照/下载需要按敏感文件管控。

## 10. 验证证据

- 冒烟测试：块合并、BIT、亚秒、rbe、PG 多目标、SQL 转义、离线/重连结构等全绿；
- 黄金快照：130 节点，作为生成器回归基线；
- 节点契约 lint：字段名/switch 规则校验，当前只剩 2 个已知 modbus 待装包项；
- PG SQL 实测：单引号转义、布尔归一、NULL 正确；
- 断线实测：离线区间/疑似重启正确；
- Teams flow：id/wires 闭合，首次不补报历史、断线/恢复各一次。

## 11. 当前已知风险（按优先级）

| # | 风险 | 影响 | 建议 |
|---|---|---|---|
| R1 | `comm_expr` 只数 BAD，不数 UNCERTAIN；MC 回复超时可能走输出 1，被当成好路 | 超时可能显示"在线+空数据" | 好路也判 `payload == null || msg.problem`，UNCERTAIN 也算离线 |
| R2 | Modbus 社区包未安装/未真机验证 | Modbus 支路不能视为可投产 | 装包后真机对拍 |
| R3 | PG 无断库 spool | 断库期间历史数据丢失 | 加文件缓冲+重放，或接受并书面签字 |
| R4 | PG 明文密码/快照/下载暴露面大 | 凭据泄露风险 | 快照脱敏、按现场独立 Key、adminAuth |
| R5 | 自动重连固定约 1s 重试，非退避 | 长时间宕机可能频繁重试 | 需要时做退避，但别恢复显式 reinitialize |
| R6 | `device_name / host_pc_ip` 未映射 | 这两列写不进去 | 需要时补 `pg_sql_expr` 映射 |
| R7 | Teams 状态在 flow context，重启丢状态 | 重启期间的断线/恢复不补报 | 可接受或改持久化 |
| R8 | join 超时后可能跨轮拼包 | 偶发一轮脏数据 | 仅作兜底，正常路径不依赖 join 超时 |

## 12. 请审阅者重点回答的问题

1. **MC 回复超时走输出 1 时，当前好路装配是否可能把空数据当正常数据？** `comm_expr` 只数 BAD 是否足够？
2. **PG 明文密码和快照保存方式是否满足生产安全要求？** 怎样最小改动消除？
3. **Modbus 支路目前的失败分流（null/empty/else）是否可靠？** 需要哪些真机用例？
4. **自动重连（error/close 后固定 1s 重试）是否适合现场？** 需要退避吗，还是保持包行为？
5. **断库丢数据是否可以接受？** 过渡版要不要做 spool？
6. **合并部署的"按 id 认门 + GEN_ 残留清理"在多现场/多版本共存时是否还有漏网场景？**
7. **当前只读 link out 作为定制逻辑接口是否足够？** 后面接 OPC UA 时应复用到什么程度？

## 13. 审阅时可直接复核的实测入口

- 生成接口：`POST /plc/flowgen/generate`
- 部署接口：`POST /plc/flowgen/release/{id}/deploy`
- 漂移检测：`GET /plc/flowgen/deploy/status?siteId=1`
- 离线区间：`GET /monitor/offline-intervals-edge?site_id=1&days=7`（X-API-Key）
- 异常履历：`GET /site-health/site/1/errors?days=7`
- 验证脚本：`scripts/test_flowgen_smoke.py`、`scripts/test_flowgen_golden.py`、`scripts/validate_flowgen_against_nodes.py`

## 14. 结论（给审阅者的基准判断）

- 架构选择"配置即代码 + 纯社区节点"是成立的，工程闭环（生成/部署/回滚/快照/监控）基本完整；
- 目前主要风险不在结构，而在**超时语义、断库丢数据、明文凭证和 Modbus 未验证**这四点；
- 审阅时请优先验证 R1/R2/R3，其他属于生产加固项。
