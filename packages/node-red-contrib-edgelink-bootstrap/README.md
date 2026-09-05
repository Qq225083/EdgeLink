# node-red-contrib-edgelink-bootstrap

EdgeLink **边缘采集接入配置**节点：在面板里填「后端地址 + 预分配密钥」，部署即生效——不用再改 settings.js、不用重启 Node-RED。

## 它做什么

把接入配置写入 Node-RED global context，供 config-manager 流程读取：

| 面板字段 | 写入的 global 键 |
|---|---|
| 后端地址 / 端口 | `edge_backendHost` / `edge_backendPort` |
| 节点标识 | `edge_bootstrapKey` |
| 本机IP：端口 | `edge_hostPcIp` |
| 预分配密钥 | `edge_bootstrapSecret`（credential 存储，不进 flows.json） |

## 安装

```bash
npm install /path/to/node-red-contrib-edgelink-bootstrap
# 重启 Node-RED 后，左侧「配置」类找到「EdgeLink 接入配置」节点
```

## 使用

1. 管理端「边缘节点管理」创建节点，复制一次性密钥；
2. 拖入「EdgeLink 接入配置」节点，填后端地址 + 密钥，部署；
3. 状态灯绿 = 配置已生效，采集流程自行启动。

## 注意

- 只部署一个（重复部署红灯告警，仅首个生效）；
- 空字段不覆盖现有配置（与 settings.js / 环境变量兼容）；
- 密钥泄露请到管理端「重置密钥」并更新本节点。
