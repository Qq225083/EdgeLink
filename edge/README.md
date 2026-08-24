# edge/ — 边缘侧 Node-RED 快照

本目录是采集层边缘 Node-RED 运行目录（现役 `D:\nodered`）的**干净快照**：只保留可复现的配置，凭据 / 二进制 / 依赖 / 缓存 / 日志 / 旧备份已剔除。

## 目录说明

| 路径 | 说明 |
|---|---|
| `nodered/data/flows.json` | 权威流副本（与 `docs/V12/edgelink_v12_main_flow.json` 一致，改流以 docs/V12 为准） |
| `nodered/data/settings.js` | 边缘 settings，凭据走环境变量 `EDGE_*`，无明文 |
| `nodered/start-nodered.ps1` / `start-nodered-log.ps1` / `start.bat` | 启动脚本（装载用户环境变量后启动 Node-RED） |
| `nodered/check_procs.ps1` | 进程排查脚本 |
| `nodered/package.json` | 依赖清单（含 `file:` 本地路径引用，跨机器需按实际调整；驱动包源码见 `packages/`） |
| `nodered/CHANGELOG.md` / `LICENSE` / `README.md` | Node-RED 自带文件（非 EdgeLink 内容） |

## 不在此目录的内容（安全红线）

| 类别 | 文件 | 原因 |
|---|---|---|
| 凭据 | `flows_cred.json` + `.config.runtime.json` | 凭据密文 + `_credentialSecret` 解密密钥，拿到即泄密 |
| 编辑器状态 | `.config.users.json` / `.config.nodes.json` | 运行时用户态 |
| 配置缓存 | `edge_config_cache.json` | 运行时配置快照（含设备 IP/点位） |
| 二进制 | `node.exe` / `node_v*.exe` | 190M，git 不管二进制 |
| 依赖 | `node_modules/` / `npm_cache/` | 由 `package.json` 声明，装一次即回 |
| 运行时数据 | `data/edgelink_pg_spool/` / `logs/` | 时序缓冲 / 日志 |
| 旧快照 | `*.bak-*` / `*.backup` / `*_backup_*` | 冗余；旧版 settings/flow 曾硬编码明文凭据，已剔除 |

## 重建边缘

完整步骤见 [docs/部署手册.md](../docs/部署手册.md) 第四节。核心流程：

1. 装 Node.js 18+ 与 Node-RED，安装三个驱动包（源码见 `packages/`）
2. 拷贝 `data/flows.json` 与 `data/settings.js` 到边缘 `data/`（`flowFile` 用绝对路径）
3. 配置边缘环境变量（`setx` 写入**用户环境变量**，不入仓）：
   `EDGE_API_KEY` / `EDGE_BACKEND_USER` / `EDGE_BACKEND_PASS` / `EDGE_BOOTSTRAP_SECRET` / `EDGE_PG_PASSWORD` / `EDGE_MQTT_USERNAME` / `EDGE_MQTT_PASSWORD`
4. 用 `start-nodered.ps1` 启动，按部署手册走按压配对自注册

> 凭据一律不落盘到仓库；缺失时 `settings.js` 启动会打印告警，`start-nodered.ps1` 也会逐项提示。
