# EdgeLink 边缘智联系统 — 开发文档

> **版本**：v2.2 | **日期**：2026-06-19 | **目标读者**：后端/前端开发工程师、测试工程师、运维工程师  
> **项目路径**：`C:\Users\admin\Desktop\RuoYi-Vue-FastAPI`  
> **后端**：`ruoyi-fastapi-backend`（FastAPI 0.125 + SQLAlchemy 2.0 Async + Pydantic v2）  
> **前端**：`ruoyi-fastapi-frontend`（Vue 2.6 + Element UI 2.15 + Axios + MQTT.js）  
> **采集引擎**：Node-RED 4.1.11  
> **消息中间件**：EMQX 5.x

---

## 一、系统定位

EdgeLink 是面向工厂现场的工业物联网边缘计算平台，核心能力包括：

- **PLC 台账管理**：设备档案、点位表、导入导出、唯一性校验
- **分布式采集**：多 PC 运行 Node-RED，按设备配置驱动 PLC 通信
- **数据清洗**：数值换算（linear / slope_offset）、死区防抖、质量码标记
- **运行监控**：节点心跳、PLC 通信状态、PG 写入状态、实时告警

系统采用四层架构：

```
┌────────────────────────────────────────────┐
│  配置管理层：RuoYi Web 管理系统              │
│  PLC设备管理 / 数据点表 / 采集节点监控中心    │
└──────────────────┬─────────────────────────┘
                   │ REST API (JWT + RBAC)
┌──────────────────┴─────────────────────────┐
│  数据存储层：MySQL(配置) + PostgreSQL(时序)  │
│  Redis 缓存 / TimescaleDB 超表              │
└──────────────────┬─────────────────────────┘
                   │ 办公网 (NIC1)
┌──────────────────┴─────────────────────────┐
│  采集执行层：N 台双网口 PC + Node-RED        │
│  心跳上报 / 配置拉取 / PLC 通信 / 数据写入   │
└──────────────────┬─────────────────────────┘
                   │ 工业网 (NIC2)
┌──────────────────┴─────────────────────────┐
│  设备层：三菱/西门子/欧姆龙/基恩士 PLC        │
└────────────────────────────────────────────┘
```

---

## 二、项目结构

```
RuoYi-Vue-FastAPI/
├── ruoyi-fastapi-backend/          # 后端服务
│   ├── config/                     # 配置中心
│   │   ├── database.py             # SQLAlchemy 异步引擎与 Session
│   │   ├── env.py                  # pydantic-settings 配置聚合
│   │   └── ...
│   ├── module_plc/                 # PLC 模块（本文档重点）
│   │   ├── controller/             # FastAPI 路由
│   │   ├── dao/                    # 数据库访问对象
│   │   ├── entity/                 # ORM 模型 + Pydantic VO
│   │   │   ├── do/                 # SQLAlchemy ORM (Data Object)
│   │   │   └── vo/                 # Pydantic 校验模型 (Value Object)
│   │   ├── service/                # 业务逻辑层
│   │   └── mqtt/                   # MQTT 消费者（可选）
│   ├── module_monitor/             # 监控中心模块（已并入/重构中）
│   ├── utils/                      # 工具函数
│   ├── common/                     # 通用组件（路由、权限、审计）
│   ├── server.py                   # 应用入口
│   └── requirements.txt
│
├── ruoyi-fastapi-frontend/         # 前端服务
│   ├── src/
│   │   ├── api/plc/                # PLC 模块 API 封装
│   │   │   ├── device.js
│   │   │   ├── tag.js
│   │   │   └── monitor.js
│   │   ├── views/plc/              # PLC 模块页面
│   │   │   ├── device/index.vue
│   │   │   ├── tag/index.vue
│   │   │   └── monitor/index.vue
│   │   ├── utils/request.js        # Axios 封装 + 下载方法
│   │   └── utils/mqttClient.js     # MQTT 客户端封装
│   ├── package.json
│   └── vue.config.js
│
└── docs/                           # 技术文档
    ├── edgelink_technical_spec.md
    ├── edgelink_full_spec.md
    ├── plc_device_spec.md
    ├── edgelink_mqtt_deploy.md
    ├── edgelink_multipc_deployment.md
    ├── monitor_center.sql
    └── ...
```

---

## 三、环境搭建

### 3.1 后端环境

**依赖**

- Python 3.11+
- MySQL 5.7+（配置库）
- PostgreSQL 14+（时序库，可选 TimescaleDB）
- Redis 6+
- EMQX 5.x（MQTT Broker）

**初始化**

```bash
cd ruoyi-fastapi-backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

**配置**

复制并编辑 `.env.dev`（开发环境默认加载该文件）：

```bash
APP_ENV=dev
# MySQL
DB_TYPE=mysql
DB_HOST=127.0.0.1
DB_PORT=3307
DB_USERNAME=root
DB_PASSWORD=mysqlroot
DB_DATABASE=ruoyi-fastapi
# PostgreSQL
PG_HOST=127.0.0.1
PG_PORT=5432
PG_USERNAME=postgres
PG_PASSWORD=postgres
PG_DATABASE=ruoyi_pg
# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DATABASE=2
# MQTT
MQTT_HOST=127.0.0.1
MQTT_PORT=1883
MQTT_WS_PORT=8083
MQTT_USERNAME=web_sub
MQTT_PASSWORD=web_pass
# 监控上报 API Key（生产环境必须配置）
MONITOR_API_KEY=your-secret-key
```

**启动**

```bash
python server.py
# 或
uvicorn server:app --host 0.0.0.0 --port 9099 --reload
```

### 3.2 前端环境

```bash
cd ruoyi-fastapi-frontend
npm install
npm run dev        # 开发环境
npm run build:prod # 生产打包
```

---

## 四、后端开发规范

### 4.1 模块组织

新增功能时，按以下目录结构创建文件：

```
module_<业务>/
├── controller/<name>_controller.py   # 路由定义
├── dao/<name>_dao.py                 # 数据库操作
├── entity/do/<name>_do.py            # ORM 模型
├── entity/vo/<name>_vo.py            # Pydantic 模型
└── service/<name>_service.py         # 业务逻辑
```

### 4.2 路由自动注册

后端使用 `APIRouterPro` + `RouterRegister` 自动扫描 `module_*/controller/*.py`，无需手动注册路由。

示例：

```python
from common.router import APIRouterPro
from common.aspect.pre_auth import PreAuthDependency

my_controller = APIRouterPro(
    prefix='/my-module',
    order_num=400,
    tags=['我的模块'],
    dependencies=[PreAuthDependency()]
)

@my_controller.get('/list')
async def get_list():
    return ResponseUtil.success(data=[])
```

### 4.3 权限控制

接口权限通过 `UserInterfaceAuthDependency('plc:device:list')` 声明，对应前端菜单权限标识。

常用操作标识：

- `plc:device:list` / `plc:device:add` / `plc:device:edit` / `plc:device:remove`
- `plc:tag:list` / `plc:tag:add` / `plc:tag:edit` / `plc:tag:remove`
- `monitor:center:list` / `monitor:center:edit`

### 4.4 数据库操作规范

**必须全部使用异步 SQLAlchemy 2.0 风格。**

```python
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

class MyDao:
    @classmethod
    async def get_by_id(cls, db: AsyncSession, id: int) -> MyDo | None:
        result = await db.execute(
            select(MyDo).where(MyDo.id == id)
        )
        return result.scalars().first()
```

**事务控制**：Service 层负责 `commit`/`rollback`，DAO 层只 `flush`。

```python
try:
    await MyDao.update(db, data)
    await db.commit()
except Exception as e:
    await db.rollback()
    logger.exception(f'操作失败: {e}')
    raise
```

**并发写入保护**：高并发 upsert 场景使用 `savepoint` + 唯一约束。

```python
from sqlalchemy.exc import IntegrityError

try:
    async with db.begin_nested():
        await db.flush()
    return
except IntegrityError:
    pass  # 回退到 UPDATE
```

### 4.5 VO 模型规范

使用 Pydantic v2 + `to_camel` 别名生成器，前后端自动驼峰转换。

```python
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

class MyModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        from_attributes=True,
        populate_by_name=True
    )
    id: int | None = None
    device_name: str = Field(..., description='设备名称')
```

### 4.6 日志与审计

- 业务操作使用 `@Log(title='PLC设备管理', business_type=BusinessType.INSERT)` 记录到 `sys_oper_log`
- 内部调试使用 `from utils.log_util import logger`

---

## 五、前端开发规范

### 5.1 页面结构

每个模块页面通常包含：

```
<template>
  <div class="app-container">
    <!-- 查询条件 -->
    <el-form>...</el-form>
    <!-- 操作按钮 -->
    <el-row class="mb8">...</el-row>
    <!-- 数据表格 -->
    <el-table>...</el-table>
    <!-- 分页 -->
    <pagination />
    <!-- 弹窗 -->
    <el-dialog>...</el-dialog>
  </div>
</template>
```

### 5.2 API 封装

所有接口调用封装在 `src/api/plc/*.js`，使用 `@/utils/request`。

```javascript
import request from '@/utils/request'

export function getDevice(deviceId) {
  return request({
    url: '/plc/device/' + deviceId,
    method: 'get'
  })
}
```

### 5.3 错误处理

统一使用 `err.message` 获取错误信息：

```javascript
someApi().then(() => {
  this.$modal.msgSuccess('操作成功')
}).catch(err => {
  this.$modal.msgError(err.message || '操作失败')
})
```

### 5.4 MQTT 使用

监控中心已接入 MQTT 实时推送。新增实时功能时参考 `src/utils/mqttClient.js`。

---

## 六、PLC 模块核心说明

### 6.1 状态体系

| 字段 | 取值 | 含义 |
|------|------|------|
| `status` | `0` | 启用（Node-RED 采集） |
| `status` | `1` | 停用（保留可见，不采集） |
| `del_flag` | `0` | 正常 |
| `del_flag` | `2` | 软删除 |

**原则**：全系统零物理 DELETE，删除统一走软删除。

### 6.2 通信方式

| 通信方式 | 是否需要 PLC IP | 备注 |
|----------|----------------|------|
| `MC_Protocol` | 是 | 三菱 MC 协议，支持 3E/4E 帧 |
| `Modbus_TCP` | 是 | Modbus TCP |
| `GOT` | 是 | 触摸屏透传 |
| `PLC_RS232C` | 否 | 串口通信 |

### 6.3 校验规则

- `FX` 系列禁止使用 `4E` 帧
- 非 `PLC_RS232C` 通信方式必须填写 PLC IP
- 端口号范围 `1-65535`
- 设备名称、设备编号全局唯一（未删除记录内）

### 6.4 监控告警

| 告警类型 | 触发条件 | 恢复条件 |
|----------|----------|----------|
| `NODE_OFFLINE` | 节点心跳超时 60s | 心跳恢复 |
| `PLC_OFFLINE` | 连续 3 次通信失败 | 通信成功 |
| `PG_WRITE_LAG` | PG 写入失败 | 写入成功 |

### 6.5 Node-RED 上报接口

Node-RED 调用以下接口上报状态（需 `X-API-Key` Header）：

- `POST /monitor/heartbeat`
- `POST /monitor/device-comm`
- `POST /monitor/pg-write`

参考 `docs/nodered_mqtt_heartbeat.js` 与 `docs/nodered_mqtt_init.js`。

---

## 七、数据库变更流程

### 7.1 新增表

1. 在 `module_plc/entity/do/` 下创建 ORM 模型
2. 在 `config/database.py` 的 `Base.metadata.create_all()` 路径中确保表能自动创建（开发环境）
3. 生产环境编写 SQL 迁移脚本并放入 `docs/`

### 7.2 新增字段

1. 修改 `entity/do/*.py`
2. 同步修改 `entity/vo/*.py`
3. 编写 `ALTER TABLE` 脚本

### 7.3 唯一约束/索引

高并发场景必须加唯一约束，参考 `docs/monitor_unique_constraints.sql`。

---

## 八、Node-RED 对接

### 8.1 心跳周期

默认 30 秒上报一次心跳，携带：

- `host_pc_ip`：本机办公网 IP
- `node_ip`：实际上报 IP（可与办公网 IP 不同，用于识别工业网 IP）
- `running_flows`：运行流数量
- `memory_usage_mb`：内存占用

### 8.2 配置刷新

Node-RED 启动时和运行中按配置间隔从后端拉取设备/点位配置，具体流程参考 `docs/nodered_plc_full_flow.json`。

### 8.3 数据写入

Node-RED 将清洗后的数据写入 PostgreSQL `plc_data_log` 表，表结构参考 `docs/plc_data_log.sql`。

---

## 九、调试与测试

### 9.1 后端调试

```bash
# 启动服务
python server.py

# 查看自动注册的路由
# 访问 http://127.0.0.1:9099/dev-api/docs
```

### 9.2 前端调试

```bash
npm run dev
```

浏览器访问 `http://localhost:80`（默认）。

### 9.3 测试建议

| 场景 | 方法 |
|------|------|
| 并发新增设备 | 使用 JMeter / locust 同时创建同名设备 |
| 并发心跳上报 | 多线程调用 `/monitor/heartbeat` |
| 导入异常 | 准备含浮点 `sortOrder`、非法寄存器类型的 Excel |
| 路由切换取消下载 | 点击导出后快速切换页面 |

---

## 十、部署

### 10.1 后端部署

```bash
cd ruoyi-fastapi-backend
# 生产环境配置
APP_ENV=prod python server.py
```

### 10.2 前端部署

```bash
cd ruoyi-fastapi-frontend
npm run build:prod
# 部署 dist/ 目录到 Nginx / IIS
```

### 10.3 生产环境检查清单

- [ ] MySQL / PostgreSQL / Redis / EMQX 已启动
- [ ] `.env.prod` 中 `MONITOR_API_KEY` 已配置且与 Node-RED 一致
- [ ] Node-RED 已配置 `X-API-Key` Header
- [ ] 唯一约束 SQL 已执行
- [ ] 前端 `VUE_APP_BASE_API` 指向正确后端地址
- [ ] 前端 `VUE_APP_MQTT_WS_URL` 指向正确 EMQX WebSocket 地址

---

## 十一、常见问题

### Q1: 新增模块后路由没有自动注册？

A: 确保文件名以 `_controller.py` 结尾，且模块目录以 `module_` 开头。

### Q2: 数据库表没有自动创建？

A: 检查 `config/database.py` 中 `Base` 是否已导入该 ORM 模型。生产环境建议手动执行 SQL。

### Q3: 前端报错 `err.msg is undefined`？

A: 统一改为 `err.message`。

### Q4: 心跳上报返回 401？

A: 检查是否携带 JWT Token 与 `X-API-Key`。若 `MONITOR_API_KEY` 为空则不校验 API Key。

### Q5: 节点列表中 indust_net_ip 为空？

A: 心跳上报的 `node_ip` 需要与 `host_pc_ip` 不同才会被识别为工业网 IP。

---

## 十二、参考文档

- [系统技术式样书](./edgelink_technical_spec.md)
- [完整技术规格文档](./edgelink_full_spec.md)
- [PLC 设备管理模块规格](./plc_device_spec.md)
- [MQTT 部署指南](./edgelink_mqtt_deploy.md)
- [多 PC 部署指南](./edgelink_multipc_deployment.md)

---

*本文档随版本迭代更新，如有遗漏请联系项目负责人补充。*
