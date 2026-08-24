## v1.6.3 (2026-08-05)
- **FIX: SLMP ASCII Code 以太网通信（重要）** — 旧版 `asciify`/`deasciify` 实现的是串口 ASCII 格式（STX+hex+ETX+checksum），无法与以太网 ASCII Code 的 PLC 通信。新增 `toAsciiHex`/`fromAsciiHex`/`dehexifyFrame`（纯 hex 编解码，无帧头帧尾），read/write 节点 TCP 路径全面切换
- **FIX: write 节点 ASCII 接收路径补齐** — 位写、字写、RMW 读、RMW 写四个 TCP `_dataHandler` 均已补 hex 解码
- **FIX: UDP+ASCII 假阳性** — 选 UDP+ASCII 时降级为 Binary 并打 warn，避免用户误以为 UDP 支持 ASCII Code
- **FIX: bitOffset 空字符串误报警告** — 点位配置中含 `bitOffset: ""` 时不再打印 `Invalid bitOffset` 警告
- **TEST: +12 项 SLMP ASCII** — 往返、3E/4E 帧提取、错误路径、垃圾前缀、尾数据、与 asciify 一致性；write 端到端 ASCII 测试更新

## v1.6.0 (2026-08-02)
- **FIX: engValue 浮点算术尾巴** — `applyTransform` 统一 10 位小数舍入（新增 `roundEng`）：27862×0.1 输出 2786.2 而非 2786.2000000000003；小值精度保留（0.00006 不会像旧 toFixed(4) 那样被抹成 0.0001）；|v|≥9e5 大值跳过舍入（v*1e10 逼近 2^53，舍入反而引入误差）。计算点位 rawValue 同步处理。注：FLOAT32 解码源本身只有 ~7 位有效数字，显示层格式化另行处理
- **FEAT: 写入表格新增默认值列（value）** — 面板可配静态默认值，任意消息触发即整表写入，临时写固定值调试不再依赖 function 节点；CSV 导入导出同步
- **FEAT: msg.tags 与面板表格合并（替代全量覆盖）** — msg 点位按 id（其次 regType+addr）匹配面板行补齐缺失字段，value 缺省回落面板默认；未被 msg 引用的面板行本轮不执行（防静态值随动态轮次误写，写操作有副作用）
- **FIX: 写入值统一收敛** — 面板字符串值按类型转换（BOOL 词表 true/1/on，数字 Number()），非法值拒写而不是静默写 0；空串视为缺省值
- **TEST: 104 项** — 新增舍入边界（尾巴/小值/大值/roundEng）、静态默认值写入、id 合并覆盖/回落、副作用安全用例

## v1.5.1 (2026-07-28)
- **FEAT: 写入节点 `mitsubishi-write`（新）** — 批量字写入（0x1401）、TCP/UDP 双传输、独立写连接池、per-PLC 轮次闸、值校验钳制（UINT16/INT16/INT32）、X 写入警告、SIM 模式；输出 `data[tagId]={value,quality,ts}`
- **FEAT: 位设备原生位写**（0x1401 子指令 0x0001）— M/X/Y/L/B 单往返写入，替代 RMW 消除竞态；nibble 打包与 pymcprotocol 对拍一致；RMW 仅保留"字内位"（D100.3）场景
- **FIX: 写分组严格连续**（`groupTagsContiguous`）— 杜绝间隙填 0 清空 PLC 未配置地址（字写/位写同类问题，两轮修复）；写帧 `dataLen=12+2n` 修正（旧版少 2 字节，真机必报帧长错误）
- **FIX: read 侧请求级超时回调**（`_tmoHandler(mcSocket)()` → `_tmoHandler()`，真实超时路径 TypeError）+ 回归测试
- **FIX: 分组改为 960 字 span 感知聚类**（`groupTags`，万点 11 帧替代旧 cluster<50 的 200+ 帧）；addr=0 合法化（D0/M0/X0）；FX 八进制含 8/9 拒绝；响应帧型严格校验；FLOAT32/applyTransform/计算点位去 toFixed(4)；UDP RMW `_closed` 释放；UINT16 负数/INT32 越界钳制
- **TEST: 91 项** — 写帧 golden buffer（含 dataLen 断言）、encode↔decode 往返对称、连续/间隙分组、原生位写、RMW、请求级超时、10k 压测

## v1.4.4 (2026-07-27)
- **FEAT: UDP 传输支持** — `mitsubishi-config` 新增 `protocol: tcp|udp`（默认 tcp 兼容存量）；新增 `nodes/mc-udp.js` 会话层（共享 dgram socket、单在途串行化、ICMP 仅失败当前请求、迟到包丢弃、空闲 10min 回收、close 释放）；3E/4E 帧在 UDP 下与 TCP 完全一致（SLMP 原生支持）
- **FIX: 32/64 位数据断线（重要）** — emit 的 `rawValue` 现在输出**解码后的值**（INT32/UINT32/FLOAT32/DOUBLE 多字组装结果），原首字保留在 `rawWord` 备查；此前下游只消费 `rawValue` 导致 32/64 位点位只入库第一个字
- **FIX: 4E 帧布局按 SLMP 规范重排** — 序列号+固定值 0000 进副标题（偏移 2-5）、数据长=0x0C（旧误为 0x0E）、总长 25 字节；响应解析 endCode@13/dataStart=15/minLen=15（旧 @9/13/11）；TCP 分帧偏移同步修正；golden buffer 对拍测试（参照 pymcprotocol/SH-080008）
- **FIX: X/Y 地址进制规则** — 仅 FX(iQ-F) 系列为 8 进制，Q/L/iQ-R 均为 16 进制（旧注释"Q 系为 8 进制"有误）；`mitsubishi-config` 新增 `series` 字段（Q/L/iQ-R/FX）
- **FIX: 连接池 `_closed` 中止路径泄漏** — 全部 6 处关闭中止点统一 `releaseConnection`，重部署落在读取窗口不再楔死连接
- **FEAT: per-PLC 轮次闸** — 同 PLC 上轮未结束时新轮次直接失败返回（`Round in progress`），替代池队列积压过期数据；close 时清理防跨部署泄漏
- **FEAT: 错误可被 catch 节点捕获** — 所有失败路径 `node.error(text, msg)`（帧白名单/无有效点/无组/节流/闸/连接失败/连接丢失）
- **FEAT: 编辑器对齐运行时能力** — 点位表格新增 字节序/字序/位偏移 三列（CSV 导入导出同步）；config 新增 PLC 系列与传输协议
- **FEAT: 分组改为 960 字 span 感知聚类**（万点级采集）— 替代旧 `cluster<50` 拍脑袋值：1 万连续 INT16 从 200+ 帧降到 11 帧；`groupTags` 提取至 mc-protocol 可单测（INT16/INT32/DOUBLE/位元件/混排全覆盖）
- **FIX: bitOffset 钳制 0-15**（越界告警并归 0）；地址上限 0xFFFFFF 校验（超限拒绝而非静默截断）
- **FIX: slope=0 合法化** — `applyTransform` 不再被 `||1` 吞掉；未知 dataType 回退原值
- **REFACTOR: 解码逻辑提取** — 内联解码提取为 `mc.decodeTag`（可单测，行为不变）；TCP/UDP 输出装配共享 `assembleAndSend()`
- **TEST: 测试套件重建** — 3E/4E golden buffer 对拍、X/Y 进制、decodeTag 全组合、UDP 端到端（dgram 模拟 PLC：3E 解码/4E 序列号回显/丢包重试）——43 passing
- **二次审查修复（review#1-9）**：FX 八进制地址含 8/9 直接拒绝（旧 parseInt('18',8) 静默截断为 1）；响应帧型与请求帧型严格校验（3E↔D0/4E↔D4）；build 帧 wordCount 1-960 函数级守卫；FLOAT32/applyTransform/计算点位去除 toFixed(4) 精度截断；TCP 增加请求级兜底定时器（防慢滴漏响应绕过 socket 空闲超时）；删除批次拆分 subMax 死变量；mc-udp releaseNode 幂等性注释。未采纳：#2（JS 单线程模型下检查与回调同步执行无竞态窗口）、#5（EventEmitter 监听器按注册顺序同步执行，且建议修法会去掉 socket 错误重连韧性）

## v1.4.2 (2026-07-18)
- CHORE: 发布 v1.4.2

## v1.4.1 (2026-07-18)
- FIX: 输出补全 `deviceName` — 模拟/成功/失败/节流/无组/连接丢失路径全部携带，兼容下游 `sf-data-processor`
- FIX: 连接池引用计数 — `CONN_POOL[key].users[nodeId]` 跟踪节点使用关系，单个节点 close 不再误杀其他节点共享的连接
- FIX: `_activeNodeCount` 泄漏 — PLC 配置未关联时提前 return 前正确递减，清理定时器可正常停止
- FIX: socket 闭包捕获 — `attemptGroup` 内 timeout/error/data 处理器通过 IIFE 绑定当前 socket 实例，重连后避免误操作新 socket
- FIX: 统一监听器清理 — `cleanupListeners(sock)` 替代多处重复 removeListener
- TEST: 新增 `deviceName` 传入与 fallback 到 PLC 配置名的测试

## v1.4.0 (2026-07-18)
- FIX: INT32/UINT32 高低字顺序修正（D0 为低字，D1 为高字）
- FIX: X/Y 位元件地址按三菱八进制解析与显示
- FIX: 4E 帧始终携带序列号字段，兼容严格 PLC 实现
- FIX: 位元件批量字数上限统一为 960 字（15360 点）
- FIX: 32 位类型自动扩展读取范围以包含相邻寄存器
- FIX: 数据处理器异常时正确标记失败并继续后续组
- FIX: deviceId hash 边界值处理（`Math.abs` 负数问题）
- FIX: Buffer 溢出判断前置于 `Buffer.concat`
- FIX: frameType 支持大小写不敏感
- ENHANCE: 连接池 key 增加帧格式/网络号/站号，避免不同配置冲突
- ENHANCE: 并发建连请求串行化，防止同一 PLC 建立多个 socket
- ENHANCE: socket 增加 `end`/`close` 监听，快速检测干净断连
- ENHANCE: 连接失败指数退避，避免重连风暴
- ENHANCE: 队列请求增加超时机制
- ENHANCE: 输入节流时输出失败消息，不再静默丢弃
- ENHANCE: 支持 Node-RED 1.0+ `done()` 回调
- ENHANCE: 全局清理定时器在最后一个节点关闭时停止
- TEST: 新增单元测试覆盖帧构造、解码、连接池


- FIX: 计算点位 — operator/referenceTag 未写入 validTags 导致计算失效
- FIX: 计算点位 — 32位类型用 convertedValue（全解码值），非 rawValue（低16位）
- FIX: CSV 导入 — 字段映射冗余 fallback 修正

## v1.3.0 (2026-07-17)
- NEW: 设备ID手动配置 — config 面板新增 deviceId 字段，独立使用无需 msg.payload.id
- NEW: 表格分页 — 每页 50/100/200/500 条，支持上千点位不卡顿
- NEW: 计算点位 — referenceTag + operator(add/sub/mul/div) 合并多寄存器值 (如 D0+D1)
- NEW: CSV导入导出 — 批量管理点位数据
- ENHANCE: 表头 sticky 固定 + 滚动体限制 420px

## v1.2.2 (2026-07-14)
- FIX: 队列深度上限 R1 — MAX_QUEUE=50，PLC慢速时拒绝入队防OOM
- FIX: 入口节流 R2 — 队列>20时跳过本周期，防雪崩
- FIX: Buffer上限 R5 — 64KB上限，畸形响应防内存泄漏
- FIX: 动态连接追踪 R6/R7 — close时清理所有曾用连接（含动态IP）
- FIX: finishWithError 防御性释放 R10
- FIX: 清理定时器队列检查 R11
- PERF: groupTs 每组合并时间戳，减少 new Date() 调用

## v1.2.1 (2026-07-14)
- ENHANCE: 连接池请求队列 — 多节点共享同一PLC时排队串行，防止读写交错
- ENHANCE: TCP keepalive (setKeepAlive 30s) — 防止空闲连接被交换机断开
- FIX: 事件监听器残留 — once('timeout')/once('error') 在成功路径中精确清理
- FIX: deviceId 归一化为数字 — 防止下游 edge_commStatus 索引类型错乱
- FIX: node.send 防重入保护 — safeSend 确保每次 on('input') 只输出一条消息
- CLEAN: 移除死代码 connLog + refCount
- DOCS: 版本号注释与 package.json 对齐

## v1.2.0 (2026-07-04)
- FIX: busy-wait self-send causing 4GB heap OOM (message clone storm)
- FIX: deviceId now uses msg.payload.id (numeric) first, falling back to deviceName
- FIX: lock conflict now drops message directly instead of setTimeout(self-send)
# Changelog

## 1.0.2 (2026-06-30)

### Fixed
- 输出添加 `regType` 字段，适配 `edgelink-pg-store` 直写 `register_type` 列
- `rawValue` 保留 PLC 原始 int16，`engValue` 使用解码值 × 斜率 + 偏移
- 4E 帧 `serialNo` 首帧不再跳号（先赋值再递增）
- 输出添加 `deviceId` 字段，适配 pg-store 动态分表

## 1.0.1 (2026-06-29)

### Added
- 14 个运行时 BUG 修复（锁重入、异步异常、serialNo 自增、批量超限、脏帧拦截等）
- `close` 处理器：节点关闭时释放全局锁
- `_destroyedByUs` 标志：区分主动关闭与异常断开

## 1.0.0 (2026-06-29)

### Initial Release
- 三菱 MC Protocol 3E/4E 以太网采集
- 表格编辑器：一个节点读写 N 个点位
- 6 种数据类型：INT16 / UINT16 / INT32 / UINT32 / FLOAT32 / BOOL
- 8 种软元件：D / W / R / X / Y / M / L / B
- 斜率偏移变换：`engValue = rawValue × slope + offset`
- 19 个 MC 错误码中文映射
- 全局模拟模式
- 零外部依赖（纯 Node.js `net` + `Buffer`）
