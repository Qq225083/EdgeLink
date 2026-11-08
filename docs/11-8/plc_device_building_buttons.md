# PLC 设备管理页：按栋别按钮分组

日期：2026-11-08

## 背景

PLC 设备管理页左侧原来使用「栋 → 楼层 → 工程 → 采集点」树形结构。新建采集点还没有 PLC 时也会出现在树里，层级深、空节点多，现场查看不直观。

## 变更口径

- 左侧改为「全部 + 栋别按钮」；
- 每个栋按钮显示该栋 PLC 总数；
- 没有 PLC 的采集点仍参与分组，对应栋显示 `0 台`；
- 未填写栋别的历史采集点统一归入 `未配置`；
- 新登记/编辑采集点时，栋别由后端强制必填；
- 点击栋按钮后，右侧显示该栋所有采集点下的 PLC；
- 「全部」也只统计/显示左侧可见采集点范围内的 PLC；未登记或已停用采集点上的孤儿归属不计入；
- 点击栋后，下方显示该栋具体采集点 chip；
- 新增 PLC 前必须选择具体采集点，避免挂错采集电脑；
- 搜索支持栋别、采集点名称、采集点 IP。

## 技术实现

前端：

- `ruoyi-fastapi-frontend/src/views/plc/device/index.vue`
- 移除 `el-tree`；
- 左侧采集点来源改为 `/plc/device/node-options`，只展示采集配置登记点，不展示既存监控单独登记点；
- 新增 `buildingGroups / filteredBuildingGroups / selectedBuildingGroup`；
- 新增 `selectBuilding()`；
- `selectNode()` 保留为具体采集点过滤和新增归属锁定。
- `ruoyi-fastapi-frontend/src/views/plc/siteRegister/index.vue` 栋别输入框明确为必填。
- `ruoyi-fastapi-frontend/src/views/plc/bootstrap-key/index.vue` 节点管理弹窗补齐栋别/楼层/工程，避免后端必填校验后新增/编辑失败或覆盖旧位置数据。

后端：

- `PlcDeviceQueryModel` 新增可选 `hostPcIps`；
- `DeviceDao.get_device_list()` 支持 `host_pc_ip IN (...)`；
- 新增 `GET /plc/device/node-options`，复用 `plc:device:list` 权限返回启用采集点；
- `bootstrap-key` 新增/编辑接口统一强制 `building` 非空；
- `site-health` 与 `bootstrap-key` 按办公网 IP+端口双向同步名称、工业网 IP、栋别/楼层/工程（不限 `source`）；办公网 IP+端口变化时同步迁移 `plc_device.host_pc_ip`；
- 用于点击栋时一次查询该栋多个采集点的 PLC；
- 不新增表、不改表结构。

## 边界

- `hostPcIp` 仍表示单采集点过滤；
- `hostPcIps` 仅用于栋别批量过滤；
- 两者同时传入时后端会同时套用，前端正常选择路径不会同时传；
- 采集点数量过多时，`hostPcIps` 限制为 2000 字符，当前登记规模足够。
