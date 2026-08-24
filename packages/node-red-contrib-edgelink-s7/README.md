# node-red-contrib-edgelink-s7

EdgeLink 工业采集系统 — 西门子 S7 协议读取节点（**v1 只读**）。

基于 [`@st-one-io/nodes7`](https://github.com/st-one-io/nodes7)（ISO-on-TCP / RFC1006），支持 S7-300/400/1200/1500。

## 节点

- **s7-config**：PLC 连接配置（host / port 默认 102 / rack 默认 0 / slot 默认 1 / 超时 / 重试）
- **s7-read**：批量读取节点，含 S7Endpoint 长连接池、per-PLC 轮次闸、批次失败隔离

## 输入契约（msg.payload，EdgeLink 后端快照）

```js
{
  id: 30,                        // 设备 ID（也接受 deviceId）
  deviceName: 'xxx',
  plcIp: '192.168.1.10', plcPort: 102,
  protocolParams: { rack: 0, slot: 1 },   // S7 机架/槽位（cfg 默认值兜底）
  tags: [
    { id: 59, regAddr: 'DB1.DBW0', regType: 'DB', dataType: 'INT16', name: '温度' }
  ],
  timeout: 3000, maxRetries: 2, retryInterval: 300
}
```

> 地址以 **regAddr**（TIA 风格字符串）为准；`tag.addr` 数字是中心侧按三菱规则解析的，对 S7 无意义，一律忽略。

## 输出契约（msg.payload）

成功：

```js
{ success: true, deviceId, deviceName,
  data: { '59': { rawValue: -123, quality: 0, ts: '2026-08-23T...Z', regType: 'DB' } },
  error: null, driverType: 'driver-s7', plcIp, plcPort, roundTimeMs }
```

失败（连接失败 / 轮次闸 / 无有效点位）：`success:false`、`data:{}`、`error:'...'`，且 `node.error(err, msg)`（catch 节点可捕获）。部分点位失败：`success:false`，坏点位 `rawValue:null, quality:1` 占位，好点位正常返回。

quality 语义：`0=GOOD 1=BAD 2=UNCERTAIN`（与 MC 包一致）。

轮次闸：同 PLC 上一轮未结束时新一轮直接失败，`error = 'Round in progress (previous scan not finished)'`。

## 地址格式（TIA 风格，大小写不敏感）

| 区域 (regType) | 位 (BOOL) | 16 位 (INT16/UINT16) | 32 位 (INT32/UINT32/FLOAT) |
|---|---|---|---|
| DB | `DB1.DBX0.0` | `DB1.DBW0` | `DB1.DBD4` |
| M  | `M0.1`（也接受 `MX0.1`） | `MW10` | `MD10` |
| I  | `I0.0` | `IW0` | `ID0` |
| Q  | `Q0.0` | `QW0` | `QD0` |

### dataType → nodes7 地址映射

| dataType | DB 区示例 | M 区示例 | nodes7 地址 |
|---|---|---|---|
| BOOL | `DB1.DBX0.0` | `M0.1` | `DB1,X0.0` / `M0.1` |
| INT16 | `DB1.DBW0` | `MW10` | `DB1,INT0` / `MI10` |
| UINT16 | `DB1.DBW0` | `MW10` | `DB1,WORD0` / `MW10` |
| INT32 | `DB1.DBD4` | `MD10` | `DB1,DINT4` / `MDI10` |
| UINT32 | `DB1.DBD4` | `MD10` | `DB1,DWORD4` / `MD10` |
| FLOAT | `DB1.DBD4` | `MD10` | `DB1,REAL4` / `MR10` |
| DOUBLE | — | — | **不支持**：nodes7 无 LREAL，点位被剔除并报错「S7 驱动 v1 暂不支持 DOUBLE（LREAL），请改用 FLOAT」 |

> ⚠️ 非 DB 区的有符号类型（INT16/INT32/FLOAT）会译为 nodes7 的 `I`/`DI`/`R` 后缀（如 `MI10`/`MDI10`/`MR10`）——
> 若按 TIA 字面透传 `MW10`/`MD10`，nodes7 会按 WORD/DWORD **无符号**解码，负数与浮点全部出错。

线序：S7 协议固定**大端**，点位上的 `byteOrder`/`wordOrder` 一律忽略。

## PLC 侧前提

- S7-1200/1500：TIA Portal 中开启「允许来自远程对象的 PUT/GET 通信访问」；DB 块取消「优化的块访问」。
- slot：S7-1200/1500 通常 1；S7-300 通常 2；S7-400 按硬件组态。

## 开发

```bash
npm install
npm test
```

测试不依赖真实 PLC（`@st-one-io/nodes7` 全部由 proxyquire stub；地址解析用 nodes7 官方 addressParser 交叉验证）。
