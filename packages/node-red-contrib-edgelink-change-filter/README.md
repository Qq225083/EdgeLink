# node-red-contrib-edgelink-change-filter

EdgeLink 变化过滤节点包：数组记录按唯一键逐字段对比，只输出发生变化的项；配套 diff → 逐点位 INSERT SQL 展开节点。用于替代存量 function 节点中"存旧值→对比→拼 SQL"的手写逻辑，减少数据库写入量与网络传输量。

## 节点

| 节点 | 职责 |
|---|---|
| `change-filter` | 通用变化检测：与上一次输入对比，输出带 `_changed_fields` / `_old_values` / `_is_new` 元数据的 diff 记录 |
| `change-to-sql` | 业务展开：把 `_changed_fields` 按映射表展开为逐点位 INSERT SQL（`msg.query`） |

典型链路：

```
[PLC读取] → [change-filter] → [change-to-sql] → [pg 节点]
```

## change-filter

**输入** `msg.payload`（对象数组）：

```json
[
  { "equipment_id": "b040", "col3": 100, "col4": 200, "timestamp": "..." },
  { "equipment_id": "b041", "col3": 150, "col4": 250, "timestamp": "..." }
]
```

**输出**（仅变化项模式）：只含变化记录，每条附元数据；无变化输出 `[]`。

```json
[
  { "equipment_id": "b040", "col3": 105, "col4": 200,
    "_changed_fields": ["col3"],
    "_old_values": { "col3": 100 },
    "_changes": { "col3": 105 },
    "_is_new": false }
]
```

`_changes` 为变化字段的新值（对象，键为字段名），字段被删除时值为 `null`；旧值见 `_old_values`。

**配置**：

| 参数 | 默认 | 说明 |
|---|---|---|
| `keyField` | `id` | 唯一键字段，按值匹配记录（不用数组索引，设备顺序变化不影响） |
| `excludeFields` | `timestamp,insert_time` | 不参与比较的字段，逗号分隔 |
| `outputMode` | `changed_only` | `changed_only` 仅变化项 / `all_with_flag` 全量并附 `_changed` 标记 |
| `firstPass` | `pass_through` | `pass_through` 首帧全量通过并建基准 / `drop` 首帧只建基准不输出 |
| `threshold` | `0` | 数值死区：\|Δ\| ≥ 阈值才算变化，0 = 关闭；类型变化一律算变化 |
| `timeoutSec` | `0` | 设备超过 N 秒未出现则清除其基准（防内存累积），再现时按新记录；0 = 不清理 |

**行为要点**：

- 基准保存在节点闭包内，不使用 flow/global context；节点重启/重部署后基准清空，首帧按新记录处理（下游写库需幂等）。
- 新记录（含首帧）`_is_new=true`，`_changed_fields` 为全部参与比较的字段，`_old_values` 为空——下游可统一按"全量写入该设备"处理。
- 输入非数组：红色状态 + 抛错（catch 节点可捕获），不发送消息。
- 记录缺唯一键字段：跳过该条并 warn；设备离线（记录减少）不报错。
- 对象/数组字段按 JSON.stringify 深比较（对 key 顺序敏感）。

**状态灯**：绿点 = 有变化输出；灰圈 = 无变化；蓝点 = 首帧已建基准（drop 模式）；红圈 = 输入错误。

## change-to-sql

接收 change-filter 的输出，把变化字段展开为逐点位写库载荷，两种输出格式：

- **`sql`（默认）**：`msg.query` 挂拼好的 INSERT，对接通用"执行 msg.query"的 pg 节点：

```sql
INSERT INTO wedh.wed_scn1(insert_time, tag_id, value) VALUES
('2024-09-18T10:00:00.000Z', 1, 105),
('2024-09-18T10:00:00.000Z', 2, 250);
```

- **`rows`**：`msg.payload.rows` + `msg.tableName`，对接 **edgelink-pg-store**，自动获得断库内存重试 → 磁盘 spool → 恢复自动重放、`ON CONFLICT` 幂等去重，值走参数化绑定：

```js
msg.tableName = 'wedh.wed_scn1';
msg.payload = { rows: [
  { insert_time: '...', tag_id: 1, value: 105 },
  { insert_time: '...', tag_id: 2, value: 250 }
]};
```

**配置**：

| 参数 | 默认 | 说明 |
|---|---|---|
| `table` | （必填） | 目标表，支持 `schema.table`；校验为合法标识符防注入 |
| `timeColumn` / `tagColumn` / `valueColumn` | `insert_time` / `tag_id` / `value` | 列名 |
| `keyField` | `equipment_id` | 记录中用于查设备专属映射的字段 |
| `outputFormat` | `sql` | `sql` = msg.query（通用 pg 执行节点）/ `rows` = payload.rows（edgelink-pg-store） |
| `fieldMapping` | `{}` | 字段 → tag_id 映射（JSON） |

**映射表**：先查设备专属、再回落 `"*"` 公共默认；查不到的字段跳过并 warn。

```json
{
  "*":    { "col3": 1,   "col4": 2 },
  "b040": { "col3": 101, "col4": 102 }
}
```

**行为要点**：

- 仅写入数值型字段（typeof number 且有限），非数值跳过并 warn。
- 没有可写入行时不发送消息（不会下发空 SQL）。
- 时间戳统一 `new Date().toISOString()`（UTC，`timestamptz` 直接可收）。
- 本节点无状态。

## 测试

```bash
npm install
npm test
```

## License

MIT
