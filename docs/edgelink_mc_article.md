# 我在 Node-RED 里造了个三菱 PLC 采集节点，比官方的好用 10 倍

## 起因：被 mcprotocol 折磨了一年

做工业边缘计算这两年，Node-RED 里三菱 PLC 的采集方案基本只有一个选择——`node-red-contrib-mcprotocol`。用过的都知道有多痛苦：

**一个节点只能读一个点位。** 你要读 50 个 D 寄存器？拖 50 个节点，一个一个配。然后 50 个节点各自独立发 TCP 请求，PLC 以太网模块直接被压爆，响应越来越慢，最后 timeout。

**数据类型全靠自己转。** PLC 里 D200 存的是 FLOAT32（占两个寄存器），mcprotocol 读回来是两个 INT16，你得在后面挂一个 function 节点，写一堆 Buffer 操作把两个 16 位拼成 32 位浮点。斜率换算？再挂一个 function。

**出错只会说 timeout。** PLC 返回 0xC052（地址越界）、0xC059（批量超限），mcprotocol 统统给你转成一句 "timeout"。你盯着日志查了半天，最后发现是表里填错了一个地址。

**serialNo 是个摆设。** 4E 帧的 serialNo 字段设计来就是做请求-响应匹配的，mcprotocol 直接写死一个值不变。PLC 响应回来根本不知道是哪个请求的。

我忍了一年，最终决定自己造一个。

## 做了什么

名字就叫 `node-red-contrib-mitsubishi`，npm 直接装。核心思路就一句话：**一个节点干完所有事。**

### 1. 一个节点读 N 个点位

打开节点配置，里面是个表格。需要采集的点位一行一行填进去。

有人会说：mcprotocol 也能填 Quantity 读连续地址啊。确实，读 D100-D199 全 INT16，mcprotocol 填个 Quantity=100 更快。但真实工控场景哪有多少"100 个全 INT16 连续排列不掺杂其他类型"的情况？更多时候是这样的：

- D100（温度，INT16，斜率 0.1） + D200（压力，FLOAT32） + D500（状态，UINT16）——**散点跨地址**
- D300（INT16） + X0（开关 BOOL） + M5（运行状态 BOOL）——**混寄存器类型**

mcprotocol 遇到这些就得拆成好几个节点，还不算 FLOAT32 拼寄存器和斜率换算的 function 节点。

针对连续批量我也没落下——节点里有个**批量生成**栏：

```
起始 [100]  数量 [100]  [D▼]  [INT16▼]  [生成]
```

点一下，100 行自动填好。中间个别特殊的（比如 D150 是 FLOAT32）单独改就行。填完表，一个 inject 触发，所有点位一次性读回来。后台会自动把同类型的寄存器聚类合并——D 寄存器归一组发一条批量读指令，X 归一组发另一条。100 个点不是 100 个 TCP 连接，是两三个。

### 2. 六种数据类型，自动解码

INT16 / UINT16 / INT32 / UINT32 / FLOAT32 / BOOL，表格里下拉选，不用写一行代码。

FLOAT32 占两个寄存器怎么办？节点自动读 D200 和 D201，拼成 32 位，解码成浮点。UINT16 读到负数？自动 +65536。你拿到手的直接就是最终值，不用管 PLC 里存的什么格式。

### 3. 斜率偏移，内置

PLC 温度存 2530，实际是 253.0℃。表格里斜率填 0.1，偏移填 0，输出的 `engValue` 直接就是 253.0。不需要再挂 function 节点。

### 4. 错误诊断，19 个码全部映射

PLC 返回的每一个 MC 错误码都有对应的中文说明：

```
[PLC 0xC051] Device not supported     ← 寄存器类型不支持
[PLC 0xC052] Address out of range     ← 地址越界
[PLC 0xC059] Points out of range      ← 批量点数超限
```

不用再猜 timeout 是什么意思了，看一眼就知道哪行配置填错了。

### 5. 4E 帧 serialNo 完整支持

每发一帧 serialNo 自增 1，响应回来校验 serialNo 是否匹配。不匹配直接丢弃重试。4E 帧的机制终于不是摆设了。

### 6. 零依赖

整个节点只用了 Node.js 自带的 `net` 和 `Buffer` 模块。不依赖任何第三方包。不会出现"pg 版本不兼容"、"mcprotocol 依赖冲突"这种问题。拖进去就能用。

### 7. 模拟模式

在 Node-RED 的 `settings.js` 里加一行：

```javascript
mcSimulationMode: true
```

不连 PLC 也能跑，随机生成仿真数据。出差路上、在家写流程、CI 自动化测试，不用扛一台 PLC。

## 跟 mcprotocol 硬碰硬

| | mcprotocol | mitsubishi（我的） |
|---|---|---|
| 读 50 个点位 | 拖 50 个节点 | **拖 1 个节点，填表** |
| FLOAT32 | 自己写 function 拼接 | **表格选 FLOAT32，自动解码** |
| 原始值→工程值 | 自己写 function 换算 | **填斜率 0.1，自动变换** |
| 出错提示 | "timeout" | **[PLC 0xC052] Address out of range** |
| serialNo | 固定不变 | **每帧自增 + 响应校验** |
| 模拟测试 | ❌ | **✅ 一行配置** |
| 外部依赖 | 有 | **0** |

## 不只是独立节点——EdgeLink 生态

这个 MC 节点不是孤立存在的。它和另一个节点 `node-red-contrib-edgelink-pg` 是一对：

```
[mitsubishi-read] → [edgelink-pg-store] → PostgreSQL/TimescaleDB
    ↑ PLC 数据采集         ↑ 批量写入（带缓冲、重试、断线保护）
```

MC 读节点输出的数据格式，PG 写节点直接认识，零配置入库。`deviceId` 自动做分表、`regType` 自动写 `register_type` 列、`engValue` 直接写 `eng_value` 列。

PG 节点也不是普通的 SQL 执行器——它内置了批量缓冲（100 条一次 INSERT）、失败重试队列、建表死循环保护、PG 假死超时 kill。这俩加起来就是一条完整的 PLC→数据库链路，中间不需要写一行代码。

## 安装

```bash
cd ~/.node-red
npm install node-red-contrib-mitsubishi
```

GitHub：[https://github.com/Qq225083/node-red-contrib-mitsubishi](https://github.com/Qq225083/node-red-contrib-mitsubishi)

## 不支持的

实话实说，当前版本只支持 3E 和 4E 帧。这意味着：

- ✅ Q 系列、L 系列、iQ-R、iQ-F（FX5U）
- ✅ FX3U + 以太网模块（FX3U-ENET）
- ❌ 纯串口的 FX3U（需要 1E 帧）
- ❌ A 系列（需要 1E 帧）

不带以太网模块的老 FX3U 暂时用不了。这是我的下一步计划——1E 帧已经在路上了。

## 总结

造这个节点的初衷很简单：我是一个工业现场工程师，我不想把时间花在写 function 节点、拼 Buffer、猜 timeout 上。我想拖一个节点、填表、部署，然后去喝杯咖啡。

现在可以了。
