# node-red-contrib-edgelink-site-health

EdgeLink **存量采集点健康度监视**节点：让领导也能监控老版本采集程序的 Node-RED 是否正常工作。

定期采集本机 Node-RED 的运行信息，经 HTTP 直连上报到后端「存量采集点监控」：

- Node 进程内存（`process.memoryUsage().rss`）
- 整机内存（`os.totalmem()` / `os.freemem()`）
- 运行流数量
- Node-RED 版本
- 运行时长

## 为什么独立成节点

与 V12 采集体系完全解耦：**不依赖 config-manager / MQTT / JWT**，只凭登记时下发的一次性 `key` 上报，零第三方依赖，兼容旧版 Node-RED（>=1.0）。

## 安装

在旧版 Node-RED 的目录里：

```bash
npm install /path/to/node-red-contrib-edgelink-site-health
# 或打包后
npm install node-red-contrib-edgelink-site-health-1.0.4.tgz
```

重启 Node-RED 后，在左侧「功能」类里找到「采集点健康度」节点，拖入任意流即可。

## 配置

| 字段 | 说明 |
|---|---|
| 名称 | 节点显示名（默认「采集点健康度」） |
| 服务器 IP | EdgeLink 后端地址（或反向代理地址） |
| 端口 | 后端端口（默认 80） |
| 接口路径前缀 | 系统在子目录/反代下填前缀（如 `/prod-api`），直连后端留空 |
| 心跳频率 | 10–180 秒，默认 30 |
| 使用 HTTPS | 后端启用 TLS 时勾选。**仅支持受信任 CA 签发的证书**；自签名证书会握手失败（节点一直黄灯退避），此时请改用 HTTP 直连，或在系统层信任该证书 |
| 密钥 Key | 管理端「存量采集点监控 → 采集点登记」生成，仅显示一次 |

`Key` 走 Node-RED credential 机制，存于 `flows_cred.json`，不入 `flows.json`（导出/快照自动脱敏）。

## 状态灯

- 🟢 绿：上报正常
- 🟡 黄：连接失败 / 服务端异常，指数退避重试中（封顶 5 分钟）
- 🔴 红：Key 无效或未配置，已停止
- 🟡 黄（补充）：上报 IP/端口与登记不符 → 低频重探（300s），服务端改回登记后自动恢复

## 后端接口

`POST {路径前缀}/site-health/report?interval=...&memory_rss_mb=...&memory_total_mb=...&memory_free_mb=...&running_flows=...&node_red_version=...&uptime_sec=...&node_port=...`

`key` 通过请求头 `Authorization: Bearer <key>` 传递（不落 URL，避免进入访问日志；query 参数仍保留兼容）。无 JWT，采用「IP 粗防泛洪 + key 精确限流」双层限流，同一 IP 部署多个 Node-RED 实例互不影响。**Key 与登记情报绑定：上报来源 IP 必须等于登记的办公网 IP（或工业网 IP），否则返回 `ip_mismatch` 拒绝**——A 采集点的 Key 装到 B 机器上会红灯停止，防止数据串台。节点会自动上报 `node_port`（`uiPort`），用于在监控页区分同 IP 多实例。离线判定：`3 × 心跳间隔` 内未上报即判离线。
