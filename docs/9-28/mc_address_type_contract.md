# MC 地址与类型契约（生成器版）

记录日期：2026-10-24  
适用范围：`module_flowgen` 生成器 + `node-red-contrib-mcprotocol@1.2.1`。

## 1. 位设备地址模型

位设备集合：`M / L / F / V / X / Y / B`。

- `register_address` 是基位号；
- `bit_offset` 是地址偏移，不是字内位号；
- 全局位号 = `parse_address(register_address) + bit_offset`；
- 读取地址和输出 key 都不带 `.bit`。

示例：

| 配置 | 生成读取地址 | 输出 key |
|---|---|---|
| `M200 + bit_offset=0` | `M200` | `M200` |
| `M200 + bit_offset=3` | `M203` | `M203` |
| `M200/M201/M202` 三位连读 | `M200,3` | `M200`、`M201`、`M202` |

字设备集合：`D / W / R`。只有字设备上的 BIT/BOOL 才使用 `.bit`：

| 配置 | 生成读取地址 | 输出 key |
|---|---|---|
| `D100 + bit_offset=3` | `D100.3` | `D100.3` |
| `D100.3` 起 4 位 | `D100.3,4` | `D100.3` ~ `D100.6` |

## 2. 地址进制

统一入口是 `MCDriver.parse_address()`：

| 寄存器 | 配置侧进制 | 下发/key 格式 |
|---|---|---|
| `W / B` | 十六进制 | 大写十六进制 |
| 非 FX 的 `X / Y` | 十六进制 | 大写十六进制 |
| FX/IQF 或显式 `octalInputOutput=true` 的 `X / Y` | 八进制 | 换算为大写十六进制 |
| 其他 | 十进制 | 十进制 |

FX 示例：`X10 → X8`、`X17 → XF`、`Y10 → Y8`。

注意：FX X/Y 当前只完成离线契约与生成器回归；真机探针未做，生产启用前必须用现场 PLC 验证编程口地址与读取结果一致。

## 3. 类型映射

| 数据类型 | MC 地址前缀 | 字数 |
|---|---|---:|
| `INT16` | 无 | 1 |
| `UINT16` | `UINT` | 1 |
| `INT32` | `DINT` | 2 |
| `UINT32` | `DWORD` | 2 |
| `FLOAT` | `FLOAT` | 2 |
| `DOUBLE` | 不支持 | - |

`DOUBLE` 在生成期明确拒绝：当前 MC 包的 `REAL/FLOAT` 是 4 字节/2 字，不是 8 字节。配置应改为 `FLOAT` 或拆成两个 32 位值。

字节序/字序当前只允许默认值：`LITTLE_ENDIAN / LOW_FIRST`；生成器不接受非默认值。
