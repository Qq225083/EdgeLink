<h1 align="center">EdgeLink</h1>
<h4 align="center">PLC 数据采集与清洗系统 · 工业边缘数据采集平台</h4>
<p align="center">
  <img alt="python version" src="https://img.shields.io/badge/python-3.11-blue">
  <img alt="node version" src="https://img.shields.io/badge/node-%E2%89%A518-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

EdgeLink 是一套面向工业现场的 **PLC 数据采集与清洗系统**：在 Web 端配置设备与采集点位，经「保存≠发布」的版本闸门下发给边缘 Node-RED，由边缘侧完成多协议采集，数据经断库缓冲、清洗计算后写入 PostgreSQL 时序库，并通过 MQTT 秒级推送与监控告警。

基于 [RuoYi-Vue-FastAPI](https://github.com/insistence/RuoYi-Vue-FastAPI)（MIT）二次开发，保留其权限、菜单、部门、日志等后台基建，在其上构建了完整的 PLC 采集业务层。

## 数据链路

```
Web 配置（Vue2 + Element UI）
  → 后端（FastAPI，9099）
  → 发布即版本（plc_config_snapshot 快照，保存≠生效）
  → Node-RED 边缘采集（1880；MC/Modbus/S7，30s 轮询兜底 + MQTT 秒级加速）
  → PostgreSQL 时序存储（edgelink.plc_data，断库时磁盘 spool 存储转发）
  → MQTT（EMQX 1883）实时推送 + 监控告警
控制面：kill switch（节点级停用，MQTT 秒级 + 心跳轮询兜底）
```

## 核心特性

- **保存≠发布**：Web 端保存配置只写入草稿，必须到「发布中心」发布才会生成快照下发边缘；发布中心只列出与最新快照有差异的设备，发布后以「边缘已应用版本」卡片确认收敛，杜绝误操作实时影响采集层。
- **协议可插拔**：后端配置驱动，前端协议表单由驱动 Schema 自动渲染；新增协议 = 新增驱动包 + Schema 配置，业务骨架不动。
- **断库存储转发（spool）**：时序库中断时数据先落内存重试缓冲，超阈值写磁盘 `data\edgelink_pg_spool\`，恢复后自动重放；写入采用 `ON CONFLICT DO NOTHING` 幂等去重。
- **秒级 MQTT**：配置下发与停用走 MQTT 秒级通道，30s 心跳轮询兜底，双通道确保边缘最终收敛。
- **计算点位**：同设备点位间 和/平均/最大/最小 等派生计算，变更判定独立跟踪，删除/停用有引用守卫。
- **监控告警**：NODE_OFFLINE / PLC_OFFLINE 等告警，通知通道依赖 EMQX。
- **运行时体检**：`runtime_healthcheck.py`（22 项）+ `api_smoke.py`（60 项）验收脚本，部署后按序全绿才算完成。

## 协议驱动

四个自研 Node-RED 驱动包，位于 `packages/`：

| 驱动 | 协议 | 说明 |
|---|---|---|
| `node-red-contrib-mitsubishi` | 三菱 MC | 支持 3E/4E 帧与 ASCII 方言，TCP/UDP + binary/ascii_q/ascii_slmp |
| `node-red-contrib-edgelink-modbus` | Modbus | RTU/TCP，6 种字节序、wordOrder、bitOffset 位提取、INT/FLOAT/DOUBLE |
| `node-red-contrib-edgelink-s7` | 西门子 S7 | 纯 Python S7 模拟器联调验收 |
| `node-red-contrib-edgelink-pg` | PostgreSQL | 时序写入 + 断库 spool 存储转发 |

## 目录结构

```
EdgeLink
├── ruoyi-fastapi-backend/   后端（FastAPI + SQLAlchemy 2.0 async + Pydantic v2）
├── ruoyi-fastapi-frontend/  前端（Vue2 + Element UI）
├── packages/                4 个 Node-RED 驱动包
│   ├── node-red-contrib-mitsubishi
│   ├── node-red-contrib-edgelink-modbus
│   ├── node-red-contrib-edgelink-s7
│   └── node-red-contrib-edgelink-pg
├── docs/                    规格 / 迁移 SQL / 权威流 / 部署手册
├── tools/                   体检与验收脚本（runtime_healthcheck / api_smoke / mqtt_probe 等）
├── docker-compose.my.yml    MySQL 版编排（后续 Docker 化用）
├── docker-compose.pg.yml    PostgreSQL 版编排
└── LICENSE                  MIT
```

## 快速开始

完整部署（裸机 / Windows）见 [docs/部署手册.md](docs/部署手册.md)，要点：

- **环境**：Python 3.11、Node.js 18+、PostgreSQL 14+、MySQL 8、EMQX 5.x、Redis 5+
- **后端**：`python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt`，配置 `.env.dev` 后 `python app.py --env=dev`
- **前端**：`npm ci && npm run build:prod`，nginx 托管 `dist/`，`/prod-api` 反代到 9099
- **初始化**：`init_plc_db.py`（MySQL 业务表 + 驱动种子）、`init_pg_db.py`（PG 时序库）、按日期顺序执行 `docs/migration_*.sql`
- **边缘**：装 Node-RED + 三个驱动包，部署权威流 `docs/V12/edgelink_v12_main_flow.json`，配置边缘环境变量后按压配对自注册

## 测试与验收

```bash
python tools/runtime_healthcheck.py   # 22 项运行时体检
python tools/api_smoke.py             # 60 项 API 验收
# 各驱动包目录下：
cd packages/node-red-contrib-mitsubishi && npm test     # MC 122
cd packages/node-red-contrib-edgelink-modbus && npm test # Modbus 56
cd packages/node-red-contrib-edgelink-pg && npm test      # pg 9
```

## 许可证

本项目基于 [RuoYi-Vue-FastAPI](https://github.com/insistence/RuoYi-Vue-FastAPI) 二次开发，沿用其 [MIT 许可证](LICENSE)。
