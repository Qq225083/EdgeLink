# AGENTS.md — EdgeLink 审阅交接目录（2026-10-18）

> 本目录是本次会话的交接工作区。新开 Claude Code 时先读本文件，再读
> `记忆-2026-10-18-审阅与整改.md`。完整证据行号、P0 清单、两周排期结论都在那份记忆里；
> 本文件只放“进门必读”。

## 当前状态

- 三周整改计划：本会话独立复核 **Day 1–12 全 PASS**；**Day 13 未执行（FAIL，无真机证据）**；**Day 14 离线交付 PASS、整日 INCOMPLETE（浸泡观察依赖 Day 13）**。逐日裁决在记忆第 14 节；DI/DISCRETE=`Input` 的上一轮误判已在 14.8 撤回。
- 仓库根：`C:\Users\admin\Desktop\RuoYi-Vue-FastAPI`；分支 `main`；基准 commit `21352a6`。
- 工作区未提交改动（Day 1–9 累积，提交前给用户过目）：
  - `module_flowgen/drivers/`（新增，MC driver 等）
  - `module_flowgen/service/flow_builders.py`、`generator_service.py`、`deploy_service.py`
  - `module_flowgen/dao/flowgen_dao.py`
  - `scripts/golden/flowgen_golden.json`（137 节点）、`test_flowgen_smoke.py`、`test_flowgen_golden.py`、
    `validate_flowgen_against_nodes.py`、`mc_contract_probe.js/.expected.json`、`mc_reconnect_probe.js`
  - 未跟踪：`10-18/`、`ruoyi-fastapi-frontend/tmp_*.py`、`tmp_v13_analysis/`
- 审阅对象：`../EdgeLink生成flow设计审阅文档.md`
- 整改计划：`../整改计划.md`
- OPC UA 设计：`../生成器改造与OPCUA输出设计.md`
- 机器上 live Node-RED：`D:\nodered\data\flows.json`
- MC 包源码：`D:\nodered\data\node_modules\node-red-contrib-mcprotocol`

## 用户是谁 / 怎么沟通

- EdgeLink 项目负责人/开发者，中文交流；日企现场，**MC 为主，S7 暂缓**。
- 要判断，不要含糊；结论先行，给证据行号、人日、风险灯。
- 用户明确纠正过的三件事，别再犯：
  1. 不要写“MC 超时没有空数据”或“超时走输出 1”。`make_mc_read` 是
     `errorHandling='output2'`，超时/错误走输出 2；真正的风险是成功路可能空值 +
     `UNCERTAIN` 不计入离线。
  2. `M200.3,4` 不是“读 4 个字”，是**位数组读**；真正的问题是输出键契约。
  3. “纯社区节点”要拆成：**数据面纯社区 + 基础设施自研 site-health**。
- 已撤回的误判，不要重复：
  - `_load_config_version` 的 `order_by(id).limit(1)` **不是 bug**（快照表是单行 upsert）。
  - INT32/UINT32 生成的 `DDINT100`/`DDWORD100` 是**对的**。
  - 位设备全局点位不是 `M200.8~M200.B`，而是 **`M200~M203`**。
  - 删除 `reinitialize` 重连支路**不是功能回退**——`read.js:213-220` 只识别 `connect`/`disconnect`，`reinitialize` 本就是死支路；Day 7 用 `topic="connect"` 心跳替换，不要恢复它。
  - FX X/Y 的进制**不能**用探针的「包按十六进制」去否定生成器的「八进制解析」——分三个域：用户配置域（FX X/Y 八进制，项目契约）→ 生成器换算（八进制→十六进制）→ 包地址域（十六进制）。`X17 → XF` 换算方向正确，保留；探针 `X17→offset 23` 是「未换算会读错」的反例，不是换算错误。

## 下一步（从记忆第 14 节继续）

三周计划：**Day 1–12 PASS；Day 13 未执行（FAIL）；Day 14 离线交付 PASS、整日 INCOMPLETE**，裁决见记忆 14.7/14.8。
**Day 13（试点部署 + 72h 浸泡）必须真机执行**：generate → deploy 预览 → deploy →
画布/心跳/PG/MQTT 校验 → join 失败/断线恢复注入 → 72h 起算。adminAuth 的 live 启用
（settings.js + 真账号 + token + 重启）需用户书面授权，未执行。
**Day 14 离线项已完成**：FC 映射单一来源（`drivers/modbus.py`）、0-65535 范围、大小写归并、混合协议校验回归、HR/IR/CR/DI golden（145 节点）、文档四件套。**剩余只有浸泡观察与真机**（社区包本机未装，`edgelink-modbus` 契约不同不能替代；FC01/02/03/04 抓包、跨轮 join、亚秒、72h 未做）。
上边缘前先过 Day 9/10 的真机验收项（14.3 / 14.4）；跟进项见 14.5（teamsWebhook 列表脱敏）与 14.6。

## 操作红线

- git 提交/推送前必须给用户过目文件清单。
- 改 `D:\nodered\data\flows.json` 前必须备份（`baseline_*/flows.json.bak-*`）。
- 后端改动需重启生效；菜单 SQL 改动后用户重新登录生效。
- 不要以 `edge/nodered/` 快照为基准（滞后）；live 在 `D:\nodered\data\flows.json`。
- 不要把 V12/V13 的结论和当前 `module_flowgen` 生成器混为一谈；V13 的
  `cd v13 && node --test test/` 与本次生成器测试无关。

## 快速恢复提示词

> 先读 `10-18/deepseek/AGENTS.md` 和 `记忆-2026-10-18-审阅与整改.md`，
> 我们从第 10 节继续；先不要改代码，先确认走 A 还是 B。
