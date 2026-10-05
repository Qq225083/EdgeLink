# EdgeLink V13 工作区

> V13 = V12 采集系统的结构重构（行为不变）。方案见 `docs/v13_refactor_plan.md`。
> 本目录是 V13 所有改动的唯一工作区；现网 function 的原始副本在 `ruoyi-fastapi-frontend/tmp_v13_analysis/`（对拍基准）。

## 目录

```
v13/
  lib/                 核心 lib（壳层 function 通过 global.get('edgeCore') 使用）
  shells/              4 个 V13 壳的可读源码（flows.json 里的是转义字符串，改这里）
  flows/flows.json            当前线上完整 flow 的 V13 快照（node tools/export_flows.js 同步）
  flows/edgelink_v13.flow.json  自包含可导入的 V13 系统 flow（node tools/export_v13_flow.js 生成）
  tools/               patch_sf_*.js（壳写回 flows.json）+ export_flows.js
  test/                node:test 单测（零依赖，Node ≥18 内置 runner）
  settings-snippet.js  settings.js 接入片段 + 壳层约定
```

## 运行测试

```bash
cd v13 && node --test test/
```

## 壳层三行约定（每个改造后的 function 开头）

```javascript
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, msg) { node.warn('[' + scope + '] ' + msg); });
```

## 纪律（与 v13_refactor_plan.md §二一致）

- lib 永不碰 `node`：send 槽位 / status / warn 由壳层显式处理；
- stateStore 底层键名保持 `edge_*` 原样，与未重构的小 function 兼容；
- httpClient 不引入重试、不改 timeout 值、不动 header/body 序列化（逐字节等价）；
- kill switch 缓存读写保持同步 fs（事件循环内天然串行，禁止改 async）。

## 进度

- [x] STEP 1：httpClient / logger / stateStore + 单测
- [x] STEP 1 收尾：④ 心跳壳（252→222 行）+ 5 分支壳测试 + 线上替换
- [x] STEP 2：transform / reportFilter / calcTags / commState + ② 数据管道壳（403→316 行）+ 8 分支壳测试
- [x] STEP 3a：configCache（kill switch 唯一入口，同步 fs）+ ④ 壳收口
- [ ] STEP 3b（可选）：心跳 async 化（高风险，独立任务，不并入主线）
- [x] STEP 4：netUtils / bootstrap + ③ IP检测登录壳（327→174 行）+ 6 分支壳测试
- [x] STEP 5：tagConfig（MC 地址解析 21 条表驱动矩阵）/ retryPolicy + ① 壳（535→301 行）+ 5 分支壳测试
- [x] **画布级拆分**：三个子流程全部拆成节点流水线（数据管道 9 节点 / sf-monitor 6 节点 / sf-config-manager 7 节点 + 保留 http 登录节点），节点级 status 定位卡点；链路集成测试 12 条
- [ ] 真机对拍：启用主 tab，按 golden 语料覆盖清单验证（等用户启用）

**测试总量：104 用例全绿**（`cd v13 && node --test test/`）

### 画布拆分后的结构

```
sf-data-processor:  ①入口·防重入 → success? → 失败[②通断状态→③告警+BAD] / 成功[④恢复→⑤变换过滤→⑥计算点→⑦合并→⑧组装]
sf-monitor:         ①取态 → ②MQTT心跳 / ③HTTP心跳(kill switch) → ④逐台在线 → ⑤comm消费 → ⑥PG统计（401 → reauth 直发，周期去重）
sf-config-manager:  ①锁+IP → ②复查/bootstrap → POST /login → ③JWT+缓存 → ④nodeId反查 → ⑤分页拉取 → ⑥分组输出；失败 → ⑦登录重试（自循环）
```

### 现网记录在案、未顺手修的怪癖（重构纪律：只记录不修改）
1. 心跳超时路径原版双重执行收尾（timeout+error 双触发），V13 httpClient 单次结算语义下自然修复——唯一有意行为差异；
2. `edge_retryState.attempt` 只增不减（成功登录不重置），运行一段时间后登录重试恒走 120s 熔断分支；
3. protocolParams 合并是单 try 包裹：设备级 JSON 损坏会连累点位级不合并；
4. FX 系列 X/Y 地址含字母时被剥除字母按八进制解析（如 `X1F`→1）。
