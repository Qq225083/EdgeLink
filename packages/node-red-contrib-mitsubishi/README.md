# node-red-contrib-mitsubishi

[![npm version](https://img.shields.io/npm/v/node-red-contrib-mitsubishi.svg)](https://www.npmjs.com/package/node-red-contrib-mitsubishi)
[![license](https://img.shields.io/npm/l/node-red-contrib-mitsubishi.svg)](LICENSE)
[![Node-RED](https://img.shields.io/badge/Node--RED-%E2%89%A53.0.0-red.svg)](https://nodered.org)

三菱 MC Protocol（SLMP）3E/4E 读写节点。**一个节点读/写 N 个点位，零外部依赖，TCP 长连接池 + UDP 会话双传输，Binary/ASCII 双通信模式，104 项测试含规范对拍与万点压测。**

支持 Q / L / iQ-R / iQ-F（FX5U）/ FX3U+以太网模块，适配 EdgeLink 采集管线（输出可直接被 `edgelink-pg-store` 识别入库）。

> **v1.6.0（2026-08-02）**
> - **写入表格新增「默认值」列** — 面板配好静态值，任意消息触发即整表写入，临时写固定值调试不再需要 function 节点
> - **`msg.tags` 改为与面板表格合并**（原来是全量覆盖）— msg 只带 `{id, value}` 即可按 id（或 regType+addr）匹配面板行补齐定义；未被 msg 引用的面板行本轮**不执行**（写操作有副作用，防误写）
> - **engValue 浮点尾巴修复** — `27862 × 0.1` 输出 `2786.2` 而非 `2786.2000000000003`（10 位小数舍入，小值精度不丢）
> - 详见 [CHANGELOG](CHANGELOG.md)

> **v1.5.1（2026-07-28）写入能力**
> - **新增 `mitsubishi-write` 写节点**：批量字写入（0x1401）+ **位设备原生位写**（子指令 0x0001，M/X/Y/L/B 单往返无竞态），TCP/UDP 双传输
> - **写安全设计**：写分组严格连续——**绝不向未配置的中间地址写 0**（间隙即拆组，杜绝批量写误清 PLC 数据）
> - **万点采集**：960 字 span 感知聚类，1 万连续点位仅 11 帧（旧版 200+ 帧）

---

## 节点一览

| 节点 | 类型 | 说明 |
|------|------|------|
| `PLC 连接配置` | config | 存储 PLC IP、端口、帧格式、系列、传输协议等连接参数 |
| `MC 读取` | input | 点位表格批量采集，输出 `{rawValue, engValue, quality, ts}` |
| `MC 写入` | output | 点位表格批量写入，支持静态默认值与 msg 动态值 |

---

## 截图

![节点面板](https://raw.githubusercontent.com/Qq225083/node-red-contrib-mitsubishi/main/images/palette.png)

![配置面板](https://raw.githubusercontent.com/Qq225083/node-red-contrib-mitsubishi/main/images/config.png)

![采集输出](https://raw.githubusercontent.com/Qq225083/node-red-contrib-mitsubishi/main/images/output.png)

---

## 为什么选这个节点？

| 痛点 | 其他 MC 节点 | 本节点 |
|------|-------------|--------|
| 读 50 个点位 | 拖 50 个节点 | **拖 1 个节点，填表格** |
| 读 D200 是 FLOAT32 | 自己写 function 解码 | **表格选 FLOAT32，自动解码** |
| 原始值 2530 → 实际 253.0℃ | 自己写 function 换算 | **填斜率 0.1，自动变换** |
| 临时写个固定值调试 | 写 function 拼报文 | **表格填默认值，inject 一点就写** |
| PLC 返回错误码 0xC052 | 只会说 "timeout" | **"Address out of range"** |
| serialNo 不递增 | 4E 帧可能串包 | **每帧自增 + 响应校验** |

---

## 特性

### 采集（MC 读取）

- **表格编辑器** — 一个节点配置 N 个点位（支持上千点，分页 + CSV 导入导出 + 批量生成）
- **7 种数据类型** — INT16 / UINT16 / INT32 / UINT32 / FLOAT32 / DOUBLE(FLOAT64) / BOOL
- **8 种软元件** — D / W / R / X / Y / M / L / B，位元件自动逐位拆包
- **智能聚类** — 960 字 span 感知分组，自动合并批量读取、超限自动拆组（防 PLC `0xC059`）
- **斜率偏移变换** — `engValue = rawValue × slope + offset`，10 位小数舍入去浮点尾巴
- **计算点位** — `this [+−×÷] ref` 由已有点位派生新值
- **字节序/字序/位偏移** — 6 种字节序组合 + 字内取位（D100.3）

### 写入（MC 写入）

- **批量字写入**（0x1401）— 同组连续地址单帧写入，**严格连续分组，绝不向间隙写 0**
- **原生位写**（子指令 0x0001）— M/X/Y/L/B 单往返写入，替代 RMW 消除竞态
- **字内位 RMW** — D100.3 场景自动读-改-写
- **静态默认值列** — 面板表格直接配写入值，inject 触发即可写
- **动态写入** — `msg.tags` 按 id/地址与面板行合并，value 缺省回落默认值
- **值收敛与安全** — BOOL 词表（true/1/on）、数值钳制、非法值**拒写**而不是静默写 0、X 写入警告

### 连接与可靠性

- **TCP 长连接池** — 读写双池独立，键含帧格式/网络号/站号；请求队列串行化，多节点共享 PLC 不交错
- **UDP 会话层** — 共享 dgram socket、单在途串行化、ICMP 仅失败当前请求、迟到包丢弃
- **断线自动重建** — close/end/timeout 检测 + 指数退避 + 并发建连保护
- **TCP Keepalive** — 30 秒探测，防空闲连接被交换机/防火墙断开
- **per-PLC 轮次闸** — 上轮未结束新轮次直接失败，杜绝过期数据积压

### 工程化

- **零依赖** — 纯 Node.js `net` / `dgram` / `Buffer`，无第三方库
- **模拟模式** — `mcSimulationMode: true` 不连 PLC 即可离线开发/演示
- **可读错误诊断** — 19 个 MC 错误码映射为可读信息，失败路径 `node.error` 可被 catch 节点捕获
- **动态参数** — `msg.payload.plcIp` 覆盖 IP 一节点采多台 PLC；`protocolParams` 覆盖站号等
- **104 项测试** — 帧级 golden buffer 对拍（参照 pymcprotocol/SH-080008）、编解码往返、万点 UDP 压测

---

## 安装

```bash
cd ~/.node-red
npm install node-red-contrib-mitsubishi
```

重启 Node-RED，左侧节点栏 **edgelink** 分类下出现 `MC 读取` / `MC 写入`。

---

## 支持的 PLC

| 系列 | 帧格式 | 状态 |
|------|--------|------|
| Q 系列（QnU / QnUDV） | 3E / 4E | ✅ |
| L 系列 | 3E / 4E | ✅ |
| iQ-R | 4E | ✅ |
| iQ-F（FX5U） | 4E | ✅ |
| FX3U + 以太网模块（FX3U-ENET） | 3E | ✅ |
| A 系列 | 1E / 2E | ❌（仅支持 3E/4E） |

---

## 使用方法

### 1. 添加 PLC 连接配置

拖入 **`PLC 连接配置`** 节点，双击配置：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 名称 | `PLC-1` | 显示名称 |
| IP 地址 | `192.168.1.10` | PLC 以太网模块 IP |
| 端口 | `5007` | 3E 默认 5007 / 4E 默认 5008 |
| 帧格式 | `3E` | 3E（Q/L/FX3U）或 4E（iQ-R/iQ-F/FX5U） |
| PLC 系列 | `Q` | Q / L / iQ-R / FX（**仅 FX 的 X/Y 为 8 进制地址**，其余 16 进制） |
| 传输协议 | `tcp` | TCP 长连接（默认）/ UDP 无连接（QJ71E71、CPU 内置以太网常用） |
| 通信模式 | `Binary` | Binary（默认）/ ASCII（Hex 编码 + STX/ETX/校验和，部分老旧 PLC 只开 ASCII 口） |
| 网络号 | `0` | 多跳网络用，直连填 0 |
| 站号 | `0` | 目标站号，直连 CPU 填 0 |
| 超时 (ms) | `3000` | 读写超时 |
| 重试次数 | `2` | 失败重试次数（不含首次） |
| 重试间隔 (ms) | `300` | 重试等待时间 |

### 2. MC 读取：配置点位表格

拖入 **`MC 读取`** 节点，关联 PLC 配置，在表格中添加点位：

| 寄存器 | 地址 | 数据类型 | 斜率 | 偏移 | 名称 |
|--------|------|----------|------|------|------|
| D | 100 | INT16 | 0.1 | 0 | 温度 |
| D | 200 | FLOAT32 | 1 | 0 | 压力 |
| X | 0 | BOOL | — | — | 开关 |
| D | 300 | UINT16 | 1 | 0 | 计数器 |

> **斜率/偏移公式**：`engValue = rawValue × slope + offset`（结果按 10 位小数舍入，消除 `2786.2000000000003` 这类浮点尾巴）
>
> 例如 PLC 存温度原始值 2530（实际 253.0℃），设斜率 = 0.1，偏移 = 0，输出 engValue = 253.0

inject 节点 → MC 读取节点，部署后点击 inject 按钮即可采集。

### 3. MC 写入：三种写法

拖入 **`MC 写入`** 节点，关联 PLC 配置。

**① 静态写入（v1.6.0）** — 表格填点位 + **默认值**列，inject 触发即整表写入：

| 寄存器 | 地址 | 数据类型 | ID | 默认值 |
|--------|------|----------|------|--------|
| D | 100 | INT16 | temp_set | 25.0 |
| M | 0 | BOOL | m_start | true |

**② 动态写入** — `msg.tags` 携带值，面板提供定义（合并而非覆盖）：

```javascript
msg.tags = [
  { id: "temp_set", value: 30 },   // 按 id 匹配面板行：地址/类型用面板定义，value 覆盖默认值
  { id: "m_start" }                // 不给 value → 回落面板默认值
];
node.send(msg);
```

> **合并规则（v1.6.0）**：msg 点位按 `id`（其次 `regType+addr`）匹配面板行补齐缺失字段；未被 msg 引用的面板行本轮**不执行**——静态默认值不会随动态轮次被误写。

**③ 全动态写入** — 面板留空，msg 携带完整定义：

```javascript
msg.tags = [
  { id: "sp1", regType: "D", addr: 100, dataType: "INT16", value: 42 },
  { id: "b1", regType: "M", addr: 10, dataType: "BOOL", value: true }
];
```

> **值规则**：BOOL 接受 `true/1/"1"/"true"/"on"`；数字直接给数值或数字字符串；**非法值拒写**（告警并跳过），不会静默写 0。无 value 且无默认值的点位跳过。

### 4. 动态点位与动态参数（高级）

上游传入 `msg.tags` 可完全接管读取点位（读取侧为覆盖语义），适配 EdgeLink 采集管线：

```javascript
msg.tags = [
  { id: "温度", regType: "D", addr: 100, dataType: "INT16", slope: 0.1, offset: 0 },
  { id: "压力", regType: "D", addr: 200, dataType: "FLOAT32" }
];
```

运行时覆盖连接参数：

```javascript
msg.payload.plcIp = "192.168.1.20";        // 覆盖目标 IP，一节点采多台
msg.payload.protocolParams = { unitId: 3 };// 覆盖站号
msg.payload.timeout = 5000;                 // 覆盖超时
```

---

## 输出格式

### MC 读取

```javascript
msg.payload = {
  success: true,
  deviceId: "PLC-1",          // 适配 edgelink-pg-store 动态分表
  deviceName: "PLC-1",
  data: {
    "温度": {
      rawValue: 2530,         // 解码后的原始值（32/64 位为多字组装结果，原始首字在 rawWord）
      engValue: 253.0,        // rawValue × 斜率 + 偏移（10 位小数舍入）
      quality: 0,             // 0=正常 2=异常
      ts: "2026-06-30T08:00:00.000Z",
      regType: "D"
    }
  },
  error: null,
  driverType: "driver-mc-protocol",
  plcIp: "192.168.1.10",
  plcPort: 5007,
  roundTimeMs: 12
}
```

### MC 写入

```javascript
msg.payload = {
  success: true,
  deviceId: "PLC-1",
  deviceName: "PLC-1",
  data: {
    "temp_set": { value: 25, quality: 0, ts: "...", regType: "D" }
  },
  error: null,
  driverType: "driver-mc-write-protocol",
  plcIp: "192.168.1.10",
  plcPort: 5007,
  roundTimeMs: 8
}
```

### 失败输出（读/写同构）

```javascript
msg.payload = {
  success: false,
  deviceId: "PLC-1",
  data: {},
  error: "[PLC 0xC052] Address out of range",   // 19 个 MC 错误码可读；网络/超时/帧错误前缀区分
  driverType: "driver-mc-protocol",
  plcIp: "192.168.1.10",
  plcPort: 5007,
  roundTimeMs: 3012
}
```

---

## 架构

```
┌──────────┐     ┌──────────────────────────────────────┐     ┌──────────┐
│ inject / │     │  mitsubishi-read / mitsubishi-write  │     │ 三菱 PLC │
│ msg.tags │────→│                                      │────→│          │
└──────────┘     │  1. 校验清洗（地址进制/值收敛）      │     │ Q / L /  │
                 │  2. 去重 + 聚类分组（960 字/连续）   │     │ iQ-R /   │
                 │  3. 连接池 ──→ 逐组 3E/4E 帧        │     │ iQ-F /   │
                 │  4. 解码/回显校验 + 斜率变换         │     │ FX5U     │
                 │  5. 输出 data[tagId]                 │     └──────────┘
                 └──────────────────────────────────────┘
 TCP: 读/写双长连接池，key 含 host:port:frame:network:station
      请求队列串行化 · 空闲 10 分钟回收 · 断线检测重建 · 指数退避
 UDP: 共享 dgram socket · 单在途串行化 · 迟到包丢弃 · 空闲回收
```

---

## 与 node-red-contrib-mcprotocol 对比

| 维度 | 本节点 | mcprotocol |
|------|--------|------------|
| 点位数量 | **N 个 / 节点** | 1 个 / 节点 |
| 连接模型 | **长连接池 + 请求队列** | 短连接（每请求新建销毁） |
| TCP 断线恢复 | **自动检测重建** | ⚠️ 已知 BUG（不自恢复） |
| 传输协议 | **TCP + UDP** | TCP + UDP |
| 通信模式 | **Binary + ASCII** | Binary |
| 数据类型 | **读 7 种 / 写 6 种** | 基础类型 |
| 位元件 | **自动拆包 + 原生位写** | 不支持 |
| 斜率偏移变换 | **内置**（含浮点尾巴舍入） | 无 |
| 写入能力 | ✅ **字批量写 + 位原生写 + RMW + 静态默认值列** | ✅ mcprotocol-write |
| 写安全 | ✅ **严格连续分组，绝不向间隙写 0** | ⚠️ 批量写连续覆盖 |
| 动态 IP 覆盖 | ✅ `msg.payload.plcIp` | ❌ |
| serialNo | **每帧自增 + 回显校验** | 固定不变 |
| 模拟模式 | ✅ `mcSimulationMode=true` | ❌ |
| 1E 帧 | ❌（仅 3E/4E） | ✅ |
| 测试 | ✅ **104 项（规范对拍/万点压测/读写 e2e）** | ❌ 无 |
| 依赖 | **0**（纯 Node.js） | mcprotocol 依赖 |
| 维护状态 | ✅ 活跃（2026-08） | ⚠️ 停更（2021-01） |

> **选择建议**：需要 1E 帧/老 A 系列 PLC/T·C·SM 等全软元件家族 → mcprotocol。读写高频采集、万点级规模、要测试护栏与写安全 → 本节点。

---

## 模拟模式

在 Node-RED `settings.js` 中添加：

```javascript
mcSimulationMode: true
```

重启后 `MC 读取` 返回随机仿真数据、`MC 写入` 直接返回成功（不触碰 PLC）。用于离线开发、CI 测试、Demo 演示。

---

## 与 EdgeLink 生态集成

```
┌──────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│ node-red-contrib │     │ node-red-contrib     │     │ PostgreSQL /     │
│ -mitsubishi      │────→│ -edgelink-pg         │────→│ TimescaleDB      │
│ (本节点)         │     │ (PG 批量写入)        │     │                  │
└──────────────────┘     └──────────────────────┘     └──────────────────┘
```

本节点输出的 `deviceId`、`regType`、`rawValue`、`engValue`、`quality`、`ts` 字段可由 `edgelink-pg-store` 自动识别为 MC 驱动格式，零配置写入数据库。

---

## 测试

```bash
npm install
npm test
```

**104 项测试**覆盖：

- 3E/4E 帧构造字节级 golden buffer 对拍（参照 pymcprotocol / SH-080008 手册）
- 写帧 dataLen、原生位写 nibble 打包、RMW、ASCII STX/ETX/校验和编码
- INT32/UINT32/FLOAT32/DOUBLE 多字解码与 encode↔decode 往返对称
- X/Y 八进制地址解析（FX）与 16 进制（Q/L/iQ-R）
- engValue 舍入边界（浮点尾巴/小值精度/大值跳过）
- 写入合并规则（id 匹配/默认值回落/副作用安全）
- 连接池引用计数/退避/队列超时、UDP 会话、10,000 点位 × 3 轮压测

## FAQ

**Q: 连接如何管理？**  
TCP 采用**读写双长连接池**：连接建立后保持复用，池 key 含 `host:port:frame:network:station`，不同配置不复用同一条连接。同一 PLC 多节点通过**请求队列串行化**防读写交错。空闲 > 10 分钟自动回收，断开自动检测重建，失败指数退避。UDP 为无连接会话层：共享 socket、单在途串行化、ICMP 仅失败当前请求。

**Q: 能同时读写多个 PLC 吗？**  
可以。每个 `PLC 连接配置` 配置一个 PLC，或运行时通过 `msg.payload.plcIp` / `msg.payload.protocolParams` 动态覆盖。

**Q: 点位地址能写成 "D100" 格式吗？**  
可以。地址字段兼容 `"D100"` 格式（自动提取数字部分），也支持纯数字 `100`。
> **注意**：`X` / `Y` 仅在 **FX 系列**下为 8 进制地址（`X10` 是八进制物理点），Q/L/iQ-R 均为 16 进制。config 的"PLC 系列"字段决定解释规则。

**Q: 一次最多读/写多少点？**  
读取：字元件单次最多 960 字、位元件单次最多 15360 点，超出自动拆组。写入按严格连续分组拆帧，间隙地址绝不补 0。

**Q: 支持 FX3U 吗？**  
带以太网模块（FX3U-ENET）支持 3E 帧。不带以太网模块的 FX3U 不支持（需要 1E 帧或串口）。

**Q: 只开了 ASCII 口的老 PLC 能用吗？**  
可以。config 的"通信模式"选 ASCII，帧按 Hex 编码 + STX/ETX/校验和传输（v1.5.1 起，3E/4E 均支持）。

---

## 更新日志

详见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT · 可自由商用、修改、再发布
