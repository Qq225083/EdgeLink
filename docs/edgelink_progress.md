# EdgeLink 边缘智联 — 系统开发进度文档

> **最后更新**：2026-06-07  
> **当前阶段**：PLC 设备管理模块开发完成，数据库就绪，准备接入 Node-RED 采集引擎  
> **项目路径**：`C:\Users\admin\Desktop\RuoYi-Vue-FastAPI`  
> **后端**：`ruoyi-fastapi-backend`（FastAPI + SQLAlchemy 2.0 async）  
> **前端**：`ruoyi-fastapi-frontend`（Vue 2.6 + Element UI）

---

## 一、项目背景

EdgeLink 边缘智联是一个工业物联网边缘计算平台，替代传统 Excel VBA 方案，为工厂现场的 PLC 设备提供配置管理、数据采集和监控能力。

核心架构：
```
RuoYi 管理系统（配置层）
    ↓ 写入配置
PostgreSQL / MySQL（配置存储）
    ↓ 每 1-5 秒拉取
Node-RED 采集引擎（采集层）
    ↓ MC协议 / Modbus TCP / GOT透传 / RS-232C
三菱 PLC 设备（设备层）
```

---

## 二、已完成模块

### 2.1 PLC 设备管理模块（module_plc）—— 已完成

#### 功能清单（20 个 API 端点全部实现）

**设备管理（9 个端点）：**

| 方法 | 路径 | 权限码 | 功能 |
|------|------|--------|------|
| GET | `/plc/device/list` | `plc:device:list` | 分页查询设备列表（含点位数量），支持 deviceName/deviceCode/plcIp/status/plcBrand 筛选 |
| GET | `/plc/device/{device_id}` | `plc:device:list` | 查询设备详情（含该设备下所有未删除点位） |
| POST | `/plc/device` | `plc:device:add` | 新增设备（校验IP格式、端口范围、FX系列≠4E帧） |
| PUT | `/plc/device` | `plc:device:edit` | 编辑设备（同上校验） |
| PUT | `/plc/device/status/{device_id}` | `plc:device:edit` | 切换设备启停状态（el-switch 实时切换） |
| PUT | `/plc/device/disable/{device_ids}` | `plc:device:remove` | 批量停用设备（status='1'，逗号分隔） |
| DELETE | `/plc/device/{device_ids}` | `plc:device:remove` | 批量软删除设备（del_flag='2'，级联软删除点位） |
| POST | `/plc/device/clone/{device_id}` | `plc:device:add` | 克隆设备（复制设备+全部点位到新设备，提示含新旧设备名） |
| POST | `/plc/device/export` | `plc:device:list` | 导出设备列表 Excel（当前筛选条件，19 列含备注） |

**点位管理（11 个端点）：**

| 方法 | 路径 | 权限码 | 功能 |
|------|------|--------|------|
| GET | `/plc/tag/list/{device_id}` | `plc:tag:list` | 分页查询指定设备的点位 |
| GET | `/plc/tag/detail/{tag_id}` | `plc:tag:list` | 查询单点位详情 |
| GET | `/plc/tag/global/list` | `plc:tag:list` | 跨设备全局点位查询（JOIN 设备表，支持 registerType/address/deviceName 筛选） |
| POST | `/plc/tag` | `plc:tag:add` | 新增点位（校验寄存器类型 D/W/X/Y/M、数据类型 INT16/INT32/FLOAT/BIT） |
| PUT | `/plc/tag` | `plc:tag:edit` | 编辑点位 |
| PUT | `/plc/tag/status/{tag_id}` | `plc:tag:edit` | 切换点位启停状态 |
| PUT | `/plc/tag/disable/{tag_ids}` | `plc:tag:remove` | 批量停用点位 |
| DELETE | `/plc/tag/{tag_ids}` | `plc:tag:remove` | 批量软删除点位 |
| PUT | `/plc/tag/batch` | `plc:tag:edit` | 批量更新点位（支持同时修改寄存器类型/数据类型/单位/状态） |
| GET | `/plc/tag/template` | `plc:tag:add` | 下载 Excel 导入模板（含下拉校验） |
| POST | `/plc/tag/import/{device_id}` | `plc:tag:add` | 批量导入点位（Excel/JSON，返回结构化结果：成功数+失败明细） |

#### 前端页面（2 个）

**1. PLC设备管理页面（/plc/device）** — `src/views/plc/device/index.vue`，~850 行

- 查询筛选区：设备名称(模糊)、设备编号(精确)、IP(精确)、状态(下拉)、品牌(下拉)
- 操作工具栏：新增/修改/停用/删除/导出，按钮按权限码显隐
- 设备列表表格（14 列）：选择框、设备编号、设备名称、品牌、系列、IP:端口、通信方式、帧格式、采集周期、超时/重试、点位数量、备注、状态(el-switch)、操作(5个按钮)
- 设备编辑弹窗（Tab 分组）：基本属性 / 网络配置 / 采集参数
- 通信方式联动：MC_Protocol→IP+端口+帧格式必填，Modbus_TCP→隐藏帧格式，GOT→隐藏帧格式，RS-232C→隐藏IP/端口/帧格式
- PLC系列联动：FX系列禁用4E帧，如已选4E自动重置为3E
- 克隆设备弹窗：填新名称+编号+IP，自动复制源设备所有字段+全部点位
- 点位管理弹窗（嵌套）：增/改/停用/删除/下载模板/导入点位，状态开关切换
- 点位编辑弹窗（8 字段）：名称/寄存器类型/地址/数据类型/单位/状态/排序号/描述
- 导入结果弹窗：成功数/失败数表格，失败行号+原因

**2. 数据点表页面（/plc/tag）** — `src/views/plc/tag/index.vue`，~150 行

- 跨设备全局点位视图
- 筛选：点位名称(模糊)、寄存器类型(下拉)、寄存器地址(精确)、设备名称(模糊)、状态(下拉)
- 批量修改弹窗：勾选N个点位 → 选择要修改的字段 → 一次提交
- 表格列（9 列）：选择框、设备名称(JOIN)、点位名称、寄存器类型、地址、数据类型、单位、描述、状态开关、排序

#### 前端 API 封装（2 个）

- `src/api/plc/device.js` — 9 个函数（listDevice/getDevice/addDevice/updateDevice/disableDevice/toggleDeviceStatus/delDevice/cloneDevice/exportDevice）
- `src/api/plc/tag.js` — 10 个函数（listTag/getTag/addTag/updateTag/disableTag/toggleTagStatus/delTag/downloadTagTemplate/importTags/listTagGlobal/batchUpdateTags）

---

## 三、后端架构

### 3.1 文件清单（10 个源文件）

```
module_plc/
├── controller/
│   ├── device_controller.py    # 9 个端点，~220 行
│   └── tag_controller.py       # 11 个端点，~250 行
├── service/
│   ├── device_service.py       # 设备 CRUD + 克隆 + 导出，~380 行
│   └── tag_service.py          # 点位 CRUD + 导入导出 + 批量更新 + 模板，~320 行
├── dao/
│   ├── device_dao.py           # 设备表纯 SQL 操作（ORM 模式），~145 行
│   └── tag_dao.py              # 点位表纯 SQL 操作（ORM 模式），~200 行
├── entity/
│   ├── do/
│   │   ├── device_do.py        # PlcDevice ORM 模型，25 列，~40 行
│   │   └── tag_do.py           # PlcTag ORM 模型，15 列，~30 行
│   └── vo/
│       ├── device_vo.py        # Pydantic v2 模型（camelCase 别名），~70 行
│       └── tag_vo.py           # Pydantic v2 模型 + 导入/批量模型，~80 行
```

### 3.2 分层职责

| 层 | 职责 | 关键约束 |
|----|------|---------|
| Controller | FastAPI 路由 + `@Log` 审计 + `ResponseUtil` 响应 + 参数提取 | 不写业务逻辑 |
| Service | 业务逻辑 + 校验 + 事务管理（try/commit/rollback） | commit 前将 ORM 属性存入普通变量（防 MissingGreenlet） |
| DAO | 纯数据库操作（SQLAlchemy async） | 新增/编辑 使用 ORM 对象 + flush，删除/批量更新 使用 `update().values()` |
| Entity/DO | SQLAlchemy ORM 模型 | `__tablename__` + Column 定义，无 `relationship()` |
| Entity/VO | Pydantic v2 模型 | `alias_generator=to_camel` + `from_attributes=True` |

### 3.3 关键设计决策

| 决策 | 原因 |
|------|------|
| DO 模型无 `relationship()` | `CamelCaseUtil.transform_result` 序列化 ORM 时，`InstrumentedList` 会触发懒加载导致 `MissingGreenlet` |
| `commit()` 前保存 ORM 属性 | commit 后 SQLAlchemy 会 expire 实例，再访问属性触发 SELECT 但 greenlet 上下文已不存在 |
| 新增/编辑用 ORM 对象 + flush | 替代裸 dict 拼 SQL（`update(Table), [dict]`），key 拼错会产生静默错误 |
| `edit_device_dao` / `edit_tag_dao` 内部 fetch | 方法签名兼容旧调用方（只需传 `{id, ...fields}`），内部 fetch→setattr→flush |
| 软删除/批量操作用 `update().values()` | 批量场景（`WHERE id IN (...)` / `WHERE device_id=...`）使用 SQL 表达式更高效 |
| Pydantic VO 加 `populate_by_name=True` | 服务层可用 snake_case 构造对象（如 `TagImportResult(success_count=5)`），前端用 camelCase 接收 |
| Controller 路由静态路径在参数化路径之前 | Starlette 按注册顺序匹配，`/template` 必须在 `/{tag_ids}` 之前，否则 405 |
| Excel 导入用纯 `openpyxl` | 零 pandas/numpy 依赖，适配工厂现场 Windows 机器 C 扩展安装困难的场景 |
| LIKE 查询使用 `.contains()` | 替代 f-string 拼接，SQLAlchemy 原生参数化，防注入 |

---

## 四、数据库设计

### 4.1 设备主表 `plc_device`（25 字段）

| # | 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|------|------|------|--------|------|
| 1 | `id` | BIGINT PK | Y | AUTO | 设备ID |
| 2 | `device_name` | VARCHAR(100) | Y | — | 设备名称 |
| 3 | `device_code` | VARCHAR(50) | — | NULL | 设备编号（如 `PLC-Q-01`），Node-RED 短标识 |
| 4 | `plc_brand` | VARCHAR(50) | Y | `Mitsubishi` | PLC 品牌 |
| 5 | `plc_series` | VARCHAR(50) | — | NULL | PLC系列：`Q` / `L` / `FX` / `iQ-R` |
| 6 | `com_type` | VARCHAR(50) | — | NULL | 通信方式：`MC_Protocol` / `Modbus_TCP` / `GOT` / `PLC_RS232C` |
| 7 | `plc_ip` | VARCHAR(50) | Y | — | PLC IP地址 |
| 8 | `mes_ip` | VARCHAR(50) | — | NULL | MES/MDPS 对接 IP |
| 9 | `mes_port` | INT | Y | `0` | MES/MDPS 对接端口 |
| 10 | `plc_port` | INT | Y | `5007` | PLC 通信端口 |
| 11 | `mc_frame` | VARCHAR(10) | — | NULL | MC 协议帧格式：`3E` / `4E` |
| 12 | `station_no` | INT | Y | `0` | 站号（0-255） |
| 13 | `network_no` | INT | Y | `0` | 网络号（0-255） |
| 14 | `scan_interval_ms` | INT | Y | `1000` | 采集周期（毫秒） |
| 15 | `comm_timeout_ms` | INT | Y | `3000` | 通信超时（毫秒） |
| 16 | `retry_count` | INT | Y | `2` | 失败重试次数 |
| 17 | `retry_interval_ms` | INT | Y | `500` | 重试间隔（毫秒） |
| 18 | `trigger_kind` | INT | Y | `0` | 触发方式：0=握手 1=固定周期 2=变化触发 |
| 19 | `status` | CHAR(1) | Y | `0` | 状态：0=启用 1=停用 |
| 20 | `create_by` | VARCHAR(64) | — | NULL | 创建者 |
| 21 | `create_time` | DATETIME | — | NULL | 创建时间 |
| 22 | `update_by` | VARCHAR(64) | — | NULL | 更新者 |
| 23 | `update_time` | DATETIME | — | NULL | 更新时间 |
| 24 | `remark` | VARCHAR(500) | — | NULL | 备注 |
| 25 | `del_flag` | CHAR(1) | Y | `0` | 删除标志：0=正常 2=已删除 |

### 4.2 点位从表 `plc_tag`（15 字段）

| # | 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|------|------|------|--------|------|
| 1 | `id` | BIGINT PK | Y | AUTO | 点位ID |
| 2 | `device_id` | BIGINT FK | Y | — | 所属设备ID（→ `plc_device.id`） |
| 3 | `tag_name` | VARCHAR(100) | Y | — | 点位名称 |
| 4 | `register_type` | VARCHAR(10) | Y | — | 寄存器类型：`D`/`W`/`X`/`Y`/`M` |
| 5 | `register_address` | VARCHAR(50) | Y | — | 寄存器地址（如 `100`、`0`） |
| 6 | `data_type` | VARCHAR(20) | Y | — | 数据类型：`INT16`/`INT32`/`FLOAT`/`BIT` |
| 7 | `unit` | VARCHAR(20) | — | NULL | 物理单位（如 `℃`、`mm`、`%`） |
| 8 | `description` | TEXT | — | NULL | 点位描述 |
| 9 | `status` | CHAR(1) | Y | `0` | 状态：0=启用 1=停用 |
| 10 | `sort_order` | INT | Y | `0` | 排序号（升序） |
| 11 | `create_by` | VARCHAR(64) | — | NULL | 创建者 |
| 12 | `create_time` | DATETIME | — | NULL | 创建时间 |
| 13 | `update_by` | VARCHAR(64) | — | NULL | 更新者 |
| 14 | `update_time` | DATETIME | — | NULL | 更新时间 |
| 15 | `del_flag` | CHAR(1) | Y | `0` | 删除标志：0=正常 2=已删除 |

### 4.3 两级状态体系

系统使用两个独立字段控制设备/点位的生命周期：

| 维度 | 字段 | 值 | 含义 | Node-RED 行为 | 页面可见 |
|------|------|-----|------|-------------|---------|
| 启用 | `status` | `'0'` | 正常运行 | 采集 | 可见，开关绿色 |
| 停用 | `status` | `'1'` | 暂停采集 | **跳过** | 可见，开关灰色 |
| 正常 | `del_flag` | `'0'` | 有效数据 | — | 可见 |
| 已删除 | `del_flag` | `'2'` | 逻辑删除 | **跳过** | **隐藏** |

### 4.4 索引设计（6 个）

Node-RED 每 1-5 秒执行 `plc_device JOIN plc_tag WHERE status='0' AND del_flag='0'` 拉配置。100 台×50 点=5000 条配置，必须建索引。

```sql
-- 设备表索引
CREATE INDEX idx_device_status_del ON plc_device(status, del_flag);
CREATE INDEX idx_device_ip ON plc_device(plc_ip);
CREATE INDEX idx_device_brand ON plc_device(plc_brand);

-- 点位表索引（最关键）
CREATE INDEX idx_tag_device_id ON plc_tag(device_id);
CREATE INDEX idx_tag_status_del ON plc_tag(status, del_flag);
CREATE INDEX idx_tag_device_status ON plc_tag(device_id, status, del_flag);  -- 覆盖索引
```

### 4.5 外键

```sql
CONSTRAINT fk_plc_tag_device FOREIGN KEY (device_id) REFERENCES plc_device (id)
-- DELETE_RULE=RESTRICT（非 CASCADE，软删除替代物理删除）
```

---

## 五、代码质量

### 5.1 代码统计

| 类别 | 文件数 | 总行数 | 备注 |
|------|--------|--------|------|
| 后端 Controller | 2 | ~470 | device 220 + tag 250 |
| 后端 Service | 2 | ~700 | device 380 + tag 320 |
| 后端 DAO | 2 | ~345 | device 145 + tag 200 |
| 后端 Entity | 4 | ~220 | DO 70 + VO 150 |
| 前端页面 | 2 | ~1000 | device 850 + tag 150 |
| 前端 API | 2 | ~175 | device 80 + tag 95 |
| 数据库脚本 | 2 | ~310 | init 240 + migrate 70 |
| **合计** | **16** | **~3,220** | |

### 5.2 已修复问题清单

| 轮次 | 严重度 | 问题 | 修复方式 |
|------|--------|------|---------|
| 1 | P0 | `edit_device_dao` / `edit_tag_dao` 用裸 dict 拼 SQL | 改为 ORM fetch→setattr→flush |
| 1 | P1 | 设备列表缺"备注"列 | 表格加 `<el-table-column prop="remark" width="55">` |
| 1 | P1 | 重复 `</el-table>` 标签 | 删除多余闭合标签 |
| 2 | P0 | `device_code` 筛选条件被静默忽略 | DAO WHERE 子句补 `device_code ==` 条件 |
| 2 | P0 | 软删除日志写"停用" | `soft_delete_*_services` 日志改为"删除" |
| 2 | P0 | DeviceService 含 ~450 行重复/死代码 | 删除所有点位方法（已在 TagService 中），净减 376 行 |
| 2 | P0 | 克隆成功提示不显示新设备名 | 后端返回 `f'克隆成功：{old} → {new}'`，前端用 `response.msg` |
| 2 | P1 | 4 处 f-string LIKE 拼接 | 全部改为 `.contains()` |
| 2 | P1 | Controller 内联 40 行 Excel 解析 | 下沉到 `TagService.parse_import_file`，controller 仅 3 行 |
| 2 | P1 | 校验常量双份定义 | 随死代码删除，仅 tag_service.py 保留一份 |
| 2 | P2 | 前端未使用变量（`triggerKindMap`/`tagSingle`/`single`） | 删除 |
| 2 | P2 | `wb.close()` 无 try/finally | 改用 try/finally 保护 |
| 3 | P0 | `init_plc_db.py` 字段不全（16→25, 10→15） | 重写建表脚本，对齐 DO 模型 |
| 3 | P0 | `init_plc_db.py` 外键用 ON DELETE CASCADE | 改为 RESTRICT（软删除体系不用级联删除） |
| 3 | P0 | `init_plc_db.py` 缺 6 个索引 | 补建 |
| 3 | P0 | 菜单缺"数据点表" + 点位权限挂在错误父菜单 | init 脚本补菜单 + migrate 脚本修归属 |

### 5.3 当前已知限制

| 项目 | 类型 | 说明 |
|------|------|------|
| 设备导出端点参数绑定可能不生效 | P1 | 后端 `Form()` 读 body，前端 `params` 走 URL query string，待验证 |
| `parse_import_file` → `import_tag_services` 双层防御 | P2 | 前者已归一化到 camelCase，后者又回退 snake_case/中文 key，冗余 |
| 分页写死 9999 上限 | P2 | 设备详情/克隆时 `page_size=9999` 获取全部点位，超限静默截断 |
| 无点位导出 | Phase 2 | 有导入模板下载+导入，缺少对称的 `POST /plc/tag/export` |
| 无设备批量修改 | Phase 2 | 改 20 台采集周期需逐台操作，缺少 `PUT /plc/device/batch` |
| 无点位变更日志 | Phase 2 | 溯源需翻 `sys_oper_log` JSON，无专用点位变更记录表 |

### 5.4 技术栈版本

| 组件 | 版本/说明 |
|------|----------|
| 后端框架 | FastAPI 0.125 |
| ORM | SQLAlchemy 2.0 (async) |
| 数据校验 | Pydantic v2 |
| 数据库 | MySQL 5.7+ / PostgreSQL 14+（`.env` 切换） |
| 缓存 | Redis 6+（JWT token、字典、配置缓存） |
| Excel | 纯 openpyxl（零 pandas/numpy） |
| 前端框架 | Vue 2.6 |
| UI 组件 | Element UI 2.15 |
| HTTP 客户端 | Axios |
| 路由注册 | 自动发现 `module_*/controller/*.py`（`APIRouterPro` + `RouterRegister`） |
| 权限 | JWT + `UserInterfaceAuthDependency('plc:xxx:xxx')` |
| 审计 | `@Log(title, business_type)` 装饰器 → `sys_oper_log` |

---

## 六、权限码清单（8 个）

| 权限码 | 控制范围 |
|--------|----------|
| `plc:device:list` | 菜单「PLC设备管理」+ 列表/详情/导出 |
| `plc:device:add` | 新增设备/克隆设备 |
| `plc:device:edit` | 修改设备/切换状态 |
| `plc:device:remove` | 停用设备/删除设备 |
| `plc:tag:list` | 菜单「数据点表」+ 列表/详情/全局查询 |
| `plc:tag:add` | 新增点位/下载模板/导入 |
| `plc:tag:edit` | 修改点位/切换状态/批量更新 |
| `plc:tag:remove` | 停用点位/删除点位 |

---

## 七、数据库当前状态

```
数据库: ruoyi (MySQL 5.7+, 127.0.0.1:3308)
plc_device: 25 字段 ✅ | 6 个索引 ✅ | 16 条记录（9 条有效）
plc_tag:    15 字段 ✅ | 6 个索引 ✅ | 25 条记录（6 条有效）
外键:       fk_plc_tag_device (RESTRICT) ✅
菜单:       连接配置 → PLC设备管理 + 数据点表，8 个按钮权限归属正确 ✅
```

---

## 八、需要测评的 AI 请关注

1. **架构合理性**：Controller → Service → DAO → Entity 分层是否得当
2. **SQLAlchemy async 使用**：commit/flush/expire 时序、MissingGreenlet 防护是否到位
3. **软删除体系**：`status` + `del_flag` 两级状态设计是否合理
4. **前端联动逻辑**：通信方式↔字段显隐、系列↔帧格式禁用的实现
5. **代码一致性**：14 个文件是否遵循统一模式
6. **安全性**：权限码覆盖、IP/端口校验、SQL 注入防护
7. **ORM 更新模式**：`edit_*_dao` 的 fetch→setattr→flush 是否正确
8. **剩余限制**：第三节 5.3 列出的 6 个已知项是否需要优先处理
