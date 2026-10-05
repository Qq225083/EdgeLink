<template>
  <div class="app-container">
    <!-- 说明 -->
    <el-card shadow="never" class="tip-card">
      <div class="tip-title"><i class="el-icon-info" /> 流程生成与发布</div>
      <p class="tip-text">
        按采集点把当前<b>已发布配置</b>生成为纯现成节点的 Node-RED flows.json（每 PLC 一条独立采集支路 + 基础设施）。
        点「部署」经 Admin API 一键推送到边缘：<b>默认只替换生成标签页</b>，边缘上的自定义程序不受影响（部署前弹窗会列出替换/保留清单）。
        MQTT/PG 凭证可在生成时填写并随部署自动下发，或留空在编辑器里录入一次（按节点 id 保留，重新部署不丢失）。
        每次部署自动归档画布快照（含自定义逻辑），误删/换机可从「画布快照」下载恢复。
      </p>
    </el-card>

    <!-- 操作栏 -->
    <el-card shadow="never" class="form-card">
      <el-form :inline="true">
        <el-form-item label="采集点">
          <el-select v-model="queryParams.siteId" placeholder="选择采集点" filterable clearable style="width: 300px" @change="handleSiteChange">
            <el-option v-for="s in siteOptions" :key="s.id" :label="`${s.siteName}（${s.officeIp}:${s.nodePort || '-'}）`" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" icon="el-icon-magic-stick" :disabled="!queryParams.siteId" :loading="generating" @click="openGenerateDialog">生成流程</el-button>
          <el-button icon="el-icon-camera" :disabled="!queryParams.siteId" @click="openSnapshotDialog">画布快照</el-button>
          <el-button icon="el-icon-refresh" @click="getList">刷新</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 边缘状态（漂移检测 + 节点包版本留痕） -->
    <el-card v-if="queryParams.siteId && deployStatus" shadow="never" class="form-card">
      <div class="deploy-status">
        <template v-if="deployStatus.online">
          <el-tag type="success" size="small">边缘在线</el-tag>
          <span class="ds-item">{{ deployStatus.edge }} · {{ deployStatus.edgeNodeCount }} 节点</span>
          <el-tag v-if="deployStatus.runningVersion" type="warning" size="small">边缘在跑 v{{ deployStatus.runningVersion }}</el-tag>
          <el-tag v-else type="info" size="small">边缘版本未回执</el-tag>
          <el-tag v-if="deployStatus.match === true" type="success" size="small">与最新版 v{{ deployStatus.latestVersion }} 一致</el-tag>
          <el-tag v-else-if="deployStatus.match === false" type="danger" size="small">画布与最新版 v{{ deployStatus.latestVersion }} 不一致（可能被手改或未部署）</el-tag>
          <el-tag v-else type="info" size="small">尚无版本可比对</el-tag>
          <span v-if="deployStatus.modules" class="ds-item ds-modules">实装：{{ deployStatus.modules }}</span>
          <span class="ds-item" style="margin-left:auto">
            部署模式：
            <el-switch v-model="deployFullReplace" active-text="全量清空" inactive-text="只替换GEN_标签页" />
          </span>
        </template>
        <template v-else>
          <el-tag type="info" size="small">边缘离线</el-tag>
          <span class="ds-item">{{ deployStatus.edge }} 不可达（Node-RED 未启动或网络不通），部署/漂移检测暂不可用</span>
        </template>
        <el-button type="text" icon="el-icon-refresh" style="margin-left:auto" @click="loadDeployStatus">刷新</el-button>
      </div>
    </el-card>

    <!-- 版本列表 -->
    <el-table v-loading="loading" :data="releaseList">
      <el-table-column label="版本" prop="version" width="70" align="center" />
      <el-table-column label="配置快照版本" prop="configVersion" width="110" align="center" />
      <el-table-column label="设备数" prop="deviceCount" width="80" align="center" />
      <el-table-column label="节点数" prop="nodeCount" width="80" align="center">
        <template slot-scope="scope">
          <span :style="scope.row.nodeCount > 500 ? 'color:#f56c6c;font-weight:bold' : ''">{{ scope.row.nodeCount }}</span>
        </template>
      </el-table-column>
      <el-table-column label="内容哈希" prop="sha256" width="120" align="center">
        <template slot-scope="scope">{{ (scope.row.sha256 || '').slice(0, 8) }}</template>
      </el-table-column>
      <el-table-column label="生成告警" prop="remark" :show-overflow-tooltip="true">
        <template slot-scope="scope">
          <span v-if="scope.row.remark" style="color:#e6a23c">{{ scope.row.remark }}</span>
          <span v-else style="color:#67c23a">无</span>
        </template>
      </el-table-column>
      <el-table-column label="生成人" prop="createBy" width="90" align="center" />
      <el-table-column label="生成时间" prop="createTime" width="160" align="center" />
      <el-table-column label="状态" width="150" align="center">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.status === '1'" type="success" size="mini">已部署</el-tag>
          <el-tag v-else type="info" size="mini">草稿</el-tag>
          <div v-if="scope.row.deployTime" style="font-size:11px;color:#909399">{{ scope.row.deployTime }}</div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="290" align="center" fixed="right">
        <template slot-scope="scope">
          <el-button size="mini" type="text" icon="el-icon-view" @click="handlePreview(scope.row)">预览</el-button>
          <el-button size="mini" type="text" icon="el-icon-download" :loading="scope.row._downloading" @click="handleDownload(scope.row)">下载</el-button>
          <el-button size="mini" type="text" icon="el-icon-position" style="color:#67c23a" :loading="scope.row._deploying" @click="handleDeploy(scope.row)">部署</el-button>
          <el-button size="mini" type="text" icon="el-icon-refresh-left" style="color:#e6a23c" :loading="scope.row._rollbacking" @click="handleRollback(scope.row)">回滚</el-button>
        </template>
      </el-table-column>
    </el-table>
    <pagination v-show="total > 0" :total="total" :page.sync="queryParams.pageNum" :limit.sync="queryParams.pageSize" @pagination="getList" />

    <!-- 生成参数对话框 -->
    <el-dialog title="生成流程" :visible.sync="generateOpen" width="640px" append-to-body>
      <el-alert type="info" :closable="false" style="margin-bottom: 12px"
        title="默认参数通常无需修改；topic 前缀在切流前保持 edgelink/gen（与现网隔离），切换时改 edgelink。" />
      <el-form :model="generateForm" label-width="130px">
        <el-form-item label="MQTT topic前缀">
          <el-input v-model="generateForm.topicPrefix" maxlength="100" />
        </el-form-item>
        <el-form-item label="标签页前缀">
          <el-input v-model="generateForm.tabPrefix" maxlength="16" style="width: 180px" />
          <span style="font-size:11px;color:#909399;margin-left:8px">生成标签页名 = 前缀+采集_设备名；部署按 id 认门，前缀仅用于展示与残留清理</span>
        </el-form-item>
        <el-form-item label="块读空洞容忍">
          <el-input-number v-model="generateForm.blockGap" :min="0" :max="32" style="width: 180px" />
          <span style="font-size:11px;color:#909399;margin-left:8px">字；跳址点位（如只读 D1/D3/D5…）间隙≤该值时合并成一块，多读几字丢弃。0=只合并连续地址</span>
        </el-form-item>
        <el-form-item label="MQTT broker">
          <el-row :gutter="8">
            <el-col :span="15"><el-input v-model="generateForm.mqttHost" placeholder="地址" /></el-col>
            <el-col :span="9"><el-input-number v-model="generateForm.mqttPort" :min="1" :max="65535" style="width:100%" /></el-col>
          </el-row>
          <el-row :gutter="8" style="margin-top:6px">
            <el-col :span="12"><el-input v-model="generateForm.mqttUsername" placeholder="账号（留空=现场编辑器录入）" maxlength="64" /></el-col>
            <el-col :span="12"><el-input v-model="generateForm.mqttPassword" type="password" show-password placeholder="密码" maxlength="128" /></el-col>
          </el-row>
        </el-form-item>
        <el-form-item label="后端上报地址">
          <el-row :gutter="8">
            <el-col :span="15"><el-input v-model="generateForm.backendHost" placeholder="site-health 上报指向" /></el-col>
            <el-col :span="9"><el-input-number v-model="generateForm.backendPort" :min="1" :max="65535" style="width:100%" /></el-col>
          </el-row>
        </el-form-item>
        <el-form-item label="PG 写库支路">
          <el-switch v-model="generateForm.enablePg" active-text="生成" inactive-text="不生成" />
          <span style="margin-left:8px;color:#e6a23c;font-size:12px">postgres 节点格式待真机验证，默认关</span>
        </el-form-item>
        <template v-if="generateForm.enablePg">
          <el-form-item label="PG 地址">
            <el-row :gutter="8">
              <el-col :span="15"><el-input v-model="generateForm.pgHost" /></el-col>
              <el-col :span="9"><el-input-number v-model="generateForm.pgPort" :min="1" :max="65535" style="width:100%" /></el-col>
            </el-row>
            <span style="font-size:11px;color:#909399">所有目标共用；账号密码在 Node-RED 侧按节点录入一次（credential）</span>
          </el-form-item>
          <el-form-item v-for="(tgt, ti) in generateForm.pgTargets" :key="ti" :label="'目标 ' + (ti + 1)">
            <div class="pg-target-box">
              <el-row :gutter="8">
                <el-col :span="7"><el-input v-model="tgt.pgDb" placeholder="库名" maxlength="64" /></el-col>
                <el-col :span="7"><el-input v-model="tgt.pgSchema" placeholder="模式，如 public" maxlength="64" /></el-col>
                <el-col :span="8"><el-input v-model="tgt.pgTable" placeholder="表名" maxlength="64" /></el-col>
              </el-row>
              <el-row :gutter="8" style="margin-top:6px">
                <el-col :span="20">
                  <el-select v-model="tgt.pgFields" multiple collapse-tags placeholder="插入字段（默认全部列）" style="width: 100%">
                    <el-option v-for="f in pgFieldOptions" :key="f.value" :label="f.label" :value="f.value" :disabled="f.required" />
                  </el-select>
                </el-col>
                <el-col :span="4" style="text-align:right">
                  <el-button v-if="generateForm.pgTargets.length > 1" type="text" icon="el-icon-delete" style="color:#f56c6c" @click="generateForm.pgTargets.splice(ti, 1)" />
                </el-col>
              </el-row>
              <el-row :gutter="8" style="margin-top:6px">
                <el-col :span="12"><el-input v-model="tgt.pgUser" placeholder="PG 账号（留空=现场编辑器录入）" maxlength="64" /></el-col>
                <el-col :span="12"><el-input v-model="tgt.pgPassword" type="password" show-password placeholder="PG 密码" maxlength="128" /></el-col>
              </el-row>
            </div>
          </el-form-item>
          <el-form-item label=" ">
            <el-button type="text" icon="el-icon-plus" @click="addPgTarget">添加写入目标（可同时写多张表）</el-button>
            <span style="font-size:11px;color:#909399;margin-left:6px">设备ID/点位ID/质量码为必填列，自动带上</span>
          </el-form-item>
        </template>
      </el-form>
      <div slot="footer">
        <el-button @click="generateOpen = false">取 消</el-button>
        <el-button type="primary" :loading="generating" @click="handleGenerate">生 成</el-button>
      </div>
    </el-dialog>

    <!-- 预览对话框 -->
    <el-dialog title="flows.json 预览" :visible.sync="previewOpen" width="900px" append-to-body>
      <pre class="json-preview">{{ previewText }}</pre>
      <div slot="footer">
        <el-button @click="previewOpen = false">关 闭</el-button>
      </div>
    </el-dialog>

    <!-- 画布快照对话框 -->
    <el-dialog title="边缘画布快照（含自定义标签页，误删/换机恢复用）" :visible.sync="snapshotOpen" width="760px" append-to-body>
      <div style="margin-bottom:10px">
        <el-button type="primary" size="small" icon="el-icon-camera" :loading="snapshotting" @click="handleCreateSnapshot">立即备份当前画布</el-button>
        <span style="font-size:12px;color:#909399;margin-left:8px">部署成功也会自动归档；每现场保留最近 20 份</span>
      </div>
      <el-table v-loading="snapshotLoading" :data="snapshotList" size="small" max-height="400">
        <el-table-column label="ID" prop="id" width="70" align="center" />
        <el-table-column label="来源" width="90" align="center">
          <template slot-scope="scope">
            <el-tag size="mini" :type="scope.row.source === 'deploy' ? 'success' : 'warning'">{{ scope.row.source === 'deploy' ? '部署归档' : '手动备份' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="关联版本" width="90" align="center">
          <template slot-scope="scope">{{ scope.row.releaseId ? 'v' + (releaseVersionMap[scope.row.releaseId] || scope.row.releaseId) : '-' }}</template>
        </el-table-column>
        <el-table-column label="节点数" prop="nodeCount" width="80" align="center" />
        <el-table-column label="操作人" prop="createBy" width="90" align="center" />
        <el-table-column label="归档时间" prop="createTime" width="160" align="center" />
        <el-table-column label="操作" width="90" align="center">
          <template slot-scope="scope">
            <el-button size="mini" type="text" icon="el-icon-download" @click="handleDownloadSnapshot(scope.row)">下载</el-button>
          </template>
        </el-table-column>
      </el-table>
      <pagination v-show="snapshotTotal > 0" :total="snapshotTotal" :page.sync="snapshotQuery.pageNum" :limit.sync="snapshotQuery.pageSize" @pagination="getSnapshotList" />
    </el-dialog>
  </div>
</template>

<script>
import { listSite } from "@/api/plc/siteHealth";
import { generateFlow, listRelease, getRelease, downloadRelease, rollbackRelease, deployRelease, getDeployStatus, getDeployPreview, createSnapshot, listSnapshot, downloadSnapshot } from "@/api/plc/flowRelease";
import { saveAs } from "file-saver";

export default {
  name: "FlowRelease",
  data() {
    return {
      loading: false,
      generating: false,
      generateOpen: false,
      previewOpen: false,
      previewText: "",
      siteOptions: [],
      releaseList: [],
      deployStatus: null,
      deployFullReplace: false,
      snapshotOpen: false,
      snapshotLoading: false,
      snapshotting: false,
      snapshotList: [],
      snapshotTotal: 0,
      snapshotQuery: { pageNum: 1, pageSize: 10, siteId: null },
      total: 0,
      queryParams: { pageNum: 1, pageSize: 10, siteId: null },
      generateForm: {
        topicPrefix: "edgelink/gen",
        tabPrefix: "GEN_",
        blockGap: 8,
        mqttHost: "127.0.0.1",
        mqttPort: 1883,
        backendHost: "127.0.0.1",
        backendPort: 9099,
        enablePg: false,
        pgHost: "127.0.0.1",
        pgPort: 5432,
        mqttUsername: "",
        mqttPassword: "",
        pgTargets: [{ pgDb: "ruoyi_pg", pgSchema: "public", pgTable: "plc_data_log", pgFields: [], pgUser: "", pgPassword: "" }]
      },
      pgFieldOptions: [
        { value: 'device_id', label: '设备ID', required: true }, { value: 'tag_id', label: '点位ID', required: true },
        { value: 'node_id', label: '节点ID' }, { value: 'tag_name', label: '点位名称' },
        { value: 'tag_address', label: '寄存器地址' }, { value: 'register_type', label: '寄存器类型' },
        { value: 'raw_value', label: '原始值' }, { value: 'eng_value', label: '工程值' },
        { value: 'unit', label: '单位' }, { value: 'quality', label: '质量码', required: true },
        { value: 'transform_type', label: '换算类型' }, { value: 'ts', label: '采集时间' }
      ]
    };
  },
  created() {
    this.loadSites();
  },
  computed: {
    releaseVersionMap() {
      const m = {};
      this.releaseList.forEach(r => { m[r.id] = r.version; });
      return m;
    }
  },
  methods: {
    loadSites() {
      listSite({ pageNum: 1, pageSize: 100 }).then(response => {
        this.siteOptions = response.rows || [];
        if (this.siteOptions.length > 0 && !this.queryParams.siteId) {
          this.queryParams.siteId = this.siteOptions[0].id;
          this.getList();
        }
      });
    },
    handleSiteChange() {
      this.queryParams.pageNum = 1;
      this.getList();
    },
    loadDeployStatus() {
      if (!this.queryParams.siteId) { this.deployStatus = null; return; }
      getDeployStatus(this.queryParams.siteId).then(response => {
        this.deployStatus = response.data || null;
      }).catch(() => { this.deployStatus = null; });
    },
    getList() {
      if (!this.queryParams.siteId) { this.releaseList = []; this.total = 0; return; }
      this.loadDeployStatus();
      this.loading = true;
      listRelease(this.queryParams).then(response => {
        this.releaseList = (response.rows || []).map(item => ({ ...item, _downloading: false, _rollbacking: false, _deploying: false }));
        this.total = response.total || 0;
        this.loading = false;
      }).catch(() => { this.loading = false; });
    },
    openGenerateDialog() {
      this.generateOpen = true;
    },
    addPgTarget() {
      const last = this.generateForm.pgTargets[this.generateForm.pgTargets.length - 1] || {};
      this.generateForm.pgTargets.push({
        pgDb: last.pgDb || "ruoyi_pg", pgSchema: "public", pgTable: "", pgFields: [], pgUser: "", pgPassword: ""
      });
    },
    handleGenerate() {
      const payload = { siteId: this.queryParams.siteId, ...this.generateForm };
      if (payload.enablePg) {
        payload.pgTargets = payload.pgTargets.map(t => ({
          pgHost: payload.pgHost, pgPort: payload.pgPort,
          pgDb: t.pgDb, pgSchema: t.pgSchema, pgTable: t.pgTable,
          pgFields: (t.pgFields && t.pgFields.length) ? t.pgFields : null,
          pgUser: t.pgUser || "", pgPassword: t.pgPassword || ""
        }));
      }
      this.generating = true;
      generateFlow(payload).then(response => {
        this.generating = false;
        this.generateOpen = false;
        const data = response.data || {};
        const warnings = data.warnings || [];
        if (warnings.length > 0) {
          this.$alert(warnings.join("<br/>"), response.msg || "生成完成", { dangerouslyUseHTMLString: true, type: "warning" });
        } else {
          this.$modal.msgSuccess(response.msg || "生成成功");
        }
        this.getList();
      }).catch(() => { this.generating = false; });
    },
    handlePreview(row) {
      getRelease(row.id).then(response => {
        const payload = (response.data || {}).payload || "";
        try {
          this.previewText = JSON.stringify(JSON.parse(payload), null, 2);
        } catch (e) {
          this.previewText = payload;
        }
        this.previewOpen = true;
      });
    },
    handleDownload(row) {
      row._downloading = true;
      downloadRelease(row.id).then(res => {
        saveAs(new Blob([res.data], { type: "application/json" }), `flows_site${row.siteId}_v${row.version}.json`);
        row._downloading = false;
      }).catch(() => { row._downloading = false; });
    },
    handleRollback(row) {
      this.$confirm(`将以 v${row.version} 的内容生成一个新版本作为最新版（版本链只前进不后退，可随时再回滚回来）。确认回滚？`, "回滚确认", {
        confirmButtonText: "回滚", cancelButtonText: "取消", type: "warning"
      }).then(() => {
        row._rollbacking = true;
        rollbackRelease(row.id).then(response => {
          row._rollbacking = false;
          this.$modal.msgSuccess(response.msg || "回滚完成");
          this.getList();
        }).catch(() => { row._rollbacking = false; });
      }).catch(() => {});
    },
    handleDeploy(row) {
      const modeText = this.deployFullReplace
        ? "【全量清空】边缘上所有现有流程（含其他程序）都会被删除后替换"
        : "【合并部署】只替换生成标签页，边缘上其他程序原样保留";
      const doDeploy = () => {
        row._deploying = true;
        deployRelease(row.id, this.deployFullReplace).then(response => {
          row._deploying = false;
          const data = response.data || {};
          this.$alert(
            `部署成功。${data.mode === 'merge' ? `移除旧生成节点 ${data.removed} 个，其他程序未动。` : '全量替换完成。'}${data.modules ? `边缘实装节点包版本：${data.modules}` : ''}`,
            "部署结果",
            { type: "success" }
          );
          this.getList();
        }).catch(() => { row._deploying = false; });
      };
      const showConfirm = (previewHtml) => {
        this.$confirm(
          `将把 v${row.version} 推送到边缘 Node-RED 并立即生效。${modeText}。${previewHtml}部署期间该现场采集会短暂中断重连（约数秒），变化过滤基线清零。确认部署？`,
          "部署确认",
          { confirmButtonText: "部署", cancelButtonText: "取消", type: "warning", dangerouslyUseHTMLString: true }
        ).then(doDeploy).catch(() => {});
      };
      // 部署预览：列出将替换/摘除/新增/保留的标签页（边缘离线时降级为纯确认）
      getDeployPreview(row.id).then(response => {
        const p = response.data || {};
        if (!p.online) { showConfirm(""); return; }
        const sec = (title, arr, color) => arr && arr.length
          ? `<div style="margin:4px 0"><b style="color:${color}">${title}</b>：${arr.join("、")}</div>` : "";
        const driftWarn = p.genDrift
          ? `<div style="margin:4px 0;color:#f56c6c;font-weight:bold">⚠️ 检测到生成页面被手工修改（或边缘在跑其他版本），部署将把生成区覆盖回 v${row.version} 的内容，手工修改会丢失！建议先备份画布快照。</div>` : "";
        showConfirm(
          `<div style="margin:8px 0;padding:8px;background:#f5f7fa;border-radius:4px;font-size:12px">` +
          driftWarn +
          sec("将替换", p.replace, "#e6a23c") + sec("将摘除", p.remove, "#f56c6c") +
          sec("将新增", p.add, "#67c23a") + sec("将保留（不动）", p.keep, "#409EFF") +
          `</div>`
        );
      }).catch(() => showConfirm(""));
    },
    openSnapshotDialog() {
      this.snapshotQuery.siteId = this.queryParams.siteId;
      this.snapshotQuery.pageNum = 1;
      this.snapshotOpen = true;
      this.getSnapshotList();
    },
    getSnapshotList() {
      this.snapshotLoading = true;
      listSnapshot(this.snapshotQuery).then(response => {
        this.snapshotList = response.rows || [];
        this.snapshotTotal = response.total || 0;
        this.snapshotLoading = false;
      }).catch(() => { this.snapshotLoading = false; });
    },
    handleCreateSnapshot() {
      this.snapshotting = true;
      createSnapshot(this.queryParams.siteId).then(response => {
        this.snapshotting = false;
        this.$modal.msgSuccess(response.msg || "快照已保存");
        this.getSnapshotList();
      }).catch(() => { this.snapshotting = false; });
    },
    handleDownloadSnapshot(row) {
      downloadSnapshot(row.id).then(res => {
        saveAs(new Blob([res.data], { type: "application/json" }), `canvas_snapshot_site${row.siteId}_${row.id}.json`);
      });
    }
  }
};
</script>

<style scoped>
.tip-card { margin-bottom: 12px; }
.tip-title { font-weight: bold; margin-bottom: 6px; }
.tip-text { color: #606266; font-size: 13px; line-height: 1.6; margin: 0; }
.form-card { margin-bottom: 12px; }
.deploy-status {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ds-item { color: #606266; font-size: 13px; }
.ds-modules { color: #909399; font-size: 12px; }
.pg-target-box {
  border: 1px dashed #dcdfe6;
  border-radius: 4px;
  padding: 8px 10px;
  width: 100%;
  background: #fafafa;
}
.json-preview {
  max-height: 60vh;
  overflow: auto;
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 12px;
  font-size: 12px;
  line-height: 1.5;
  border-radius: 4px;
}
</style>
