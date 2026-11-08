# Modbus Driver 离线契约

记录日期：2026-10-24  
适用范围：`module_flowgen.drivers.modbus.ModbusDriver`，目标节点包为社区 `node-red-contrib-modbus`。

## 1. 当前边界

本机未安装社区 `node-red-contrib-modbus`，driver 的 `capabilities.required_modules` 明确标记为：

```text
node-red-contrib-modbus: unverified-local-missing
```

本机存在的自研 `node-red-contrib-edgelink-modbus` 不是当前生成器目标：它使用 `modbus-config` 与 `regType=holding|input|coil|discrete`，契约不同，不能混用。

## 2. 功能码映射

以 `node-red-contrib-modbus@5.23.2` 的 `modbus-read` 为准：

| 后端寄存器类型 | modbus-read `dataType` | 功能码 |
|---|---|---:|
| `CR / COIL` | `Coil` | FC1 |
| `DI / DISCRETE` | `Input` | FC2 |
| `HR` | `HoldingRegister` | FC3 |
| `IR` | `InputRegister` | FC4 |

关键证据：5.23.2 的 `modbus-read.html` 下拉项是 `value='Input'` 表示 FC2；运行时 `functionCodeModbusRead()` 中 `case "Input": return 2`。`DiscreteInput` 不是该读取节点的合法枚举，传入会落到 `default: return -1`。

## 3. 地址与块规划

过渡版 Modbus 只支持单字/位类型：

- `INT16 / UINT16 / BIT / BOOL`；
- 多字类型（如 `FLOAT / INT32`）生成期拒绝，提示需 buffer-parser；
- 地址必须是 `0-65535` 十进制；
- 块上限 120；
- 寄存器类型分组前统一转大写，`hr` 与 `HR` 不会因大小写被拆成两块。

HR/IR 字区上的 BIT/BOOL 必须填 `bit_offset: 0-15`；CR/COIL/DI/DISCRETE 位区不要求位偏移。

## 4. 已做离线验证

- 混合 MC + Modbus 配置的 `_validate_inputs()` 回归通过；
- HR/IR/CR/DI 已纳入 canonical golden；
- 当前 golden 为 145 节点；
- 既有 Modbus lint 失败仍只剩“社区包未安装”相关问题，没有新增失败项。

未完成：真机 FC01/FC02/FC03/FC04 抓包、跨轮 join、亚秒 `rateUnit=ms`、72 小时浸泡。
