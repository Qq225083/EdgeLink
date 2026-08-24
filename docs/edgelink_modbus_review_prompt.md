# Node-RED Modbus TCP 采集节点 — 代码审计提示词

## 背景

这是 EdgeLink 工业边缘采集系统的第三个 npm 包 `node-red-contrib-edgelink-modbus`，前两个是：
- `node-red-contrib-mitsubishi`（三菱 MC 协议，已发布 npm，82/100 分）
- `node-red-contrib-edgelink-pg`（PostgreSQL 批量写入，已发布 npm，82/100 分）

三者的定位互补：MC 读 PLC → PG 写数据库；Modbus 读 PLC → PG 写数据库。

## 审计目标

请从以下维度深度审查 `modbus-read.js` 和 `modbus-config.js`，找出 **会导致运行时崩溃、数据错误、资源泄漏、生产事故的 BUG**。不要提风格建议或"可以换个变量名"这类建议。

## 审计维度（按严重性排序）

### 1. Modbus TCP 协议正确性（P0）
- TCP 帧格式：TransactionID(2) + ProtocolID(2) + Length(2) + UnitID(1) + FC(1) + Data
- 功能码 01/02/03/04 的请求/响应格式是否正确
- 异常响应（FC | 0x80）的解析是否正确
- 字节序处理（AB/BA/ABCD/CDAB/BADC/DCBA）是否覆盖所有场景
- 线圈/离散输入的位拆包是否正确（起始地址非 8 对齐时）
- 保持寄存器/输入寄存器的 16 位读取是否正确
- 32 位数据类型（INT32/UINT32/FLOAT32）的相邻寄存器拼接逻辑是否正确

### 2. 边界条件与崩溃保护（P0）
- 空点位列表、非法地址（负数、NaN、超大值）
- 单点位、大量点位（>125 寄存器或 >2000 线圈）的分组是否正确
- 响应帧半包/粘包处理
- 响应帧 dataLen 为 0 或异常值
- Buffer 越界访问
- 网络超时、TCP 连接立即断开、连接被拒绝

### 3. 资源管理（P0）
- Socket 是否在所有路径下关闭（成功/失败/超时/异常）
- 全局锁（edge_mb_lock_*）是否在所有路径下释放
- close 处理器是否正确释放锁
- 多个异步回调中是否有变量共享导致的竞态

### 4. 数据类型转换（P1）
- INT16/UINT16/INT32/UINT32/FLOAT32/BOOL 的位运算是否正确
- 32 位数据类型读取相邻寄存器时，如果相邻地址不在同一分组内会怎样
- BOOL 类型（针对线圈/离散输入）的处理
- 负数值处理

### 5. 错误处理（P1）
- Modbus 异常码（0x01-0x0B）是否全部映射
- 异常码返回后是否继续重试（应该直接失败不重试）
- TCP 错误 vs Modbus 业务错误的区分

### 6. 配置节点（P1）
- modbus-config 的参数校验
- unitId 范围 0-247
- 默认值是否合理

## 代码位置

- `nodes/modbus-read.js` — 主节点（协议帧构造、响应解析、字节序、分组、重试）
- `nodes/modbus-config.js` — 配置节点
- `nodes/modbus-read.html` — 表格编辑器 UI
- `nodes/modbus-config.html` — 配置面板 UI

## 技术约束

- Node-RED 4.x 运行环境
- ES5 语法（无箭头函数、无 let/const、无 async/await）
- 纯 Node.js 实现，零外部依赖（仅 `net` 模块）
- 配置节点 HTML 表单必须用 `node-config-input-*` 前缀（Node-RED 4.x 硬要求）

## 输出格式

按以下格式输出：

### P0 — 必须修复（会导致崩溃/数据错误/资源泄漏）
- **BUG-X**：描述 + 代码位置（行号） + 失败场景 + 修复建议

### P1 — 建议修复（健壮性/兼容性）
- **BUG-X**：描述 + 代码位置（行号） + 修复建议

### 总体评分（满分 100）
按：协议正确性(20) + 错误处理(20) + 代码质量(15) + 功能覆盖(10) + 性能(10) + 文档(5) + 安全(10) + 可维护性(10) 评分

## 参考：同系列 mitsubishi 节点已知问题（modbus 可能也有）

1. 位元件起始地址未按 8 或 16 对齐
2. serialNo 首帧跳号（modbus 没有 serialNo，但有 TransactionID）
3. 输出缺少 regType/deviceId 字段
4. 模拟模式随机值不可复现
5. close 处理器变量引用可能为 null
