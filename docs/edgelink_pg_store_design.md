# edgelink-pg-store 设计说明书

## 概述

`edgelink-pg-store` 是 EdgeLink 边缘采集系统的 PostgreSQL/TimescaleDB 批量写入节点。它是一个 **Node-RED 自定义 output 节点**，定位为"工业 SCADA 数据记录器"而非通用 SQL 客户端。

**核心差异**：通用 PG 节点是"给你一个数据库客户端，自己写 SQL"；`edgelink-pg-store` 是"给我采集数据，剩下的不用管"。

## 技术栈

- Node-RED 3.x / 4.x
- PostgreSQL 12+（依赖 `pg` 8.x 驱动）
- TimescaleDB 2.x+（可选超表）
- ES5 语法（兼容 Node-RED function 节点环境）

## 输入格式（自动识别三种）

节点通过 `detectFormat()` 函数自动识别三种输入格式，优先级为：

### 格式 1：MC 驱动格式（接 mitsubishi-read / modbus-read）

```javascript
msg.payload = {
  success: true,
  deviceId: "PLC-烘炉-1号",
  data: {
    "温度": { rawValue: 2530, engValue: 253.0, quality: 0, ts: "2026-06-27T16:00:00.000Z", regType: "D" },
    "开关": { rawValue: 1, engValue: 1, quality: 0, ts: "2026-06-27T16:00:00.000Z", regType: "X" }
  }
}
```

- 检测条件：`payload.data` 存在，且其值为嵌套对象
- 固定 7 列 schema：`insert_time, device_id, tag_id, register_type, raw_value, eng_value, quality`
- 支持 `ON CONFLICT DO NOTHING`（按 PK 去重）
- 支持 `autoCreateTable` 自动建表 + 索引 + TimescaleDB 超表
- 支持 `${deviceId}` 动态分表

### 格式 2：批量 rows（inject + function 构造）

```javascript
msg.payload = {
  rows: [
    { sensor: "temp", value: 25.5, ts: "2026-06-29T16:00:00Z" },
    { sensor: "press", value: 1.2, ts: "2026-06-29T16:00:00Z" }
  ]
}
msg.topic = "sensor_data"
```

- 检测条件：`payload.rows` 存在且为数组
- 列名自动从第一行 `Object.keys()` 提取并 sanitize
- 表名：`msg.tableName` > `msg.topic` > 节点配置 `tableName`
- 无 ON CONFLICT（无固定 PK 定义）

### 格式 3：单行 object（inject 直接写）

```javascript
msg.payload = { sensor: "temp", value: 25.5, ts: "2026-06-29T16:00:00Z" }
msg.topic = "sensor_data"
```

- 检测条件：纯 object（无 `.data`、无 `.rows`）
- 自动包装为单行数组，其余同批量 rows

### 动态控制

| 字段 | 作用 | 适用范围 |
|------|------|----------|
| `msg.tableName` | 动态覆盖表名 | 三种格式 |
| `msg.topic` | 表名（备用） | 通用格式 |
| `msg.flush = true` | 强制立即写入 | 三种格式 |
| `payload.success === false` | 跳过上游失败消息 | MC 格式 |

## 输出格式

```javascript
// 缓冲中（每次输入后立即输出）
{ success: true, inserted: 0, buffered: N, tableName: "plc_data", roundTimeMs: 0, originalData: {...} }

// 批量写入完成（异步输出）
{ success: true, inserted: 100, failed: 0, buffered: 0, tableName: "plc_data", roundTimeMs: 45 }
```

## 核心架构

### 连接池管理（模块级全局单例）

```
POOLS = { "user@host:port/db" → { pool: pg.Pool, refCount: number } }
```

- Key 维度：`user@host:port/database`（避免同库不同账户冲突）
- 多个 edgelink-pg-store 引用同一 edgelink-pg-config 时共享 Pool
- 节点关闭时 `refCount--`，归零时 `pool.end()`
- **不维护额外清理定时器**：pg 驱动自带 `idleTimeoutMillis` 回收空闲连接

### 批量写入流程

```
收到 msg
  │
  ├─→ detectFormat(payload) → mc | batch | single
  ├─→ 解析为 rows[] + columns[] + tableName
  │
  ├─→ ensureBuffer(cols, tbl, isMC)
  │     │ 列/表与当前缓冲不一致？→ flushBuffer() 先刷新旧数据
  │     └─→ 存入 _buffer[]
  │
  ├─→ 主缓冲溢出？→ splice(0, overflow) 丢弃最老
  │
  ├─→ 触发条件：buffer.length >= batchSize || msg.flush || flushInterval 到期
  │     │
  │     ├─ _writing 锁检查 → 为 true 则跳过
  │     ├─ _writing = true
  │     ├─ executeInsert(rows, columns, tableName, isMC)
  │     │     ├─ pool.connect() → 参数化 SQL → client.query()
  │     │     ├─ 成功 → _writing = false, output
  │     │     ├─ 连接错误 → addToRetryBuffer(), output
  │     │     └─ 脏数据 → discard, output
  │     └─ _writing = false
  │
  └─→ 输出 { buffered: N, originalData: ... }
```

### 统一写入锁（防竞态）

三个触发源（batchSize 到达、`msg.flush`、定时器到期）共享一把 `_writing` 锁。锁为 true 时后续触发全部跳过，等当前 INSERT 完成再开下一轮。

### 失败重试

- **retryBuffer**：FIFO 队列 `[{ rows, columns, tableName, isMC }]`
- **固定重试间隔**：`retryInterval`（默认 5000ms），无退避
- **超限保护**：`retryBufferMax`（默认 1000）达到后用 `shift()` 丢弃最老批次
- **错误分类**：

| 类型 | SQLSTATE | 处理 |
|------|----------|------|
| 连接错误 | ECONNREFUSED / ETIMEDOUT / 08xxx | → retryBuffer |
| 表不存在 | 42P01 | MC 格式 + autoCreateTable → 建表后重试；其余 → 丢弃 |
| 数据类型错误 | 22P02 | → 丢弃（脏数据不反复重试） |
| 其他 | 其余 | → retryBuffer（Node-RED 日志记录） |

### close 事件

```javascript
node.on('close', function(done) {
    clearTimeout(_flushTimer);
    clearInterval(_retryTimer);
    flushBuffer(function() {
        releasePool(pgConfig);  // refCount--, 必要时 pool.end()
        if (typeof done === 'function') done();  // 必须调用，让 Node-RED 等待
    });
});
```

## 配置节点：edgelink-pg-config

| 字段 | 默认值 | 说明 |
|------|--------|------|
| name | PG-本地 | 显示名称 |
| host | 127.0.0.1 | 数据库主机 |
| port | 5432 | 端口 |
| database | ruoyi_pg | 数据库名 |
| user | postgres | 用户名 |
| password | (空) | 密码 |
| maxConnections | 10 | 连接池最大连接数 |
| idleTimeout | 30000 | 空闲超时(ms) |

## 写入节点：edgelink-pg-store

| 字段 | 默认值 | 说明 |
|------|--------|------|
| pgConfig | (必选) | 关联 edgelink-pg-config |
| tableName | plc_data | 表名，MC 格式支持 `${deviceId}` |
| batchSize | 100 | 批量触发条数 |
| bufferMax | 5000 | 主缓冲上限 |
| flushInterval | 5000 | 定时刷新(ms)，0=禁用 |
| retryBufferMax | 1000 | 重试缓冲上限 |
| retryInterval | 5000 | 重试间隔(ms) |
| autoCreateTable | false | MC 格式自动建表 |
| useTimescaleDB | false | MC 格式创建超表 |

## 表结构（MC 格式 autoCreateTable=true）

```sql
CREATE TABLE IF NOT EXISTS plc_data (
    insert_time   TIMESTAMPTZ NOT NULL,
    device_id     VARCHAR(64) NOT NULL,
    tag_id        VARCHAR(64) NOT NULL,
    register_type VARCHAR(8),
    raw_value     NUMERIC,
    eng_value     NUMERIC,
    quality       INTEGER DEFAULT 0,
    PRIMARY KEY (insert_time, device_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_plc_data_dt
    ON plc_data (device_id, tag_id, insert_time DESC);

-- useTimescaleDB=true 时单独执行
SELECT create_hypertable('plc_data', 'insert_time', if_not_exists => TRUE);
```

## 关键设计决策

1. **不做 SQL 直通**：SQL 直通与参数化保护、批量缓冲、格式检测逻辑冲突。通用 SQL 需求用 `node-red-contrib-postgresql` 等节点互补。

2. **不做退避策略**：固定 `retryInterval`，不维护失败计数器。边缘场景 PG 要么很快恢复（网络抖动），要么彻底挂（需人工介入），退避不带来实际收益。

3. **不维护 Pool 清理定时器**：pg 驱动自带 `idleTimeoutMillis`，正常 close 路径已覆盖 `releasePool → pool.end()`。

4. **3 类错误不 7 类**：只分连接错误、表不存在、数据错误 + 兜底。23505 由 `ON CONFLICT DO NOTHING` 在 SQL 层解决，53100/42501 等罕见。

5. **格式检测而非显式选择**：用户不必配置"输入格式"字段。节点从 `payload` 结构自动推断，MC 驱动的 `.data` 嵌套对象与通用格式的扁平 object 可自然区分。

6. **Node-RED 4.x config 节点 input 前缀**：config 节点（`category: 'config'`）HTML 表单字段 `id` 必须使用 `node-config-input-*` 前缀，普通节点使用 `node-input-*`。用错会导致编辑属性全部回退默认值。

## 文件结构

```
node-red-contrib-edgelink-pg/
├── package.json
├── README.md
└── nodes/
    ├── edgelink-pg-config.js    (25 行，config 节点后端)
    ├── edgelink-pg-config.html  (65 行，config 节点 UI)
    ├── edgelink-pg-store.js     (380 行，写入节点后端)
    └── edgelink-pg-store.html   (160 行，写入节点 UI)
```

总计约 630 行，无死代码，无"万一将来"预埋接口。

## 与现有 PG 节点的对比

| 维度 | 通用 PG 节点 | edgelink-pg-store |
|------|-------------|-------------------|
| 写入方式 | 单条 SQL | 批量 buffer → 一次 INSERT，性能 100x |
| PG 断连 | msg 丢失 | retryBuffer FIFO 自动补入 |
| 连接池 | 节点各自为政 | 全局单例共享 |
| 竞态保护 | 无 | `_writing` 锁 |
| 内存安全 | 无 | bufferMax + retryBufferMax 双上限 |
| 上游集成 | 自己拼 SQL | 直吃 MC/modbus 驱动输出 |
| close 时 | 数据丢 | flush + done() 不丢数据 |
| 代码量 | 通常 800-2000 行 | 380 行 |
