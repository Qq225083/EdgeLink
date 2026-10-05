-- 14_pg_create_plc_data_log.sql
-- 【在 PostgreSQL 的 ruoyi_pg 库执行，不是 MySQL】
-- 过渡版 PG 写库支路目标表（对应生成弹窗目标1默认 public.plc_data_log）
CREATE TABLE IF NOT EXISTS public.plc_data_log (
    id              BIGSERIAL PRIMARY KEY,
    device_id       INTEGER          NOT NULL,
    tag_id          INTEGER          NOT NULL,
    node_id         INTEGER,
    tag_name        VARCHAR(128),
    tag_address     VARCHAR(64),
    register_type   VARCHAR(16),
    raw_value       DOUBLE PRECISION,
    eng_value       DOUBLE PRECISION,
    unit            VARCHAR(32),
    quality         VARCHAR(16)      NOT NULL DEFAULT 'UNCERTAIN',
    transform_type  VARCHAR(32),
    ts              TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plc_data_log_ts ON public.plc_data_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_plc_data_log_dev_ts ON public.plc_data_log (device_id, ts DESC);

-- 验证（执行后可逐条取消注释测试）
-- INSERT INTO public.plc_data_log (device_id,tag_id,quality,node_id,tag_name,tag_address,register_type) VALUES (49,92,'GOOD',66,'测试点','100','D');
-- SELECT * FROM public.plc_data_log ORDER BY id DESC LIMIT 1;
-- DELETE FROM public.plc_data_log WHERE tag_name='测试点';

-- ---------------------------------------------------------------------------
-- 2026-10-03 追加：现网 postgres 库的 plc_data_log 为早期 DDL 所建（无 register_type
-- 等列），生成流按勾选字段插入时报 42703「字段不存在」。补齐缺失列：
-- 【已于 2026-10-03 在 postgres 库执行，服务器执行时同样跑这一段】
-- ---------------------------------------------------------------------------
ALTER TABLE public.plc_data_log ADD COLUMN IF NOT EXISTS register_type VARCHAR(16);
-- 若早期表还缺其他列，按同样方式补：
-- ALTER TABLE public.plc_data_log ADD COLUMN IF NOT EXISTS device_name VARCHAR(100);
-- ALTER TABLE public.plc_data_log ADD COLUMN IF NOT EXISTS host_pc_ip VARCHAR(20);
