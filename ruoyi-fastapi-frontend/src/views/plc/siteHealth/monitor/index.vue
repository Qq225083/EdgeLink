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
      <el-form-item label="来源" prop="source">
        <el-select v-model="queryParams.source" placeholder="全部" clearable style="width: 130px" @change="handleQuery">
          <el-option label="采集配置" value="config" />
          <el-option label="存量登记" value="register" />
        </el-select>
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
      <el-table-column type="expand" width="45">
        <template slot-scope="scope">
          <div class="expand-detail">
            <div class="detail-item"><span class="detail-label">位置</span><span>{{ [scope.row.building, scope.row.floor, scope.row.processStage].filter(Boolean).join(' / ') || '-' }}</span></div>
            <div class="detail-item"><span class="detail-label">工业网IP</span><span>{{ scope.row.industIp || '-' }}</span></div>
            <div class="detail-item"><span class="detail-label">上报IP</span><span>{{ scope.row.reportIp || '-' }}</span></div>
            <div class="detail-item"><span class="detail-label">采集点标识</span><span>{{ scope.row.nodeKey || '-' }}</span></div>
            <div class="detail-item"><span class="detail-label">Node-RED 版本</span><span>{{ scope.row.nodeRedVersion || '-' }}</span></div>
          </div>
          <div class="expand-actions">
            <el-button size="mini" plain icon="el-icon-edit" @click="handleUpdate(scope.row)" v-hasPermi="['site:health:edit']">修改</el-button>
            <el-button size="mini" plain icon="el-icon-key" @click="handleRegenerate(scope.row)" v-hasPermi="['site:health:edit']">重置密钥</el-button>
            <el-button size="mini" plain :icon="scope.row.status === 0 ? 'el-icon-video-play' : 'el-icon-video-pause'" @click="handleToggleStatus(scope.row)" v-hasPermi="['site:health:edit']">{{ scope.row.status === 0 ? '启用' : '停用' }}</el-button>
            <el-button size="mini" plain type="danger" icon="el-icon-delete" @click="handleDelete(scope.row)" v-hasPermi="['site:health:remove']">删除</el-button>
          </div>
        </template>
      </el-table-column>
      <el-table-column type="selection" width="45" align="center" />
      <el-table-column label="采集场所" align="center" prop="siteName" min-width="160" :show-overflow-tooltip="true" />
      <el-table-column label="联系人" align="center" prop="contact" min-width="90" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ scope.row.contact || '-' }}</template>
      </el-table-column>
      <!-- 来源：纯文本+图标，与状态列的彩色标签区分开 -->
      <el-table-column label="来源" align="center" min-width="100">
        <template slot-scope="scope">
          <span class="source-text">
            <i :class="scope.row.source === 'config' ? 'el-icon-connection' : 'el-icon-edit-outline'" />
            {{ scope.row.source === 'config' ? '采集配置' : '存量登记' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="办公网IP:端口" align="center" min-width="160" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ scope.row.officeIp }}{{ scope.row.nodePort ? ':' + scope.row.nodePort : '' }}</template>
      </el-table-column>
      <el-table-column label="状态" align="center" width="85">
        <template slot-scope="scope">
          <el-tag v-if="scope.row.status === 0" type="info" size="mini">已停用</el-tag>
          <el-tag v-else-if="!scope.row.hasReported" type="warning" size="mini">未接入</el-tag>
          <el-tag v-else-if="scope.row.isOnline" type="success" size="mini">在线</el-tag>
          <el-tag v-else type="danger" size="mini">离线</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="心跳间隔" align="center" min-width="80">
        <template slot-scope="scope">{{ scope.row.heartbeatInterval || 30 }}s</template>
      </el-table-column>
      <el-table-column label="最近心跳" align="center" min-width="160" :show-overflow-tooltip="true">
        <template slot-scope="scope">{{ formatTime(scope.row.lastHeartbeat) }}</template>
      </el-table-column>
      <el-table-column label="进程内存" align="center" min-width="95">
        <template slot-scope="scope">{{ formatMb(scope.row.memoryRssMb) }}</template>
      </el-table-column>
      <el-table-column label="整机已用" align="center" min-width="95">
        <template slot-scope="scope">{{ formatMb(scope.row.memoryUsedMb) }}</template>
      </el-table-column>
      <el-table-column label="运行流数" align="center" min-width="80">
        <template slot-scope="scope">{{ scope.row.runningFlows == null ? '-' : scope.row.runningFlows }}</template>
      </el-table-column>
      <el-table-column label="运行时长" align="center" min-width="105">
        <template slot-scope="scope">{{ formatUptime(scope.row.uptimeSec) }}</template>
      </el-table-column>
      <el-table-column label="操作" align="center" class-name="small-padding fixed-width op-cell" width="280" fixed="right">
        <template slot-scope="scope">
          <el-button size="mini" type="text" icon="el-icon-view" @click="handleHistory(scope.row)" v-hasPermi="['site:health:list']">履历</el-button>
          <el-button size="mini" type="text" icon="el-icon-data-line" @click="handleTrend(scope.row)" v-hasPermi="['site:health:list']">趋势</el-button>
          <el-button size="mini" type="text" icon="el-icon-folder-opened" @click="handleUploads(scope.row)" v-hasPermi="['site:health:list']">上传记录</el-button>
          <el-button size="mini" type="text" icon="el-icon-warning-outline"
            :style="scope.row.lastErrors && scope.row.lastErrors.length ? 'color:#E6A23C' : ''"
            @click="handleErrors(scope.row)" v-hasPermi="['site:health:list']">
            报错{{ scope.row.lastErrors && scope.row.lastErrors.length ? ' ' + scope.row.lastErrors.length + '条' : '' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 分页 -->
    <pagination v-show="total>0" :total="total" :page.sync="queryParams.pageNum" :limit.sync="queryParams.pageSize" @pagination="getList" />

    <!-- 心跳履历抽屉 -->
    <el-drawer :title="historyTitle" :visible.sync="historyOpen" size="60%" :append-to-body="true">
      <div class="history-toolbar">
        <el-date-picker v-model="historyRange" type="datetimerange" size="mini" style="width: 340px"
          range-separator="至" start-placeholder="开始时间" end-placeholder="结束时间"
          value-format="yyyy-MM-dd HH:mm:ss" @change="handleHistoryRangeChange" />
        <el-button size="mini" icon="el-icon-refresh" @click="loadHistory(false); loadOfflineIntervals()">刷新</el-button>
        <span class="history-count">默认最近 7 天，可自选起止时间</span>
      </div>
      <el-tabs v-model="historyTab">
        <el-tab-pane label="断线区间" name="offline">
          <div class="offline-summary">
            <el-tag v-if="offlineCurrent" type="danger" size="small">当前离线中</el-tag>
            <el-tag v-else-if="offlineSiteStatus === 0" type="info" size="small">已停用</el-tag>
            <el-tag v-else type="success" size="small">当前在线</el-tag>
            <span class="history-count">判定规则：相邻心跳间隔 &gt; 3×心跳间隔 记为一段离线；恢复时 uptime 变小标记疑似重启</span>
            <el-switch v-model="offlineShowShort" active-text="含短间隔(&lt;5分钟)" style="margin-left: auto" @change="loadOfflineIntervals" />
          </div>
          <el-table v-loading="offlineLoading" :data="offlineList" size="small" border max-height="420">
            <el-table-column label="断线开始" align="center" width="170" :show-overflow-tooltip="true">
              <template slot-scope="scope">{{ formatTime(scope.row.start) }}</template>
            </el-table-column>
            <el-table-column label="恢复时间" align="center" width="170" :show-overflow-tooltip="true">
              <template slot-scope="scope">
                <el-tag v-if="scope.row.ongoing" type="danger" size="mini">未恢复</el-tag>
                <span v-else>{{ formatTime(scope.row.end) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="离线时长" align="center" width="110">
              <template slot-scope="scope">{{ formatDuration(scope.row.durationSec) }}</template>
            </el-table-column>
            <el-table-column label="疑似重启" align="center" width="90">
              <template slot-scope="scope">
                <el-tag v-if="scope.row.restarted" type="warning" size="mini">疑似重启</el-tag>
                <span v-else>-</span>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="心跳履历" name="logs">
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
            <el-pagination small layout="total, prev, pager, next" :total="historyTotal" :page-size="historyPageSize" :current-page.sync="historyPageNum" @current-change="handleHistoryPageChange" />
          </div>
        </el-tab-pane>
      </el-tabs>
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
        <el-form-item label="通知地址" prop="teamsWebhook">
          <el-input v-model="editForm.teamsWebhook" placeholder="断线通知地址：告警邮箱 或 Teams Incoming Webhook（选填）" maxlength="500" />
        </el-form-item>
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

    <!-- 最近报错对话框（节点心跳捎带上报的 error 级日志快照） -->
    <el-dialog :title="errorsTitle" :visible.sync="errorsOpen" width="640px" append-to-body>
      <el-alert
        title="以下为该采集点最近 7 天的异常履历（逐条记录，最多 500 条，单条截断 500 字）；完整日志以现场 Node-RED 日志为准"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
      />
      <div class="history-toolbar" style="margin-bottom: 10px">
        <el-date-picker v-model="historyRange" type="datetimerange" size="mini" style="width: 340px"
          range-separator="至" start-placeholder="开始时间" end-placeholder="结束时间"
          value-format="yyyy-MM-dd HH:mm:ss" @change="handleErrorsRangeChange" />
      </div>
      <el-table :data="errorsList" size="small" border max-height="420">
        <el-table-column label="时间" align="center" prop="ts" width="160" :show-overflow-tooltip="true" />
        <el-table-column label="次数" align="center" width="70">
          <template slot-scope="scope">
            <el-tag v-if="(scope.row.count || 1) > 1" type="danger" size="mini">×{{ scope.row.count }}</el-tag>
            <span v-else>1</span>
          </template>
        </el-table-column>
        <el-table-column label="错误信息" prop="msg" :show-overflow-tooltip="false">
          <template slot-scope="scope">
            <span class="error-msg">{{ scope.row.msg }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div class="history-footer">
        <el-pagination small layout="total, prev, pager, next" :total="errorsTotal" :page-size="errorsPageSize" :current-page.sync="errorsPageNum" @current-change="handleErrorsPageChange" />
      </div>
    </el-dialog>

    <!-- flows.json 上传记录抽屉 -->
    <el-drawer :title="uploadsTitle" :visible.sync="uploadsOpen" size="50%" :append-to-body="true">
      <div class="history-toolbar">
        <el-button size="mini" icon="el-icon-refresh" @click="loadUploads">刷新</el-button>
        <span class="history-count">每站点仅保留最近 5 份</span>
      </div>
      <el-table v-loading="uploadsLoading" :data="uploadsList" size="small" border>
        <el-table-column label="上传时间" align="center" width="160" :show-overflow-tooltip="true">
          <template slot-scope="scope">{{ formatTime(scope.row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="上传原因" prop="reason" min-width="140" :show-overflow-tooltip="true" />
        <el-table-column label="大小" align="center" width="90">
          <template slot-scope="scope">{{ formatBytes(scope.row.sizeBytes) }}</template>
        </el-table-column>
        <el-table-column label="SHA-256" align="center" width="110">
          <template slot-scope="scope">
            <el-tooltip v-if="scope.row.sha256" :content="scope.row.sha256" placement="top">
              <span class="sha-short">{{ scope.row.sha256.slice(0, 10) }}…</span>
            </el-tooltip>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" align="center" width="80">
          <template slot-scope="scope">
            <el-button size="mini" type="text" icon="el-icon-download" :loading="scope.row._downloading" @click="handleDownloadUpload(scope.row)">下载</el-button>
          </template>
        </el-table-column>
        <template slot="empty">该采集点还没有上传记录（在 Node-RED 编辑器里点击「flows.json 上传」节点按钮触发）</template>
      </el-table>
    </el-drawer>
  </div>
</template>

<script>
import { listSite, getSiteSummary, getSiteHistory, getSiteTrend, updateSite, regenerateSiteKey, toggleSiteStatus, delSite, getSiteUploads, downloadSiteUpload, getSiteErrors, getSiteOfflineIntervals } from "@/api/plc/siteHealth";
import * as echarts from "echarts";
import { saveAs } from "file-saver";
import { blobValidate } from "@/utils/ruoyi";

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
        source: null,
      },
      // 一览卡片统计
      summary: { total: 0, online: 0, offline: 0, notConnected: 0, disabled: 0 },
      lastRefreshTime: '',
      // 履历抽屉
      historyOpen: false,
      historyTitle: '',
      historyTab: 'offline',
      historyRange: null,
      offlineList: [],
      offlineCurrent: false,
      offlineSiteStatus: null,
      offlineLoading: false,
      // 短维护间隔（重启后端/重新部署造成的几分钟断档）默认不显示，开关可切回全量
      offlineShowShort: false,
      historyLoading: false,
      historyList: [],
      historyLimit: 200,
      historyPageNum: 1,
      historyPageSize: 50,
      historyTotal: 0,
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
      // 最近报错对话框
      errorsOpen: false,
      errorsTitle: '',
      errorsList: [],
      errorsPageNum: 1,
      errorsPageSize: 50,
      errorsTotal: 0,
      // flows.json 上传记录抽屉
      uploadsOpen: false,
      uploadsTitle: '',
      uploadsLoading: false,
      uploadsList: [],
      uploadsSiteId: null,
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
      // 切换采集点时先清空上一个站点的数据，避免短暂显示旧数据
      this.historyTab = 'offline';
      this.historyRange = null;
      this.historyPageNum = 1;
      this.historyList = [];
      this.historyTotal = 0;
      this.offlineList = [];
      this.offlineCurrent = false;
      this.offlineSiteStatus = null;
      this.historyOpen = true;
      this.loadHistory(false);
      this.loadOfflineIntervals();
    },
    /** 加载离线区间（断线开始/恢复/时长/疑似重启；默认过滤 <5 分钟的短维护间隔） */
    loadOfflineIntervals() {
      if (!this.currentSite) return;
      const range = this.historyRange || [];
      this.offlineLoading = true;
      getSiteOfflineIntervals(this.currentSite.id, 7, {
        start: range[0],
        end: range[1],
        min_sec: this.offlineShowShort ? 0 : 300,
      }).then(response => {
        const d = response.data || {};
        this.offlineList = d.intervals || [];
        this.offlineCurrent = !!d.currentOffline;
        this.offlineSiteStatus = d.siteStatus == null ? null : Number(d.siteStatus);
        this.offlineLoading = false;
      }).catch(() => { this.offlineList = []; this.offlineCurrent = false; this.offlineLoading = false; });
    },
    /** 加载履历（按页码分页 + 时间范围筛选） */
    loadHistory() {
      if (!this.currentSite) return;
      this.historyLoading = true;
      const offset = (this.historyPageNum - 1) * this.historyPageSize;
      const range = this.historyRange || [];
      getSiteHistory(this.currentSite.id, { limit: this.historyPageSize, offset, start: range[0], end: range[1] }).then(response => {
        const d = response.data || {};
        const rows = d.rows || [];
        this.historyTotal = d.total || 0;
        this.markGaps(rows);
        this.historyList = rows;
        this.historyLoading = false;
      }).catch(() => {
        this.historyLoading = false;
      });
    },
    handleHistoryRangeChange() {
      this.historyPageNum = 1;
      this.loadHistory();
      this.loadOfflineIntervals();
    },
    handleHistoryPageChange(page) {
      this.historyPageNum = page;
      this.loadHistory();
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
    /** 查看异常履历（最近 7 天逐条记录，分页展示） */
    handleErrors(row) {
      this.currentSite = row;
      this.errorsTitle = '【' + row.siteName + '】异常履历（最近 7 天）';
      this.errorsOpen = true;
      this.errorsPageNum = 1;
      this.errorsList = [];
      this.loadErrors();
    },
    loadErrors() {
      if (!this.currentSite) return;
      const offset = (this.errorsPageNum - 1) * this.errorsPageSize;
      const range = this.historyRange || [];
      getSiteErrors(this.currentSite.id, { limit: this.errorsPageSize, offset, start: range[0], end: range[1] }).then(response => {
        const d = response.data || {};
        this.errorsList = d.rows || [];
        this.errorsTotal = d.total || 0;
      }).catch(() => { this.errorsList = []; this.errorsTotal = 0; });
    },
    handleErrorsRangeChange() {
      this.errorsPageNum = 1;
      this.loadErrors();
    },
    handleErrorsPageChange(page) {
      this.errorsPageNum = page;
      this.loadErrors();
    },
    /** 打开上传记录抽屉 */
    handleUploads(row) {
      this.uploadsSiteId = row.id;
      this.uploadsTitle = '【' + row.siteName + '】flows.json 上传记录';
      this.uploadsList = [];
      this.uploadsOpen = true;
      this.loadUploads();
    },
    /** 加载上传记录 */
    loadUploads() {
      if (!this.uploadsSiteId) return;
      this.uploadsLoading = true;
      getSiteUploads(this.uploadsSiteId).then(response => {
        this.uploadsList = (response.data || []).map(item => ({ ...item, _downloading: false }));
        this.uploadsLoading = false;
      }).catch(() => {
        this.uploadsLoading = false;
      });
    },
    /** 下载某次上传的 flows.json（blob → saveAs） */
    handleDownloadUpload(row) {
      row._downloading = true;
      downloadSiteUpload(this.uploadsSiteId, row.id).then(res => {
        row._downloading = false;
        if (blobValidate(res.data)) {
          const filename = decodeURIComponent(res.headers['download-filename'] || ('flows-' + row.id + '.json'));
          saveAs(new Blob([res.data]), filename);
        } else {
          this.$modal.msgError("下载失败：服务端返回了错误信息");
        }
      }).catch(() => {
        row._downloading = false;
        this.$modal.msgError("下载失败");
      });
    },
    /** 字节数 → 人类可读 */
    formatBytes(n) {
      if (n == null || n === '') return '-';
      const num = Number(n);
      if (isNaN(num)) return '-';
      if (num >= 1024 * 1024) return (num / 1024 / 1024).toFixed(1) + 'MB';
      if (num >= 1024) return (num / 1024).toFixed(1) + 'KB';
      return num + 'B';
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
    formatDuration(sec) {
      if (sec == null) return '-';
      let s = Number(sec);
      if (isNaN(s) || s < 0) return '-';
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = Math.floor(s % 60);
      if (d > 0) return d + '天' + h + '小时';
      if (h > 0) return h + '小时' + m + '分';
      if (m > 0) return m + '分' + ss + '秒';
      return ss + '秒';
    },
  }
};
</script>

<style scoped>
/* 断线区间页签：顶部摘要 */
.offline-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
/* 展开行详情：两列网格，信息不再挤主行 */
.expand-detail {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 6px 24px;
  padding: 8px 16px 8px 40px;
  background: #fafbfc;
}
.detail-item {
  font-size: 13px;
  color: #303133;
  display: flex;
  gap: 8px;
}
.detail-label {
  color: #909399;
  min-width: 90px;
  flex-shrink: 0;
}
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
/* 来源列：纯文本+图标，与状态列标签视觉区分 */
.source-text {
  color: #606266;
  font-size: 13px;
}
.source-text i {
  margin-right: 4px;
  color: #909399;
}
/* 展开行内的操作按钮区（修改/重置密钥/启停/删除） */
.expand-actions {
  padding: 8px 16px 12px 40px;
  background: #fafbfc;
  border-top: 1px dashed #ebeef5;
}
.error-msg {
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
  color: #f56c6c;
  word-break: break-all;
  white-space: pre-wrap;
}
.sha-short {
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
  color: #909399;
}
/* 操作列：全部按钮平铺单行，紧凑间距 */
.el-table >>> .op-cell .cell {
  white-space: nowrap;
}
.el-table >>> .op-cell .el-button + .el-button {
  margin-left: 6px;
}
.text-danger {
  color: #f56c6c;
}
</style>
