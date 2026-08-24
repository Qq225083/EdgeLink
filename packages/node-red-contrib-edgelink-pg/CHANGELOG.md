# Changelog

## v1.6.1 (2026-08-03)

- FIX: **spool 轮转归档 `.1` 永不重放且被静默覆盖**（P0-8）— replay 现在优先消费 `.1` 归档（最老数据先入库），完整重放后自动接力下一轮直到清空；轮转覆盖非空旧 `.1` 前发 `spool_archive_overwrite` 事件 + 大字 warn（旧实现：PG 停机超 100MB spool 即无声丢数据）
- FIX: **stranded `.replaying` 双存在搁浅** — active 与 `.replaying` 同时存在时（重放中崩溃+期间有新写入）合并回 active 重放（旧实现永久搁浅且无告警）
- FIX: **65535 绑定参数上限**（P2-20）— `executeInsert` 分片插入（1000 行/片），`bufferMax` 调大不再溢出；配合 `edgelink.plc_data` 新建唯一索引 `uq_plc_data_dedup(insert_time,node_id,device_id,tag_id)`，分片重试幂等
- FEAT: 重试救回的行补发 `inserted` 事件、3 处 `dropped` 事件携带 `failed` 计数（心跳健康指标口径修复，联动 EdgeLink Day7/P1-13）
- TEST: **PG 停机演练**（`test/pg_outage_drill.js`）— 锁表 25s 注入故障：300 直写 + 200 spool 重放 + 100 恢复直写 = 600 行零丢失零重复（唯一索引对账）

## v1.6.0 (2026-08-02)

- FIX: **串表写数据** — 写入在途时收到不同表/schema 的数据会混入同一 buffer，flush 时按最后一个 schema 整批插入（设备 A 数据写进设备 B 表，且 MC 各设备列相同，错误插入会"成功"，无报错）。缓冲改为分段模型（每段绑定列/表/格式/冲突策略），删除 `ensureBuffer`/`_pendingSchemas` 机制
- FIX: **确定性错误无限重试** — `classifyError` 改白名单制：仅连接类/瞬态错误（08xxx、ECONN*、57P01-03、53300/53400、55P03、40001、40P01）进重试缓冲；未知错误一律视为确定性错误，直接落 spool/死信
- FIX: **MC 格式 + update 策略必现 42P10** — 冲突目标改为完整 PK `(insert_time, device_id, tag_id)`；冲突目标列不再出现在 SET 子句；数据缺冲突目标列时降级 DO NOTHING（每表告警一次）
- FIX: **flush 定时器语义** — 不再每条消息 reset（持续低速数据下定时 flush 永远触发不了，延迟退化为攒满 batchSize）；改为有数据时启动一次，触发后仍有数据再续
- FIX: **关闭丢数据** — close 等待在途写入完成后再释放连接池（旧逻辑 `_writing` 时立即放行，pool 提前 end）；关闭时主缓冲 + 重试缓冲剩余数据全部落 spool（此前直接丢弃），重部署/重启不再丢数据，DB 恢复后自动重放
- FIX: **spool 重放阻塞事件循环** — spool 文件（上限 100MB）改 1MB 分块流式读取，不再一次性 `readFileSync` + `split`
- FIX: `SET statement_timeout` 失败被无视，会在死连接上继续 INSERT；`pool.connect` 失败按白名单分类（认证失败不再无限重试）
- FIX: `create_hypertable` 失败被静默吞掉 → 现输出 warning，表按普通表继续使用
- FIX: 通用建表 boolean 类型推断为 BOOLEAN（原推断为 TEXT，插入 boolean 必报 42804）
- FIX: 输入异常时 `done(err)`，下游 catch 节点可捕获
- FIX: pool key 纳入密码哈希 — 同库不同密码的两个配置不再错误共享连接池
- FIX: UI 限值与代码 clamp 对齐（batchSize ≤ 2000，bufferMax / retryBufferMax ≥ 50）
- TEST: 新增回归测试 — 在途写入不串表、确定性错误落 spool、MC update 冲突目标含 tag_id

## v1.4.2 (2026-07-18)
- CHORE: 发布 v1.4.2

## v1.4.1 (2026-07-18)
- FIX: Pool idle error handler 作用域错误 — `setStatus` / `node` 未定义导致 ReferenceError；改为通过 `POOLS[key].nodes` 通知所有使用该 pool 的节点
- FIX: `conflictStrategy` 注入风险 — 增加 `ignore/update/none` 白名单校验，非法值回退 `ignore`
- FIX: 节点 close 时从 pool 的 nodes 映射中移除自身，避免通知已关闭节点

## v1.4.0 (2026-07-18)
- FIX: retryBufferMax 配置失效 — 删除 retryRowMax，UI 配置值真正生效
- FIX: 缓冲超限静默丢数据 — 超限前尝试 flush，丢弃时输出 warning + `dropped` 事件
- FIX: autoCreateTable 默认值改为 false（生产环境应由 DBA 预建表）
- FIX: 输入处理支持 Node-RED 1.0+ `done()` 回调
- FIX: 关闭时强制超时从固定 10s 改为动态（基于未 flush 行数，上限 60s）
- FIX: 关闭时同时尝试 flush 重试缓冲
- FIX: Pool 空闲错误除 console 外，更新节点状态并发送 `pool_error` 事件
- FIX: 通用格式建表类型推断增强（null/数组/对象回退 TEXT）
- FIX: _tableCreationFailed TTL 可配置（默认 5 分钟）
- TEST: 新增单元测试覆盖 batch/MC 写入、缓冲 flush、重试上限、close 行为

## v1.3.0
- NEW: 冲突策略可配置 — ignore(默认)/update/none，config 面板 + msg 动态覆盖
- NEW: 通用格式自动建表 — idColumn/tsColumn 配置，非MC格式也可自动建表
- ENHANCE: 建表含 PRIMARY KEY + 索引 + TimescaleDB 超表支持

## v1.2.0 (2026-07-14)
- FIX: _roundStart 并发安全 — flushBuffer 内部捕获，消除共享状态竞态
- FIX: _pendingSchema → 数组队列 — 多 schema 切换不再静默丢失
- FIX: _tableCreationFailed TTL 清理 — 5 分钟过期，手动建表后可恢复
- FIX: pool.connect connectionTimeoutMillis=5s — 防 PG 不可达时永久挂起
- FIX: retryBuffer 按总行数限制 (retryRowMax=5000) — 防大条目导致 OOM
- FIX: 仅 flush/retry 时 node.send — 消除缓冲模式下的下游误判
- FIX: detectFormat MC 精确检测 (rawValue/engValue/quality) — 防嵌套对象误判
- FIX: 索引名用哈希 (idx_NNNNNN_dt) — 防长表名碰撞
- ENHANCE: 事件驱动重试 — 有数据才启定时器，消除空轮询
- ENHANCE: close 时记录未刷新数据条数到 warn 日志
- CLEAN: 移除 config 节点 console.log 调试输出
- CHANGE: 分类目录改为 edgelink

## v1.1.0 (2026-07-04)
- FIX: getPool() refCount incremented on every INSERT, pool never released
- FIX: registerPool() for constructor-time refCount, releasePool() for close-time
- FIX: close handler 10s safety timeout to force pool release
- CHANGE: bufferMax default 5000 to 1000, batchSize default 100 to 50
- NEW: memory guard auto-drops old data when buffer exceeds bufferMax x 2
- NEW: flushTimeout configurable (default 15s)
- FIX: pool.end() async error handling

## 1.0.0 (2026-06-29)

### Initial Release

- **Nodes**
  - `edgelink-pg-config` — PostgreSQL connection configuration node
  - `edgelink-pg-store` — Batch write node with buffer, retry, and multi-format input

- **Features**
  - Three auto-detected input formats: MC driver, batch rows, single-row object
  - Global connection pool with reference counting (multi-node sharing)
  - Batch INSERT with parameterized queries and `ON CONFLICT DO NOTHING`
  - Dual buffer protection: `bufferMax` + `retryBufferMax` with FIFO overflow
  - Fixed-interval retry (no backoff) for connection failures
  - 3-tier error classification: connection, table-not-found, data-error
  - Auto-create table + index + TimescaleDB hypertable (MC format)
  - Dynamic table name via `${deviceId}` template, `msg.tableName`, or `msg.topic`
  - `_writing` mutex lock preventing concurrent INSERT race conditions
  - `close` handler with `done()` callback ensuring last-flush before shutdown
  - Real-time status indicator (green/yellow/red)
  - ES5 syntax, Node-RED 3.x/4.x compatible
