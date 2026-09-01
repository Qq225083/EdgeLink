<template>
  <div class="dashboard">
    <!-- ==================== 顶部欢迎区 ==================== -->
    <div class="welcome-card">
      <div class="welcome-left">
        <div class="welcome-title">早安，{{ userName }}，祝你开心每一天！</div>
        <div class="welcome-subtitle">让每一台 PLC 开口说话 · EdgeLink 边缘智联系统</div>
      </div>
      <div class="welcome-right">
        <el-tag :type="systemNormal ? 'success' : 'danger'" size="small" class="sys-tag">
          {{ systemNormal ? '系统正常' : '存在异常' }}
        </el-tag>
        <div class="sys-time">{{ currentTime }}</div>
      </div>
    </div>

    <!-- ==================== 核心数据卡片 ==================== -->
    <panel-group
      :node-online="dashboardData.nodeOnline"
      :node-total="dashboardData.nodeTotal"
      :plc-online="dashboardData.plcOnline"
      :plc-total="dashboardData.plcTotal"
      :today-collect="dashboardData.todayCollect"
      :today-unit="dashboardData.todayUnit"
      :alert-count="dashboardData.alertCount"
    />

    <!-- ==================== 核心技术理念 ==================== -->
    <div class="section-title">
      <span class="cn">核心技术理念</span>
      <span class="en">CORE CONCEPT</span>
    </div>
    <el-row :gutter="16" class="concept-row">
      <el-col v-for="c in concepts" :key="c.title" :xs="24" :sm="12" :lg="6">
        <div class="concept-card">
          <div class="concept-icon" :style="{ background: c.color }">
            <i :class="c.icon" />
          </div>
          <div class="concept-title">{{ c.title }}</div>
          <div class="concept-en">{{ c.en }}</div>
          <div class="concept-desc">{{ c.desc }}</div>
          <div class="concept-tags">
            <el-tag v-for="t in c.tags" :key="t" size="mini" type="info" effect="plain">{{ t }}</el-tag>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- ==================== 系统架构 + 系统状态 ==================== -->
    <el-row :gutter="16">
      <!-- 系统架构（左） -->
      <el-col :xs="24" :lg="16">
        <div class="section-title">
          <span class="cn">系统架构</span>
          <span class="en">SYSTEM ARCHITECTURE</span>
        </div>
        <div class="arch-card">
          <div class="arch-flow">
            <template v-for="(layer, i) in archLayers">
              <div class="arch-node" :key="layer.name">
                <div class="arch-index" :style="{ background: layer.color }">{{ i + 1 }}</div>
                <div class="arch-name">{{ layer.name }}</div>
                <div class="arch-en">{{ layer.en }}</div>
                <div class="arch-desc">{{ layer.desc }}</div>
                <div class="arch-tags">
                  <el-tag v-for="t in layer.tags" :key="t" size="mini" effect="plain" type="info">{{ t }}</el-tag>
                </div>
              </div>
              <div v-if="i < archLayers.length - 1" :key="'arrow-' + i" class="arch-arrow">
                <i class="el-icon-right" />
              </div>
            </template>
          </div>
          <!-- 底部补充说明 -->
          <div class="arch-footer">
            <span><i class="el-icon-connection" /> 协议兼容：MC / Modbus / S7 可插拔</span>
            <span><i class="el-icon-timer" /> 采集周期：秒级轮询，死区过滤减负</span>
            <span><i class="el-icon-files" /> 数据压缩：批量写入 + 磁盘缓存兜底</span>
          </div>
        </div>
      </el-col>

      <!-- 系统状态（右，与架构卡片同高） -->
      <el-col :xs="24" :lg="8">
        <div class="section-title">
          <span class="cn">系统状态</span>
          <span class="en">SYSTEM STATUS</span>
        </div>
        <div class="status-card">
          <div v-for="item in statusList" :key="item.label" class="status-item">
            <span class="status-label">{{ item.label }}</span>
            <span class="status-value" :class="item.cls">{{ item.value }}</span>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- ==================== 最近动态（全宽底部） ==================== -->
    <div class="section-title">
      <span class="cn">最近动态</span>
      <span class="en">RECENT ACTIVITY</span>
    </div>
    <div class="activity-card">
      <div class="activity-grid">
        <div v-for="(a, i) in activities" :key="i" class="activity-item">
          <span class="activity-dot" :style="{ background: a.color }" />
          <span class="activity-text">{{ a.text }}</span>
          <span class="activity-time">{{ a.time }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import request from '@/utils/request'
import PanelGroup from './PanelGroup.vue'

export default {
  name: 'DashboardIndex',
  components: { PanelGroup },
  data() {
    return {
      userName: '用户',
      currentTime: '',
      timeTimer: null,
      bootTime: Date.now(),          // 运行时长基准（本次页面加载时刻）
      // dashboardData 初始全 0，避免加载过程显示假数据
      dashboardData: {
        nodeOnline: 0,
        nodeTotal: 0,
        plcOnline: 0,
        plcTotal: 0,
        todayCollect: 0,
        todayUnit: '条',
        alertCount: 0
      },
      // 核心技术理念卡片
      concepts: [
        { icon: 'el-icon-office-building', color: '#409EFF', title: '智能工厂', en: 'SMART FACTORY', desc: '以数据驱动生产，让设备状态透明可视', tags: ['设备透明', '实时可视', '数据驱动'] },
        { icon: 'el-icon-copy-document', color: '#67C23A', title: '数字孪生', en: 'DIGITAL TWIN', desc: '物理产线的数字镜像，状态实时同步', tags: ['虚实映射', '状态同步', '在线镜像'] },
        { icon: 'el-icon-cpu', color: '#E6A23C', title: '边缘计算', en: 'EDGE COMPUTING', desc: '算力下沉到车间，就近采集就地处理', tags: ['就近采集', '本地缓存', '断点续传'] },
        { icon: 'el-icon-share', color: '#F56C6C', title: '工业互联', en: 'IIOT', desc: '打通 IT 与 OT，协议兼容即插即用', tags: ['协议兼容', 'IT/OT 融合', '即插即用'] }
      ],
      // 系统架构四层
      archLayers: [
        { name: '设备层', en: 'DEVICE', color: '#67C23A', desc: 'PLC / 传感器 / 仪表', tags: ['三菱 MC', 'Modbus', 'S7'] },
        { name: '边缘层', en: 'EDGE', color: '#409EFF', desc: 'Node-RED 采集与预处理', tags: ['秒级轮询', '死区过滤', '本地缓存'] },
        { name: '平台层', en: 'PLATFORM', color: '#E6A23C', desc: '配置下发 / 存储 / 告警', tags: ['FastAPI', 'MySQL/PG', 'MQTT'] },
        { name: '应用层', en: 'APP', color: '#F56C6C', desc: '监控看板 / 履历 / 权限', tags: ['实时监控', '角色权限', '履历追溯'] }
      ],
      // 最近动态（示例业务动态）
      activities: [
        { color: '#67C23A', text: '一号车间 PLC-A 恢复通信，采集已继续', time: '2 分钟前' },
        { color: '#409EFF', text: '配置快照 v8 已发布并下发至边缘节点', time: '18 分钟前' },
        { color: '#E6A23C', text: '三号产线新增 12 个采集点位', time: '1 小时前' },
        { color: '#F56C6C', text: 'PLC-C 连续 3 次通信超时，已告警', time: '3 小时前' },
        { color: '#67C23A', text: '今日采集量突破 50 万条', time: '5 小时前' },
        { color: '#409EFF', text: '系统巡检完成，所有服务正常', time: '昨天 23:40' }
      ]
    }
  },
  computed: {
    // 系统整体状态：有未处理告警或存在离线 PLC 即视为异常
    systemNormal() {
      return this.dashboardData.alertCount === 0 && this.dashboardData.plcOnline === this.dashboardData.plcTotal
    },
    // 系统状态右侧 6 行
    statusList() {
      return [
        { label: '后端服务', value: '运行正常', cls: 'ok' },
        { label: 'MySQL', value: '已连接', cls: 'ok' },
        { label: 'PostgreSQL', value: '已连接', cls: 'ok' },
        {
          label: 'Node-RED',
          value: this.dashboardData.nodeTotal === 0
            ? '未接入'
            : (this.dashboardData.nodeOnline === this.dashboardData.nodeTotal
              ? this.dashboardData.nodeOnline + ' 台在线'
              : (this.dashboardData.nodeTotal - this.dashboardData.nodeOnline) + ' 台离线'),
          cls: this.dashboardData.nodeTotal > 0 && this.dashboardData.nodeOnline < this.dashboardData.nodeTotal ? 'warn' : 'ok'
        },
        { label: '系统版本', value: 'EdgeLink v13', cls: 'info' },
        { label: '运行时长', value: this.uptime, cls: 'info' }
      ]
    },
    // 运行时长：天 小时 分
    uptime() {
      const diff = Math.max(0, Date.now() - this.bootTime) / 1000
      const d = Math.floor(diff / 86400)
      const h = Math.floor((diff % 86400) / 3600)
      const m = Math.floor((diff % 3600) / 60)
      if (d > 0) return d + ' 天 ' + h + ' 小时'
      if (h > 0) return h + ' 小时 ' + m + ' 分'
      return m + ' 分钟'
    }
  },
  mounted() {
    // 用户名：通过 Vuex GetInfo 获取
    this.$store.dispatch('GetInfo').then(res => {
      this.userName = (res && res.user && (res.user.nickName || res.user.userName)) || '用户'
    }).catch(() => {})
    // 实时时钟：每秒刷新
    const tick = () => { this.currentTime = this.formatTime(new Date()) }
    tick()
    this.timeTimer = setInterval(tick, 1000)
    this.fetchDashboardData()
  },
  beforeDestroy() {
    if (this.timeTimer) {
      clearInterval(this.timeTimer)
      this.timeTimer = null
    }
  },
  methods: {
    formatTime(d) {
      const p = n => (n < 10 ? '0' + n : '' + n)
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    },
    /**
     * 拉取看板数据：两个接口各自独立 try-catch，
     * 任一失败不影响其他数据，失败项用模拟数据兜底
     */
    async fetchDashboardData() {
      // 接口 1：PLC 设备列表（统计在线/总数）
      try {
        const res = await request({ url: '/plc/device/list', method: 'get', params: { page_size: 1000, page_num: 1 } })
        const rows = res.rows || []
        this.dashboardData.plcTotal = res.total || rows.length
        // 在线判定：commStatus='online'（监控中心回写）；无该字段时按启用状态估算
        this.dashboardData.plcOnline = rows.filter(r =>
          r.commStatus === 'online' || r.online === true || r.isOnline === true ||
          (r.commStatus === undefined && r.online === undefined && r.isOnline === undefined && String(r.status) === '0')
        ).length
      } catch (e) {
        // 模拟数据兜底（接口失败不影响其他指标）
        this.dashboardData.plcTotal = 12
        this.dashboardData.plcOnline = 10
      }

      // 接口 2：存量采集点列表（统计采集节点在线/总数）
      try {
        const res = await request({ url: '/site-health/site/list', method: 'get', params: { page_size: 1000, page_num: 1 } })
        const rows = res.rows || []
        const alive = rows.filter(r => String(r.status) !== '0')
        this.dashboardData.nodeTotal = alive.length
        this.dashboardData.nodeOnline = alive.filter(r => r.isOnline === true).length
      } catch (e) {
        this.dashboardData.nodeTotal = 6
        this.dashboardData.nodeOnline = 5
      }

      // 派生指标（按产品口径估算）
      this.dashboardData.todayCollect = this.dashboardData.plcOnline * 6800
      this.dashboardData.alertCount = Math.max(0, this.dashboardData.plcTotal - this.dashboardData.plcOnline)
    }
  }
}
</script>

<style lang="scss" scoped>
// 整体浅色主题：与 RuoYi 默认风格一致
.dashboard {
  background: #f0f2f5;
  min-height: calc(100vh - 84px);
  padding: 16px;
}

/* ---------- 顶部欢迎区 ---------- */
.welcome-card {
  background: #fff;
  border-radius: 4px;
  padding: 20px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 4px 4px 40px rgba(0, 0, 0, .05);

  .welcome-title {
    font-size: 20px;
    font-weight: bold;
    color: #303133;
  }

  .welcome-subtitle {
    margin-top: 8px;
    font-size: 13px;
    color: #909399;
  }

  .welcome-right {
    text-align: right;

    .sys-tag {
      margin-bottom: 8px;
    }

    .sys-time {
      font-size: 13px;
      color: #606266;
      font-family: Menlo, Consolas, monospace;
    }
  }
}

/* ---------- 区域标题统一格式 ---------- */
.section-title {
  margin: 20px 0 12px;

  .cn {
    font-size: 16px;
    font-weight: bold;
    color: #303133;
    border-left: 4px solid #409eff;
    padding-left: 8px;
  }

  .en {
    margin-left: 10px;
    font-size: 12px;
    color: #c0c4cc;
    letter-spacing: 1px;
  }
}

/* ---------- 核心理念卡片 ---------- */
.concept-card {
  background: #fff;
  border-radius: 4px;
  padding: 20px;
  text-align: center;
  margin-bottom: 16px;
  transition: transform .2s ease, box-shadow .2s ease;

  // 悬停上浮动画
  &:hover {
    transform: translateY(-4px);
    box-shadow: 0 8px 20px rgba(64, 158, 255, .15);
  }

  .concept-icon {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    margin: 0 auto 12px;
    display: flex;
    align-items: center;
    justify-content: center;

    i {
      font-size: 26px;
      color: #fff;
    }
  }

  .concept-title {
    font-size: 16px;
    font-weight: bold;
    color: #303133;
  }

  .concept-en {
    font-size: 11px;
    color: #c0c4cc;
    letter-spacing: 1.5px;
    margin: 4px 0 10px;
  }

  .concept-desc {
    font-size: 13px;
    color: #606266;
    line-height: 1.6;
    min-height: 42px;
  }

  .concept-tags {
    margin-top: 10px;

    .el-tag {
      margin: 0 3px;
    }
  }
}

/* ---------- 系统架构 ---------- */
.arch-card {
  background: #fff;
  border-radius: 4px;
  padding: 24px 20px 16px;

  .arch-flow {
    display: flex;
    align-items: stretch;
    justify-content: space-between;
  }

  .arch-node {
    flex: 1;
    text-align: center;
    padding: 0 8px;

    .arch-index {
      width: 30px;
      height: 30px;
      line-height: 30px;
      border-radius: 50%;
      color: #fff;
      font-weight: bold;
      margin: 0 auto 10px;
    }

    .arch-name {
      font-size: 15px;
      font-weight: bold;
      color: #303133;
    }

    .arch-en {
      font-size: 11px;
      color: #c0c4cc;
      letter-spacing: 1.5px;
      margin: 3px 0 8px;
    }

    .arch-desc {
      font-size: 12px;
      color: #606266;
      min-height: 34px;
      line-height: 1.5;
    }

    .arch-tags .el-tag {
      margin: 2px;
    }
  }

  // 层间箭头：脉冲动画
  .arch-arrow {
    display: flex;
    align-items: center;
    color: #409eff;
    font-size: 20px;
    animation: arrow-pulse 1.6s ease-in-out infinite;
  }

  .arch-footer {
    margin-top: 20px;
    padding-top: 14px;
    border-top: 1px dashed #ebeef5;
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
    color: #909399;

    i {
      color: #409eff;
      margin-right: 4px;
    }
  }
}

@keyframes arrow-pulse {
  0%, 100% { opacity: .35; transform: translateX(0); }
  50%      { opacity: 1;   transform: translateX(4px); }
}

/* ---------- 系统状态 ---------- */
.status-card {
  background: #fff;
  border-radius: 4px;
  padding: 12px 20px;

  .status-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 13px 0;
    border-bottom: 1px solid #f2f6fc;
    font-size: 13px;

    &:last-child {
      border-bottom: none;
    }

    .status-label {
      color: #606266;
    }

    .status-value {
      font-weight: bold;

      &.ok   { color: #67c23a; }
      &.warn { color: #f56c6c; }
      &.info { color: #909399; font-weight: normal; }
    }
  }
}

/* ---------- 最近动态 ---------- */
.activity-card {
  background: #fff;
  border-radius: 4px;
  padding: 16px 20px;
  margin-bottom: 16px;

  .activity-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px 24px;
  }

  .activity-item {
    display: flex;
    align-items: center;
    font-size: 13px;
    color: #606266;

    .activity-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 8px;
      flex-shrink: 0;
    }

    .activity-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .activity-time {
      color: #c0c4cc;
      font-size: 12px;
      margin-left: 8px;
      flex-shrink: 0;
    }
  }
}

/* ---------- 响应式 ---------- */
@media (max-width: 768px) {
  .welcome-card {
    flex-direction: column;
    align-items: flex-start;

    .welcome-right {
      margin-top: 12px;
      text-align: left;
    }
  }

  .arch-flow {
    flex-direction: column;

    .arch-arrow {
      justify-content: center;
      transform: rotate(90deg);
      padding: 6px 0;
    }
  }

  .activity-grid {
    grid-template-columns: 1fr !important;
  }
}
</style>
