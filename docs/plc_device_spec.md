# EdgeLink 边缘智联 — PLC 设备管理模块 完整规格文档

> **所属系统**：EdgeLink 边缘智联  
> **所属菜单**：🔗 连接配置 → PLC设备管理 / 数据点表  
> **路由路径**：`/plc/device`、`/plc/tag`  
> **后端模块**：`module_plc`  
> **最后更新**：2026-06-06  
> **当前状态**：Phase 1 完成，支持 1-20 台三菱 PLC 的配置管理

---

## 一、系统定位与页面结构

### 1.1 模块定位

本模块是 EdgeLink 系统中「连接配置」的核心子模块，替代 Excel VBA 作为 PLC 设备台账和采集点位的配置中心。配置数据存储在 PostgreSQL/MySQL，由 Node-RED 采集引擎按 1-5 秒间隔读取，通过三菱 MC 协议（3E/4E 帧）、Modbus TCP、GOT 透传或 RS-232C 串口动态驱动 PLC 通信。

### 1.2 页面结构

```
连接配置 (一级菜单目录)
├── PLC设备管理 (C, /plc/device)     ← 设备台账主页面
│   ├── 查询筛选区                   ← 设备名称(模糊)、编号、IP(精确)、状态、品牌
│   ├── 操作工具栏                   ← 新增/修改/停用/删除/导出
│   ├── 设备列表表格                 ← 含点位数量列、可点击状态开关
│   ├── 分页组件
│   ├── 设备编辑弹窗 (Tab分组)       ← 基本属性/网络配置/采集参数
│   ├── 克隆设备弹窗                 ← 填新名称+IP即可复制整台设备+点位
│   ├── 点位管理弹窗                 ← 查看/增/改/停用/删除/导入/导出该设备的下级点位
│   ├── 点位编辑弹窗                 ← 8 个字段
│   └── 导入结果弹窗                 ← 成功/失败明细表格
│
└── 数据点表 (C, /plc/tag)           ← 跨设备点位全局视图
    ├── 查询筛选区                   ← 点位名称、寄存器类型、地址、设备名称、状态
    ├── 批量修改弹窗                 ← 勾选点位 → 批量改类型/数据类型/单位/状态
    └── 分页组件
```

### 1.3 技术栈

| 层 | 技术 |
|---|------|
| 后端框架 | FastAPI 0.125 + SQLAlchemy 2.0 (async) + Pydantic v2 |
| 数据库 | MySQL 5.7+ / PostgreSQL 14+（通过 `.env` 切换） |
| 缓存 | Redis 6+（JWT token、字典、配置缓存） |
| 前端 | Vue 2.6 + Element UI 2.15 + Axios |
| 路由注册 | 自动发现 `module_*/controller/*.py`（`APIRouterPro` + `RouterRegister`） |
| 权限 | JWT + `UserInterfaceAuthDependency('plc:xxx:xxx')` |
| 审计 | `@Log(title, business_type)` 装饰器 → `sys_oper_log` |
| Excel | 纯 `openpyxl`（零 pandas/numpy 依赖） |

---

## 二、数据库设计

### 2.1 设备主表 `plc_device`（25 字段）

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

### 2.2 点位从表 `plc_tag`（15 字段）

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

### 2.3 两级状态体系

系统使用 **两个独立字段** 控制设备/点位的生命周期：

| 维度 | 字段 | 值 | 含义 | Node-RED | 页面可见 |
|------|------|-----|------|----------|---------|
| 启用 | `status` | `'0'` | 正常运行 | 采集 | 可见 |
| 停用 | `status` | `'1'` | 暂停采集 | **跳过** | 可见（灰色开关） |
| 正常 | `del_flag` | `'0'` | 有效数据 | — | 可见 |
| 已删除 | `del_flag` | `'2'` | 逻辑删除 | **跳过** | **隐藏** |

**操作映射**：

| 用户操作 | 按钮颜色 | icon | 数据库效果 | 对应 API |
|---------|---------|------|-----------|---------|
| 开关切换 | `el-switch` 点击 | — | `status` 翻转 | `PUT /plc/device/status/{id}` / `PUT /plc/tag/status/{id}` |
| 停用 | `warning` 橙色 | `el-icon-switch-button` | `status='1'` | `PUT /plc/*/disable/{ids}` |
| 删除 | `danger` 红色 | `el-icon-delete` | `del_flag='2'` | `DELETE /plc/*/{ids}` |

- **删除设备时级联删除其下所有点位**（`del_flag='2'`）
- **所有查询自动过滤** `WHERE del_flag = '0'`
- **物理 DELETE 禁止**，代码中无任何 `DELETE` SQL 语句

### 2.4 索引设计

> Node-RED 每 1-5 秒执行 `plc_device JOIN plc_tag WHERE status='0' AND del_flag='0'` 拉配置。  
> 100 台 × 50 点 = 5000 条配置，无索引即全表扫描。

```sql
-- 设备表索引
CREATE INDEX idx_device_status_del ON plc_device(status, del_flag);
CREATE INDEX idx_device_ip ON plc_device(plc_ip);
CREATE INDEX idx_device_brand ON plc_device(plc_brand);

-- 点位表索引（最关键）
CREATE INDEX idx_tag_device_id ON plc_tag(device_id);
CREATE INDEX idx_tag_status_del ON plc_tag(status, del_flag);
CREATE INDEX idx_tag_device_status ON plc_tag(device_id, status, del_flag);  -- Node-RED 覆盖索引
```

**索引命中说明**：

| 查询场景 | 命中索引 |
|---------|---------|
| Node-RED 拉全量配置 | `idx_device_status_del` + `idx_tag_status_del` |
| Node-RED 拉单设备 `WHERE device_id=? AND status='0' AND del_flag='0'` | `idx_tag_device_status`（**覆盖索引**，只扫索引不读表） |
| 前端列表筛选 IP | `idx_device_ip` |
| 前端列表筛选品牌 | `idx_device_brand` |
| 点位列表 `WHERE device_id=?` | `idx_tag_device_id` |

---

## 三、RESTful API 端点（20 个）

### 3.1 设备接口（9 个）

| 方法 | 路径 | 权限码 | 说明 |
|------|------|--------|------|
| GET | `/plc/device/list` | `plc:device:list` | 分页查询（参数：`deviceName`(模糊), `deviceCode`, `plcIp`(精确), `status`, `plcBrand`），返回含 `tagCount` |
| GET | `/plc/device/{device_id}` | `plc:device:list` | 查询单设备详情（含该设备下所有未删除点位列表） |
| POST | `/plc/device` | `plc:device:add` | 新增设备（校验 IP 格式、端口范围、系列↔帧格式兼容性） |
| PUT | `/plc/device` | `plc:device:edit` | 编辑设备（同上校验） |
| PUT | `/plc/device/status/{device_id}` | `plc:device:edit` | 切换设备启停状态（Query: `?status=0|1`） |
| PUT | `/plc/device/disable/{device_ids}` | `plc:device:remove` | 批量停用设备（`status='1'`，逗号分隔 ID） |
| DELETE | `/plc/device/{device_ids}` | `plc:device:remove` | 批量删除设备（`del_flag='2'`，级联删除点位） |
| POST | `/plc/device/clone/{device_id}` | `plc:device:add` | 克隆设备（复制设备 + 全部未删除点位到新设备） |
| POST | `/plc/device/export` | `plc:device:list` | 导出设备列表 Excel（当前筛选条件） |

### 3.2 点位接口（11 个）

| 方法 | 路径 | 权限码 | 说明 |
|------|------|--------|------|
| GET | `/plc/tag/list/{device_id}` | `plc:tag:list` | 分页查询指定设备的点位 |
| GET | `/plc/tag/detail/{tag_id}` | `plc:tag:list` | 查询单个点位详情 |
| GET | `/plc/tag/global/list` | `plc:tag:list` | **跨设备**全局查询（JOIN 设备表，支持 `registerType`, `registerAddress`, `deviceName` 筛选） |
| POST | `/plc/tag` | `plc:tag:add` | 新增点位（校验寄存器类型、数据类型） |
| PUT | `/plc/tag` | `plc:tag:edit` | 编辑点位 |
| PUT | `/plc/tag/status/{tag_id}` | `plc:tag:edit` | 切换点位启停状态（Query: `?status=0|1`） |
| PUT | `/plc/tag/disable/{tag_ids}` | `plc:tag:remove` | 批量停用点位（`status='1'`） |
| DELETE | `/plc/tag/{tag_ids}` | `plc:tag:remove` | 批量删除点位（`del_flag='2'`） |
| PUT | `/plc/tag/batch` | `plc:tag:edit` | 批量更新点位字段（`registerType`/`dataType`/`unit`/`status`） |
| GET | `/plc/tag/template` | `plc:tag:add` | 下载点位导入 Excel 模板（含下拉校验） |
| POST | `/plc/tag/import/{device_id}` | `plc:tag:add` | 批量导入点位（Excel/JSON，返回结构化结果） |

### 3.3 路由注册机制

项目使用 `RouterRegister` 自动扫描 `module_*/controller/*.py`，提取 `APIRouterPro` 实例并注册。**新增模块无需修改 `server.py`。**

**关键约束**：`APIRouterPro` 中，静态路径段（如 `/template`、`/disable/`、`/status/`、`/batch`、`/global/list`）必须定义在参数化路径（如 `/{tag_ids}`）**之前**，否则 Starlette 会将静态段当作参数值匹配，导致 405 Method Not Allowed。

---

## 四、后端架构

### 4.1 分层结构与文件职责

```
controller/          ← FastAPI 路由 + 参数校验 + @Log 审计 + ResponseUtil 响应
    ↓
service/             ← 业务逻辑 + 事务管理(commit/rollback) + 自定义校验
    ↓
dao/                 ← 纯数据库操作（SQLAlchemy async select/insert/update）
    ↓
entity/do/           ← SQLAlchemy ORM 模型（Base 子类，__tablename__）
entity/vo/           ← Pydantic v2 模型（alias_generator=to_camel + from_attributes）
```

### 4.2 Service 拆分

| 文件 | 职责 | 方法数 |
|------|------|--------|
| `device_service.py` | 设备 CRUD + 克隆 + 导出 + 状态管理 | ~13 |
| `tag_service.py` | 点位 CRUD + 导入导出 + 批量更新 + 模板生成 + 全局查询 | 11 |

共享校验常量（`VALID_REGISTER_TYPES`、`VALID_DATA_TYPES`）和校验函数（`_validate_register_type`、`_validate_data_type`）在 `tag_service.py` 中定义为模块级，供 `DeviceService` 的 `clone_device_services` 等方法复用。

### 4.3 关键设计决策及原因

| 决策 | 原因 |
|------|------|
| DO 模型 **无** SQLAlchemy `relationship()` | `CamelCaseUtil.transform_result` 序列化 ORM 对象时，`InstrumentedList` 触发懒加载 → `MissingGreenlet` |
| `await commit()` **前**必须将 ORM 属性存入普通 Python 变量 | `commit()` 后 SQLAlchemy expire 全部已加载实例，再访问属性触发 SELECT 但 greenlet 上下文已不存在 |
| Pydantic VO 模型加 `populate_by_name=True` | 允许服务层用 snake_case 构造 Pydantic 对象（如 `TagImportResult(success_count=5)`），同时前端用 camelCase 接收 |
| 导入解析用纯 `openpyxl` 不依赖 `pandas` | 目标环境为工厂现场 Windows 机器，`numpy` C 扩展安装困难 |
| `model_dump` 显式 `exclude={'device_name', 'tag_count'}` | 这些字段仅存在于 Pydantic VO 模型（用于序列化输出），ORM 模型没有对应列，传入会报 `invalid keyword argument` |
| 控制器路由 `/template`、`/import`、`/global/list` 定义在 `/{tag_ids}` 之前 | 避免 Starlette 路由将 `/template` 当作 `{tag_ids}` 参数值匹配 |

---

## 五、前端功能详情

### 5.1 查询筛选区

| 筛选项 | 组件 | 匹配方式 |
|--------|------|----------|
| 设备名称 | `el-input` | 模糊 LIKE `%xxx%` |
| 设备编号 | `el-input` | 精确 |
| IP地址 | `el-input` | 精确 |
| 状态 | `el-select` | 精确（启用/停用） |
| 品牌 | `el-select` | 精确（Mitsubishi/Siemens/Omron/Keyence） |

### 5.2 设备列表表格列

| 列名 | 字段 | 宽度 | 特殊渲染 |
|------|------|------|----------|
| 选择框 | — | 55 | `type="selection"` |
| 设备编号 | `deviceCode` | 110 | `show-overflow-tooltip` |
| 设备名称 | `deviceName` | 140 | `show-overflow-tooltip` |
| 品牌 | `plcBrand` | 90 | — |
| 系列 | `plcSeries` | 70 | — |
| IP:端口 | `plcIp`:`plcPort` | 150 | 模板拼接 |
| 通信方式 | `comType` | 110 | — |
| 帧格式 | `mcFrame` | 65 | — |
| 采集周期 | `scanIntervalMs` | 85 | 带单位 `ms` |
| 超时/重试 | `commTimeoutMs`/`retryCount` | 100 | 模板拼接 |
| 点位 | `tagCount` | 55 | 批量 SQL `COUNT+GROUP BY` |
| 状态 | `status` | 65 | **可点击** `el-switch`（`@change` 调 toggle API） |
| 操作 | — | 280 | 修改/停用/删除(红)/克隆/点位 |

### 5.3 设备编辑弹窗 Tab 分组

弹窗包含三个 `el-tabs` 分组：

**Tab「基本属性」**：`device_name`、`device_code`、`plc_brand`、`plc_series`、`com_type`、`mc_frame`、`status`、`remark`

**Tab「网络配置」**：`plc_ip`（RS-232C 隐藏）、`plc_port`（RS-232C 隐藏）、`mes_ip`、`mes_port`、`station_no`（仅 MC_Protocol/GOT 显示）、`network_no`（仅 MC_Protocol/GOT 显示）

**Tab「采集参数」**：`scan_interval_ms`、`comm_timeout_ms`、`retry_count`、`retry_interval_ms`、`trigger_kind`

### 5.4 点位编辑弹窗

| 字段 | 组件 | 校验 |
|------|------|------|
| 点位名称 | `el-input` | **必填** |
| 寄存器类型 | `el-select`（D/W/X/Y/M） | **必填** |
| 寄存器地址 | `el-input` | **必填** |
| 数据类型 | `el-select`（INT16/INT32/FLOAT/BIT） | **必填** |
| 单位 | `el-input` | — |
| 状态 | `el-radio-group`（启用/停用） | — |
| 排序号 | `el-input-number` (0-9999) | — |
| 描述 | `el-input textarea` | — |

### 5.5 跨设备点位页面（`/plc/tag`）

独立的全局点位视图，查询支持：`tagName`(模糊)、`registerType`、`registerAddress`、`deviceName`(模糊)、`status`。表格显示设备名称列（JOIN），状态开关可点击。

工具栏提供「批量修改」：勾选 N 个点位 → 弹出对话框 → 选择要修改的字段（寄存器类型/数据类型/单位/状态）→ 一次提交更新全部。

---

## 六、前端联动与校验规则

### 6.1 通信方式 ↔ 字段显隐联动

| 通信方式 | PLC IP/端口 | 站号/网络号 | 帧格式 |
|---------|-----------|------------|--------|
| `MC_Protocol` | 必填 | 必填 | 必填 |
| `Modbus_TCP` | 必填 | 隐藏(重置为0) | 隐藏(清空) |
| `GOT` | 必填 | 必填 | 隐藏(清空) |
| `PLC_RS232C` | 隐藏(清空/5007) | 隐藏(重置为0) | 隐藏(清空) |

`onComTypeChange` 触发时：更新 `v-show` 显隐 + 重置隐藏字段值 + 动态调整 `rules.plcIp`/`rules.plcPort`。

### 6.2 系列 ↔ 帧格式联动

- `FX` 系列：**禁用 4E**，如已选 4E 则自动重置为 3E
- `Q`/`L`/`iQ-R`：3E 和 4E 均可选

### 6.3 前端校验规则

| 字段 | 规则 |
|------|------|
| `deviceName` | 必填 |
| `plcBrand` | 必填 |
| `plcIp` | RS-232C 时取消必填；否则必填 + 正则 `/^(\d{1,3}\.){3}\d{1,3}$/` |
| `plcPort` | RS-232C 时取消必填；否则必填 |
| `plcSeries` | 必填 |
| `comType` | 必填 |
| `tagName` / `registerType` / `registerAddress` / `dataType` | 必填 |

---

## 七、后端校验规则

### 7.1 新增/编辑设备

| 校验项 | 规则 | 错误信息 |
|--------|------|----------|
| `plc_ip` / `mes_ip` | `ipaddress.ip_address()` | `IP地址格式不正确：xxx` |
| `plc_port` / `mes_port` | 1 ≤ port ≤ 65535 | `端口号范围不正确：xxx` |
| `plc_series`=`FX` + `mc_frame`=`4E` | 拒绝 | `FX系列PLC不支持4E帧格式` |

### 7.2 新增/编辑/导入点位

| 校验项 | 规则 | 有效值 |
|--------|------|--------|
| `device_id` | 设备存在且 `del_flag='0'` | — |
| `register_type` | 枚举（大小写不敏感） | `D`, `W`, `X`, `Y`, `M` |
| `data_type` | 枚举（大小写不敏感） | `INT16`, `INT32`, `FLOAT`, `BIT` |

### 7.3 导入特有逻辑

- 模板表头中英文兼容：`点位名称` ↔ `tag_name`，`寄存器类型` ↔ `register_type`
- 逐行校验 → 成功的 commit，失败的返回行号+原因
- 全部失败则 rollback
- 返回 `TagImportResult{successCount, failCount, errors[{row, reason}]}`

---

## 八、权限码清单（8 个）

| 权限码 | 控制范围 |
|--------|----------|
| `plc:device:list` | 菜单 + 设备列表/详情/导出 |
| `plc:device:add` | 新增设备/克隆设备 |
| `plc:device:edit` | 修改设备/切换状态 |
| `plc:device:remove` | 停用设备/删除设备 |
| `plc:tag:list` | 菜单 + 点位列表/详情/全局查询 |
| `plc:tag:add` | 新增点位/下载模板/导入 |
| `plc:tag:edit` | 修改点位/切换状态/批量更新 |
| `plc:tag:remove` | 停用点位/删除点位 |

菜单层级：连接配置(目录) → PLC设备管理(页面) + 数据点表(页面) → 8 个按钮权限。

---

## 九、操作审计

| 操作 | `@Log` 标题 | `BusinessType` |
|------|------------|----------------|
| 新增/克隆设备 | PLC设备管理 | INSERT |
| 编辑设备 | PLC设备管理 | UPDATE |
| 停用设备 | PLC设备管理 | UPDATE |
| 删除设备 | PLC设备管理 | DELETE |
| 导出设备 | PLC设备管理 | EXPORT |
| 新增点位 | PLC点位管理 | INSERT |
| 编辑点位 | PLC点位管理 | UPDATE |
| 停用点位 | PLC点位管理 | UPDATE |
| 删除点位 | PLC点位管理 | DELETE |
| 导入点位 | PLC点位管理 | IMPORT |
| 批量更新 | PLC点位管理 | UPDATE |

全部自动记录到 `sys_oper_log`（操作人、IP、参数、响应、耗时）。

---

## 十、与 Node-RED 的衔接设计

### 10.1 配置拉取 SQL

```sql
SELECT d.*, t.tag_name, t.register_type, t.register_address, t.data_type
FROM plc_device d
JOIN plc_tag t ON d.id = t.device_id
WHERE d.status = '0' AND d.del_flag = '0'
  AND t.status = '0' AND t.del_flag = '0'
```

### 10.2 字段映射表

| RuoYi 字段 | Node-RED 用途 |
|-----------|--------------|
| `plc_ip` / `plc_port` | mcprotocol 节点连接参数 |
| `mc_frame` / `station_no` / `network_no` | MC 协议帧头组装 |
| `com_type` | 选择通信协议节点（MC / Modbus / GOT / RS-232C） |
| `register_type` + `register_address` | 目标寄存器地址 |
| `data_type` | 解析字节长度（INT16=1字, INT32/FLOAT=2字, BIT=位） |
| `scan_interval_ms` | inject 节点触发间隔 |
| `comm_timeout_ms` | 通信超时判断 |
| `retry_count` / `retry_interval_ms` | 失败重试策略 |
| `trigger_kind` | 触发模式选择 |
| `status='0'` | 是否纳入采集 |
| `del_flag='0'` | 是否有效配置 |

---

## 十一、文件清单（14 个源文件）

| 层 | 文件 |
|----|------|
| DO | `module_plc/entity/do/device_do.py` |
| DO | `module_plc/entity/do/tag_do.py` |
| VO | `module_plc/entity/vo/device_vo.py` |
| VO | `module_plc/entity/vo/tag_vo.py` |
| DAO | `module_plc/dao/device_dao.py` |
| DAO | `module_plc/dao/tag_dao.py` |
| Service | `module_plc/service/device_service.py` |
| Service | `module_plc/service/tag_service.py` |
| Controller | `module_plc/controller/device_controller.py` |
| Controller | `module_plc/controller/tag_controller.py` |
| 前端 API | `src/api/plc/device.js` |
| 前端 API | `src/api/plc/tag.js` |
| 前端页面 | `src/views/plc/device/index.vue` |
| 前端页面 | `src/views/plc/tag/index.vue` |

---

## 十二、已知限制与建议

| 项目 | 类型 | 说明 |
|------|------|------|
| `edit_*_dao` 用裸 dict 拼 SQL | bug 隐患 | key 拼错静默失败，应改为 ORM 属性赋值→flush |
| 设备列表缺"备注"列 | UX 缺口 | 备注在弹窗才可见，现场需要列表直接看 |
| 克隆成功提示无新设备名 | UX 缺口 | 提示"克隆成功"但不知道新设备叫什么 |
| 无设备批量修改 | Phase 2 | 改 20 台采集周期需逐台操作 |
| 无点位变更日志 | Phase 2 | 溯源需翻 `sys_oper_log` JSON |
| 无点位导出 | Phase 2 | 有导入无备份导出 |
