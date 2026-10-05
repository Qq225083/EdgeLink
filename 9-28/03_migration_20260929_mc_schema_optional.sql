-- ============================================================
-- 过渡版 — mitsubishi_mc 驱动 schema 修正（2026-09-29，幂等可重复执行）
-- 内容：protocol（传输协议）/ commCode（通信数据代码）改为非必填——
--   为空时生成器按默认 TCP/binary 处理（生成器已接管这两个字段进连接节点）。
-- 说明：config_schema 是 JSON 列，fields 数组顺序当前为
--   [mcFrame, protocol, commCode, stationNo, networkNo, plcPort]，
--   即 protocol=fields[1]、commCode=fields[2]。执行后请用下方 SELECT 验证。
-- ============================================================

UPDATE plc_driver
SET config_schema = JSON_SET(
    config_schema,
    '$.fields[1].required', CAST('false' AS JSON),
    '$.fields[2].required', CAST('false' AS JSON)
)
WHERE driver_code = 'mitsubishi_mc';

-- 验证（应输出 protocol:false / commCode:false）：
-- SELECT driver_code,
--   JSON_EXTRACT(config_schema, '$.fields[1].name'), JSON_EXTRACT(config_schema, '$.fields[1].required'),
--   JSON_EXTRACT(config_schema, '$.fields[2].name'), JSON_EXTRACT(config_schema, '$.fields[2].required')
-- FROM plc_driver WHERE driver_code = 'mitsubishi_mc';
