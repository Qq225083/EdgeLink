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

**方式一：首启引导页（推荐，现场运维用）**

Node-RED 启动后浏览器打开（或自动弹出）`http://<本机>:1880/edgelink/guide`：

- 已激活：显示绑定采集点与采集就绪状态；
- 未激活：填「后端地址 + 端口 + 密钥 + 本机IP」→ 校验并绑定——页面后端调 `/plc/config/bootstrap/auto` 做密钥 + IP:端口 双绑定校验；
- 校验通过：写入 global context（运行中的 config-manager 下个周期即生效）并落盘 `userDir/edgelink-bootstrap.json`（0600，重启后由本节点回读生效）；
- 校验失败只影响采集就绪状态，**不阻断 Node-RED 运行**，修正后重新提交即可。

**方式二：节点面板（传统）**

1. 管理端「边缘节点管理」创建节点，复制一次性密钥；
2. 拖入「EdgeLink 接入配置」节点，填后端地址 + 密钥，部署；
3. 状态灯绿 = 配置已生效，采集流程自行启动。

## 注意

- 取值优先级：**节点面板 > 引导页落盘文件 > settings.js / 环境变量**（空字段不覆盖，老机器兼容）；
- 只部署一个（重复部署红灯告警，仅首个生效）；
- 密钥泄露请到管理端「重置密钥」，再到引导页重新绑定或更新本节点；
- 引导页走 httpAdmin（无 adminAuth 时无登录保护），仅限内网使用。
