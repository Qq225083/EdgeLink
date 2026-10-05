-- ============================================================
-- 过渡版 — mitsubishi_mc 驱动 schema 面向社区节点配置面（2026-09-29，幂等）
-- 内容：
--   1. 新增 plcType（Q/L/R/FX 下拉）与 octalInputOutput（X/Y 八进制开关）两个可选字段
--      —— 对应社区节点 MC Protocol Connection 的真实配置面；
--   2. protocol / commCode 已为非必填（见 migration_20260929_mc_schema_optional.sql），
--      本脚本整体重写 fields 以固化最终形态；
--   3. schema_version 1 → 2。
-- 约束：平铺字段名（mcFrame/stationNo/networkNo/plcPort）不变——前端平铺逻辑、
--       V12 快照、生成器三处引用。新字段落 protocol_params，生成器已消费。
-- ============================================================

UPDATE plc_driver
SET config_schema = '{
  "fields": [
    {"name": "plcType", "type": "select", "label": "PLC 类型", "options": ["Q", "L", "R", "FX"], "default": "Q", "required": false},
    {"name": "mcFrame", "type": "select", "label": "帧格式", "options": ["3E", "4E"], "default": "3E", "required": true},
    {"name": "protocol", "type": "select", "label": "传输协议", "options": ["TCP", "UDP"], "default": "TCP", "required": false},
    {"name": "commCode", "type": "select", "label": "通信数据代码", "options": ["binary", "ascii"], "default": "binary", "required": false},
    {"name": "stationNo", "type": "number", "label": "站号", "default": 0, "min": 0, "max": 255, "required": true},
    {"name": "networkNo", "type": "number", "label": "网络号", "default": 0, "min": 0, "max": 255, "required": true},
    {"name": "plcPort", "type": "number", "label": "PLC 端口", "default": 5007, "min": 1, "max": 65535, "required": true},
    {"name": "octalInputOutput", "type": "select", "label": "X/Y 八进制（FX 系列）", "options": ["false", "true"], "default": "false", "required": false}
  ]
}',
schema_version = 2
WHERE driver_code = 'mitsubishi_mc';

-- 验证：
-- SELECT driver_code, schema_version, JSON_EXTRACT(config_schema,'$.fields[0].name') FROM plc_driver WHERE driver_code='mitsubishi_mc';
