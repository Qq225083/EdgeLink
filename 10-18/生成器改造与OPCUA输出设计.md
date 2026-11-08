# 生成器改造方向与 OPC UA 输出设计（10-18）

## 一、结论

- **值得做**：现有 MC/Modbus → 块读装配 → 契约报文的管线可以原样保留，在契约装配后新增 OPC UA Server 输出端。
- **不是把 link out 改成 OPC UA**：link out 继续留给定制逻辑；OPC UA 是另一种输出形态（客户端主动读/订阅）。
- **建议先做只读版**：只暴露当前值、质量码、时间戳，不做写入，不做复杂事件。

## 二、生成器最值得改的点（按优先级）

1. **输出插件化**：MQTT / PG / link out / OPC UA 共用同一份契约装配，不为 OPC UA 复制一套装配逻辑。生成器按 `enable_opcua` 决定是否生成对应支路。
2. **统一数据映射层**：把 `register_type + data_type` → 输出类型集中管理，OPC UA 直接复用，避免各输出各写一套。
3. **质量码语义统一**：GOOD/BAD/UNCERTAIN → OPC UA StatusCode（Good/Bad/Uncertain）。断线空值必须是 `Null + Bad`，不能写成 0。
4. **通信状态修正**：`comm_expr` 目前只数 BAD，不数 UNCERTAIN，超时可能显示在线，建议一并修掉。
5. **生成期验证继续加强**：真实节点包字段校验、包版本留痕、黄金快照，别引入"能生成但运行不起来"的新输出。
6. **配置参数化**：`enable_opcua / opcua_port / namespace / 是否允许写` 进生成弹窗，不硬编码在生成器里。

## 三、OPC UA 数据模型（只读版）

### 地址空间（建议）
```
ns=2;s=EdgeLink.Node{node_id}.Device{device_id}.Tag{tag_id}
例：ns=2;s=EdgeLink.Node66.Device49.Tag92
```
- 每设备一个对象节点，点位为其下变量节点；
- NodeId 用确定性 id，设备/点位删除重建不漂移。

### 字段映射
| 当前契约字段 | OPC UA |
|---|---|
| eng_value（优先）/ raw_value | Value |
| INT16/UINT16 | Int16/UInt16 |
| INT32/UINT32 | Int32/UInt32 |
| FLOAT/DOUBLE | Float/Double |
| BIT/BOOL | Boolean |
| quality=GOOD/BAD/UNCERTAIN | StatusCode=Good/Bad/Uncertain |
| ts | SourceTimestamp（没有则用服务端当前时间） |
| tag_name/tag_address | DisplayName / Description |
| unit | EngineeringUnit（可选） |

### 服务地址
`opc.tcp://<边缘IP>:4840/edgelink`

## 四、实现路径（建议阶段）

### M1：只读原型
- 边缘新增 OPC UA Server 节点（包名与版本需先核实，不凭印象写死）；
- 每轮更新变量值，不重建地址空间；
- 用 UaExpert 验证能连接、能读到 2-3 个点位、断线时质量码变 Bad。

### M2：生成器输出
- 按设备/点位自动生成地址空间和变量；
- 增加生成期校验、冒烟断言、黄金快照；
- 验收：改点位后重新部署，客户端能读到新点位，旧点位消失。

### M3：生产增强
- 订阅性能压测（亚秒周期下不能频繁创建/销毁对象）；
- 断线/重连行为与质量码一致性；
- 访问控制（内网 ACL 或账号/证书）；
- 只读保持默认，写入另开需求评审。

## 五、必须提前防的坑

1. **不要每轮重建地址空间**：否则内存和连接都会抖，亚秒采集时必炸。
2. **不要用 0 代替空值**：BAD 要保留 Null+Bad，否则下游会当成真实 0。
3. **包版本先验证**：OPC UA 节点包的 server API、地址空间写法、性能都要真机验证，不能只按文档生成。
4. **不要默认无认证暴露到办公网**：只读原型可以内网开放，生产需要 ACL 或账号/证书。
5. **不要默认开放写入**：写回 PLC 需要另外一套地址/类型/权限设计。

## 六、预估工作量

- 只读原型：1-2 天（含 UaExpert 验证）；
- 生成器自动输出：2-3 天（含测试）；
- 生产加固：另评，重点在性能与安全。
