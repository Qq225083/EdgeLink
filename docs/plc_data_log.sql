-- ===================================================================
-- EdgeLink 采集历史数据表 (PostgreSQL + TimescaleDB)
-- 数据库: ruoyi_pg
-- 用途: 存储 200台PLC × 数千点位的采集历史
-- 参考: TimescaleDB hypertable + 自动压缩策略
-- ===================================================================

-- ===================================================================
-- 1. 建表
-- ===================================================================
CREATE TABLE IF NOT EXISTS plc_data_log (
    id              BIGSERIAL,
    device_id       BIGINT      NOT NULL,               -- plc_device.id
    tag_id          BIGINT      NOT NULL,               -- plc_tag.id
    node_id         BIGINT,                             -- nodered_node.id (哪台PC采集的)
    raw_value       DOUBLE PRECISION,                   -- PLC原始值 (可追溯)
    eng_value       DOUBLE PRECISION,                   -- 工程值 (换算后，Grafana用这个)
    quality         VARCHAR(10) NOT NULL DEFAULT 'GOOD',-- 数据质量码: GOOD/BAD/UNCERTAIN
    transform_type  VARCHAR(20) DEFAULT 'none',         -- 当时用的换算类型 (快照)
    ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- 采集时间 (PC本地时间)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()  -- 入库时间
);

-- ===================================================================
-- 2. 核心索引
-- ===================================================================
-- 按点位+时间查趋势 (最常用)
CREATE INDEX IF NOT EXISTS idx_log_tag_ts ON plc_data_log (tag_id, ts DESC);
-- 按设备查最近值
CREATE INDEX IF NOT EXISTS idx_log_device_ts ON plc_data_log (device_id, ts DESC);
-- 按质量码筛选
CREATE INDEX IF NOT EXISTS idx_log_quality ON plc_data_log (quality, ts DESC)
    WHERE quality != 'GOOD';

-- ===================================================================
-- 3. TimescaleDB hypertable (如果安装了 TimescaleDB)
--    将普通表转为 hypertable，按7天一个chunk自动分区
--    注意：仅在 PostgreSQL + TimescaleDB 环境下执行，MySQL 环境跳过
-- ===================================================================
DO $$ BEGIN
    PERFORM create_hypertable('plc_data_log', 'ts', chunk_time_interval => INTERVAL '7 days');
    RAISE NOTICE '[OK] plc_data_log → hypertable';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[SKIP] TimescaleDB not available or already hypertable';
END $$;

-- ===================================================================
-- 4. 自动压缩策略 (TimescaleDB可选 — 7天后压缩，节省90%磁盘)
-- ===================================================================
ALTER TABLE plc_data_log SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'tag_id',
    timescaledb.compress_orderby = 'ts DESC'
);
SELECT add_compression_policy('plc_data_log', INTERVAL '7 days');

-- ===================================================================
-- 5. 数据保留策略 (原始1s数据保留30天，之后自动删除)
-- ===================================================================
SELECT add_retention_policy('plc_data_log', INTERVAL '30 days');

-- ===================================================================
-- 6. 手动创建 1分钟聚合物化视图 (如需长期看趋势)
-- ===================================================================
-- CREATE MATERIALIZED VIEW IF NOT EXISTS plc_data_log_1min AS
-- SELECT
--     tag_id,
--     device_id,
--     time_bucket('1 minute', ts) AS bucket,
--     AVG(eng_value) AS avg_value,
--     MIN(eng_value) AS min_value,
--     MAX(eng_value) AS max_value,
--     COUNT(*) AS sample_count,
--     MAX(quality) AS worst_quality
-- FROM plc_data_log
-- WHERE quality = 'GOOD'
-- GROUP BY tag_id, device_id, bucket;

-- ===================================================================
-- 7. 注释
-- ===================================================================
COMMENT ON TABLE  plc_data_log IS 'PLC采集历史数据 (TimescaleDB hypertable)';
COMMENT ON COLUMN plc_data_log.raw_value IS 'PLC寄存器原始值 (可追溯，公式错可重算)';
COMMENT ON COLUMN plc_data_log.eng_value IS '换算后的工程值 (Grafana/报表直接使用)';
COMMENT ON COLUMN plc_data_log.quality IS '数据质量码: GOOD(正常)/BAD(通信中断)/UNCERTAIN(超出量程)';
COMMENT ON COLUMN plc_data_log.transform_type IS '采集时使用的换算类型快照 (便于问题追溯)';
COMMENT ON COLUMN plc_data_log.ts IS 'Node-RED采集时间 (PC本地时钟，非PLC时钟)';
