# 部署中心（节点与文档下载）模块设计说明

> 版本：v1.0-draft　日期：2026-08-30
> 定位：EdgeLink 交付物自助下载中心——自研节点包 / 完整部署包 / 增量部署包 / 文档手册，现场人员登录即可自取，替代"找开发要文件"。
> 设计原则：**策划好的交付中心，不是通用文件管理器**——只展示策划过的交付物，不提供任意文件上传下载。

---

## 1. 模块边界

| 做 | 不做 |
|---|---|
| manifest 策划的四类交付物下载 | 任意文件上传/下载管理 |
| 版本/大小/日期自动从磁盘读取 | 文件预览、在线编辑 |
| 打包脚本产出 zip + 更新 manifest | 后台手工维护清单 |

---

## 2. 交付物目录约定（后端）

```
ruoyi-fastapi-backend/downloads/
  manifest.json                                ← 交付物清单（随发版更新）
  packages/node-red-contrib-edgelink-site-health.zip
  full/edgelink-nodered-full-v13.zip           ← 方式一：完整 Node-RED 包（待产出）
  inc/edgelink-nodered-inc-v13.zip             ← 方式二：增量包（待产出）
  docs/EdgeLink部署手册.pdf                     ← 面向现场/用户的文档
```

manifest.json 结构（后端只读，前端按此渲染分组）：

```json
{
  "groups": [
    {
      "key": "packages",
      "title": "自研节点包",
      "items": [
        {
          "id": "site-health-node",
          "name": "存量监控节点包",
          "version": "1.0.6",
          "file": "packages/node-red-contrib-edgelink-site-health.zip",
          "desc": "下载后解压到 Node-RED 的 node_modules，重启即识别。",
          "tags": ["Node-RED ≥1.0", "零依赖"]
        }
      ]
    },
    { "key": "nodered-full", "title": "完整部署包", "items": [] },
    { "key": "nodered-inc",  "title": "增量部署包", "items": [] },
    { "key": "docs",         "title": "文档与手册", "items": [] }
  ]
}
```

- `file` 为相对 `downloads/` 的路径；**大小/修改时间由后端从磁盘 stat 补充**，manifest 不手写；
- `tags` 用于前端展示小标签（适用环境/依赖说明）。

---

## 3. 后端接口契约

实现位置：`module_admin/controller/common_controller.py`（沿用 `/common` 前缀 + JWT PreAuth）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/common/downloads/manifest` | 读取 manifest.json，逐项补充 `sizeBytes` / `updatedAt`（stat），按 groups 原样返回；文件缺失的项标 `missing: true`（前端置灰） |
| GET | `/common/download/package?file=<rel>` | 下载交付物。**安全要求**：rel 经 `os.path.realpath` 归一后必须仍位于 `downloads/` 内（防 `../` 路径穿越），否则 400；不存在返回 `{code:404}`；存在返回 `FileResponse(application/zip 或 application/octet-stream)` |

错误处理沿用项目约定（HTTP 200 + body.code 业务码）。

---

## 4. 前端页面设计

- 组件：`ruoyi-fastapi-frontend/src/views/plc/downloadCenter/index.vue`
- 权限：`deploy:center:list`（查看/下载）；后续若加 manifest 维护功能再补 `deploy:center:edit`
- 布局：按 groups 分区块，每区块标题 + 卡片行（el-row/el-col 响应式）：

```
┌ 自研节点包 ────────────────────────────┐
│ [卡片] 存量监控节点包  v1.0.6  [Node-RED≥1.0][零依赖]
│        下载后解压到 node_modules，重启即识别
│        8.4 KB · 2026-08-30 · [下载]     │
└─────────────────────────────────────────┘
```

- 卡片字段：名称、版本 tag、描述、tags、大小（自动换算 KB/MB）、更新时间、下载按钮（loading 态）；
- `missing: true` 的项按钮置灰并提示「文件未就位，请联系管理员」；
- 下载方法：`this.$download.zip('/common/download/package?file=' + encodeURIComponent(file), name)`（axios+blob 携带 JWT）；
- 页面顶部 el-alert 提示：「现场部署请先下载对应安装包，按附带的安装说明操作」。

---

## 5. 菜单设计

挂在 EdgeLink 系统目录（2083）下、与采集配置同级，order_num 5（可视化/点检为隐藏项不占视觉序）：

| menu_id | 名称 | parent | path | component | perms | 类型 |
|---|---|---|---|---|---|---|
| 3010 | 部署中心 | 2083 | deploy-center | plc/downloadCenter/index | deploy:center:list | C |

> 若后期加「交付物维护」（上传/编辑 manifest），补 F 型按钮 `deploy:center:edit`。

---

## 6. 打包与发版约定（关键纪律）

1. 每个交付物由对应打包脚本产出（复用 `v13/tools/export_*` 模式），产出 zip 的同时**更新 manifest.json 的 version**；
2. manifest.json 入 Git 版本管理——下载页展示的版本永远真实可溯；
3. 完整包/增量包的打包脚本（后续任务）必须输出排除清单（凭据/日志/spool/缓存一律不入包）。

---

## 7. 扩展点（预留）

- manifest 增项 = 发新包，前端零改动；
- 后续可加「安装说明在线查看」（item 增加 `guide` 字段，页内抽屉展示 markdown）；
- 后续可加「更新检查」（现场节点包上报版本 vs manifest 版本，监控页提示可升级）。
