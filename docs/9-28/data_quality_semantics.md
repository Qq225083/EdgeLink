# 采集数据质量语义

记录日期：2026-10-24  
适用范围：`module_flowgen` 生成的 MC/Modbus 契约装配与通信状态上报。

## 1. 点位级 quality

块内装配对每个配置点位生成：

- `GOOD`：成功取到值；
- `BAD`：块读取失败，整块按配置点位补齐 BAD；
- `UNCERTAIN`：读取成功但该点位的 key/数组下标缺失，`raw_value` 与 `eng_value` 置 `null`。

`UNCERTAIN` 表示“本轮没有拿到该点位的数据”，不表示设备离线，也不应直接触发离线告警。

## 2. 计数语义

最终装配保留并新增以下字段：

- `value_count`：配置点位总数；
- `good_count`：`GOOD` 点位数；
- `bad_count`：`BAD` 点位数；
- `uncertain_count`：`UNCERTAIN` 点位数。

顶层 `quality` 仍只输出 `GOOD / BAD`：存在 `BAD` 时为 `BAD`，否则为 `GOOD`。三态质量不写入顶层，避免破坏旧下游。

## 3. 通信状态语义

`comm` 只判断设备级通信连通性，同时满足以下条件才在线：

1. `payload` 非空；
2. `values` 数量大于 0；
3. 不存在 `BAD`；
4. 上游没有 `problem`。

因此：

- 单点缺失：`UNCERTAIN +1`，但 `comm=true`；
- 单块失败：该块点位 `BAD`，`comm=false`；
- 空数组、`null`、`problem`：`comm=false`。

已用真实 JSONata 注入覆盖：单点缺失、单块失败、空数组/null/problem、正常块四类场景。
