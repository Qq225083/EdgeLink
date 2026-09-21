# node-red-contrib-edgelink-site-health

EdgeLink **存量采集点监控**节点包：让领导也能监控老版本采集程序的 Node-RED 是否正常工作。

调色板「存量监控」分类下含两个功能节点（外加一个共享配置节点）：

| 节点 | 类型 | 作用 |
|---|---|---|
| 存量监控服务器 `site-health-server` | 配置节点 | 集中维护后端地址/端口/路径前缀/HTTPS/密钥 Key，两个功能节点共同引用 |
| 采集点健康度 `site-health` | 功能节点 | 定期上报心跳（内存/运行流/版本/时长）+ 增量上报 error 级日志 |
| flows.json 上传 `site-flows-upload` | 功能节点 | 按钮触发，输入原因后把本机 flows.json 传回后端留档（每站点留最近 5 份） |

## 为什么独立成节点

与 V12 采集体系完全解耦：**不依赖 config-manager / MQTT / JWT**，只凭登记时下发的一次性 `key` 上报，零第三方依赖，兼容旧版 Node-RED（>=1.0）。

## 安装

在旧版 Node-RED 的目录里：

```bash
npm install /path/to/node-red-contrib-edgelink-site-health
# 或打包后
npm install node-red-contrib-edgelink-site-health-1.1.0.tgz
```

重启 Node-RED 后，在左侧「存量监控」分类里找到两个功能节点，拖入任意流即可。

## 推荐配置方式：共享配置节点（v1.1.0 起）

1. 拖入任一功能节点，在其「服务器配置」下拉框点「添加新的 site-health-server…」；
2. 在共享配置里填：服务器 IP / 端口 / 接口路径前缀 / HTTPS / 密钥 Key；
3. 两个功能节点都引用这一个配置 —— **重置密钥时只需改共享配置一处**。

`Key` 走 Node-RED credential 机制，存于 `flows_cred.json`，不入 `flows.json`（导出/快照自动脱敏）。

> 兼容说明：1.0.x 部署的「采集点健康度」节点升级后**不选共享配置也能继续工作**（回落到节点自身的服务器/Key 字段），可择机迁移到共享配置。

## 采集点健康度（心跳）

定期上报：

- Node 进程内存（`process.memoryUsage().rss`）
- 整机内存（`os.totalmem()` / `os.freemem()`）
- 运行流数量
- Node-RED 版本、运行时长、监听端口（`uiPort`，区分同 IP 多实例）
- **error 级日志**（v1.1.0+）：旁路监听 Node-RED 日志，只收 error/fatal 级，缓冲 20 条 × 500 字，随心跳增量上报，成功才清除；监控页「最近报错」列可见。**v1.1.1 起同内容错误自动去重计数**（`{ts, msg, count}`），防止坏点位反复抛同一条错灌满缓冲、挤掉其它不同错误

| 字段 | 说明 |
|---|---|
| 服务器配置 | 引用共享配置节点；留空则用下方旧版兼容字段 |
| 心跳频率 | 10–180 秒，默认 30 |
| （兼容字段）服务器 IP / 端口 / 路径前缀 / HTTPS / 密钥 Key | 未选共享配置时生效 |

### 状态灯

- 🟢 绿：上报正常
- 🟡 黄：连接失败 / 服务端异常，指数退避重试中（封顶 5 分钟）
- 🔴 红：Key 无效或未配置，已停止
- 🟡 黄（补充）：上报 IP/端口与登记不符 → 低频重探（300s），服务端改回登记后自动恢复

## flows.json 上传

- 点击节点按钮 → 输入**上传原因**（必填，记录到后端）→ 上传本机 flows.json；
- 文件路径默认自动推断（`settings.flowsFile` → `userDir/flows.json`），现场路径特殊时可在节点里手填；
- 后端校验与心跳一致（Key + IP/端口绑定），另加 **10MB 上限**、**SHA-256 完整性校验**、**每 key 每小时 5 次限流**；
- 后端每站点只保留最近 **5 份**，监控页「上传记录」可查看时间/原因/SHA-256 并下载。

## 后端接口

- 心跳：`POST {前缀}/site-health/report?interval=...&memory_rss_mb=...`（指标走 query；error 日志走 JSON body `{"errors":[{ts,msg}]}`，旧节点不带 body 照常工作）
- 上传：`POST {前缀}/site-health/flows/upload`（JSON body：`{reason, content, sha256, node_port}`）

`key` 均通过请求头 `Authorization: Bearer <key>` 传递（不落 URL，避免进入访问日志）。无 JWT，采用「IP 粗防泛洪 + key 精确限流」双层限流，同一 IP 部署多个 Node-RED 实例互不影响。**Key 与登记情报绑定：上报来源 IP 必须等于登记的办公网 IP（或工业网 IP），端口必须等于登记端口，否则拒绝**——A 采集点的 Key 装到 B 机器上会红灯停止，防止数据串台。离线判定：`3 × 心跳间隔` 内未上报即判离线。
