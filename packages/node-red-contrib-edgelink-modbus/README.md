# node-red-contrib-edgelink-modbus

[![npm version](https://img.shields.io/npm/v/node-red-contrib-edgelink-modbus.svg)](https://www.npmjs.com/package/node-red-contrib-edgelink-modbus)
[![license](https://img.shields.io/npm/l/node-red-contrib-edgelink-modbus.svg)](LICENSE)
[![Node-RED](https://img.shields.io/badge/Node--RED-%E2%89%A53.0.0-red.svg)](https://nodered.org)

Modbus TCP/RTU 读写节点。**一个节点读 N 个点位，一个节点写单点位，长连接池读写共享，表格编辑器，RTU 串口支持（serialport 可选依赖）。**

---

## 截图

（替换为实际截图地址）
<!-- ![表格编辑器](https://raw.githubusercontent.com/Qq225083/node-red-contrib-edgelink-modbus/main/images/table.png) -->

---

## 为什么选这个节点？

| 痛点 | `node-red-contrib-modbus` | 本节点 |
|------|--------------------------|--------|
| 读 50 个寄存器 | 拖 50 个节点或配 Flex-Connector | **1 个节点，填表** |
| FLOAT32 跨寄存器 | 自己写 function 拼接 | **表格选 FLOAT32，自动读相邻寄存器** |
| 字节序不一致 | 全局配一个 | **每个标签独立选 AB/BA/ABCD...** |
| 原始值 2530 → 253.0℃ | 自己换算 | **填斜率 0.1，自动输出** |
| PLC 返回异常码 | "Error" | **[MB 0x02] Illegal data address** |

---

## 特性

- **表格编辑器** — 一个节点配置 N 个点位，自动按寄存器类型和地址聚类合并为批量读取
- **写入节点** 🆕 — FC05 写线圈 / FC06 写单寄存器 / FC16 多寄存器（32/64 位类型原子写入）
- **读写共享连接池** 🆕 — 读写节点复用同一长连接，请求自动排队串行化，防止读写交错
- **长连接池** — TCP 连接持久复用，跨轮采集无需重复握手
- **请求队列串行化** — 多节点共享同一设备时自动排队，防止读写交错
- **TCP Keepalive** — 30 秒探测保活，防止空闲连接被断开
- **断线自动重建** — 连接断开或超时自动检测并重建
- **deviceId 归一化** — 输出始终为数字，兼容下游索引
- **4 种寄存器类型** — 线圈(FC01)、离散输入(FC02)、保持寄存器(FC03)、输入寄存器(FC04)
- **6 种数据类型** — INT16 / UINT16 / INT32 / UINT32 / FLOAT32 / BOOL
- **6 种字节序** — AB / BA / ABCD / CDAB / BADC / DCBA，每个标签独立配置
- **斜率偏移变换** — `engValue = rawValue × slope + offset`
- **批量生成** — 起始地址 + 数量 + 类型，一键填表
- **异常诊断** — 11 个 Modbus 异常码映射
- **模拟模式** — `RED.settings.mbSimulationMode = true` 不连设备即可测试（读写均支持）
- **零依赖** — 仅使用 Node.js 内置 `net` + `Buffer`

---

## 安装

```bash
cd ~/.node-red
npm install node-red-contrib-edgelink-modbus
```

重启 Node-RED，左侧节点栏 **edgelink** 分类下出现 `Modbus 读取` 节点。配置节点在 config 侧边栏。

---

## 使用方法

### 1. 添加连接配置

拖入 **Modbus 连接配置**，填写：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| IP 地址 | `192.168.1.10` | Modbus TCP 设备 IP |
| 端口 | `502` | Modbus TCP 默认端口 |
| 从站地址 | `1` | Modbus 从站 ID（RTU 必填 1-247） |
| 超时 | `3000` | 读写超时(ms)，RTU 同时作为整帧等待上限 |
| 串口名 | 留空 | **留空 = Modbus TCP**；填写（如 `COM3` / `/dev/ttyUSB0`）= Modbus RTU |
| 波特率/数据位/校验/停止位 | `9600 / 8 / N / 1` | RTU 串口参数 |

> RTU 也可由上游消息逐轮指定：`msg.payload.protocolParams = { serialPort, baudRate, dataBits, parity, stopBits, unitId }`。串口连接与 TCP 入同一长连接池（池键 `rtu:COM3:9600:8N1`），同一物理串口同时仅允许一个连接。RTU 依赖 `serialport`（可选依赖：仅用 TCP 的环境不装也能加载本包）。

### 2. 配置点位表格

拖入 **Modbus 读取**，关联配置，在表格中添加点位：

| 寄存器类型 | 地址 | 数据类型 | 字节序 | 斜率 | 偏移 | 名称 |
|-----------|------|----------|--------|------|------|------|
| 保持寄存器 | 0 | INT16 | AB | 0.1 | 0 | 温度 |
| 保持寄存器 | 10 | FLOAT32 | ABCD | 1 | 0 | 压力 |
| 线圈 | 0 | BOOL | — | — | — | 开关 |

> 连续批量：起始 0、数量 100、保持寄存器、INT16，一键生成。

### 3. 触发采集

inject 节点 → Modbus 读取节点，部署后点击 inject 即可。

### 4. 写入数据 🆕

拖入 **Modbus 写入**，关联同一配置节点。两种触发方式：

**裸值**（用面板配置的地址/类型）：

```javascript
msg.payload = 123;            // 按面板 addr/dataType 写入
return msg;
```

**对象**（逐字段覆盖面板，适合动态写入）：

```javascript
msg.payload = {
  regType: 'holding',         // holding(FC06/16) 或 coil(FC05)
  addr: 100,
  value: 42,
  dataType: 'FLOAT32',        // 32/64 位类型自动走 FC16 原子写入
  byteOrder: 'ABCD'           // 可选，AB/BA/ABCD/CDAB/BADC/DCBA
};
return msg;
```

输出 `msg.payload = { success, write: {regType, addr, value, fc}, error, ... }`。

> **安全约定**：写失败**不自动重试**（写操作有副作用，超时请求可能已到达设备）；需要重试请在流程中自行决定重发。

---

## 输出格式

```javascript
msg.payload = {
  success: true,
  deviceId: 1001,                      // 数字ID，兼容下游索引
  data: {
    "温度": {
      rawValue: 2530,          // 寄存器原始值
      engValue: 253.0,         // 解码后 × 斜率 + 偏移
      quality: 0,              // 0=正常 2=异常
      ts: "2026-07-04T08:00:00.000Z",
      regType: "holding"
    },
    "压力": {
      rawValue: 4123,
      engValue: 41.23,
      quality: 0,
      ts: "2026-07-04T08:00:00.000Z",
      regType: "holding"
    }
  },
  error: null,
  driverType: "driver-modbus-tcp",
  plcIp: "192.168.1.10",
  plcPort: 502,
  roundTimeMs: 12
}
```

---

## 与 EdgeLink 生态集成

```
┌──────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│ edgelink-modbus  │────→│ edgelink-pg-store    │────→│ PostgreSQL /     │
│ (本节点)         │     │ (PG 批量写入)        │     │ TimescaleDB      │
└──────────────────┘     └──────────────────────┘     └──────────────────┘
```

---

## 模拟模式

```javascript
// Node-RED settings.js
mbSimulationMode: true
```

所有 Modbus 读取节点不连设备，返回随机仿真数据。

---

## 支持的设备

任何支持 Modbus TCP / RTU 协议的设备：PLC（西门子/施耐德/台达/汇川）、远程 IO 模块、传感器、变频器等。

---

## 限制

- 传输：Modbus TCP + Modbus RTU（串口，v1.5.0 起）；暂不含 Modbus ASCII
- 读取：FC01/02/03/04；写入：FC05(单线圈)/FC06(单寄存器)/FC16(多寄存器)，暂不含 FC15 批量线圈
- RTU 不支持 unitId=0 广播地址

---

## 许可证

MIT
