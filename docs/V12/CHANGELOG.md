# EdgeLink v12.1 Release Notes (2026-07-04)

## Summary

v12.1 fixes 4 critical bugs discovered in v12.0 production testing. All issues were
root-caused to npm driver node quality gaps — the core architecture (3npm + 4subflow)
is sound but the npm nodes lacked sufficient integration testing.

## Critical Fixes

| Bug | Symptom | Root Cause | Fix |
|-----|---------|------------|-----|
| OOM Crash | Node.js heap 4GB exhausted in ~158s | `mitsubishi-read` busy-wait `setTimeout(self-send)` caused unbounded message clone storm | Lock conflict now drops message (next inject cycle retries naturally) |
| 4E Frame Crash | `_frameSerialNo is not defined` | Variable name mismatch: stored as `_sentSerialNo`, read as `_frameSerialNo` in sf-mc-driver function node | Renamed to `_sentSerialNo` |
| URL Encoding Crash | `ERR_UNESCAPED_CHARACTERS` in heartbeat | `deviceId` with Chinese characters not `encodeURIComponent()`-ed before HTTP request | All URL params now `encodeURIComponent()` |
| Single Device Output | Only 1 device data visible after routing | npm drivers used config node name ("MC-PLC"/"Modbus-??") as deviceId instead of msg.payload.id | deviceId priority: `msg.payload.id > msg.payload.deviceName > config name` |

## npm Package Versions

| Package | Old | New | Changes |
|---------|-----|-----|---------|
| node-red-contrib-mitsubishi | 1.1.0 | **1.2.0** | OOM fix + deviceId fix + lock-skip |
| node-red-contrib-edgelink-modbus | 1.0.1 | **1.1.0** | deviceId fix |
| node-red-contrib-edgelink-pg | 1.0.3 | **1.1.0** | Pool refCount fix + buffer limits + memory guard |

## Flow Changes (edgelink_v12_main_flow.json)

- `sf-mc-fn-driver`: `_frameSerialNo` -> `_sentSerialNo` (4E frame fix)
- `sf-mon-fn-heartbeat`: `encodeURIComponent()` on all URL params
- `sf-pw-fn-enqueue`: MAX_QUEUE 10000 -> 2000 + memory guard
- pg-store instances: bufferMax 5000 -> 1000

## Backend Changes (not version-bumped)

- `settings.js`: globalFunctionTimeout 0 -> 15s
- MQTT consumer removed (merged into APScheduler scanner)
- Monitor DAO returns affected objects for notification publishing
- Database connection pool reduced (sync pool 35 -> 8)

## Deployment

1. Update npm packages: `cd D:\nodered && npm update`
2. Import `edgelink_v12_main_flow.json` into Node-RED
3. Restart with: `node --max-old-space-size=8192 node_modules/node-red/red.js -s data/settings.js`
