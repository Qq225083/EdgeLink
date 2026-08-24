## v1.5.0 (2026-08-23)
- NEW: Modbus RTU（串口）支持 — 配置/上游 protocolParams 带 `serialPort`（如 COM3）即走 RTU，否则 TCP 行为不变；RTU 参数 baudRate/dataBits/parity/stopBits 缺省 9600/8/N/1
- NEW: RTU 帧构造/解析入 `modbus-protocol.js` — CRC16（poly 0xA001、init 0xFFFF、低字节在前）、`buildRtuFrame`/`buildRtuWriteFrame`/`parseRtuResponse`/`parseRtuWriteResponse`/`rtuExpectedResponseLen`；响应 CRC 错/截断帧计入失败走现有重试/质量码路径
- NEW: `nodes/modbus-serial.js` — serialport 懒加载可选依赖（TCP-only 环境不装也能加载，RTU 使用时再报中文错误）+ SerialSock 把串口适配成 net.Socket 形态（write/data/setTimeout 闲置超时/destroy）
- NEW: RTU 连接入同一连接池 — 池键 `rtu:COM3:9600:8N1` 参数化；同一物理串口不同参数直接拒绝（串口独占）；错误/断开触发与 TCP 相同的销毁重建逻辑
- NEW: RTU 收帧按"期望长度 + 帧间静默超时（≥3.5 字符时间，下限 30ms）"收齐一帧，不按固定字节数死等
- NEW: 编辑器 HTML — modbus-config 补串口参数区；modbus-read/write 补节点级串口覆盖字段（留空跟随连接配置）
- FIX: cleanupListeners handler 判空 — 重试耗尽分支在新一轮 attempt 里清理时 removeListener(x, null) 在 Node 18 直接抛错（潜伏缺陷，RTU 失败路径测试暴露；TCP 语义不变）
- TEST: 新增 modbus-rtu_spec.js 40 例 — CRC16 已知向量/RTU 帧构造/解析（异常帧、CRC 错、截断）/传输选择/池 RTU 行为/读写节点 RTU 成功失败契约形状与 TCP 一致性

## v1.4.0 (2026-08-02)
- NEW: modbus-write 节点 — FC05 写单线圈 / FC06 写单寄存器 / FC16 写多寄存器（32/64 位原子写入）；裸值或对象 payload 触发，响应 txnId + 回显校验
- NEW: 写安全约定 — 写失败不自动重试（写操作有副作用），由上游决定是否重发
- REFACTOR: 连接池抽为共享模块 `nodes/modbus-pool.js` — 读写节点复用同一池，跨节点类型串行化
- FIX: ownerId 属主追踪 — 节点在持有连接时被关闭直接销毁在途连接（此前部分部署可致共享连接 inUse 永久卡死）
- FIX: 队列获得连接补登 users 引用计数（此前排队路径漏登，close 清理失真）
- FIX: releaseConnection 属主校验 + destroyConnection socket 指纹 — 过期回调不再释放/误杀他人连接
- FIX: 面板字节序 AB/BA/ABCD/CDAB/BADC/DCBA 未映射到协议轴被静默忽略 — decodeValue/encodeValue 现两种词汇均接受
- FIX: applyTransform/计算点位 slope=0 被 `|| 1` 吞掉
- FIX: 计算点位改用 convertedValue 解码值运算（此前用无符号 rawValue，INT16 负值/32 位类型结果错误）
- FIX: FLOAT32 解码移除 toFixed(4) 截断（与 DOUBLE 精度策略一致）
- FIX: 配置缺失的节点 close 时 _activeNodeCount 多减一次（记账失真，清理定时器提前停止）
- TEST: 新增 modbus-pool（7 例）/ modbus-write（8 例，含迷你从站集成测试），协议层补写入帧/回显/编码回环用例，共 52 例

## v1.3.2 (2026-07-18)
- FIX: close 连接池 key 解析 — 直接传完整 key 而非 split 拼接（IPv4 点分十进制误拆为冒号分隔）
- FIX: destroyConnection 兼容单 key 参数调用
- CLEAN: 移除重复的 CONN_POOL/MAX_QUEUE 声明

## v1.3.1 (2026-07-18)
- CHORE: 发布 v1.3.1

## v1.3.0 (2026-07-18)
- REFACTOR: 提取 `nodes/modbus-protocol.js` — 帧构造/解析/解码/变换与运行时解耦，便于单元测试
- FIX: 连接池生产级重构 — 新增节点级 `users` 引用计数、连接失败指数退避、队列超时、`connecting` 状态、清理定时器生命周期管理
- FIX: socket 闭包捕获 — `attemptGroup` 内 timeout/error/data 处理器绑定当前 socket 实例
- FIX: `_activeNodeCount` 泄漏 — Modbus 配置未关联时提前 return 前正确递减
- FIX: Node-RED 1.0+ `send/done` 回调支持 — input/close 均正确调用生命周期回调
- FIX: 节流与无组路径输出携带 `deviceName` 并正确 `done()`
- TEST: 新增 `test/modbus-protocol_spec.js` 与 `test/modbus-read_spec.js`，17 个用例覆盖帧、解码、模拟模式、deviceName fallback

## v1.2.1 (2026-07-18)
- FIX: 脏帧/延迟帧循环丢弃 — txnId 不匹配时完整跳过旧帧，避免误解析 `buf[7]` 功能码
- FIX: socket 闭包捕获 — timeout/error 回调绑定当前 socket 实例，防止重连后错误操作新 socket
- FIX: 监听器统一清理 — `cleanupListeners()` 替代多处重复 removeListener，避免 `undefined` handler
- FIX: 输出补全 `deviceName` — 连接失败/成功路径均携带，兼容下游 `sf-data-processor`
- FIX: close 时连接池 key 解析错误 — `destroyConnection('host:port')` 会找不到条目导致连接泄漏
- FIX: HTML 帮助文本笔误 `add/thish+ref` → `add=this+ref`

## v1.2.0 (2026-07-17)
- NEW: 设备ID手动配置 — config 面板新增 deviceId 字段
- NEW: 表格分页 — 每页 50/100/200/500 条，支持上千点位不卡顿
- NEW: 计算点位 — referenceTag + operator(add/sub/mul/div) 合并两个寄存器值
- NEW: CSV导入导出 — 批量管理点位数据
- ENHANCE: sticky 表头 + 420px 滚动区

## v1.1.2 (2026-07-14)
- FIX: 队列深度上限 R1 — MAX_QUEUE=50，设备慢速时拒绝入队防OOM
- FIX: 入口节流 R2 — 队列>20时跳过本周期，防雪崩
- FIX: 响应txnId校验 R3 — 校验响应事务ID，丢弃脏帧/延迟帧
- FIX: Buffer上限 R5 — 64KB上限，畸形响应防内存泄漏
- FIX: 动态连接追踪 R6/R7 — close时清理所有曾用连接（含动态IP）
- FIX: finishWithError 防御性释放 R10
- FIX: 清理定时器队列检查 R11
- PERF: groupTs 每组合并时间戳

## v1.1.1 (2026-07-14)
- ENHANCE: 连接池请求队列 — 多节点共享同一设备时排队串行，防止读写交错
- ENHANCE: TCP keepalive (setKeepAlive 30s) — 防止空闲连接被交换机断开
- FIX: 事件监听器残留 — once('timeout')/once('error') 在成功路径中精确清理
- FIX: deviceId 归一化为数字 — 防止下游 edge_commStatus 索引类型错乱
- FIX: node.send 防重入保护 — safeSend 确保每次 on('input') 只输出一条消息
- CLEAN: 移除全局锁 _mbLocks + node._activeClient — 由连接池管理生命周期
- PERF: 消除短连接握手 — TCP 持久复用，每轮扫描省 2-3 次 TCP 握手

## v1.1.0 (2026-07-04)
- FIX: deviceId now uses msg.payload.id (numeric) first, falling back to deviceName
