# node-red-contrib-mitsubishi 节点设计文档

## 一、项目概述

**名称**: `node-red-contrib-mitsubishi`
**定位**: Node-RED 三菱 MC Protocol 3E/4E 以太网采集节点
**版本**: v2.0
**依赖**: 零外部 npm 依赖，仅使用 Node.js 内置 `net` + `Buffer`

### 设计目标

| 目标 | 说明 |
|------|------|
| 独立可用 | 脱离任何后端，拖拽配置即可采集 PLC 数据 |
| 集成友好 | 兼容 EdgeLink V10 调度器，`msg.tags` 覆盖配置 |
| 协议完整 | 支持 3E/4E 帧、8 种软元件、位元件拆包、智能批量 |
| 开箱即用 | 内置斜率偏移变换，输出 `engValue` 无需后处理 |
| 生产可靠 | 14 个已知 bug 全部修复，含异步异常保护、全局锁隔离 |

### 适用场景

- 独立 PLC 数据采集（inject 触发 → 读 PLC → MQTT/DB 写入）
- 嵌入 EdgeLink V10 采集管线（scheduler 传 `msg.tags` 覆盖节点配置）
- 模拟测试（全局开启 `mcSimulationMode` 后不连真实 PLC）

---

## 二、节点架构

### 2.1 节点组成（2 个）

```
┌─ mitsubishi-config (配置节点) ─┐    ┌─ mitsubishi-read (处理节点) ──┐
│ host, port, frame, networkNo,  │───→│ 引用 PLC 配置                  │
│ stationNo, timeout, maxRetries │    │ 表格编辑点位 (默认)            │
│ retryInterval                  │    │ msg.tags 覆盖 (动态)            │
└────────────────────────────────┘    │ 协议驱动核心逻辑               │
                                      └────────────────────────────────┘
```

**config 节点**: 存储连接参数，可被多个 read 节点共享引用。
**read 节点**: 1 输入 1 输出，表格配置点位，执行 MC 协议读取，输出结构化数据。

### 2.2 输入输出格式

**输入**（两种方式并存，`msg.tags` 优先）:

```javascript
// 方式1: msg.tags 动态传入（优先级最高）
msg.tags = [
  { id: "温度", regType: "D", addr: 100, dataType: "INT16", slope: 0.1, offset: 0 },
  { id: "开关", regType: "X", addr: 0,  dataType: "BOOL" }
];

// 方式2: 节点表格静态配置（msg.tags 不存在时兜底）
// 用户通过编辑器面板的表格逐行填写
```

**输出**:

```javascript
msg.payload = {
  success: true,
  data: {
    "温度": { rawValue: 2530, engValue: 253.0, quality: 0, ts: "2026-..." },
    "开关": { rawValue: 1,    engValue: 1,     quality: 0, ts: "2026-..." }
  },
  error: null,                          // 失败时: "[PLC 0xC052] Address out of range (D100)"
  driverType: "driver-mc-protocol",
  plcIp: "192.168.1.10",
  plcPort: 5007,
  roundTimeMs: 12
}
```

**engValue 变换公式**: `engValue = rawValue × slope + offset`

---

## 三、协议实现

### 3.1 支持的软元件（8 种）

| 类型 | 代码 | 说明 | 编址 |
|------|------|------|------|
| D | 0xA8 | 数据寄存器（字） | 十进制 |
| W | 0xB4 | 链接寄存器（字） | 十进制 |
| R | 0xAF | 文件寄存器（字） | 十进制 |
| X | 0x9C | 输入（位） | 八进制→十进制 |
| Y | 0x9D | 输出（位） | 八进制→十进制 |
| M | 0x90 | 内部继电器（位） | 十进制 |
| L | 0x92 | 锁存继电器（位） | 十进制 |
| B | 0xA0 | 链接继电器（位） | 十进制 |

**位元件读取方式**: 按字（16 位）批量读取，逐位拆包。例如 X0~X15 → 1 个字 → 拆成 16 个 0/1。

### 3.2 帧格式

**3E 请求帧** (21 字节):
```
Offset  Size  Field
0       2     副头部 0x50 0x00
2       1     网络号
3       1     PC号 0xFF
4       2     目标I/O号 0x03FF
6       1     目标站号
7       2     数据长度 0x000C (12)
9       2     监视定时器 0x0010
11      2     指令 0x0401 (批量读取)
13      2     子指令 0x0000 (字单位)
15      3     起始软元件地址 (小端, 3字节)
18      1     软元件代码
19      2     点数 (小端)
```

**4E 请求帧** (22/24 字节):
与 3E 的区别：
- 副头部 `0x54 0x00`（非 `0x50 0x00`）
- 起始地址 4 字节 (支持 > 64K 地址空间)
- 可选项：2 字节序列号（SerialNo），用于请求-响应对账
- 数据长度: 无SN=13(0x0D), 有SN=15(0x0F)

**3E 响应帧**:
```
Offset  Size  Field
0       2     副头部 0xD0 0x00
...
7       2     响应数据长度 (含 endCode)
9       2     结束码 (0=成功)
11      n     数据
```

**4E 响应帧**:
与 3E 的区别：
- 副头部 `0xD4 0x00`
- 偏移 11-12 为序列号回显
- 数据从偏移 13 开始
- 响应数据长度 = endCode(2) + serialNo(2) + data → 减 4 得到纯数据长度

### 3.3 智能批量读取（聚类算法）

```
输入: 用户配置的 N 个点位 (不同地址、不同类型的混合列表)
算法:
  1. 按 regType 分组 (D一组, X一组, ...)
  2. 组内按 addr 升序排序
  3. 相邻地址 gap ≤ 20 且数量 ≤ 50 → 合并为一个批量读取请求
  4. 字元件单次上限 960 字, 位元件 15360 个点 (960×16)
  5. 超限自动拆分组
输出: 最少数量的 TCP 请求
```

### 3.4 数据类型转换

```
INT16:   直接 readInt16LE
UINT16:  负值 + 65536
INT32:   高16位 << 16 | 低16位, 补码
UINT32:  combined >>> 0
FLOAT32: Buffer(4) 拼两字, readFloatLE
BOOL:    位元件直接 0/1
```

### 3.5 MC 错误码诊断（内置映射表）

```
0xC051 → "Device/register not supported"
0xC052 → "Address out of range"
0xC059 → "Points/word count out of range"
0xC0D0 → "PLC status error (not running)"
...等 19 个常见码
→ 输出到 msg.payload.error: "[PLC 0xC052] Address out of range (D100)"
```

---

## 四、配置面板设计

### 4.1 mitsubishi-config（连接配置）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| name | text | PLC-1 | 显示名称 |
| host | text | 192.168.1.10 | IP 地址 |
| port | number | 5007 | 端口 |
| frame | select | 3E | 3E / 4E |
| networkNo | number | 0 | 网络号 |
| stationNo | number | 0 | 站号 |
| timeout | number | 3000 | 通信超时 (ms) |
| maxRetries | number | 2 | 失败重试次数 |
| retryInterval | number | 300 | 重试间隔 (ms) |

### 4.2 mitsubishi-read（读取节点）

| 字段 | 类型 | 说明 |
|------|------|------|
| name | text | 节点显示名 |
| plc | config-select | 关联 mitsubishi-config |
| serialNo | number | 4E 帧序列号起始值 (0=不启用) |
| tags | 表格编辑器 | 默认点位配置 |

**表格编辑器列**：

| 列 | 输入类型 | 说明 |
|-----|---------|------|
| 寄存器 | select (D/W/R/X/Y/M/L/B) | 软元件类型 |
| 地址 | number | 软元件编号 |
| 数据类型 | select (INT16/UINT16/INT32/UINT32/FLOAT32/BOOL) | 解析方式 |
| 斜率 | number | 变换乘数，默认 1 |
| 偏移 | number | 变换加数，默认 0 |
| 名称 | text | 点位标签 |
| ID | text | 输出 key (不填自动生成) |
| ✕ | button | 删除行 |

---

## 五、运行时行为

### 5.1 全局锁

```
锁粒度: host:port（不同设备不互斥）
超时: 60s
重入: 拒绝（绝对互斥，含同节点重入）
清理: 采集完成/异常退出均释放
```

### 5.2 通信模式

```
TCP 短连接:
  - 每个 group 独立 new net.Socket()
  - connect → write → read → destroy
  - 失败重试: 重新 connect（不复用旧 socket）
理由: MC 协议无状态，短连接简化状态管理，避免连接池泄漏
```

### 5.3 重试策略

```
网络错误 (TCP closed/timeout/connect fail):
  → 重试 (最多 maxRetries 次, 间隔 retryInterval ms)

PLC 业务错误 (endCode ≠ 0):
  → 立即失败，不重试 (业务错误重试不自愈)
```

### 5.4 模拟模式

```
全局设置: mcSimulationMode = true
行为: 不连 PLC，直接返回随机数据
数据格式: 与真实采集完全一致
位元件: 随机 0/1
字元件: 随机 0~1000
成功概率: 100%（无模拟失败）
```

### 5.5 节点状态

| 状态 | 颜色 | 文字 |
|------|------|------|
| 空闲/无点位 | 灰色 | "0 valid tags" |
| 被锁 | 黄色 | "busy" |
| 成功 | 绿色 | "PLC-1 3 vals 12ms" |
| 失败 | 红色 | "PLC-1 0 vals" + 错误信息 |
| 模拟 | 绿色 | "SIM 3 tags" |

---

## 六、Bug 修复历史

| # | 等级 | 问题 | 修复 |
|---|------|------|------|
| 1 | P0 | 锁允许同实例重入 | 去掉 `instanceId !== node.id` 条件 |
| 2 | P0 | 异步回调异常锁不释放 | 所有回调加 try-catch + lock release |
| 3 | P0 | PLC 业务错误被重试 | endCode → 返回 `{mcError}` 对象，立即失败 |
| 4 | P0 | dataLen 未校验脏帧 | `0 < dataLen < 2000` 范围检查 |
| 5 | P0 | serialNo 固定不变 | 每帧 `++pp.serialNo & 0xFFFF` + 响应校验 |
| 6 | P0 | 批量字数可能超上限 | 960 字上限 + 自动拆包 |
| 7 | P1 | X/Y 八进制地址 | config-manager `parseInt(addr, 8)` 已处理 |
| 8 | P1 | 3E networkNo 硬编码 | 改用 `pp.networkNo \|\| 0` |
| 9 | P1 | 参数字符串 NaN | `_clampInt()` NaN-safe |
| 10 | P1 | 模拟模式随机失败 | `ok = true` |
| 11 | P2 | sort 修改原数组 | `.slice().sort()` |
| 12 | P2 | addr/regType 未校验 | parseInt + MC_DEVICE_CODES 查表兜底 |
| 13 | P2 | 位元件起始地址未对齐 | `startA - (startA % 16)` |
| 14 | P2 | _lastMcEndCode 隐式全局 | 删除，改用 `raw.mcError` 对象传递 |

---

## 七、与 node-red-contrib-mcprotocol 对比

| 维度 | 插件 | 本节点 |
|------|------|--------|
| 点位数量 | 每节点 1 个地址 | 表格编辑器，N 个点位 |
| 批量优化 | 无 | 智能聚类合并 |
| dataType | 仅 INT16 | INT16/UINT16/INT32/UINT32/FLOAT32/BOOL |
| 位元件 | 不支持拆包 | 按字读 + 逐位拆 |
| eng 变换 | 无 | raw × slope + offset |
| 错误诊断 | "timeout" | `[PLC 0xC052] Address out of range` |
| 序列号 | 固定 | 每帧自增 + 回显校验 |
| 连接稳健 | pool bug, 长连必断 | 短连接, 无状态泄漏 |
| 维护状态 | 3 年未更新 | 14 bug 已清零 |
| npm 依赖 | 无 | 无 |
| 源代码 | 黑盒 | 全部可控 |

---

## 八、可扩展性

| 方向 | 说明 |
|------|------|
| Modbus TCP 节点 | 复用表格编辑器，替换驱动为 Modbus 协议（已有 EdgeLink V10 Modbus 驱动可改造） |
| 写操作支持 | 功能码 0x06/0x10 写寄存器，0x05 写线圈（协议层已就绪，需增加输入模式） |
| ASCII 模式 | 帧编解码切换，兼容老 FX 系列串口网关 |
| 1E/2E 帧 | 覆盖 A 系列老 PLC |
| 连接池模式 | 按需切换到长连接，减少高频采集时的 TCP 握手开销 |
| CI/CD | GitHub Actions 自动 npm publish + 版本管理 |

---

## 九、文件结构

```
node-red-contrib-mitsubishi/
├── package.json                  # npm 包配置
├── README.md                     # 用户文档（接线图、配置截图、PLC 兼容表）
└── nodes/
    ├── mitsubishi-config.js      # 配置节点后端（连接参数存储）
    ├── mitsubishi-config.html    # 配置节点 UI（IP/端口/帧格式等表单）
    ├── mitsubishi-read.js        # 读取节点后端（完整 MC 驱动：帧构造/响应解析/聚类/锁/重试/变换）
    └── mitsubishi-read.html      # 读取节点 UI（表格编辑器 + PLC 关联）
```

---

## 十、许可证

MIT — 可自由商用、修改、再发布。
