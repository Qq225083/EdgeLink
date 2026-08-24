<template>
  <div class="app-container">
    <!-- 统计卡片（围绕「待发布变更」与发布通道状态） -->
    <el-row :gutter="16" class="kpi-row">
      <el-col :span="6">
        <div class="kpi-card kpi-blue">
          <div class="kpi-value">{{ stats.changedDeviceCount }}</div>
          <div class="kpi-label">待发布变更设备</div>
          <div class="kpi-sub">新增 {{ stats.changedBreakdown.added }} · 修改 {{ stats.changedBreakdown.modified }} · 删除 {{ stats.changedBreakdown.deleted }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="kpi-card kpi-purple">
          <div class="kpi-value">{{ stats.changedAffectedHostCount }}</div>
          <div class="kpi-label">变更涉及采集节点</div>
          <div class="kpi-sub">变更点位 {{ stats.changedTagCount }} 个</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="kpi-card kpi-green">
          <div class="kpi-value">{{ stats.snapshotVersion ? 'v' + stats.snapshotVersion : '--' }}</div>
          <div class="kpi-label">当前快照版本</div>
          <div class="kpi-sub">{{ stats.lastPublishTime ? '最近发布 ' + parseTime(stats.lastPublishTime) : '尚未发布过' }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="kpi-card" :class="edgeCardClass">
          <div class="kpi-value">{{ stats.edgeNodes.online }}/{{ stats.edgeNodes.total }}</div>
          <div class="kpi-label">边缘节点在线</div>
          <div class="kpi-sub">{{ edgeVersionText }}</div>
        </div>
      </el-col>
    </el-row>

    <!-- 操作栏 -->
    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-button type="primary" icon="el-icon-refresh" size="mini" @click="getList">刷新</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button
          type="success"
          icon="el-icon-upload2"
          size="mini"
          :disabled="selectedIds.length === 0"
          @click="handlePublishSelected"
          v-hasPermi="['plc:publish:edit']"
        >发布选中</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button
          type="warning"
          icon="el-icon-upload2"
          size="mini"
          :disabled="total === 0"
          @click="handlePublishAll"
          v-hasPermi="['plc:publish:edit']"
        >发布全部变更</el-button>
      </el-col>
      <right-toolbar :showSearch.sync="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <!-- 影响范围预览 -->
    <el-card v-if="selectedIds.length > 0" class="impact-card" style="margin-bottom: 16px">
      <div slot="header">
        <span><i class="el-icon-warning-outline" /> 已选设备影响范围</span>
      </div>
      <el-row :gutter="16">
        <el-col :span="12">
          <div class="impact-summary">
            <div>已选设备：<b>{{ selectedIds.length }}</b> 台</div>
            <div>涉及采集节点：<b>{{ impactByHost.length }}</b> 个</div>
          </div>
        </el-col>
        <el-col :span="12">
          <el-tag
            v-for="item in impactByHost"
            :key="item.hostPcIp"
            type="info"
            size="small"
            style="margin: 0 8px 8px 0"
          >
            {{ item.hostPcIp }} ({{ item.deviceCount }}台)
          </el-tag>
        </el-col>
      </el-row>
    </el-card>

    <!-- 设备列表（仅展示与最新已发布快照有差异的设备） -->
    <el-table ref="deviceTable" v-loading="loading" :data="deviceList" @selection-change="handleSelectionChange">
      <el-table-column type="selection" width="55" align="center" :selectable="rowSelectable" />
      <el-table-column label="设备编号" align="center" prop="deviceCode" width="120" :show-overflow-tooltip="true" />
      <el-table-column label="设备名称" align="center" prop="deviceName" width="160" :show-overflow-tooltip="true" />
      <el-table-column label="变更类型" align="center" width="90">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.changeType === 'added'" type="success" size="small">新增</el-tag>
          <el-tag v-else-if="scope.row.changeType === 'deleted'" type="danger" size="small">删除</el-tag>
          <el-tag v-else type="warning" size="small">修改</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="变更内容" align="left" min-width="220" :show-overflow-tooltip="true">
        <template slot-scope="scope">
          <span v-if="scope.row.changeType === 'added'">新设备，首次发布（{{ scope.row.tagCount }} 个点位）</span>
          <span v-else-if="scope.row.changeType === 'deleted'">{{ deleteSummary(scope.row) }}</span>
          <span v-else>{{ modifiedSummary(scope.row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="采集节点 IP" align="center" prop="hostPcIp" width="140" />
      <el-table-column label="点位数" align="center" prop="tagCount" width="80" />
      <el-table-column label="最后更新时间" align="center" prop="updateTime" width="170">
        <template slot-scope="scope">
          <span>{{ parseTime(scope.row.updateTime) }}</span>
        </template>
      </el-table-column>
      <template slot="empty">
        <div class="publish-empty">
          <i class="el-icon-circle-check" />
          <p>当前无待发布变更，所有配置与最新已发布快照一致</p>
          <p class="publish-empty-sub" v-if="stats.snapshotVersion">
            当前快照版本：v{{ stats.snapshotVersion }}<span v-if="stats.lastPublishTime">（最近发布：{{ parseTime(stats.lastPublishTime) }}）</span>
          </p>
          <p class="publish-empty-sub" v-else>尚未发布过配置</p>
        </div>
      </template>
    </el-table>

    <!-- 分页 -->
    <pagination
      v-show="total > 0"
      :total="total"
      :page.sync="queryParams.pageNum"
      :limit.sync="queryParams.pageSize"
      @pagination="getList"
    />

    <!-- 发布确认弹窗 -->
    <el-dialog :title="publishTitle" :visible.sync="confirmOpen" width="500px" append-to-body>
      <div class="publish-confirm-body">
        <p><i class="el-icon-warning" style="color: #E6A23C; margin-right: 8px" />{{ publishMessage }}</p>
        <div v-if="!isPublishAll" class="impact-detail">
          <div class="impact-title">影响节点分布：</div>
          <el-tag
            v-for="item in impactByHost"
            :key="item.hostPcIp"
            type="info"
            size="small"
            style="margin: 0 8px 8px 0"
          >
            {{ item.hostPcIp }} ({{ item.deviceCount }}台)
          </el-tag>
        </div>
        <div v-else class="impact-detail">
          <div class="impact-title">将把当前全部配置固化为新快照（v{{ (stats.snapshotVersion || 0) + 1 }}），</div>
          <div>并通知全部 <b>{{ stats.affectedHostCount }}</b> 个采集节点；本次含变更设备 <b>{{ stats.changedDeviceCount }}</b> 台。</div>
        </div>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button type="primary" :loading="publishLoading" @click="submitPublish">确 定</el-button>
          <el-button @click="cancelPublish">取 消</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script>
import { listPublishDevice, publishConfig } from "@/api/plc/publish";

export default {
  name: "PlcPublishCenter",
  data() {
    return {
      // 加载状态
      loading: true,
      publishLoading: false,
      // 搜索显示
      showSearch: true,
      // 查询参数
      queryParams: {
        pageNum: 1,
        pageSize: 10
      },
      // 列表数据
      deviceList: [],
      total: 0,
      // 选中数据
      selectedIds: [],
      selectedRows: [],
      // 统计
      stats: {
        totalEnabledDevices: 0,
        totalEnabledTags: 0,
        affectedHostCount: 0,
        lastPublishTime: null,
        snapshotVersion: 0,
        changedDeviceCount: 0,
        changedBreakdown: { added: 0, modified: 0, deleted: 0 },
        changedAffectedHostCount: 0,
        changedTagCount: 0,
        edgeNodes: { total: 0, online: 0, lastHeartbeatAgoSec: null, appliedVersionMin: null, nodes: [] }
      },
      // 确认弹窗
      confirmOpen: false,
      isPublishAll: false,
      publishTitle: "确认发布配置",
      publishMessage: "",
      // 设备级字段键名 → 中文标签（变更摘要展示用）
      DEVICE_FIELD_LABELS: {
        deviceName: "设备名称", hostPcIp: "采集节点", backupPcIp: "备用节点",
        plcIp: "PLC IP", plcPort: "PLC端口", comType: "通信方式", mcFrame: "帧格式",
        plcSeries: "系列", stationNo: "站号", networkNo: "网络号",
        scanIntervalMs: "采集周期", commTimeoutMs: "通信超时", retryCount: "重试次数",
        retryIntervalMs: "重试间隔", triggerKind: "触发方式", status: "启停状态",
        protocolParams1: "协议参数"
      }
    };
  },
  computed: {
    /** 按采集节点 IP 分组的影响范围 */
    impactByHost() {
      const groups = {};
      this.selectedRows.forEach(row => {
        const ip = row.hostPcIp || "未配置";
        if (!groups[ip]) {
          groups[ip] = { hostPcIp: ip, deviceCount: 0 };
        }
        groups[ip].deviceCount += 1;
      });
      return Object.values(groups);
    },
    /** 边缘心跳副标题 */
    edgeHeartbeatText() {
      const ago = this.stats.edgeNodes.lastHeartbeatAgoSec;
      if (ago === null || ago === undefined) return "暂无心跳";
      if (ago < 60) return `最近心跳 ${ago}s 前`;
      return `最近心跳 ${Math.floor(ago / 60)}min 前`;
    },
    /** 边缘已应用版本副标题：与最新快照对比（未上报时回退为心跳文本） */
    edgeVersionText() {
      const applied = this.stats.edgeNodes.appliedVersionMin;
      const latest = this.stats.snapshotVersion;
      if (applied === null || applied === undefined) return this.edgeHeartbeatText;
      if (!latest) return "边缘已应用 v" + applied;
      if (applied >= latest) return `已应用 v${applied}，与最新一致`;
      return `已应用 v${applied}，最新 v${latest}（待收敛）`;
    },
    /** 第 4 卡颜色：有节点离线或已应用版本落后最新快照 → 红色 */
    edgeCardClass() {
      const e = this.stats.edgeNodes;
      const allOnline = e.total > 0 && e.online === e.total;
      const lagging = e.appliedVersionMin !== null && e.appliedVersionMin !== undefined
        && this.stats.snapshotVersion > 0 && e.appliedVersionMin < this.stats.snapshotVersion;
      return (allOnline && !lagging) ? "kpi-orange" : "kpi-red";
    }
  },
  created() {
    this.getList();
  },
  methods: {
    /** 查询可发布设备列表 */
    getList() {
      this.loading = true;
      listPublishDevice(this.queryParams).then(response => {
        this.deviceList = response.rows || [];
        this.total = response.total || 0;
        if (response.stats) {
          const s = response.stats;
          this.stats = {
            totalEnabledDevices: s.totalEnabledDevices || 0,
            totalEnabledTags: s.totalEnabledTags || 0,
            affectedHostCount: s.affectedHostCount || 0,
            lastPublishTime: s.lastPublishTime || null,
            snapshotVersion: s.snapshotVersion || 0,
            changedDeviceCount: s.changedDeviceCount || 0,
            changedBreakdown: s.changedBreakdown || { added: 0, modified: 0, deleted: 0 },
            changedAffectedHostCount: s.changedAffectedHostCount || 0,
            changedTagCount: s.changedTagCount || 0,
            edgeNodes: s.edgeNodes || { total: 0, online: 0, lastHeartbeatAgoSec: null, appliedVersionMin: null, nodes: [] }
          };
        }
        this.loading = false;
      }).catch(() => {
        this.loading = false;
      });
    },

    /** 表格选择变化 */
    handleSelectionChange(selection) {
      this.selectedIds = selection.map(item => item.id);
      this.selectedRows = selection;
    },

    /** 删除墓碑行不可勾选（设备已不存在，只能随整体快照发布移除） */
    rowSelectable(row) {
      return row.changeType !== "deleted";
    },

    /** 删除行的变更内容说明 */
    deleteSummary(row) {
      const reason = (row.changeSummary && row.changeSummary.deleteReason) || "设备已删除";
      return `${reason}，发布后边缘将停止采集（原 ${row.tagCount} 个点位）`;
    },

    /** 修改行的变更内容摘要 */
    modifiedSummary(row) {
      const s = row.changeSummary || {};
      const parts = [];
      if (s.deviceFields && s.deviceFields.length) {
        parts.push("设备字段: " + s.deviceFields.map(f => this.DEVICE_FIELD_LABELS[f] || f).join("/"));
      }
      if (s.tagsAdded) parts.push(`点位+${s.tagsAdded}`);
      if (s.tagsModified) parts.push(`点位改${s.tagsModified}`);
      if (s.tagsRemoved) parts.push(`点位-${s.tagsRemoved}`);
      return parts.join("，") || "内容变更";
    },

    /** 发布选中 */
    handlePublishSelected() {
      if (this.selectedIds.length === 0) {
        this.$modal.msgWarning("请至少选择一台设备");
        return;
      }
      this.isPublishAll = false;
      this.publishTitle = "确认发布选中变更";
      this.publishMessage = `即将发布 ${this.selectedIds.length} 台变更设备的配置到对应采集节点（删除的设备请使用「发布全部变更」），是否继续？`;
      this.confirmOpen = true;
    },

    /** 发布全部 */
    handlePublishAll() {
      this.isPublishAll = true;
      this.publishTitle = "确认发布全部变更";
      this.publishMessage = "即将把当前全部配置固化为新快照版本，并通知所有采集节点重新拉取，是否继续？";
      this.confirmOpen = true;
    },

    /** 取消发布 */
    cancelPublish() {
      this.confirmOpen = false;
      this.publishLoading = false;
    },

    /** 提交发布 */
    submitPublish() {
      this.publishLoading = true;
      const data = this.isPublishAll ? {} : { device_ids: this.selectedIds };
      publishConfig(data).then(response => {
        // 🔧 P0-3：如实展示发布结果（部分失败/全部失败不再只弹成功）
        const d = response.data || {};
        const failed = d.failedDevices || [];
        if (d.status === 'failed') {
          this.$modal.msgError(response.msg || "配置发布失败");
        } else if (failed.length > 0) {
          const names = failed.map(f => f.deviceName || ('设备' + f.deviceId)).join('、');
          this.$modal.alertWarning((response.msg || '部分发布成功') + '<br>未送达：' + names);
        } else {
          this.$modal.msgSuccess(response.msg || "配置发布成功");
        }
        this.confirmOpen = false;
        this.publishLoading = false;
        // 清空选择并刷新
        this.$refs.deviceTable && this.$refs.deviceTable.clearSelection();
        this.selectedIds = [];
        this.selectedRows = [];
        this.getList();
      }).catch(err => {
        this.publishLoading = false;
        if (err) {
          this.$modal.msgError(this.friendlyErr(err) || "配置发布失败");
        }
      });
    },

    /** 简化错误信息 */
    friendlyErr(err) {
      if (err && err.msg) return err.msg;
      if (err && err.message) return err.message;
      if (typeof err === "string") return err;
      return "";
    }
  }
};
</script>

<style scoped>
.kpi-row { margin-bottom: 16px; }
.kpi-card { border-radius: 8px; padding: 18px 20px; color: #fff; text-align: center; min-height: 90px; }
.kpi-blue   { background: linear-gradient(135deg, #409EFF, #66B1FF); }
.kpi-purple { background: linear-gradient(135deg, #9B59B6, #BB8FCE); }
.kpi-green  { background: linear-gradient(135deg, #67C23A, #85CE61); }
.kpi-orange { background: linear-gradient(135deg, #E6A23C, #F0C78A); }
.kpi-value  { font-size: 28px; font-weight: bold; line-height: 1.2; }
.kpi-label  { font-size: 13px; opacity: 0.9; margin-top: 4px; }
.kpi-sub    { font-size: 11px; opacity: 0.85; margin-top: 4px; }
.kpi-red    { background: linear-gradient(135deg, #F56C6C, #F78989); }

.impact-card >>> .el-card__header {
  padding: 10px 16px;
  background: #f0f9ff;
  font-weight: 500;
}
.impact-summary {
  color: #606266;
  line-height: 1.8;
}
.impact-summary b {
  color: #409EFF;
}

.publish-confirm-body {
  color: #606266;
  line-height: 1.6;
}
.publish-confirm-body p {
  margin: 0 0 16px 0;
  font-size: 14px;
}
.impact-detail {
  background: #f5f7fa;
  border-radius: 4px;
  padding: 12px;
}
.impact-title {
  font-weight: 500;
  margin-bottom: 8px;
}

.publish-empty {
  padding: 28px 0;
  color: #909399;
}
.publish-empty i {
  font-size: 30px;
  color: #67C23A;
}
.publish-empty p {
  margin: 8px 0 0;
  font-size: 14px;
}
.publish-empty-sub {
  font-size: 12px !important;
  color: #C0C4CC;
}
</style>
