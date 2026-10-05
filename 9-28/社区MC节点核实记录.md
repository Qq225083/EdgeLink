# 社区 MC 节点源码核实记录（2026-09-28）

> 核实对象：[node-red-contrib-mcprotocol](https://github.com/Steve-Mcl/node-red-contrib-mcprotocol)（原版 1.2.1）及维护分支 [node-red-contrib-mcprotocol-ind](https://flows.nodered.org/node/node-red-contrib-mcprotocol-ind)（1.7.5）。
> 方法：直接读 GitHub 源码（`nodes/read.js`、`nodes/connection.js`、`package.json`）。
> 用途：生成器模板的事实依据。以下结论仅来自源码阅读，**真机行为以 M2 对拍为准**。

## 1. 注册的节点类型名（生成器填 type 字段用）

| 节点 | 注册类型名 | 出处 |
|---|---|---|
| 读取节点 | `MC Read` | read.js `RED.nodes.registerType("MC Read", mcRead)` |
| 写入节点 | `MC Write` | package.json `nodes.mcWrite`（过渡版不用） |
| 连接配置节点 | `MC Protocol Connection` | connection.js `registerType("MC Protocol Connection", ...)` |

## 2. 连接配置节点字段（生成器从 plc_device 映射）

connection.js 确认的字段与默认值：

| 字段 | 默认 | 后端来源（plc_device 列） |
|---|---|---|
| host | — | plc_ip |
| port | — | plc_port（默认 5007） |
| protocol | TCP | 固定 TCP |
| plcType | Q | plc_series 映射（Q/L/FX） |
| frame | 3E | mc_frame |
| ascii | false | 固定 false |
| PLCStation | 0 | station_no |
| PCStation | 0xff | 固定默认 |
| PLCModuleNo | 0x3ff | 固定默认 |
| network | 0 | network_no |
| timeout | 1000 | comm_timeout_ms |
| octalInputOutput | false | plc_series=FX 时置 true（**X/Y 八进制在连接级处理**，V12 怪癖④字母剥除在生成版不存在） |

## 3. 读取节点行为（read.js 逐行确认）

- **地址**：节点配 `address` 字符串（支持 msg 动态注入），透传给 `connection.read(addr)`；地址串语法（块读 `"D100,10"` 等）由底层 mcprotocol 库解释，**模板编写前需在真机验证块读语法**；
- **busy 闸**：`if (node.busy) return;`——上轮未完，新触发直接丢弃（不排队）。支路级天然防积压；
- **超时**：`busyTimeMax` 取连接 timeout，超时 → status 红环 + 按 errorHandling 分流；
- **errorHandling**：`throw` / `msg` / `output2` 三档。生成器固定用 `output2`——错误走第二输出脚，接告警支路，不用 catch 节点兜读错误；
- **输出**：`outputFormat=0` 时 payload 为 JSON 对象（key=地址字符串，如 `"D100"`；BIT 类型为 `"D100.0"`）；`outputFormat=1` 为 Array；
- ⚠️ **更正（2026-09-30 评审 A3）**：本行此前写的"带 msg.quality/msg.isGood"——**错误**。那是库返回对象（PLCReadResult）上的属性，节点出参 msgMem 只被写入 payload/mcReadDetails（read.js:104-110、225），`msg.isGood` 永远 undefined。生成器好路 quality 已改为写死 GOOD；
- ⚠️ **补充（评审 A4）**：BIT 地址串正确形式是 `M200.3`（类型+地址.十六进制位号），`M200,3,BIT` 过不了库地址正则（mcprotocol.js:3078+3087 严格匹配抛 addr is invalid）；
- ⚠️ **补充（评审 A5）**：本机 live 环境实际 vendored 的是**原版 node-red-contrib-mcprotocol@1.2.1**（无 -ind 分支），本文档结论均以 1.2.1 为准；
- **连接池**：`connection_pool.get(port, host, options)` 按 host:port 分键复用——**每 PLC 一个独立 config 节点 = 独立连接**，隔离成立；
- **控制消息**：`msg.topic = connect / disconnect / reinitialize` 可控制连接（kill switch 弱化版可用）；
- **断线**：status 红点 "not connected"，busy 复位。

## 4. 与自研 mitsubishi 节点（v1.4.4+）的差距（复学证据收集点）

| 能力 | 社区节点 | 自研节点 |
|---|---|---|
| 连接池 | ✅ 有（host:port 分键） | ✅ 有 |
| 上轮未完处理 | 丢弃（busy 闸） | 快速失败（轮次闸） |
| 队列熔断 | ❌ 无（本就无队列） | ✅ 队列 >20 熔断 |
| 块读聚类 | ❌ 运行期无（生成器在编译期聚类，见计划 §四） | ✅ 960 字 span 聚类 |
| 超时 | ✅ 连接级 timeout | ✅ 设备级配置 |
| 进程级崩溃 | 无防护（新旧相同） | 无防护，site-health 兜底 |

## 5. 待真机验证清单（M2）

- [ ] 块读地址串语法与最大长度；
- [ ] FX 系列 + `octalInputOutput=true` 的 X/Y 读取正确性；
- [ ] PLC 断网/断电恢复后的自动重连行为；
- [ ] 一台 PLC 卡死（拔网线保持 socket 半开）对其他支路的影响；
- [ ] 输出 `msg.quality` 的全部取值集合（契约映射表穷举依据）。
