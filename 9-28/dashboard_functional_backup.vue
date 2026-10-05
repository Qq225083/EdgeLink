<template>
  <div class="dashboard">
    <!-- ==================== 顶部欢迎区（企业夜景背景 + 渐变罩层） ==================== -->
    <div class="welcome-card" :style="welcomeStyle">
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

    <!-- ==================== 企业风貌图片带 ==================== -->
    <div class="photo-strip">
      <div v-for="p in companyPhotos" :key="p.src" class="photo-item">
        <img :src="p.src" :alt="p.caption" />
        <div class="photo-caption">{{ p.caption }}</div>
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

    <!-- ==================== 快捷入口 ==================== -->
    <div class="section-title">
      <span class="cn">快捷入口</span>
      <span class="en">QUICK LINKS</span>
    </div>
    <el-row :gutter="16">
      <el-col v-for="q in quickLinks" :key="q.path" :xs="12" :sm="12" :lg="6">
        <div class="quick-card" @click="go(q.path)">
          <i :class="q.icon" :style="{ color: q.color }" />
          <div class="quick-name">{{ q.name }}</div>
          <div class="quick-desc">{{ q.desc }}</div>
        </div>
      </el-col>
    </el-row>

    <!-- ==================== 系统架构 + 系统状态 ==================== -->
    <el-row :gutter="16" type="flex" class="arch-status-row">
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

    <!-- ==================== 采集点健康（全宽横条） ==================== -->
    <div class="section-title">
      <span class="cn">采集点健康</span>
      <span class="en">SITE HEALTH</span>
    </div>
    <div class="site-card">
      <div v-if="siteList.length" class="site-grid">
        <div v-for="s in siteList" :key="s.id" class="site-item" @click="go('/edgelink/site-health/monitor')">
          <span class="dot" :class="s.isOnline ? 'on' : 'off'" />
          <div class="site-info">
            <div class="site-name">{{ s.siteName }}</div>
            <div class="site-ip">{{ s.officeIp }}:{{ s.nodePort || '-' }}</div>
          </div>
          <div class="site-metrics">
            <div v-if="s.memoryUsedMb != null" class="metric">内存 {{ s.memoryUsedMb }}MB</div>
            <div class="metric dim">{{ s.isOnline ? '在线' : (s.hasReported ? '离线' : '未接入') }}</div>
          </div>
        </div>
      </div>
      <div v-else class="site-empty">还没有采集点，请到「采集登记」登记</div>
    </div>

    <!-- ==================== 最近动态（全宽底部） ==================== -->
    <div class="section-title">
      <span class="cn">最近动态</span>
      <span class="en">RECENT ACTIVITY</span>
    </div>
    <div class="activity-card">
      <div v-if="activities.length" class="activity-grid">
        <div v-for="(a, i) in activities" :key="i" class="activity-item">
          <span class="activity-dot" :style="{ background: a.color }" />
          <span class="activity-text">{{ a.text }}</span>
          <span class="activity-time">{{ a.time }}</span>
        </div>
      </div>
      <div v-else class="activity-empty"><i class="el-icon-circle-check" /> 一切正常，暂无活跃告警</div>
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
      dataTimer: null,
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
      // 系统架构四层
      archLayers: [
        { name: '设备层', en: 'DEVICE', color: '#67C23A', desc: 'PLC / 传感器 / 仪表', tags: ['三菱 MC', 'Modbus', 'S7'] },
        { name: '边缘层', en: 'EDGE', color: '#409EFF', desc: 'Node-RED 采集与预处理', tags: ['秒级轮询', '死区过滤', '本地缓存'] },
        { name: '平台层', en: 'PLATFORM', color: '#E6A23C', desc: '配置下发 / 存储 / 告警', tags: ['FastAPI', 'MySQL/PG', 'MQTT'] },
        { name: '应用层', en: 'APP', color: '#F56C6C', desc: '监控看板 / 履历 / 权限', tags: ['实时监控', '角色权限', '履历追溯'] }
      ],
      // 最近动态（实时告警，来自 /monitor/alerts；空则显示一切正常）
      activities: [],
      // 企业风貌图片（src/assets/img/company/）
      companyPhotos: [
        { src: require('@/assets/img/company/day-1.jpg'), caption: '厂区日景' },
        { src: require('@/assets/img/company/gate.png'), caption: '公司正门' },
        { src: require('@/assets/img/company/dusk-1.jpg'), caption: '厂区暮色' },
        { src: require('@/assets/img/company/night-1.jpg'), caption: '研发楼夜景' },
        { src: require('@/assets/img/company/night-2.png'), caption: '公司夜景' }
      ],
      // 采集点健康横条（site-health 只读联动）
      siteList: [],
      // 快捷入口
      quickLinks: [
        { name: 'PLC设备管理', desc: '设备与点位配置', icon: 'el-icon-cpu', color: '#67c23a', path: '/edgelink/link/plc/device' },
        { name: '数据点表', desc: '全局点位查询', icon: 'el-icon-collection-tag', color: '#409eff', path: '/edgelink/link/plc/tag' },
        { name: '流程版本', desc: '生成 / 下载 flows.json', icon: 'el-icon-magic-stick', color: '#e6a23c', path: '/edgelink/flowgen/release' },
        { name: '节点监控', desc: '节点与逐台状态', icon: 'el-icon-s-platform', color: '#909399', path: '/edgelink/monitor/plc/monitor' }
      ]
    }
  },
  computed: {
    // 欢迎横幅背景：夜景大楼 + 左深右浅渐变罩层（保证文字可读）
    welcomeStyle() {
      return {
        backgroundImage:
          'linear-gradient(100deg, rgba(15,23,42,0.78) 0%, rgba(15,23,42,0.45) 45%, rgba(15,23,42,0.15) 100%),' +
          'url(' + require('@/assets/img/company/night-1.jpg') + ')'
      }
    },
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
        { label: '系统版本', value: 'EdgeLink（过渡版）', cls: 'info' },
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
    // 看板数据 30s 轮询
    this.dataTimer = setInterval(this.fetchDashboardData, 30000)
  },
  beforeDestroy() {
    if (this.timeTimer) {
      clearInterval(this.timeTimer)
      this.timeTimer = null
    }
    if (this.dataTimer) {
      clearInterval(this.dataTimer)
      this.dataTimer = null
    }
  },
  methods: {
    formatTime(d) {
      const p = n => (n < 10 ? '0' + n : '' + n)
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    },
    /**
     * 拉取看板数据：/monitor/nodes（节点+设备+今日写入）与 /monitor/alerts（告警+动态），
     * 各自独立 try-catch；失败保持 0，不用模拟数据兜底（假数据比无数据更糟）
     */
    async fetchDashboardData() {
      // 接口 1：节点列表（节点在线、设备总数/在线、今日写入）
      try {
        const res = await request({ url: '/monitor/nodes', method: 'get' })
        const nodes = res.data || []
        this.dashboardData.nodeTotal = nodes.length
        this.dashboardData.nodeOnline = nodes.filter(n => n.isOnline).length
        this.dashboardData.plcTotal = nodes.reduce((s, n) => s + (n.deviceCount || 0), 0)
        this.dashboardData.plcOnline = nodes.reduce((s, n) => s + (n.onlineDeviceCount || 0), 0)
        this.dashboardData.todayCollect = nodes.reduce((s, n) => s + (n.todayCount || 0), 0)
      } catch (e) { /* 保持 0 */ }

      // 接口 2：活跃告警（计数 + 最近动态）
      try {
        const res = await request({ url: '/monitor/alerts', method: 'get', params: { limit: 10 } })
        const alerts = res.data || []
        this.dashboardData.alertCount = alerts.length
        this.activities = alerts.map(a => ({
          color: a.severity === 1 ? '#F56C6C' : (a.severity === 2 ? '#E6A23C' : '#409EFF'),
          text: a.alertMsg || '',
          time: this.fmtAgo(a.createdAt)
        }))
      } catch (e) { /* 保持空 */ }

      // 接口 3：采集点健康横条（site-health 只读）
      try {
        const res = await request({ url: '/site-health/site/list', method: 'get', params: { page_size: 100, page_num: 1 } })
        this.siteList = res.rows || []
      } catch (e) { /* 保持空 */ }
    },
    /** 路由跳转（快捷入口 / 采集点卡片） */
    go(path) { this.$router.push(path) },
    /** 相对时间：X分钟前 / X小时前 / X天前 */
    fmtAgo(ts) {
      if (!ts) return '-'
      const diff = Math.max(0, Date.now() - new Date(String(ts).replace(' ', 'T')).getTime()) / 1000
      if (diff < 3600) return Math.max(1, Math.floor(diff / 60)) + ' 分钟前'
      if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前'
      return Math.floor(diff / 86400) + ' 天前'
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

/* ---------- 顶部欢迎区（背景图版） ---------- */
.welcome-card {
  border-radius: 8px;
  padding: 36px 32px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.25);
  background-size: cover;
  background-position: center 60%;

  .welcome-title {
    font-size: 22px;
    font-weight: bold;
    color: #fff;
    text-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
  }

  .welcome-subtitle {
    margin-top: 8px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.85);
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  }

  .welcome-right {
    text-align: right;

    .sys-tag {
      margin-bottom: 8px;
    }

    .sys-time {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.9);
      font-family: Menlo, Consolas, monospace;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
    }
  }
}

/* ---------- 企业风貌图片带 ---------- */
.photo-strip {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
  margin: 16px 0 4px;

  .photo-item {
    position: relative;
    border-radius: 8px;
    overflow: hidden;
    height: 130px;
    cursor: default;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    transition: transform .2s ease, box-shadow .2s ease;

    &:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.18);
    }

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .photo-caption {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 14px 10px 6px;
      font-size: 12px;
      color: #fff;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.55));
    }
  }
}

@media (max-width: 992px) {
  .photo-strip { grid-template-columns: repeat(2, 1fr); }
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

/* ---------- 快捷入口卡片 ---------- */
.quick-card {
  background: #fff;
  border-radius: 4px;
  padding: 22px 16px;
  text-align: center;
  margin-bottom: 16px;
  cursor: pointer;
  transition: transform .2s ease, box-shadow .2s ease;

  &:hover {
    transform: translateY(-4px);
    box-shadow: 0 8px 20px rgba(64, 158, 255, .15);
  }

  i { font-size: 30px; }
  .quick-name { font-size: 15px; font-weight: bold; color: #303133; margin-top: 10px; }
  .quick-desc { font-size: 12px; color: #909399; margin-top: 4px; }
}

/* ---------- 采集点健康横条 ---------- */
.site-card {
  background: #fff;
  border-radius: 4px;
  padding: 16px 20px;
  margin-bottom: 16px;

  .site-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
  }

  .site-item {
    display: flex;
    align-items: center;
    border: 1px solid #ebeef5;
    border-radius: 6px;
    padding: 12px 14px;
    cursor: pointer;
    transition: all .15s;

    &:hover { border-color: #409eff; box-shadow: 0 2px 8px rgba(64, 158, 255, .15); }
  }

  .dot {
    width: 9px; height: 9px;
    border-radius: 50%;
    margin-right: 10px;
    flex-shrink: 0;
    &.on { background: #67c23a; box-shadow: 0 0 4px #67c23a; }
    &.off { background: #f56c6c; }
  }

  .site-info { flex: 1; min-width: 0; }
  .site-name { font-size: 13px; font-weight: bold; color: #303133; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .site-ip { font-size: 11px; color: #909399; font-family: Menlo, Consolas, monospace; }
  .site-metrics { text-align: right; font-size: 11px; color: #606266; }
  .site-metrics .dim { color: #909399; margin-top: 2px; }

  .site-empty { text-align: center; color: #c0c4cc; padding: 24px 0; font-size: 13px; }
}

/* ---------- 系统架构 + 系统状态：同行等高 ---------- */
.arch-status-row {
  align-items: stretch;

  > .el-col {
    display: flex;
    flex-direction: column;
  }

  .section-title {
    flex-shrink: 0;
  }

  .arch-card,
  .status-card {
    flex: 1;
    box-sizing: border-box;
    transition: transform .2s ease, box-shadow .2s ease;

    &:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(64, 158, 255, .12);
    }
  }
}

/* ---------- 系统架构 ---------- */
.arch-card {
  background: #fff;
  border-radius: 4px;
  padding: 24px 20px 16px;
  display: flex;
  flex-direction: column;   /* 内容垂直撑满，消除等高拉伸后的底部留白 */

  .arch-flow {
    display: flex;
    align-items: center;    /* 流程节点在剩余空间内垂直居中 */
    justify-content: space-between;
    flex: 1;
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
    margin-top: auto;       /* 钉在卡片底部 */
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
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;  /* 行距随卡片高度自动拉匀，消除与架构卡的高度差 */

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
  min-height: 260px;        /* 加高填充，页面更充盈 */

  .activity-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px 24px;
  }

  .activity-empty {
    text-align: center;
    color: #67c23a;
    font-size: 13px;
    padding: 24px 0;
  }

  .activity-item {
    display: flex;
    align-items: center;
    font-size: 13px;
    color: #606266;
    padding: 8px 0;

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
