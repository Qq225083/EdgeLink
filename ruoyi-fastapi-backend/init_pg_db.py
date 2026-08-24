"""PLC 时序数据表初始化 (PostgreSQL + TimescaleDB)
运行前提: pip install psycopg2-binary
数据库: ruoyi_pg (需预先创建)
"""
import os
import sys

try:
    import psycopg2
    from psycopg2 import sql
except ImportError:
    print("[ERR] 缺少 psycopg2，请执行: pip install psycopg2-binary")
    sys.exit(1)

# ====== 配置（可通过环境变量覆盖） ======
PG_HOST = os.getenv("PG_HOST", "127.0.0.1")
PG_PORT = int(os.getenv("PG_PORT", "5432"))
PG_USER = os.getenv("PG_USER", "postgres")
PG_PASS = os.getenv("PG_PASSWORD", "postgres")
PG_DB   = os.getenv("PG_DATABASE", "ruoyi_pg")

conn = psycopg2.connect(
    host=PG_HOST, port=PG_PORT, user=PG_USER,
    password=PG_PASS, database=PG_DB,
)
conn.autocommit = True
cur = conn.cursor()

# ====== 1. 建表 ======
print("[1/4] 创建 plc_data_log 表...")
cur.execute("""
CREATE TABLE IF NOT EXISTS plc_data_log (
    id              BIGSERIAL,
    device_id       BIGINT      NOT NULL,
    tag_id          BIGINT      NOT NULL,
    node_id         BIGINT,
    raw_value       DOUBLE PRECISION,
    eng_value       DOUBLE PRECISION,
    quality         SMALLINT    NOT NULL DEFAULT 0,      -- 0=GOOD 1=BAD 2=UNCERTAIN (v10: 改为整数，与Node-RED一致)
    transform_type  VARCHAR(20) DEFAULT 'none',
    ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- v10 新增: 丰富元数据列 (Node-RED sf-pg-writer 写入)
    device_name     VARCHAR(100),
    tag_address     VARCHAR(50),
    tag_name        VARCHAR(100),
    unit            VARCHAR(20),
    host_pc_ip      VARCHAR(20)
);
""")
print("  [OK] plc_data_log 表")

# ====== 2. 索引 ======
print("[2/4] 创建索引...")
indexes = [
    ("idx_log_tag_ts",    "plc_data_log", "tag_id, ts DESC"),
    ("idx_log_device_ts", "plc_data_log", "device_id, ts DESC"),
    ("idx_log_quality",   "plc_data_log", "quality, ts DESC", "quality != 0"),
    ("idx_log_host_pc",   "plc_data_log", "host_pc_ip, ts DESC"),
]
for idx_name, table, cols, *rest in indexes:
    try:
        where = f" WHERE {rest[0]}" if rest else ""
        cur.execute(
            sql.SQL("CREATE INDEX IF NOT EXISTS {} ON {} ({}){}").format(
                sql.Identifier(idx_name),
                sql.Identifier(table),
                sql.SQL(cols),
                sql.SQL(where),
            )
        )
        print(f"  [OK] 索引 {idx_name}")
    except Exception as e:
        print(f"  [SKIP] {idx_name}: {e}")

# ====== 3. TimescaleDB hypertable（如果可用） ======
print("[3/4] 尝试转为 TimescaleDB hypertable...")
try:
    cur.execute("""
        SELECT create_hypertable('plc_data_log', 'ts',
            chunk_time_interval => INTERVAL '7 days',
            if_not_exists => TRUE
        );
    """)
    print("  [OK] hypertable 已创建 (7天chunk)")
except Exception as e:
    print(f"  [SKIP] TimescaleDB 不可用，使用普通 PG 表: {e}")

# ====== 4. 压缩策略（TimescaleDB 可选） ======
print("[4/4] 配置压缩策略（如可用）...")
try:
    cur.execute("""
        ALTER TABLE plc_data_log SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'tag_id',
            timescaledb.compress_orderby = 'ts DESC'
        );
    """)
    print("  [OK] 压缩已启用")
    cur.execute("SELECT add_compression_policy('plc_data_log', INTERVAL '7 days');")
    print("  [OK] 7天后自动压缩")
except Exception as e:
    print(f"  [SKIP] 压缩策略不可用: {e}")

# ====== 验证 ======
print()
print("=" * 60)
cur.execute("""
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'plc_data_log'
    ORDER BY ordinal_position;
""")
print(f"{'column':<20} {'type':<20} {'nullable':<10}")
print("-" * 60)
for row in cur.fetchall():
    print(f"{row[0]:<20} {row[1]:<20} {row[2]:<10}")

cur.execute("SELECT count(*) FROM plc_data_log")
print(f"\n当前数据量: {cur.fetchone()[0]} 条")

# ====== v10 迁移: 已有表的 ALTER 语句 (请人工审查后执行) ======
print()
print("=" * 60)
print("[v10 迁移] 如果 plc_data_log 已存在且有数据，请手动执行以下 SQL:")
print("-" * 60)
print("""
-- 1. 添加 v10 新列
ALTER TABLE plc_data_log ADD COLUMN IF NOT EXISTS device_name VARCHAR(100);
ALTER TABLE plc_data_log ADD COLUMN IF NOT EXISTS tag_address VARCHAR(50);
ALTER TABLE plc_data_log ADD COLUMN IF NOT EXISTS tag_name    VARCHAR(100);
ALTER TABLE plc_data_log ADD COLUMN IF NOT EXISTS unit        VARCHAR(20);
ALTER TABLE plc_data_log ADD COLUMN IF NOT EXISTS host_pc_ip  VARCHAR(20);

-- 2. quality 列类型迁移 (VARCHAR→SMALLINT, 已有数据需转换)
--    注意: 此操作会锁表，建议在维护窗口执行
ALTER TABLE plc_data_log
  ALTER COLUMN quality TYPE SMALLINT
  USING CASE quality
    WHEN 'GOOD'      THEN 0
    WHEN 'BAD'       THEN 1
    WHEN 'UNCERTAIN' THEN 2
    ELSE 0
  END;

-- 3. 设置 quality 默认值
ALTER TABLE plc_data_log ALTER COLUMN quality SET DEFAULT 0;

-- 4. 新增索引
CREATE INDEX IF NOT EXISTS idx_log_host_pc ON plc_data_log (host_pc_ip, ts DESC);

-- 5. 重建 quality 部分索引 (适配整数)
DROP INDEX IF EXISTS idx_log_quality;
CREATE INDEX IF NOT EXISTS idx_log_quality ON plc_data_log (quality, ts DESC) WHERE quality != 0;
""")

cur.close()
conn.close()
print()
print("[DONE] PLC 时序数据表初始化完成")
