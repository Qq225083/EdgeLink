<template>
  <div class="app-container">
    <!-- 状态一览卡片（点击卡片过滤列表，再次点击「总数」回到全部） -->
    <div class="kpi-row">
      <div class="kpi-card kpi-blue" :class="{ 'kpi-active': !queryParams.state }" @click="filterState(null)">
        <div class="kpi-value">{{ summary.total }}</div>
        <div class="kpi-label">采集点总数</div>
      </div>
      <div class="kpi-card kpi-green" :class="{ 'kpi-active': queryParams.state === 'online' }" @click="filterState('online')">
        <div class="kpi-value">{{ summary.online }}</div>
        <div class="kpi-label">在线</div>
      </div>
      <div class="kpi-card kpi-red" :class="{ 'kpi-active': queryParams.state === 'offline' }" @click="filterState('offline')">
        <div class="kpi-value">{{ summary.offline }}</div>
        <div class="kpi-label">离线</div>
      </div>
      <div class="kpi-card kpi-orange" :class="{ 'kpi-active': queryParams.state === 'notConnected' }" @click="filterState('notConnected')">
        <div class="kpi-value">{{ summary.notConnected }}</div>
        <div class="kpi-label">未接入</div>
      </div>
      <div class="kpi-card kpi-gray" :class="{ 'kpi-active': queryParams.state === 'disabled' }" @click="filterState('disabled')">
        <div class="kpi-value">{{ summary.disabled }}</div>
        <div class="kpi-label">已停用</div>
      </div>
    </div>

    <!-- 查询条件 -->
    <el-form :model="queryParams" ref="queryForm" size="small" :inline="true" v-show="showSearch" label-width="80px">
      <el-form-item label="关键字" prop="keyword">
        <el-input v-model="queryParams.keyword" placeholder="采集场所/办公IP/工业IP/联系人" clearable style="width: 280px" @keyup.enter.native="handleQuery" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" icon="el-icon-search" size="mini" @click="handleQuery">搜索</el-button>
        <el-button icon="el-icon-refresh" size="mini" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <!-- 操作按钮栏 -->
    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-button type="danger" plain icon="el-icon-delete" size="mini" :disabled="multiple" @click="handleDelete({})" v-hasPermi="['site:health:remove']">删除</el-button>
      </el-col>
      <el-col :span="6">
        <span class="last-refresh">数据更新于 {{ lastRefreshTime || '--' }}（30s 自动刷新）</span>
      </el-col>
      <right-toolbar :showSearch.sync="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <!-- 采集点列表表格 -->
    <el-table v-loading="loading" :data="siteList" @selection-change="handleSelectionChange">
      <el-table-column type="selection" width="55" align="center" />
      <el-table-column label="采集场所" align="center" prop="siteName" min-width="130" :show-overflow-tooltip="true" />
      <el-table-column label="位置（栋/楼/工程）" align="center" width="150" :show-overflow-tooltip="true">
        <template slot-scope="scope">
          {{ [scope.row.building, scope.row.floor, scope.row.processStage].filter(Boolean).join(' / ') || '-' }}
        </template>
      </el-table-column>
      <el-table-column label="办公网IP" align="center" prop="officeIp" width="120" :show-overflow-tooltip="true" />
      <el-table-column label="工业网IP" align="center" prop="industIp" width="120" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ scope.row.industIp || '-' }}</template>
      </el-table-column>
      <el-table-column label="端口" align="center" prop="nodePort" width="80">
        <template slot-scope="scope">{{ scope.row.nodePort == null ? '-' : scope.row.nodePort }}</template>
      </el-table-column>
      <el-table-column label="联系人" align="center" prop="contact" width="90" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ scope.row.contact || '-' }}</template>
      </el-table-column>
      <el-table-column label="状态" align="center" width="90">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.status === 0" type="info" size="mini">已停用</el-tag>
          <el-tag v-else-if="!scope.row.hasReported" type="warning" size="mini">未接入</el-tag>
          <el-tag v-else-if="scope.row.isOnline" type="success" size="mini">在线</el-tag>
          <el-tag v-else type="danger" size="mini">离线</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最近心跳" align="center" width="160" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ formatTime(scope.row.lastHeartbeat) }}</template>
      </el-table-column>
      <el-table-column label="心跳间隔" align="center" width="90">
        <template slot-scope="scope">{{ scope.row.heartbeatInterval || 30 }}s</template>
      </el-table-column>
      <el-table-column label="进程内存" align="center" width="100">
        <template slot-scope="scope">{{ formatMb(scope.row.memoryRssMb) }}</template>
      </el-table-column>
      <el-table-column label="整机已用" align="center" width="100">
        <template slot-scope="scope">{{ formatMb(scope.row.memoryUsedMb) }}</template>
      </el-table-column>
      <el-table-column label="运行流" align="center" prop="runningFlows" width="70">
        <template slot-scope="scope">{{ scope.row.runningFlows == null ? '-' : scope.row.runningFlows }}</template>
      </el-table-column>
      <el-table-column label="运行时长" align="center" width="110">
        <template slot-scope="scope">{{ formatUptime(scope.row.uptimeSec) }}</template>
      </el-table-column>
      <el-table-column label="上报IP" align="center" prop="reportIp" width="120" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ scope.row.reportIp || '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" align="center" class-name="small-padding fixed-width" width="290">
        <template slot-scope="scope">
          <el-button size="mini" type="text" icon="el-icon-view" @click="handleHistory(scope.row)" v-hasPermi="['site:health:list']">履历</el-button>
          <el-button size="mini" type="text" icon="el-icon-data-line" @click="handleTrend(scope.row)" v-hasPermi="['site:health:list']">趋势</el-button>
          <el-button size="mini" type="text" icon="el-icon-edit" @click="handleUpdate(scope.row)" v-hasPermi="['site:health:edit']">修改</el-button>
          <el-button size="mini" type="text" icon="el-icon-key" @click="handleRegenerate(scope.row)" v-hasPermi="['site:health:edit']">重置密钥</el-button>
          <el-button size="mini" type="text" :icon="scope.row.status === 0 ? 'el-icon-video-play' : 'el-icon-video-pause'" @click="handleToggleStatus(scope.row)" v-hasPermi="['site:health:edit']">{{ scope.row.status === 0 ? '启用' : '停用' }}</el-button>
          <el-button size="mini" type="text" icon="el-icon-delete" style="color: #F56C6C" @click="handleDelete(scope.row)" v-hasPermi="['site:health:remove']">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 分页 -->
    <pagination v-show="total>0" :total="total" :page.sync="queryParams.pageNum" :limit.sync="queryParams.pageSize" @pagination="getList" />

    <!-- 心跳履历抽屉 -->
    <el-drawer :title="historyTitle" :visible.sync="historyOpen" size="60%" :append-to-body="true">
      <div class="history-toolbar">
        <el-button size="mini" icon="el-icon-refresh" @click="loadHistory(false)">刷新</el-button>
        <span class="history-count">已加载 {{ historyList.length }} 条（倒序，红色行为上报中断点）</span>
      </div>
      <el-table v-loading="historyLoading" :data="historyList" size="small" border :row-class-name="tableRowClassName">
        <el-table-column label="上报时间" align="center" width="180" :show-overflow-tooltip="true">
          <template slot-scope="scope">
            {{ formatTime(scope.row.reportTime) }}
            <el-tooltip v-if="scope.row._gap" content="上报中断：与上一条履历的间隔超过 3×心跳间隔（期间节点离线/停用/断网）" placement="top">
              <span class="gap-badge">断</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="上报IP" align="center" prop="reportIp" width="120" :show-overflow-tooltip="true">
          <template slot-scope="scope">{{ scope.row.reportIp || '-' }}</template>
        </el-table-column>
        <el-table-column label="进程内存" align="center" width="100">
          <template slot-scope="scope">{{ formatMb(scope.row.memoryRssMb) }}</template>
        </el-table-column>
        <el-table-column label="整机已用" align="center" width="100">
          <template slot-scope="scope">{{ formatMemUsed(scope.row) }}</template>
        </el-table-column>
        <el-table-column label="运行流" align="center" prop="runningFlows" width="70">
          <template slot-scope="scope">{{ scope.row.runningFlows == null ? '-' : scope.row.runningFlows }}</template>
        </el-table-column>
        <el-table-column label="版本" align="center" prop="nodeRedVersion" width="90" :show-overflow-tooltip="true">
          <template slot-scope="scope">{{ scope.row.nodeRedVersion || '-' }}</template>
        </el-table-column>
        <el-table-column label="运行时长" align="center" width="110">
          <template slot-scope="scope">{{ formatUptime(scope.row.uptimeSec) }}</template>
        </el-table-column>
      </el-table>
      <div class="history-footer">
        <span v-if="!historyHasMore && historyList.length" class="history-count">已加载全部</span>
        <el-button v-if="historyHasMore" size="mini" :loading="historyLoading" @click="loadHistory(true)">加载更多</el-button>
      </div>
    </el-drawer>

    <!-- 修改采集点对话框（仅情报字段，密钥只能走重置） -->
    <el-dialog title="修改采集点" :visible.sync="editOpen" width="640px" append-to-body>
      <el-alert
        title="办公网IP + 端口唯一标识一个采集点，修改不影响密钥与历史履历"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      />
      <el-form ref="editForm" :model="editForm" :rules="editRules" label-width="110px">
        <el-row>
          <el-col :span="12">
            <el-form-item label="办公网IP" prop="officeIp">
              <el-input v-model="editForm.officeIp" maxlength="20" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="工业网IP" prop="industIp">
              <el-input v-model="editForm.industIp" placeholder="选填" maxlength="20" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row>
          <el-col :span="12">
            <el-form-item label="端口" prop="nodePort">
              <el-input v-model="editForm.nodePort" placeholder="Node-RED 监听端口" maxlength="5" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="采集场所" prop="siteName">
              <el-input v-model="editForm.siteName" maxlength="100" />
            </el-form-item>
          </el-col>
        </el-row>
        <!-- 采集场所拆分：栋别/楼层/工程 -->
        <el-row>
          <el-col :span="8">
            <el-form-item label="栋别" prop="building">
              <el-input v-model="editForm.building" maxlength="50" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="楼层" prop="floor">
              <el-input v-model="editForm.floor" maxlength="50" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="工程" prop="processStage">
              <el-input v-model="editForm.processStage" maxlength="50" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row>
          <el-col :span="12">
            <el-form-item label="联系人" prop="contact">
              <el-input v-model="editForm.contact" placeholder="选填" maxlength="50" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="采集备注" prop="remark">
          <el-input v-model="editForm.remark" type="textarea" :rows="3" placeholder="选填" maxlength="200" show-word-limit />
        </el-form-item>
      </el-form>
      <div slot="footer" class="dialog-footer">
        <el-button type="primary" :loading="editSubmitting" @click="submitEdit">确 定</el-button>
        <el-button @click="editOpen = false">取 消</el-button>
      </div>
    </el-dialog>

    <!-- 内存趋势对话框（ECharts 折线，按小时分桶） -->
    <el-dialog :title="trendTitle" :visible.sync="trendOpen" width="720px" append-to-body @closed="disposeTrendChart">
      <div v-loading="trendLoading">
        <div v-if="!trendLoading && trendEmpty" class="trend-empty">最近 7 天暂无心率数据（该采集点未上报过内存指标）</div>
        <div v-show="!trendEmpty" ref="trendChart" class="trend-chart"></div>
        <div v-if="!trendEmpty" class="trend-tip">按小时聚合：实线=平均内存，虚线=峰值内存（MB）</div>
      </div>
    </el-dialog>

    <!-- 密钥重置一次性展示对话框 -->
    <el-dialog title="密钥已重置" :visible.sync="keyOpen" width="560px" :close-on-click-modal="false" :close-on-press-escape="false" :show-close="false" append-to-body>
      <el-alert
        title="旧密钥已失效，请立即复制新密钥并更新节点配置，关闭后无法再次查看！"
        type="warning"
        :closable="false"
        show-icon
      />
      <div class="key-box">
        <div class="key-label">采集点：{{ regenSiteName }}</div>
        <div class="key-value">{{ newKey }}</div>
      </div>
      <div class="key-actions">
        <el-button type="primary" icon="el-icon-copy-document" :disabled="!newKey" @click="copyKey">复制密钥</el-button>
        <el-button type="warning" plain @click="closeKeyDialog">我已保存，关闭</el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script>
import { listSite, getSiteSummary, getSiteHistory, getSiteTrend, updateSite, regenerateSiteKey, toggleSiteStatus, delSite } from "@/api/plc/siteHealth";
import * as echarts from "echarts";

const IPV4_PATTERN = /^((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/;

export default {
  name: "SiteHealthMonitor",
  data() {
    return {
      loading: true,
      showSearch: true,
      total: 0,
      siteList: [],
      ids: [],
      single: true,
      multiple: true,
      queryParams: {
        pageNum: 1,
        pageSize: 10,
        keyword: null,
        state: null,
      },
      // 一览卡片统计
      summary: { total: 0, online: 0, offline: 0, notConnected: 0, disabled: 0 },
      lastRefreshTime: '',
      // 履历抽屉
      historyOpen: false,
      historyTitle: '',
      historyLoading: false,
      historyList: [],
      historyLimit: 200,
      historyOffset: 0,
      historyHasMore: false,
      currentSite: null,
      // 修改采集点
      editOpen: false,
      editSubmitting: false,
      editSiteId: null,
      editForm: {
        officeIp: null,
        industIp: null,
        nodePort: null,
        siteName: null,
        building: null,
        floor: null,
        processStage: null,
        contact: null,
        remark: null,
      },
      editRules: {
        officeIp: [
          { required: true, message: "办公网IP不能为空", trigger: "blur" },
          { pattern: IPV4_PATTERN, message: "IP地址格式不正确", trigger: "blur" }
        ],
        industIp: [
          { pattern: IPV4_PATTERN, message: "IP地址格式不正确", trigger: "blur" }
        ],
        nodePort: [
          { required: true, message: "端口不能为空", trigger: "blur" },
          {
            validator: (rule, value, callback) => {
              const n = Number(value);
              if (!Number.isInteger(n) || n < 1 || n > 65535) return callback(new Error('端口范围 1-65535'));
              callback();
            },
            trigger: "blur"
          }
        ],
        siteName: [
          { required: true, message: "采集场所不能为空", trigger: "blur" }
        ],
        building: [
          { required: true, message: "栋别不能为空", trigger: "blur" }
        ],
        floor: [
          { required: true, message: "楼层不能为空", trigger: "blur" }
        ],
        processStage: [
          { required: true, message: "工程不能为空", trigger: "blur" }
        ],
      },
      // 趋势对话框
      trendOpen: false,
      trendTitle: '',
      trendLoading: false,
      trendEmpty: false,
      trendChart: null,
      regenSiteName: '',
      // 30s 静默轮询（看板场景，不闪 loading）
      refreshTimer: null,
    };
  },
  created() {
    this.getList();
    this.loadSummary();
    this.refreshTimer = setInterval(() => {
      this.getList(true);
      this.loadSummary();
    }, 30000);
  },
  beforeDestroy() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  },
  methods: {
    /** 查询列表（silent=true 时为后台轮询，不切换 loading 避免闪烁） */
    getList(silent) {
      if (!silent) this.loading = true;
      listSite(this.queryParams).then(response => {
        this.siteList = response.rows || [];
        this.total = response.total || 0;
        this.loading = false;
        this.lastRefreshTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      }).catch(() => {
        this.loading = false;
      });
    },
    /** 一览卡片统计 */
    loadSummary() {
      getSiteSummary().then(response => {
        this.summary = response.data || this.summary;
      }).catch(() => {});
    },
    /** 点击一览卡片过滤状态，再次点击当前卡片回到全部 */
    filterState(state) {
      this.queryParams.state = this.queryParams.state === state ? null : state;
      this.queryParams.pageNum = 1;
      this.getList();
    },
    handleQuery() {
      this.queryParams.pageNum = 1;
      this.getList();
    },
    resetQuery() {
      this.resetForm("queryForm");
      this.queryParams.state = null;
      this.handleQuery();
    },
    handleSelectionChange(selection) {
      this.ids = selection.map(item => item.id);
      this.single = selection.length !== 1;
      this.multiple = !selection.length;
    },
    /** 查看履历 */
    handleHistory(row) {
      this.currentSite = row;
      this.historyTitle = '【' + row.siteName + '】心跳履历';
      this.historyOpen = true;
      this.loadHistory(false);
    },
    /** 加载履历：loadMore=true 时按 offset 追加，否则从头刷新 */
    loadHistory(loadMore) {
      if (!this.currentSite) return;
      if (!loadMore) this.historyOffset = 0;
      this.historyLoading = true;
      getSiteHistory(this.currentSite.id, { limit: this.historyLimit, offset: this.historyOffset }).then(response => {
        const rows = response.data || [];
        const merged = loadMore ? this.historyList.concat(rows) : rows;
        this.historyOffset = merged.length;
        this.historyHasMore = rows.length >= this.historyLimit;
        this.markGaps(merged);
        this.historyList = merged;
        this.historyLoading = false;
      }).catch(() => {
        this.historyLoading = false;
      });
    },
    /** 断点标记：相邻两条履历间隔 > 3×心跳间隔，说明期间节点离线/停用/断网，较新的一条标红 */
    markGaps(list) {
      const intervalSec = (this.currentSite && this.currentSite.heartbeatInterval) || 30;
      const thresholdMs = 3 * intervalSec * 1000;
      for (let i = 0; i < list.length; i++) {
        list[i]._gap = false;
        if (i < list.length - 1) {
          const cur = new Date(String(list[i].reportTime).replace(' ', 'T')).getTime();
          const prev = new Date(String(list[i + 1].reportTime).replace(' ', 'T')).getTime();
          if (!isNaN(cur) && !isNaN(prev) && cur - prev > thresholdMs) list[i]._gap = true;
        }
      }
    },
    tableRowClassName({ row }) {
      return row._gap ? 'gap-row' : '';
    },
    /** 修改采集点情报 */
    handleUpdate(row) {
      this.editSiteId = row.id;
      this.editForm = {
        officeIp: row.officeIp,
        industIp: row.industIp,
        nodePort: row.nodePort,
        siteName: row.siteName,
        building: row.building,
        floor: row.floor,
        processStage: row.processStage,
        contact: row.contact,
        remark: row.remark,
      };
      this.editOpen = true;
      this.$nextTick(() => {
        this.$refs["editForm"] && this.$refs["editForm"].clearValidate();
      });
    },
    submitEdit() {
      this.$refs["editForm"].validate(valid => {
        if (!valid) return;
        this.editSubmitting = true;
        const payload = { ...this.editForm, nodePort: Number(this.editForm.nodePort) };
        updateSite(this.editSiteId, payload).then(() => {
          this.editSubmitting = false;
          this.editOpen = false;
          this.$modal.msgSuccess("修改成功");
          this.getList();
          this.loadSummary();
        }).catch(err => {
          this.editSubmitting = false;
          this.$modal.msgError(err.message || "修改失败");
        });
      });
    },
    /** 重置密钥 */
    handleRegenerate(row) {
      this.$modal.confirm('确定重置采集点"' + row.siteName + '"的密钥？旧密钥将立即失效，旧节点会停止上报，需重新配置新密钥。').then(() => {
        regenerateSiteKey(row.id).then(response => {
          this.newKey = response.data ? response.data.key : '';
          this.regenSiteName = row.siteName;
          this.keyOpen = true;
        }).catch(err => {
          this.$modal.msgError(err.message || "重置失败");
        });
      }).catch(() => {});
    },
    /** 启停 */
    handleToggleStatus(row) {
      const target = row.status === 0 ? 1 : 0;
      const action = target === 1 ? '启用' : '停用';
      this.$modal.confirm('确定' + action + '采集点"' + row.siteName + '"？' + (target === 0 ? '停用后旧节点上报将被拒绝。' : '')).then(() => {
        toggleSiteStatus(row.id, target).then(() => {
          this.$modal.msgSuccess(action + '成功');
          this.getList();
          this.loadSummary();
        }).catch(err => {
          this.$modal.msgError(err.message || action + "失败");
        });
      }).catch(() => {});
    },
    /** 删除（单条或批量） */
    handleDelete(row) {
      const isBatch = !row.id;
      const ids = isBatch ? this.ids.join(',') : String(row.id);
      const label = isBatch ? '所选 ' + this.ids.length + ' 个采集点' : '采集点"' + row.siteName + '"';
      this.$modal.confirm('是否确认删除' + label + '？（将同时删除其全部心跳履历，数据不可恢复）').then(() => {
        delSite(ids).then(() => {
          this.$modal.msgSuccess("删除成功");
          this.getList();
          this.loadSummary();
        }).catch(err => {
          this.$modal.msgError(err.message || "删除失败");
        });
      }).catch(() => {});
    },
    copyKey() {
      const text = this.newKey;
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          this.$modal.msgSuccess("密钥已复制");
        }).catch(() => this.fallbackCopy(text));
      } else {
        this.fallbackCopy(text);
      }
    },
    fallbackCopy(text) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        this.$modal.msgSuccess("密钥已复制");
      } catch (e) {
        this.$modal.msgError("复制失败，请手动选择复制");
      }
      document.body.removeChild(ta);
    },
    closeKeyDialog() {
      this.keyOpen = false;
      this.newKey = '';
      this.regenSiteName = '';
    },
    /** 时间格式化：ISO 字符串 → YYYY-MM-DD HH:mm:ss */
    /** 内存趋势：打开对话框并拉取最近 7 天（按小时分桶）渲染 ECharts 折线 */
    handleTrend(row) {
      this.currentSite = row;
      this.trendTitle = '【' + row.siteName + '】内存趋势（近 7 天）';
      this.trendOpen = true;
      this.trendLoading = true;
      this.trendEmpty = false;
      getSiteTrend(row.id, { hours: 168 }).then(response => {
        const rows = response.data || [];
        this.trendLoading = false;
        if (!rows.length) {
          this.trendEmpty = true;
          return;
        }
        this.$nextTick(() => this.renderTrend(rows));
      }).catch(() => {
        this.trendLoading = false;
        this.trendEmpty = true;
      });
    },
    /** 渲染趋势图（平均=实线，峰值=虚线） */
    renderTrend(rows) {
      const el = this.$refs.trendChart;
      if (!el) return;
      this.disposeTrendChart();
      this.trendChart = echarts.init(el);
      this.trendChart.setOption({
        grid: { left: 50, right: 20, top: 30, bottom: 30 },
        tooltip: { trigger: 'axis' },
        xAxis: {
          type: 'category',
          data: rows.map(r => r.bucket.slice(5)),  // 'MM-DD HH:00'
          axisLabel: { color: '#909399', fontSize: 11 }
        },
        yAxis: {
          type: 'value',
          name: 'MB',
          axisLabel: { color: '#909399' },
          splitLine: { lineStyle: { color: '#f0f2f5' } }
        },
        series: [
          {
            name: '平均内存',
            type: 'line',
            data: rows.map(r => r.avgMb),
            smooth: true,
            showSymbol: false,
            lineStyle: { color: '#409EFF', width: 2 },
            areaStyle: { color: 'rgba(64,158,255,0.12)' }
          },
          {
            name: '峰值内存',
            type: 'line',
            data: rows.map(r => r.maxMb),
            smooth: true,
            showSymbol: false,
            lineStyle: { color: '#E6A23C', width: 1, type: 'dashed' }
          }
        ]
      });
    },
    disposeTrendChart() {
      if (this.trendChart) {
        this.trendChart.dispose();
        this.trendChart = null;
      }
    },
    formatTime(val) {
      if (!val) return '-';
      const str = String(val);
      // ISO 8601 带 T 和时区；做一次宽松替换即可满足展示
      const t = str.replace('T', ' ').split('.')[0].replace(/\+.*$/, '');
      return t.slice(0, 19);
    },
    /** MB 显示（空值返回 '-'） */
    formatMb(mb) {
      if (mb == null || mb === '') return '-';
      const n = Number(mb);
      if (isNaN(n)) return '-';
      if (n >= 1024) return (n / 1024).toFixed(1) + 'GB';
      return n + 'MB';
    },
    /** 履历行整机已用内存 = total - free */
    formatMemUsed(row) {
      if (row.memoryTotalMb == null || row.memoryFreeMb == null) return '-';
      return this.formatMb(row.memoryTotalMb - row.memoryFreeMb);
    },
    /** 运行时长：秒 → 人类可读 */
    formatUptime(sec) {
      if (sec == null || sec === '') return '-';
      let s = Number(sec);
      if (isNaN(s) || s < 0) return '-';
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (d > 0) return d + '天' + h + '小时';
      if (h > 0) return h + '小时' + m + '分';
      return m + '分';
    },
  }
};
</script>

<style scoped>
/* 一览卡片：复用 V12 监控页的 KPI 渐变卡片视觉语言 */
.kpi-row {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}
.kpi-card {
  flex: 1;
  border-radius: 8px;
  padding: 18px 20px;
  color: #fff;
  text-align: center;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.kpi-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}
.kpi-active {
  box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.45), 0 4px 12px rgba(0, 0, 0, 0.18);
}
.kpi-blue   { background: linear-gradient(135deg, #409EFF, #66B1FF); }
.kpi-green  { background: linear-gradient(135deg, #67C23A, #85CE61); }
.kpi-red    { background: linear-gradient(135deg, #F56C6C, #F89898); }
.kpi-orange { background: linear-gradient(135deg, #E6A23C, #EBB563); }
.kpi-gray   { background: linear-gradient(135deg, #909399, #B1B3B8); }
.kpi-value  { font-size: 32px; font-weight: bold; line-height: 1.2; }
.kpi-label  { font-size: 13px; opacity: 0.9; margin-top: 4px; }
.last-refresh {
  color: #c0c4cc;
  font-size: 11px;
  line-height: 28px;
  letter-spacing: 0.5px;
}
.history-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.history-footer {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-top: 10px;
  min-height: 28px;
}
/* 断点行标红（el-table 行样式需要穿透 scoped） */
.el-table >>> .gap-row {
  background: #fef0f0;
}
.gap-badge {
  display: inline-block;
  color: #f56c6c;
  font-size: 11px;
  line-height: 14px;
  border: 1px solid #f56c6c;
  border-radius: 3px;
  padding: 0 3px;
  margin-left: 4px;
  vertical-align: 1px;
}
/* 趋势对话框 */
.trend-chart {
  width: 100%;
  height: 320px;
}
.trend-empty {
  text-align: center;
  color: #c0c4cc;
  font-size: 13px;
  padding: 40px 0;
}
.trend-tip {
  text-align: center;
  color: #909399;
  font-size: 12px;
  margin-top: 4px;
}
.history-count {
  color: #909399;
  font-size: 12px;
}
.key-box {
  margin: 16px 0;
  padding: 16px;
  background: #f5f7fa;
  border: 1px dashed #dcdfe6;
  border-radius: 4px;
}
.key-label {
  color: #909399;
  font-size: 12px;
  margin-bottom: 4px;
}
.key-value {
  font-family: Menlo, Consolas, monospace;
  font-size: 15px;
  color: #303133;
  word-break: break-all;
  user-select: all;
}
.key-actions {
  text-align: center;
}
</style>
