# EdgeLink 10 天修复计划与测试流手顺（总清单对应版）

> 目标：在 10 天内将 `edgelink待整改清单.md` 中的问题按优先级修复并验证。  
> 优先级策略：**先保证功能模块完整性（数据类型、协议参数、配置发布、状态一致性），再补齐安全基线，最后做工程化优化。**  
> 所有编号均对应总清单 `edgelink待整改清单.md` 的连续序号。

---

## 计划概览

| 天数 | 主题 | 主要整改项（总清单编号） | 验收目标 |
|:---:|:---|:---|:---|
| 第 1 天 | 后端点位数据模型 + 动态驱动基础 | #7、#8、#61、#72、#73、#74、#75、#78 | 后端支持新数据类型/协议参数，`plc_driver` 元数据表可用，驱动 schema API 可调用，配置下发含 `driverCode`/`driverConfig` |
| 第 2 天 | 前端点位表单 + 动态驱动表单动态渲染 | #7、#8、#37、#51、#53、#76、#77 | 前端表单可配置新数据类型/协议参数，设备表单按驱动 schema 动态渲染，点位表单按驱动能力过滤寄存器/数据类型 |
| 第 3 天 | 配置发布中心完善 | #6、#70、#71、#17 | 发布中心页面可用，发布按钮权限清晰，MQTT 刷新按节点过滤 |
| 第 4 天 | Node-RED 配置解析适配 + 动态驱动分发 | #7、#16、#30、#38、#79 | 边缘侧正确消费协议参数，按 `driverCode` 分发到对应驱动节点，失败不重载空配置 |
| 第 5 天 | 设备/点位状态一致性 | #9、#10、#18、#19、#20 | 停用/软删除后边缘停止采集，监控状态同步 |
| 第 6 天 | MQTT 与 API 安全基线 | #3、#5、#25、#29 | 清除明文/默认 MQTT 凭据，前后端均从环境变量读取 |
| 第 7 天 | JWT 与 Monitor API Key + 驱动节点兼容性改造 + Bootstrap 配置下发 | #1、#2、#23、#24、#26、#7、#8、#79、#92 | JWT 无硬编码，.env.prod 完整；Modbus/三菱节点支持新字段；Node-RED 首次启动可从后端拉取完整配置 |
| 第 8 天 | 监控服务与告警一致性 | #11、#12、#13、#32、#35、#68 | GET 接口只读、离线判定统一、告警不重复、告警信息完整 |
| 第 9 天 | 数据库与 SQL 修复 | #20、#21、#22、#56、#57、#58、#59 | 外键级联、质量码一致、TimescaleDB hypertable 启用、索引合理 |
| 第 10 天 | 集成测试与回归 | #1~#8 全部 P0，#9~#14、#16~#22 等重点 P1 | 端到端功能完整，可进入预投产状态 |
| 第 11 天 | 驱动管理页面（产品化增强） | #72、#73、#74 配套扩展 | 支持 Web 端维护 `plc_driver` / `plc_protocol_compat`，新增 PLC 不再需要直接操作数据库 |
| 第 12 天 | 发布履历与修改履历页面（产品化增强） | #90、#91 | 发布履历可追溯每次配置下发；修改履历可审计设备/点位变更历史 |

---

## 第 1 天：后端点位数据模型 + 动态驱动基础字段

> 状态：2026-07-19 代码已完成，已做语法检查与 App 路由验证，等待数据库部署后接口验证。

### 目标
补齐后端对 `UINT16/UINT32/BOOL/DOUBLE` 数据类型和 `byte_order`/`word_order`/`bit_offset` 协议参数的完整链路；同时为 Node-RED 动态驱动架构打好后端基础，新增 `driver_code` 字段、驱动元数据表、`plc_protocol_compat` 关联、驱动 schema API，以及配置下发 payload。

### 涉及整改项
- #8（数据类型不支持）
- #7（协议参数后端链路）
- #61（`TagBatchUpdateModel` 缺少协议字段）
- #72（设备表缺少 `driver_code`）
- #73（缺少 `plc_driver` 驱动元数据表）
- #74（`plc_protocol_compat` 缺少 `driver_code` 关联）
- #75（后端缺少驱动 schema API）
- #78（配置下发 payload 未包含 `driverCode`/`driverConfig`）

### 代码改动范围
1. **点位数据类型与协议参数**
   - `ruoyi-fastapi-backend/module_plc/entity/do/tag_do.py`：扩展 `data_type` 注释
   - `ruoyi-fastapi-backend/module_plc/entity/vo/tag_vo.py`：扩展 `TagModel` / `TagBatchUpdateModel`
   - `ruoyi-fastapi-backend/module_plc/service/tag_service.py`：扩展 `VALID_DATA_TYPES`、导入/导出模板、批量更新
   - `ruoyi-fastapi-backend/module_plc/dao/tag_dao.py`：确认 `_GLOBAL_TAG_COLUMNS` 包含协议参数
2. **动态驱动基础字段**
   - `ruoyi-fastapi-backend/module_plc/entity/do/device_do.py`：新增 `driver_code` 字段
   - `ruoyi-fastapi-backend/module_plc/entity/vo/device_vo.py`：新增 `driver_code` 字段
   - 新建 `docs/plc_driver.sql`：创建 `plc_driver` 表
   - `docs/plc_protocol_compat.sql`：增加 `driver_code` 字段并初始化映射
   - `ruoyi-fastapi-backend/module_plc/entity/do/protocol_compat_do.py`：新增 `driver_code` 字段
3. **动态驱动 API**
   - 新建 `module_plc/controller/driver_controller.py`：提供 `/plc/driver/list`、`<driver_code>/schema`
   - 新建 `module_plc/service/driver_service.py`：查询驱动元数据
4. **配置下发**
   - `module_plc/service/config_publish_service.py`：在设备配置 payload 中增加 `driverCode` 和 `driverConfig`

### 开发步骤
1. 在 `tag_do.py` / `tag_vo.py` / `tag_service.py` 中完成数据类型和协议参数扩展。
2. 在 `device_do.py` / `device_vo.py` 中新增 `driver_code` 字段。
3. 创建 `plc_driver` 表，初始化 `mitsubishi_mc` / `modbus_tcp` 两条元数据（含 config_schema、register_types、data_types）。
4. 给 `plc_protocol_compat` 增加 `driver_code`，并更新数据：
   - Mitsubishi Q/L/FX/iQ-R + MC_Protocol → `mitsubishi_mc`
   - Mitsubishi Q/L/FX + Modbus_TCP → `modbus_tcp`
   - Mitsubishi Q + GOT → `mitsubishi_mc`（GOT 透传本质是 MC）
   - Mitsubishi Q/FX + PLC_RS232C → `mitsubishi_mc_serial`（新增驱动）或 `mitsubishi_mc`
   - Siemens S7 系列 + Modbus_TCP → `modbus_tcp`
   - Omron/Keyence + Modbus_TCP → `modbus_tcp`
5. 实现 `driver_controller.py` 返回驱动列表和 schema。
6. 在 `config_publish_service.py` 的设备配置 payload 中拼接 `driverCode` + `driverConfig`。

### 测试流手顺

#### 1.1 单测：数据类型枚举
```bash
cd ruoyi-fastapi-backend
python -c "from module_plc.entity.vo.tag_vo import TagModel, TagBatchUpdateModel; print('VO import OK')"
```
- 构造 `data_type='UINT16'`/`'UINT32'`/`'BOOL'`/`'DOUBLE'` 的 VO 实例，均应通过校验。
- 构造 `data_type='STRING'` 应失败。

#### 1.2 接口测试：新增点位
```bash
curl -X POST http://localhost:9099/plc/tag \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": 1,
    "tagName": "UINT16_TEST",
    "registerType": "HR",
    "registerAddress": 100,
    "dataType": "UINT16",
    "byteOrder": "BIG_ENDIAN",
    "wordOrder": "BIG_ENDIAN",
    "bitOffset": 0
  }'
```
- 期望：返回 `code=200`，数据库 `plc_tag` 记录正确。

#### 1.3 批量更新协议参数
```bash
curl -X PUT http://localhost:9099/plc/tag/batch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": [1, 2],
    "byteOrder": "LITTLE_ENDIAN",
    "wordOrder": "BIG_ENDIAN"
  }'
```
- 期望：批量更新成功，数据库对应字段被修改。

#### 1.4 驱动 schema API 测试
```bash
# 列出所有驱动
curl -X GET http://localhost:9099/plc/driver/list \
  -H "Authorization: Bearer $TOKEN"

# 获取指定驱动 schema
curl -X GET http://localhost:9099/plc/driver/modbus_tcp/schema \
  -H "Authorization: Bearer $TOKEN"
```
- 期望：返回 `code=200`，包含 `config_schema`、`register_types`、`data_types` 等字段。

#### 1.5 配置下发 payload 验证
1. 新增/编辑一台设备，保存后发布配置。
2. 在 Node-RED 调试面板或 MQTT 抓包中检查下发 payload。
3. 确认 payload 包含 `driverCode`（如 `modbus_tcp`）和 `driverConfig`（如 `unit_id`）。

#### 1.6 回归：已有数据类型
- 对 `INT16/INT32/FLOAT/BIT` 点位执行新增/编辑/查询，确保不破坏。

---

## 第 2 天：前端点位表单 + 动态驱动表单动态渲染

### 目标
在前端设备/点位管理页面中增加数据类型选项和协议参数字段；同时根据 Day 1 新增的驱动 schema API，把设备表单中的协议参数、点位表单中的寄存器类型和数据类型改为动态渲染，避免硬编码。

### 涉及整改项
- #7（前端缺少协议参数）
- #8（前端数据类型选项缺失）
- #37（全局点位页寄存器筛选值域不一致）
- #51（导入点位未做文件校验）
- #53（编辑点位 API 失败无反馈）
- #76（前端设备表单未按驱动 schema 动态渲染协议参数）
- #77（前端点位表单未按驱动能力过滤寄存器类型和数据类型）

### 代码改动范围
1. `ruoyi-fastapi-frontend/src/views/plc/device/index.vue`
   - 在点位新增/编辑弹窗中增加 `byteOrder`、`wordOrder`、`bitOffset` 表单项
   - 扩展 `dataType` 下拉选项
   - 编辑弹窗的 `getTag` 增加 `.catch` 错误提示
   - 在设备表单中把 `mcFrame`/`stationNo`/`networkNo` 替换为根据驱动 schema 动态渲染的组件
   - 根据品牌/系列/通信方式查询 `driver_code`，再调用 `/plc/driver/{driver_code}/schema`
2. `ruoyi-fastapi-frontend/src/views/plc/tag/index.vue`
   - 对齐寄存器类型筛选值域与后端枚举
3. `ruoyi-fastapi-frontend/src/api/plc/device.js`
   - 新增或确认 `getDriverSchema(driverCode)` 调用
4. `ruoyi-fastapi-frontend/src/api/plc/tag.js`
   - 确认参数透传无误
5. 导入/导出模板同步字段

### 测试流手顺

#### 2.1 本地启动前端
```bash
cd ruoyi-fastapi-frontend
npm run dev
```

#### 2.2 手动测试点位表单
1. 进入“设备管理” → 选择某设备 → “新增点位”。
2. 观察表单中是否出现：数据类型 `UINT16`、`UINT32`、`BOOL`、`DOUBLE`；以及 `byteOrder`、`wordOrder`、`bitOffset`。
3. 选择 `UINT16`，填写 `byteOrder=BIG_ENDIAN`，保存。
4. 打开浏览器 DevTools → Network，确认请求体中字段名为 `byteOrder`/`wordOrder`/`bitOffset`（若后端需要 snake_case，需确认转换层）。
5. 编辑刚创建的点位，查看表单回显正确。
6. 模拟后端 `getTag` 接口失败（如关闭后端），点击编辑，确认有错误提示。

#### 2.3 动态驱动设备表单测试
1. 新增设备，选择 `Mitsubishi` → `Q` → `MC_Protocol`。
2. 确认出现：帧格式（3E/4E）、站号、网络号输入框。
3. 切换到 `Modbus_TCP` 通信方式，确认出现：Unit ID 输入框，帧格式/站号/网络号隐藏。
4. 保存设备，确认请求体中包含 `driverCode` 和 `driverConfig`。

#### 2.4 动态驱动点位表单测试
1. 在 Mitsubishi MC 设备下新增点位，选择寄存器类型 `D`。
2. 确认数据类型可选 `INT16/UINT16/INT32/UINT32/FLOAT/DOUBLE`，不可选 `X/Y/M` 等位寄存器专属类型。
3. 选择寄存器类型 `X`，确认数据类型只能选 `BIT/BOOL`。
4. 在 Modbus TCP 设备下新增点位，确认寄存器类型为 `HR/IR/COIL/DISCRETE`，数据类型按驱动 schema 过滤。

#### 2.5 全局点位页筛选
1. 进入“全局点位管理”。
2. 选择 Modbus 寄存器类型筛选，确认筛选结果与后端一致。
3. 选择 `dataType=UINT16` 筛选，确认结果正确。

#### 2.6 导入文件校验
1. 尝试上传一个大于 10MB 的 `.txt` 文件。
2. 期望：前端拦截并提示文件大小/类型不符。
3. 上传合法的 `.xlsx` 文件，确认导入成功。

---

## 第 3 天：配置发布中心完善

> 状态：2026-07-19 代码已完成，前端 `npm run build:prod` 通过，Python 语法检查通过，等待实际联调验证。

### 目标
完善「配置发布中心」页面，统一发布入口，确保发布按钮权限清晰，并且 MQTT 配置刷新消息按 `node_id` 精确过滤。

### 涉及整改项
- #6（配置下发已改为手动发布模式，需补充发布中心页面与影响范围预览）
- #70（发布配置按钮权限与 device/tag 页面按钮重复）
- #71（`plc:publish:edit` 权限已注册，待验证）
- #17（`CONFIG_REFRESH` 广播过滤弱）
- #80（动态驱动表单非平铺字段被 Pydantic 静默丢弃）

### 代码改动范围
1. 前端新增/完善 `src/views/plc/config-publish/index.vue`
   - 展示待发布设备/点位列表
   - 展示影响范围（哪些节点会受影响）
   - 提供「发布」按钮，权限控制 `plc:publish:edit`
2. `ruoyi-fastapi-frontend/src/views/plc/device/index.vue` 与 `src/views/plc/tag/index.vue`
   - 移除重复的发布按钮，改为跳转/提示到发布中心
3. `ruoyi-fastapi-backend/module_plc/service/config_publish_service.py`
   - 补充发布记录表（可选）与幂等控制
4. `docs/V12/edgelink_v12_main_flow.json`
   - 修改 `过滤本机CONFIG_REFRESH` 函数，按 `node_id` 精确匹配

### 开发步骤
1. 确认后端 `/plc/config/publish` 接口已返回：待发布设备、待发布点位、影响的 `host_pc_ip`/`node_id` 列表。
2. 前端发布中心页面调用该接口展示数据，点击发布后显示发布结果。
3. 在 `device/index.vue` 和 `tag/index.vue` 中，保存成功后提示用户“请前往配置发布中心下发”。
4. 在 Node-RED 过滤函数中：先判断 `msg.payload.node_id === global.get('edge_node_id')`，再辅助判断 `host_pc_ip`。

### 测试流手顺

#### 3.1 发布中心页面功能
1. 修改一台设备，不点击发布。
2. 进入“配置发布中心”。
3. 确认页面显示该设备在“待发布”列表中，并显示会影响的节点。
4. 点击发布，确认后端返回成功，MQTT 广播发出。

#### 3.2 权限验证
1. 使用无 `plc:publish:edit` 权限的用户登录。
2. 确认发布按钮禁用或不可见。
3. 使用有权限的用户登录，确认可发布。

#### 3.3 MQTT 广播验证
1. 启动后端和 EMQX。
2. 使用 `mosquitto_sub` 订阅 `edgelink/notify/broadcast`：
```bash
mosquitto_sub -h localhost -p 1883 -t "edgelink/notify/broadcast" -v
```
3. 修改任一设备，在发布中心发布，观察消息是否包含 `alert_type='CONFIG_REFRESH'`、`node_id`、`host_pc_ip`。

#### 3.4 Node-RED 过滤验证
1. 部署 Node-RED 流程到两台不同 `edge_node_id` 的节点。
2. 发布配置，观察是否只有对应 `node_id` 的节点触发刷新。

---

## 第 4 天：Node-RED 配置解析适配 + 动态驱动分发

> 状态：2026-07-19 代码已完成，Node-RED 流程 JSON 校验通过，等待实际部署验证。

### 目标
让 Node-RED 的 `cm-discover` 正确消费后端下发的协议参数，确保 `byte_order/word_order/bit_offset` 和数据类型被正确传递到读取节点；同时让 Node-RED 调度器根据 `driverCode` 动态分发到对应驱动节点，并修复配置刷新失败仍置就绪的问题，统一死区语义。

### 涉及整改项
- #7（Node-RED 未消费协议参数）
- #16（API 失败仍置 `configReady=true`）
- #30（`report_deadband_ms` 语义不一致）
- #38（量程映射前后端不一致）
- #79（Node-RED 未根据 `driverCode` 分发到对应驱动节点）

### 代码改动范围
1. `docs/V12/edgelink_v12_main_flow.json`
   - 在 `cm-discover` 中读取 `t.byteOrder`、`t.wordOrder`、`t.bitOffset`，存入 `edge_tagConfigs`
   - 修改 `dataType` 透传逻辑，支持 `UINT16/UINT32/BOOL/DOUBLE`
   - 修复 `sf-config-manager` 错误路径：失败时不设置 `edge_configReady=true`
   - 统一 `deadband` 语义：与后端确认是时间间隔还是数值阈值，按约定实现
   - 对齐 `slope`/`offset` 映射算法
   - 根据 `driverCode` 动态实例化驱动节点（从 `plc_driver.node_red_node_type` 读取节点类型名）

### 开发步骤
1. 在 `cm-discover` 的 `tagConfig` 构建处增加字段映射：
   ```javascript
   tag.byteOrder = t.byteOrder || 'BIG_ENDIAN';
   tag.wordOrder = t.wordOrder || 'BIG_ENDIAN';
   tag.bitOffset = t.bitOffset || 0;
   ```
2. 将 `edge_tagConfigs` 传给驱动节点时携带这些字段。
3. 在 `sf-config-manager` 的所有错误分支（HTTP 非 200、超时、`on('error')`）中移除 `global.set('edge_configReady', true)`，改为记录错误并进入重试。
4. 与后端确认 `report_deadband_ms` 语义：
   - 若为时间间隔，Node-RED 中按“距上次上报时间 ≥ deadband”判断。
   - 若为数值死区，Node-RED 中按 `Math.abs(eng - prev) ≥ deadband` 判断。
   - 统一字段名，避免 `report_deadband_ms` 与 `deadband` 混用。
5. 确认 `slope`/`offset` 映射公式：后端与 Node-RED 统一为 `eng = raw * slope + offset` 或 `eng = raw * a + b`。
6. 在 Node-RED 调度器中用 `driverCode` 查找对应节点类型：
   ```javascript
   var driverCode = device.driverCode;
   var nodeType = global.get('edge_driver_registry')[driverCode].nodeType;
   // 动态构造驱动节点消息
   ```

### 测试流手顺

#### 4.1 Node-RED 配置拉取验证
1. 启动 Node-RED，观察 `sf-config-manager` 日志：
   - 是否成功从 `/plc/tag/global/list` 获取配置。
   - `edge_tagConfigs` 中是否包含 `byteOrder`/`wordOrder`/`bitOffset`。
2. 在 Node-RED 调试面板输出 `edge_tagConfigs`，确认新字段值正确。

#### 4.2 动态驱动分发验证
1. 配置一台 Mitsubishi Q + MC_Protocol 设备，确认调度器输出到 `mitsubishi-read` 节点。
2. 配置一台 Siemens S7-1200 + Modbus TCP 设备（假设已有 `modbus-read` 节点），确认调度器输出到 `modbus-read` 节点。
3. 新增一个驱动（如 `siemens_s7`）并注册到 `edge_driver_registry`，确认调度器能正确路由。

#### 4.3 错误路径验证
1. 临时关闭后端 `/plc/tag/global/list` 接口（或改返回 500）。
2. 触发 Node-RED 配置刷新，观察 `edge_configReady` 是否保持 `false`。
3. 恢复接口，触发刷新，观察 `edge_configReady` 变为 `true`。

#### 4.4 数据类型与死区验证
1. 配置一个 `UINT16` 点位，读取一个已知值（如 65535），确认解析正确。
2. 配置一个 `BOOL` 点位，确认位偏移生效。
3. 配置 `report_deadband_ms`，分别测试数值变化和时间间隔两种语义，确认符合预期。
4. 配置 `slope=2`、`offset=10`，读取原始值 5，确认工程值 `20`（或按约定公式）。

---

## 第 5 天：设备/点位状态一致性

> 状态：2026-07-19 代码已完成，Node-RED 流程 JSON 与后端 Python 语法检查通过，等待实际联调验证。

### 目标
确保设备或点位停用、软删除后，边缘停止采集，数据库通信状态同步清理，监控 KPI 不统计已停用/已删除项。

### 涉及整改项
- #9（设备停用/软删除后边缘继续采集）
- #10（点位停用/删除未同步清理通信状态或 KPI）
- #18（设备状态过滤条件与注释语义相反）
- #19（软删除/停用后边缘未清理 `edge_commStatus`）
- #20（`device_comm_status` 无外键级联删除）

### 代码改动范围
1. `ruoyi-fastapi-backend/module_plc/service/device_service.py`
   - 在停用/软删除时记录变更，等待用户手动发布
2. `ruoyi-fastapi-backend/module_plc/service/tag_service.py`
   - 同上
3. `docs/V12/edgelink_v12_main_flow.json`
   - 在 `cleanupStaleData` 中清理 `edge_commStatus` 和 `edge_commPending`
   - 修正设备状态过滤条件，确认后端 `status` 语义（0=启用/1=停用 或相反）
4. `docs/monitor_center.sql` / 迁移脚本
   - 添加 `device_comm_status` 外键或业务层清理逻辑

### 开发步骤
1. 确认后端 `plc_device.status` 语义：
   - 若 `0=启用、1=停用`，Node-RED 中应 `if (dev.status !== '0') return;` 过滤掉非启用。
   - 统一全局配置 `EDGE_ENABLED_STATUS='0'` 避免硬编码。
2. 在 `cleanupStaleData` 中遍历 `edge_commStatus` 和 `edge_commPending`，删除已不存在于 `edge_tagConfigs` 或 `edge_devices` 中的设备条目。
3. 在设备停用/软删除时，后端已设置 `device_comm_status.online=0`，确保一致。
4. 在 KPI 统计中过滤 `status='0'` 和 `del_flag='0'`（已存在，确认生效）。

### 测试流手顺

#### 5.1 停用设备测试
1. 在前端停用一台在线设备。
2. 观察后端日志：是否标记该设备为待发布状态。
3. 在配置发布中心发布配置。
4. 观察 Node-RED 调试日志：是否停止该设备读取。
5. 观察 `device_comm_status` 表：`online` 是否变为 0。
6. 观察监控页：在线设备 KPI 是否减少，该设备不再显示为在线。

#### 5.2 软删除设备测试
1. 软删除一台设备。
2. 发布配置，确认 Node-RED 停止采集。
3. 确认 `device_comm_status` 中对应记录被清理（或通过外键级联删除）。
4. 确认监控页不再显示该设备。

#### 5.3 点位停用/删除测试
1. 停用或删除一个点位。
2. 发布配置，确认 Node-RED 配置刷新。
3. 确认该点位不再出现在 `edge_tagConfigs` 中。
4. 确认 `edge_commStatus` 中相关设备条目被清理（或更新）。

---

## 第 6 天：MQTT 与 API 安全基线

> 状态：2026-07-19 代码已完成，前端 `npm run build:prod`、后端 Python 语法、Node-RED JSON 校验均通过，等待实际联调验证。

### 目标
清除前后端及 Node-RED 中的默认 MQTT 凭据和明文传输，所有凭据从环境变量读取，未配置时明确失败。

### 涉及整改项
- #3（Node-RED 硬编码后端登录凭据与 API Key）
- #5（前端 MQTT 弱默认凭据且明文）
- #25（MQTT 凭据允许空值且未做校验）
- #29（MQTT 发布时不校验实际连接状态）

### 代码改动范围
1. `ruoyi-fastapi-backend/config/env.py`
   - `mqtt_username`、`mqtt_password` 保留为环境变量读取，但增加部署文档说明
2. `ruoyi-fastapi-frontend/src/views/plc/monitor/index.vue`
   - 删除 `MQTT_USERNAME`、`MQTT_PASSWORD`、`MQTT_WS_URL` 的默认值
   - 未配置时给出明确错误提示，不自动连接
3. `ruoyi-fastapi-frontend/.env.development` 或相关配置
   - 提供本地开发环境变量模板，不含默认口令
4. `docs/V12/edgelink_v12_main_flow.json`
   - 在 `sf-config-manager` 中删除 `admin/***`、`***` 默认值
   - 从 `global.get('edge_backendUser')` 等读取，缺失时流程报错退出
5. `ruoyi-fastapi-backend/module_plc/mqtt/mqtt_consumer.py`
   - 发布前检查 `client.is_connected()`

### 开发步骤
1. 前端：未配置 MQTT 环境变量时，在页面顶部显示提示“MQTT 配置缺失，请配置环境变量”。
2. Node-RED：在 `sf-config-manager` 开头增加：
   ```javascript
   if (!global.get('edge_backendUser') || !global.get('edge_backendPass') || !global.get('edge_apiKey')) {
       node.error('缺少 edge_backendUser / edge_backendPass / edge_apiKey，请通过 settings.js 或环境变量配置');
       return;
   }
   ```
3. 后端：EMQX 若开启认证，确保 `mqtt_username` 和 `mqtt_password` 从环境变量正确读取。

### 测试流手顺

#### 6.1 前端无默认凭据测试
1. 清空 `.env.development` 中的 MQTT 变量。
2. 重新启动前端，进入监控页。
3. 期望：不自动连接，页面提示“MQTT 配置缺失”。
4. 配置正确的 `wss://` 地址和凭据后，重新启动，确认连接成功。

#### 6.2 Node-RED 无默认凭据测试
1. 在 `settings.js` 中不设置 `edge_backendUser` 等全局变量。
2. 部署 Node-RED 流程。
3. 期望：`sf-config-manager` 报错，不继续执行登录。
4. 设置正确凭据后，确认流程正常登录后端并拉取配置。

#### 6.3 后端 MQTT 连接验证
1. 在 EMQX 中启用认证。
2. 配置正确的 `mqtt_username`/`mqtt_password`。
3. 确认后端启动后能连接 MQTT，并正常发布通知。
4. 故意配置错误密码，确认后端日志提示连接失败，不静默跳过。

---

## 第 7 天：JWT 与 Monitor API Key + 驱动节点兼容性改造 + Bootstrap 配置下发

> 状态：2026-07-21 上午 JWT 与 Bootstrap 已完成，接口验证通过；驱动节点兼容性改造待继续。
> 目标：上午完成 JWT / Monitor API Key 安全基线；下午完成自定义驱动节点（Modbus / 三菱 MC）对 Day 4 新字段的兼容性改造；同时设计并实现 `/plc/config/bootstrap` 配置下发接口，解决多采集 PC 配置分散管理问题。

### 涉及整改项
- #1（`JWT_SECRET_KEY` 硬编码）
- #2（`.env.prod` 缺失 `MONITOR_API_KEY`，已改为必填）
- #23（`.env.dev` 使用弱密钥和弱数据库密码）
- #24（数据库密码在源码中硬编码默认值）
- #26（`APP_ENV` 未设置时默认加载 `.env.dev`）
- #7 / #8 / #79（驱动节点不支持 `driverConfig` / `byteOrder` / `wordOrder` / `bitOffset` / `DOUBLE`，动态驱动架构无法闭环）
- #92（多采集 PC 配置分散管理，每台需单独维护环境变量）

### 代码改动范围
1. `ruoyi-fastapi-backend/config/env.py`
   - `jwt_secret_key: str = Field(..., min_length=32)`，移除默认值
   - `db_password` 等敏感字段设为 `Field(...)`，无默认值
2. `ruoyi-fastapi-backend/.env.dev` / `.env.prod`
   - 生成强随机 `JWT_SECRET_KEY` 和 `MONITOR_API_KEY`
   - 替换 `DB_PASSWORD='***'` 为强密码
3. `ruoyi-fastapi-backend/config/env.py`
   - 修改 `APP_ENV` 回退逻辑：未指定时抛出异常，而非默认加载 `.env.dev`
4. `D:/nodered/node-red-contrib-edgelink-modbus/nodes/modbus-read.js`
   - 支持 `incoming.driverConfig` 三级优先级
   - `byteOrder` 值域统一（`BIG_ENDIAN`/`LITTLE_ENDIAN` ↔ `AB`/`BA`）
   - 新增 `wordOrder`（`HIGH_FIRST`/`LOW_FIRST`）
   - 新增 `bitOffset`（0-15）
   - 新增 `DOUBLE` 数据类型
5. `D:/nodered/node-red-contrib-edgelink-modbus/nodes/modbus-protocol.js`
   - 32 位数据类型按 `wordOrder` 解析
   - `DOUBLE` 解析（4 寄存器）
6. `D:/nodered - 副本/node-red-contrib-mitsubishi/nodes/mitsubishi-read.js`
   - 支持 `incoming.driverConfig` 三级优先级
   - 新增 `byteOrder` / `wordOrder` / `bitOffset`
   - 新增 `DOUBLE` 数据类型
7. `D:/nodered - 副本/node-red-contrib-mitsubishi/nodes/mc-protocol.js`
   - 32 位数据类型按 `wordOrder` 解析
   - `DOUBLE` 解析（4 寄存器）
8. `ruoyi-fastapi-backend/module_plc/controller/config_publish_controller.py`
   - 新增 `/plc/config/bootstrap` 接口：Node-RED 首次启动时拉取完整配置
9. `ruoyi-fastapi-backend/module_plc/service/config_publish_service.py`
   - 新增 `get_bootstrap_config`：组装 MQTT 凭据、API Key、driver 配置、采集参数等
10. `docs/V12/edgelink_v12_main_flow.json`
    - `sf-config-manager Step 1`：首次启动时调用 `/plc/config/bootstrap` 拉取配置，替代硬编码/环境变量
11. 启动脚本或文档
    - 提供密钥生成命令（如 `openssl rand -hex 32`）

### 开发步骤

#### 上午：JWT 与 Monitor API Key
1. 将 `jwt_secret_key` 改为 `Field(..., min_length=32)`。
2. 修改 `GetConfig` 的 `env_file` 回退逻辑：未设置 `APP_ENV` 时抛出 `ValueError`。
3. 更新 `.env.dev` 和 `.env.prod`：
   - `JWT_SECRET_KEY=$(openssl rand -hex 32)`
   - `MONITOR_API_KEY=$(openssl rand -hex 32)`
   - `DB_PASSWORD` 使用强随机密码
4. 在 `README.md` 或部署文档中补充环境变量说明。

#### 下午：驱动节点兼容性改造
1. 备份原节点文件（`modbus-read.js`、`modbus-protocol.js`、`mitsubishi-read.js`、`mc-protocol.js`）。
2. 统一配置来源优先级：`incoming.driverConfig` > `incoming.protocolParams` > `config` 默认值。
3. `byteOrder` 映射：`BIG_ENDIAN`/`AB` → 大端，`LITTLE_ENDIAN`/`BA` → 小端；兼容旧值。
4. `wordOrder`：`HIGH_FIRST` 保持默认高低字顺序，`LOW_FIRST` 交换高低字。
5. `bitOffset`：对 BOOL 类型按偏移量取位。
6. `DOUBLE`：读取 4 个连续寄存器，按 `byteOrder`/`wordOrder` 拼接为 64 位浮点。
7. 重新发布 npm 包或本地链接到 Node-RED。

#### 下午/晚上：Bootstrap 配置下发
1. 后端新增 `/plc/config/bootstrap` 接口：
   - 返回 MQTT 连接参数（host/port/username/password）
   - 返回 `MONITOR_API_KEY`
   - 返回后端地址、采集参数、driver 配置等
   - 接口需要 `X-Bootstrap-Key` 或初始 JWT 鉴权
2. Node-RED `sf-config-manager` 改造：
   - 首次启动时，用初始凭据（或 `X-Bootstrap-Key`）调用 `/plc/config/bootstrap`
   - 把返回的配置写入 `global.set('edge_*')`
   - 后续运行使用拉取的配置，不再依赖 `settings.js` 硬编码
3. 配置变更时，通过「配置发布中心」下发 `CONFIG_REFRESH`，Node-RED 重新调用 bootstrap 接口拉取最新配置。

### 测试流手顺

#### 7.1 JWT 未配置启动失败
1. 临时删除 `.env.dev` 中的 `JWT_SECRET_KEY`。
2. 启动后端：
```bash
python app.py
```
3. 期望：启动失败，日志明确提示 `JWT_SECRET_KEY 未配置或长度不足`。

#### 7.2 JWT 配置正确后启动成功
1. 配置强随机 `JWT_SECRET_KEY`。
2. 启动后端，确认成功。
3. 使用 `/login` 获取 token，再用该 token 访问受保护接口，确认鉴权通过。
4. 使用错误签名 token，确认返回 401/403。

#### 7.3 Monitor API Key 验证
1. 确认 `.env.prod` 包含 `MONITOR_API_KEY`。
2. 使用 `--env=prod` 启动后端，确认正常启动。
3. 从 Node-RED 使用正确 `X-API-Key` 调用 `/monitor/heartbeat`，确认通过。
4. 使用错误 `X-API-Key`，确认返回 401。

#### 7.4 APP_ENV 未设置验证
1. 清除环境变量 `APP_ENV`。
2. 启动后端。
3. 期望：明确报错，提示必须设置 `APP_ENV`，而不是默认加载 `.env.dev`。

#### 7.5 驱动节点 `driverConfig` 优先级验证
1. 配置 Modbus 设备，`driverConfig.unitId=5`。
2. 发布配置，确认 `modbus-read` 节点使用 Unit ID=5 而非 config 默认值。
3. 配置三菱 MC 设备，`driverConfig.mcFrame=4E`。
4. 发布配置，确认 `mitsubishi-read` 节点使用 4E 帧。

#### 7.6 `byteOrder` / `wordOrder` / `bitOffset` 验证
1. Modbus：配置 `INT32` 点位，`byteOrder=LITTLE_ENDIAN`，读取已知值验证解析正确。
2. Modbus：配置 `INT32` 点位，`wordOrder=LOW_FIRST`，验证高低字顺序正确。
3. 三菱：配置 `BOOL` 点位，`bitOffset=3`，验证第 3 位读取正确。
4. 三菱：配置 `INT16` 点位，`byteOrder=LITTLE_ENDIAN`，验证解析正确。

#### 7.7 `DOUBLE` 数据类型验证
1. 配置 `DOUBLE` 点位（4 个连续寄存器）。
2. 写入已知 64 位浮点值，确认 Node-RED 解析结果正确。
3. 分别测试 `byteOrder` 和 `wordOrder` 组合，确认解析正确。

#### 7.8 Bootstrap 配置下发验证
1. 后端新增 `/plc/config/bootstrap` 接口，返回完整配置。
2. 清空 Node-RED `settings.js` 中的 `edge_apiKey`、`edge_backendUser`、`edge_backendPass`。
3. 启动 Node-RED，确认 `sf-config-manager` 自动调用 `/plc/config/bootstrap` 拉取配置。
4. 确认 `global.get('edge_apiKey')` 等已正确写入。
5. 修改后端 MQTT 凭据，通过「配置发布中心」发布，确认 Node-RED 重新拉取并生效。
6. 新增一台采集 PC，只设置初始 `X-Bootstrap-Key`，确认能自动拉取完整配置并正常工作。

---

## 第 8 天：监控服务与告警一致性

> 状态：2026-07-22 代码已完成，后端 Python 语法检查通过，等待实际联调验证。

### 目标
修复监控 GET 接口写副作用、统一离线判定逻辑、修复告警重复与告警信息缺失问题。

### 涉及整改项
- #11（监控 GET 接口写副作用）
- #12（通信状态在线判定存在两套逻辑）
- #13（`monitor_alert` 唯一约束包含可变 `status`）
- #32（`/monitor/alerts` 的 `limit` 参数无上限）
- #35（告警列表 `device_name` 恒为空）
- #68（`confirm_alert` 可将已恢复告警重新置为已确认）

### 代码改动范围
1. `ruoyi-fastapi-backend/module_plc/service/monitor_service.py`
   - 移除 `get_node_list` 中的 `clean_orphan_device_comm` 和 `_sync_nodes_from_devices` 调用
2. `ruoyi-fastapi-backend/module_plc/dao/monitor_dao.py`
   - 统一离线判定标准：建议以 `last_success_time` 时间阈值为准
   - 移除或调整“连续失败 3 次才 offline”逻辑，或仅用于告警 enrich
3. `ruoyi-fastapi-backend/module_plc/entity/do/monitor_do.py`
   - 修改 `monitor_alert` 唯一约束为 `(alert_type, node_id, device_id)`
4. `ruoyi-fastapi-backend/module_plc/controller/monitor_controller.py`
   - 限制 `/monitor/alerts` 的 `limit` 参数
5. `ruoyi-fastapi-backend/module_plc/service/monitor_service.py`
   - 告警查询 JOIN `plc_device` 回填 `device_name`
6. `ruoyi-fastapi-backend/module_plc/dao/monitor_dao.py`
   - 限制 `confirm_alert` 只能对未恢复告警生效

### 开发步骤
1. 将 `clean_orphan_device_comm` 和 `_sync_nodes_from_devices` 移到后台定时任务中（如 `monitor_task.py` 或心跳处理时）。
2. 在 `monitor_dao.py` 中统一：
   - 设备 online/offline 状态由心跳/扫描任务根据时间阈值判定。
   - `consecutive_fails` 仅用于触发告警，不作为在线状态唯一依据。
3. 修改 `monitor_alert` 唯一约束，状态流转通过更新 `status` 字段实现。
4. 确保已有数据不会触发迁移冲突（先清理重复数据）。
5. 告警查询 JOIN `plc_device` 取 `device_name`。
6. `confirm_alert` 时校验 `status=0`（未恢复），拒绝恢复后的告警确认。

### 测试流手顺

#### 8.1 GET 接口只读验证
1. 使用并发工具（如 `ab` 或 `locust`）对 `/monitor/node-list` 发起多次请求。
2. 观察数据库日志：请求期间不应出现 `INSERT`、`DELETE` 操作。
3. 验证单独的后台任务仍在执行同步。

#### 8.2 离线判定统一验证
1. 模拟设备正常上报，确认 `device_comm_status.online=1`。
2. 停止该设备上报，等待 90 秒（或配置的阈值）。
3. 确认 `online=0` 且告警触发。
4. 恢复上报，确认 `online=1`。

#### 8.3 告警唯一性验证
1. 制造同一设备同一类型告警多次触发。
2. 确认未确认告警只有一条。
3. 确认告警状态更新（0→1→2）不触发唯一冲突。
4. 确认告警恢复后，再次故障能重新创建新告警。

#### 8.4 告警列表完整性与确认限制
1. 打开告警列表，确认每条告警都有 `device_name`。
2. 对一个已恢复告警调用确认接口，确认返回失败或忽略。
3. 对一个未恢复告警调用确认，确认成功。

---

## 第 9 天：数据库与 SQL 修复

> 状态：2026-07-22 代码已完成，Node-RED JSON 与后端 Python 语法检查通过，等待实际部署验证。

### 目标
修复数据库层面的外键、质量码语义、历史表 hypertable、索引、字段长度与按日重置等问题。

### 涉及整改项
- #20（`device_comm_status` 无外键级联删除）
- #21（数据质量码类型/语义不一致）
- #22（`plc_data_log` hypertable/压缩/保留策略被注释）
- #56（`pg_write_status.today_write_count` 无按日重置）
- #57（心跳日志清理 Event 时间写死）
- #58（复合索引缺失）
- #59（`nodered_node` IP 字段长度 20 与 `plc_device` 50 不一致）
- #98（Bootstrap 安全自动注册 v2.0：两阶段接口 + `edge_collector` 角色 + 机器指纹）

### 代码改动范围
1. `docs/monitor_center.sql`
   - 为 `device_comm_status` 添加外键（如果数据库支持且业务允许级联删除）
   - 或补充业务层清理逻辑
   - 修改 `monitor_alert` 唯一约束
   - 修改 `nodered_node` IP 字段长度
2. `docs/V12/plc_data_log.sql`
   - 启用 `create_hypertable`、压缩、保留策略（取消注释）
   - 统一 `quality` 字段类型为字符串或映射逻辑
3. `docs/V12/monitor_center.sql`
   - 添加 `today_write_count` 按日重置 Event
   - 修复 `clean_heartbeat_log` 的固定起始时间
4. `module_plc/entity/do/device_do.py` / `tag_do.py`
   - 补充复合索引
5. **Bootstrap v2.0（#98）**
   - `edge_bootstrap_key` 表增加 `machine_fingerprint` 字段
   - 创建 `edge_collector` 角色和权限（`plc:tag:list`/`plc:tag:query`/`plc:driver:list`）
   - 创建 `edge_collector` 系统账号，密码存储到 `sys_config` 表

### 开发步骤
1. 如果 `plc_device` 是软删除，外键级联删除可能不适用，改为业务层在软删除时同步清理 `device_comm_status`。
2. 如果允许硬删除，添加外键 `ON DELETE CASCADE`。
3. 在 `plc_data_log.sql` 中取消 TimescaleDB 相关注释，并确保只在 PostgreSQL 环境下执行。
4. 将 `quality` 字段统一为字符串 `GOOD/BAD/UNCERTAIN`，修改 Node-RED 数据管道发送字符串。
5. 添加 MySQL Event 用于 `today_write_count` 清零和 `heartbeat_log` 清理。
6. 将 `nodered_node.host_pc_ip` 长度从 20 改为 50 或 64，与 `plc_device` 一致。
7. 在 `device_do.py` 和 `tag_do.py` 中根据高频查询补充复合索引。

### 测试流手顺

#### 9.1 外键/清理验证
1. 创建一台设备，确认生成 `device_comm_status` 记录。
2. 软删除该设备，确认 `device_comm_status` 记录被同步清理或标记为 offline。
3. 硬删除该设备（如支持），确认 `device_comm_status` 级联删除。

#### 9.2 质量码一致性验证
1. 触发一次正常数据采集，确认 `plc_data_log.quality='GOOD'`。
2. 模拟通信失败，确认 `plc_data_log.quality='BAD'`。
3. 查询数据库，确认没有 `0/1/2` 整型残留。

#### 9.3 Hypertable 启用验证
1. 在 PostgreSQL 中确认 `plc_data_log` 是 hypertable：
```sql
SELECT * FROM timescaledb_information.hypertables WHERE hypertable_name='plc_data_log';
```
2. 确认 chunk 已按 7 天生成。
3. 确认保留策略已生效（30 天）。

#### 9.4 定时 Event 验证
1. 手动触发 `today_write_count` 清零 Event 或等待零点。
2. 确认所有节点的 `today_write_count` 归零。
3. 确认 `heartbeat_log` 保留最近 7 天，旧数据被清理。

#### 9.5 索引与字段长度验证
1. 执行 explain 分析高频查询（如按 device_id 查询点位），确认使用索引。
2. 验证 `nodered_node.host_pc_ip` 可存储 IPv6 地址。

---

## 第 10 天：集成测试与回归

> 状态：2026-07-22 代码已完成，Node-RED JSON 与后端 Python 语法检查通过，等待实际集成测试验证。

### 目标
完成端到端集成测试，确保所有 P0 问题解决，P1 重点问题得到验证，系统可进入预投产状态。

### 涉及整改项
- 全部 P0：#1~#8
- 重点 P1：#9~#14、#16~#22、#30、#32、#35、#36~#39、#72~#79
- 新增 #97：Node-RED 本地配置缓存，后端崩溃时重启也能用最近配置继续采集
- 新增 #98：Bootstrap 安全自动注册 v2.0，Node-RED 零配置自动注册与配置下发

### 测试流手顺

#### 10.1 环境准备
1. 启动后端（prod 环境）。
2. 启动 EMQX（MQTT over WebSocket，生产使用 wss）。
3. 启动 PostgreSQL / MySQL。
4. 启动 Node-RED 边缘节点（至少 1 台，最好 2 台）。
5. 启动前端。

#### 10.2 动态驱动端到端测试
1. **新增三菱 MC 设备**：
   - 前端选择 Mitsubishi → Q → MC_Protocol。
   - 确认设备表单动态显示帧格式、站号、网络号。
   - 保存并发布，确认 Node-RED 调度器路由到 `mitsubishi-read` 节点。
2. **新增 Modbus TCP 设备**：
   - 前端选择 Siemens → S7-1200 → Modbus TCP。
   - 确认设备表单动态显示 Unit ID。
   - 保存并发布，确认 Node-RED 调度器路由到 `modbus-read` 节点。
3. **新增其他驱动设备（如已扩展 S7/FINS）**：
   - 验证新增驱动从后端 schema → 前端表单 → Node-RED 节点分发全链路可用。
4. **点位按驱动能力过滤**：
   - 三菱 MC 设备下选择 X 寄存器，确认只能选 BIT/BOOL。
   - 选择 D 寄存器，确认可选 INT16/UINT16/INT32/UINT32/FLOAT/DOUBLE。
   - Modbus 设备下选择 HR，确认支持 UINT16/UINT32/BOOL 等。

#### 10.3 端到端数据流测试
1. **新增设备**：
   - 前端创建三菱/MC 或 Modbus 设备。
   - 确认 Node-RED 在 30 秒内拉取到配置并注册节点。
2. **新增点位**：
   - 创建 `UINT16`、`UINT32`、`BOOL` 点位，配置 `byteOrder`、`wordOrder`、`bitOffset`。
   - 确认 Node-RED 配置刷新后，读取节点携带这些参数。
   - 确认实时数据正确写入 `plc_data_log`。
3. **修改点位**：
   - 修改地址或数据类型，保存后到配置发布中心发布。
   - 确认 Node-RED 在 30 秒内重新加载。
   - 确认新配置生效，无旧数据残留。
4. **停用设备**：
   - 停用设备，发布配置。
   - 确认 Node-RED 停止读取。
   - 确认 `device_comm_status.online=0`，监控页在线数减少。
5. **软删除设备**：
   - 软删除设备，发布配置。
   - 确认 Node-RED 清理相关状态。
   - 确认 `device_comm_status` 无僵尸记录。
6. **告警链路**：
   - 断开 PLC 网络，等待 90 秒，确认离线告警触发。
   - 恢复网络，确认告警恢复状态正确。

#### 10.4 安全基线验证
1. 检查 `.env.prod`、`Node-RED settings.js`、前端环境变量中无默认口令/API Key。
2. 使用错误 JWT 访问接口，确认返回 401。
3. 使用错误 `X-API-Key` 访问监控上报接口，确认返回 401。
4. 抓包确认 MQTT 使用 `wss://`（生产环境）。

#### 10.5 后端崩溃容错验证（本地配置缓存）
1. 确认 Node-RED 已成功拉取配置并采集数据。
2. 停止后端服务（模拟崩溃）。
3. 观察 Node-RED：继续用旧配置采集，数据继续写入 PG/MySQL。
4. 重启 Node-RED：确认能用本地缓存配置继续采集（#97）。
5. 恢复后端，确认 Node-RED 重新拉取最新配置。

#### 10.6 Bootstrap v2.0 自动注册验证（#98）
1. 清空 Node-RED `settings.js` 中的 `edge_bootstrapKey`/`edge_bootstrapSecret`/`edge_hostPcIp`。
2. 启动 Node-RED，确认自动检测 IP 和端口，调用 `/plc/config/bootstrap/auto` 完成注册。
3. 确认 `edge_secret.json` 本地缓存生成。
4. 确认 Node-RED 使用 `edge_collector` 角色登录，无 admin 权限。
5. 修改 PC 的 IP 地址，重启 Node-RED，确认通过 `machine_fingerprint` 自动映射到原节点，不创建重复记录。
6. 在「边缘节点管理」页面查看自动注册的节点，确认可禁用/启用。

#### 10.6 性能与压力测试
1. 模拟 100 台设备、每设备 100 个点位，覆盖至少 2 种驱动。
2. 连续运行 30 分钟，观察：
   - 后端 CPU/内存是否稳定
   - `plc_data_log` hypertable 是否正常工作
   - Node-RED 是否出现 `procGuard` 频繁丢弃消息
   - 监控页是否无 10 秒轮询导致的性能下降

#### 10.6 文档与清单更新
1. 更新 `docs/待整改/edgelink待整改清单.md` 中各条目的状态。
2. 补充部署文档：环境变量、密钥生成、MQTT TLS、Node-RED 配置、驱动扩展说明。
3. 输出最终测试报告。

---

## 第 11 天：驱动管理页面（产品化增强）

> 状态：2026-07-22 代码已完成，前端 `npm run build:prod` 与后端 Python 语法检查通过，等待实际使用验证。
> 目标：把 `plc_driver` / `plc_protocol_compat` 的维护从「直接操作数据库」升级为 Web 页面化管理，让新增 PLC 驱动不再需要 DBA 介入。  
> 定位：非阻塞投产项，建议在 10 天核心整改完成后实施。

### 涉及范围
- 新增 `plc_driver` 元数据管理页面
- 新增 `plc_protocol_compat` 映射维护页面（或合并到驱动管理页）
- 后端 CRUD API、JSON schema 校验、唯一性校验
- 菜单与权限：`plc:driver:list/add/edit/remove`、`plc:protocol-compat:list/add/edit/remove`

### 代码改动范围
1. 后端
   - `module_plc/controller/driver_controller.py`：新增 POST/PUT/DELETE `/plc/driver` 管理接口
   - `module_plc/service/driver_service.py`：新增驱动元数据 CRUD 与校验
   - `module_plc/controller/protocol_compat_controller.py`：新增映射维护接口
   - `module_plc/service/protocol_compat_service.py`：新增映射 CRUD 与重复检测
2. 前端
   - 新建 `src/views/plc/driver/index.vue`：驱动元数据列表与编辑
   - 新建 `src/views/plc/protocol-compat/index.vue`：品牌/系列/通信方式/寄存器映射维护
   - 或合并为 `src/views/plc/driver/index.vue` + 子标签页
   - 使用 JSON 文本框录入 `config_schema`、`register_types`、`data_types`
3. 菜单初始化
   - `init_plc_db.py`：插入「驱动管理」二级菜单与按钮权限
   - `migrate_publish_center.py` 或新建迁移脚本：为已有环境补菜单

### 最小可行版本（MVP）

#### 11.1 驱动管理
- 列表展示：driver_code、driver_name、node_red_node_type、enabled、schema_version
- 新增/编辑：表单字段 + JSON 文本框
- 删除：仅当该驱动未被任何 `plc_device` 引用时才允许删除
- 启用/禁用：切换 `enabled`，禁用后新增设备不可选

#### 11.2 协议兼容映射维护
- 列表展示：plc_brand、plc_series、com_type、driver_code、register_type
- 新增/编辑：下拉选择品牌/系列/通信方式/驱动，填写寄存器类型与标签
- 删除单条映射
- 导入导出：支持 Excel/JSON 批量维护

#### 11.3 校验规则
- `driver_code` 唯一，只能包含字母、数字、下划线
- `config_schema` 必须是合法 JSON，且 `fields` 为数组
- `register_types` 中每个 `dataTypes` 必须在 `data_types` 中有定义
- `plc_protocol_compat` 的 `(plc_brand, plc_series, com_type, register_type)` 组合唯一

### 测试流手顺

#### 11.1 驱动 CRUD
1. 进入「连接配置」→「驱动管理」。
2. 点击新增，填写 `driver_code=panasonic_fp`、`driver_name=松下 FP 以太网`。
3. 在 `config_schema` 中录入：
   ```json
   {"fields":[{"name":"unitId","type":"number","label":"单元号","default":1,"min":1,"max":255,"required":true}]}
   ```
4. 保存后列表出现新驱动。
5. 编辑该驱动，修改 `enabled=0`，确认新增设备时不可选。
6. 尝试删除一个已被 `plc_device` 引用的驱动，确认前端提示「已被设备引用，不可删除」。

#### 11.2 映射维护
1. 进入「协议兼容映射」页面。
2. 新增一条：`Panasonic` / `FP` / `MC_Protocol` / `panasonic_fp` / `D`。
3. 再次新增相同组合，确认后端返回「映射已存在」。
4. 到设备管理页新增 Panasonic FP 设备，确认通信方式下拉出现 `MC_Protocol`，驱动编码自动带出 `panasonic_fp`。

#### 11.3 新增 PLC 全流程验证
1. 通过驱动管理页面新增一个驱动。
2. 通过映射维护页面补充品牌/系列/通信方式映射。
3. 到设备管理页面新增对应品牌/系列/通信方式的设备。
4. 确认设备表单按新驱动 schema 动态渲染。
5. 新增点位，确认寄存器类型和数据类型按驱动能力过滤。
6. 发布配置，确认 MQTT payload 携带正确的 `driverCode`/`driverConfig`。

### 验收标准
- [ ] Web 端可完成驱动元数据 CRUD，无需直接操作数据库
- [ ] Web 端可完成协议兼容映射 CRUD
- [ ] 新增驱动后，设备/点位表单、配置下发链路自动生效
- [ ] 有基本权限控制，非授权用户不可修改驱动元数据

---

## 第 12 天：发布履历与修改履历页面（产品化增强）

> 目标：把 `plc_publish_log` 和 `plc_change_log` 的维护从「数据库查询」升级为 Web 页面化追溯，让运维可以查看每次配置下发和设备/点位变更的历史。  
> 定位：非阻塞投产项，建议与第 11 天驱动管理页面一起排期实施。

### 涉及整改项
- #90（发布履历页面缺失）
- #91（修改履历页面缺失）

### 代码改动范围
1. 后端
   - `module_plc/entity/do/change_log_do.py`：新建 `PlcChangeLog` DO 模型
   - `module_plc/controller/publish_log_controller.py`：新增 `/plc/publish-log/list` 发布履历查询接口
   - `module_plc/controller/change_log_controller.py`：新增 `/plc/change-log/list` 修改履历查询接口
   - `module_plc/service/publish_log_service.py`：发布履历查询与详情组装
   - `module_plc/service/change_log_service.py`：修改履历查询、变更前后值对比
   - `module_plc/service/device_service.py` / `tag_service.py`：在增删改停用方法中写入 `plc_change_log`
2. 前端
   - 新建 `src/views/plc/publish-log/index.vue`：发布履历列表（时间、发布人、设备数、节点数、操作结果）
   - 新建 `src/views/plc/change-log/index.vue`：修改履历列表（时间、操作人、对象类型、对象名称、操作类型、变更摘要）
   - 支持按时间范围、操作人、设备名称、操作类型筛选
3. 菜单初始化
   - `init_plc_db.py`：插入「发布履历」「修改履历」二级菜单与按钮权限
   - 或合并为「日志中心」一个菜单 + 两个子标签页

### 数据库变更
```sql
-- 修改履历表
CREATE TABLE IF NOT EXISTS plc_change_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    change_type VARCHAR(20) NOT NULL COMMENT '操作类型：add/update/disable/delete/enable',
    target_type VARCHAR(20) NOT NULL COMMENT '对象类型：device/tag',
    target_id BIGINT NOT NULL COMMENT '对象ID',
    target_name VARCHAR(100) COMMENT '对象名称（冗余，便于查询）',
    change_by VARCHAR(64) COMMENT '操作人',
    change_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
    before_value JSON COMMENT '变更前值',
    after_value JSON COMMENT '变更后值',
    remark VARCHAR(500) COMMENT '备注',
    INDEX idx_target (target_type, target_id),
    INDEX idx_change_time (change_time),
    INDEX idx_change_by (change_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PLC设备/点位修改履历表';
```

### 开发步骤
1. 新建 `plc_change_log` 表与 DO 模型。
2. 在 `device_service.py` 的 add/update/disable/delete/enable 方法中，记录变更前后值到 `plc_change_log`。
3. 在 `tag_service.py` 的对应方法中同样记录。
4. 新增发布履历查询接口（基于现有 `plc_publish_log`）。
5. 新增修改履历查询接口（基于 `plc_change_log`）。
6. 前端新增两个页面，支持列表、筛选、详情查看。
7. 菜单注册与权限控制。

### 测试流手顺

#### 12.1 发布履历
1. 进入「配置发布中心」→ 发布一次配置。
2. 进入「发布履历」页面。
3. 确认列表显示刚才的发布记录：时间、发布人、设备数、节点数。
4. 点击查看详情，确认显示发布的设备列表和节点列表。
5. 按时间范围筛选，确认结果正确。

#### 12.2 修改履历
1. 新增一台设备，填写完整信息。
2. 修改该设备的名称或采集周期。
3. 停用该设备。
4. 进入「修改履历」页面。
5. 确认列表显示三条记录：add、update、disable。
6. 点击每条记录，确认显示变更前后值对比。
7. 按操作人筛选，确认只显示当前用户的操作。

#### 12.3 权限验证
1. 使用无 `plc:publish-log:list` 权限的用户登录，确认无法查看发布履历。
2. 使用无 `plc:change-log:list` 权限的用户登录，确认无法查看修改履历。

### 验收标准
- [ ] 发布履历页面可查看每次发布的时间、发布人、影响范围
- [ ] 修改履历页面可查看设备/点位的增删改停用记录及变更前后值
- [ ] 支持按时间、操作人、设备筛选
- [ ] 有基本权限控制

---

## 每日检查点

每天结束时，请确认以下事项：
- [ ] 当天计划的问题已修复代码
- [ ] 对应的测试流手顺已执行并通过
- [ ] 当天的修改没有破坏原有功能（至少做了相关回归测试）
- [ ] `edgelink待整改清单.md` 中的对应条目状态已更新（修复人 / 修复日期）
- [ ] 关键改动已提交 Git（commit message 注明修复的问题编号）

## 风险提醒

- 第 3 天和第 4 天涉及前后端 + Node-RED 的联动，建议留出时间处理联调问题。
- 第 7 天修改 `JWT_SECRET_KEY` 后，所有已有 token 会失效，需要重新登录。
- 第 9 天修改数据库约束前，建议先备份数据库，避免迁移冲突。
- 如果某天任务未按时完成，建议优先保证 P0 全部完成，P1 按业务重要性顺延。
- 总清单已扩展到 71 项，本 10 天计划覆盖核心 P0 和重点 P1；剩余 P2 项可在 10 天后继续排期。
- 第 11 天为产品化增强（驱动管理页面），不阻塞投产，可根据实际资源安排。
- 第 12 天为产品化增强（发布履历与修改履历页面），不阻塞投产，建议与第 11 天一起排期。

