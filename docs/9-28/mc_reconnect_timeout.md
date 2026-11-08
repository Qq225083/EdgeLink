# MC 重连与超时契约（生成器版）

记录日期：2026-10-24  
适用范围：`module_flowgen` 生成的 MC 采集支路，目标包为 `node-red-contrib-mcprotocol@1.2.1`。

## 1. 重连指令

`read.js` 的输入分支只识别：

- `topic = "disconnect"` 或 `disconnect = true`：关闭连接；
- `topic = "connect"` 或 `connect = true`：调用连接池 `connect()`。

`reinitialize` 不被 `read.js` 识别，旧支路发 `topic=reinitialize` 会被当成普通读取消息，不是有效重连指令。

生成器现在为每台 MC 设备生成：

```text
inject(30s) → change{topic:"connect"} → 首个 MC Read
```

该心跳是幂等兜底：已连接时不会改变正常采集；未连接时触发连接池重新建 TCP。不要通过修改 MC 节点包实现重连。

## 2. 包不会自动恢复物理断线

`connection_pool.js` 的 `autoConnect` 判断存在字符串比较问题，未显式传正确选项时不能依赖包自动重连。生成器侧必须保留 30 秒 `connect` 心跳。

离线 TCP mock 验证过的三类恢复场景：

- 先 Node-RED 后 PLC 上线；
- 先 PLC 后 Node-RED 启动；
- 运行中重启 PLC / 拔插网线。

真机 72 小时浸泡仍属于 Day 13/15 验收项，不能用离线 mock 替代。

## 3. 超时与错误输出

MC Read 使用 `errorHandling = "output2"`：

- 读取成功走输出 1；
- 超时、连接错误、协议错误走输出 2；
- 不是“超时走输出 1”。

生成流中输出 2 进入块级 BAD 装配和告警限速；输出 1 进入正常块内装配。成功路如果返回空对象或缺少 key，不直接判离线，按数据质量语义进入 `UNCERTAIN` 计数。
