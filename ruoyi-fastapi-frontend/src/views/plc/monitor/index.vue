<template>
  <div class="app-container">
    <!-- MQTT 配置缺失横幅 -->
    <el-alert
      v-if="mqttConfigMissing"
      title="MQTT 配置缺失：请配置 VUE_APP_MQTT_WS_URL / VUE_APP_MQTT_USERNAME / VUE_APP_MQTT_PASSWORD 环境变量后重启前端"
      type="error"
      :closable="false"
      show-icon
      style="margin-bottom:12px"
    />

    <!-- MQTT 断线横幅 -->
    <el-alert
      v-if="mqttDisconnected && !mqttConfigMissing"
      title="实时连接已断开，数据可能滞后 — 正在自动重连..."
      type="warning"
      :closable="false"
      show-icon
      style="margin-bottom:12px"
    />

    <!-- KPI 卡片 -->
    <el-row :gutter="16" class="kpi-row">
      <el-col :span="6">
        <div class="kpi-card kpi-green">
          <div class="kpi-value">{{ onlineNodes }} / {{ nodeList.length }}</div>
          <div class="kpi-label">采集节点在线</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="kpi-card kpi-blue">
          <div class="kpi-value">{{ onlineDevices }} / {{ totalDevices }}</div>
          <div class="kpi-label">PLC 设备在线</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="kpi-card kpi-purple">
          <div class="kpi-value">{{ formatNumber(todayCollectCount) }}</div>
          <div class="kpi-label">今日总采集条数</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="kpi-card" :class="activeAlerts > 0 ? 'kpi-red' : 'kpi-green'">
          <div class="kpi-value">{{ activeAlerts }}</div>
          <div class="kpi-label">异常告警</div>
        </div>
      </el-col>
    </el-row>

    <!-- 刷新按钮 -->
    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-button type="primary" icon="el-icon-refresh" size="mini" @click="refreshAll">刷新</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-tag v-if="mqttConnected" type="success" size="mini">MQTT 实时</el-tag>
        <el-tag v-else type="info" size="mini">HTTP 模式</el-tag>
      </el-col>
      <el-col :span="2">
        <span class="last-refresh">数据更新于 {{ lastRefreshTime || '--' }}</span>
      </el-col>
    </el-row>

    <!-- 采集节点列表 -->
    <el-table
      v-loading="loading"
      :data="nodeList"
      row-key="id"
      @expand-change="onExpand"
      style="margin-top:10px"
    >
      <el-table-column type="expand">
        <template slot-scope="props">
          <!-- 展开行：该节点下的 PLC 状态 -->
          <el-table :data="props.row.plcList || []" size="small" style="margin: 10px 30px">
            <el-table-column label="PLC 名称" prop="deviceName" width="160" :show-overflow-tooltip="true" />
            <el-table-column label="IP:端口" width="160">
              <template slot-scope="s">{{ s.row.plcIp }}:{{ s.row.plcPort }}</template>
            </el-table-column>
            <el-table-column label="通信状态" width="90">
              <template slot-scope="s">
                <el-tag :type="s.row.online ? 'success' : 'danger'" size="small">
                  {{ s.row.online ? '在线' : '离线' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="最后采集时间" width="170">
              <template slot-scope="s">{{ s.row.lastSuccessTime || '-' }}</template>
            </el-table-column>
            <el-table-column label="连续失败" prop="consecutiveFails" width="80" />
            <el-table-column label="错误信息" prop="errorMsg" :show-overflow-tooltip="true" min-width="200" />
          </el-table>
          <div v-if="!props.row.plcList || props.row.plcList.length === 0" style="padding:15px;color:#999">
            暂无关联 PLC 设备（检查 plc_device.host_pc_ip 是否匹配）
          </div>
        </template>
      </el-table-column>
      <el-table-column label="节点名称" prop="nodeName" width="160" :show-overflow-tooltip="true" />
      <el-table-column label="办公网 IP" prop="officeNetIp" width="130" />
      <el-table-column label="工业网 IP" prop="industNetIp" width="130" />
      <el-table-column label="状态" width="80">
        <template slot-scope="scope">
          <el-tag :type="scope.row.isOnline ? 'success' : 'danger'" size="small">
            {{ scope.row.isOnline ? '在线' : '离线' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="运行流数" width="80">
        <template slot-scope="scope">{{ scope.row.runningFlows || '-' }}</template>
      </el-table-column>
      <el-table-column label="内存(MB)" width="80">
        <template slot-scope="scope">{{ scope.row.memoryUsageMb || '-' }}</template>
      </el-table-column>
      <el-table-column label="PG写入(成功/失败)" width="135">
        <template slot-scope="scope">
          <span :style="scope.row.pgFailCount > 0 ? 'color:#F56C6C' : ''">
            {{ scope.row.pgSuccessCount || 0 }} / {{ scope.row.pgFailCount || 0 }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="Spool积压" width="100">
        <template slot-scope="scope">
          <span :style="scope.row.spoolBytes > 0 ? 'color:#F56C6C;font-weight:bold' : ''">
            {{ formatSpoolSize(scope.row.spoolBytes) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="负责设备" width="110">
        <template slot-scope="scope">
          {{ scope.row.onlineDeviceCount }} / {{ scope.row.deviceCount }}
        </template>
      </el-table-column>
      <el-table-column label="最后心跳" width="170">
        <template slot-scope="scope">{{ scope.row.lastHeartbeat || '-' }}</template>
      </el-table-column>
      <el-table-column label="备注" prop="remark" :show-overflow-tooltip="true" width="120" />
    </el-table>

    <!-- 告警区域 -->
    <el-card class="alert-card" style="margin-top:20px">
      <div slot="header">
        <span><i class="el-icon-warning" /> 实时告警（最近20条）</span>
        <el-button style="float:right" size="mini" type="text" @click="loadAlerts">刷新告警</el-button>
      </div>
      <el-table :data="alertList" size="small" empty-text="暂无告警">
        <el-table-column label="时间" prop="createdAt" width="160" />
        <el-table-column label="类型" width="120">
          <template slot-scope="s">
            <el-tag :type="alertTypeTag(s.row.alertType)" size="small">{{ alertTypeLabel(s.row.alertType) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="级别" width="70">
          <template slot-scope="s">
            <el-tag :type="severityTag(s.row.severity)" size="small">{{ severityLabel(s.row.severity) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="节点" prop="nodeName" width="120" />
        <el-table-column label="内容" prop="alertMsg" :show-overflow-tooltip="true" min-width="250" />
        <el-table-column label="操作" width="80">
          <template slot-scope="s">
            <el-button size="mini" type="text" @click="handleConfirm(s.row)">确认</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script>
import { getNodeList, getAlertList, confirmAlert, getKpiDashboard } from '@/api/plc/monitor'
import { createMqttClient } from '@/utils/mqttClient'

// MQTT 配置 — 从环境变量读取（Vue CLI 要求 VUE_APP_ 前缀）
// P0#5: 删除弱默认凭据，未配置时不自动连接
const MQTT_WS_URL = process.env.VUE_APP_MQTT_WS_URL || ''
const MQTT_USERNAME = process.env.VUE_APP_MQTT_USERNAME || ''
const MQTT_PASSWORD = process.env.VUE_APP_MQTT_PASSWORD || ''
const MQTT_CONFIG_MISSING = !MQTT_WS_URL || !MQTT_USERNAME || !MQTT_PASSWORD

// MQTT Topic 常量
const TOPIC_HEARTBEAT = 'edgelink/heartbeat/+'
const TOPIC_NODE_STATUS = 'edgelink/nodes/+/status'
const TOPIC_ALARM_OFFLINE = 'edgelink/alarm/node_offline/+'
const TOPIC_NOTIFY = 'edgelink/notify/broadcast'

export default {
  name: 'PlcMonitor',
  data() {
    return {
      loading: false,
      // KPI 指标（从 MQTT 实时计算 + HTTP 初始化）
      totalDevices: 0,
      todayCollectCount: 0,
      activeAlerts: 0,
      // 节点列表
      nodeList: [],
      // 告警列表（仍 HTTP 拉取，后续可 MQTT 扩展）
      alertList: [],
      // MQTT 状态
      mqttClient: null,
      mqttConnected: false,
      mqttDisconnected: false,
      mqttConfigMissing: MQTT_CONFIG_MISSING,
      lastRefreshTime: ''
    }
  },
  computed: {
    /** 在线节点数 — 从 nodeList 实时计算 */
    onlineNodes() {
      return this.nodeList.filter(n => n.isOnline).length
    },
    /** 在线设备数 — 从 nodeList 中 plcList 实时计算 */
    onlineDevices() {
      let count = 0
      this.nodeList.forEach(n => {
        if (n.plcList) {
          count += n.plcList.filter(p => p.online).length
        }
      })
      return count
    }
  },
  mounted() {
    // Step 1: 立即设置定时器（防止异步初始化期间导航离开导致定时器泄漏）
    this._kpiTimer = setInterval(() => this.loadKpiAndAlerts(), 10000)
    this._offlineTimer = setInterval(() => this.checkOfflineStatus(), 5000)

    // Step 2: HTTP 一次性加载全量数据（骨架）+ MQTT 实时连接（血肉）
    this._initAsync()
  },
  beforeDestroy() {
    clearInterval(this._kpiTimer)
    clearInterval(this._offlineTimer)
    if (this._kpiRefreshTimer) clearTimeout(this._kpiRefreshTimer)
    // 清理 MQTT 连接
    if (this.mqttClient) {
      this.mqttClient.disconnect()
      this.mqttClient = null
    }
  },
  methods: {
    // ==================== 初始化 ====================

    /** 异步初始化：HTTP 加载全量数据 + MQTT 实时连接 */
    async _initAsync() {
      try {
        await this.initHttpData()
      } catch (e) {
        console.error('[Monitor] HTTP 初始化失败:', e)
      }
      this.initMqtt()
    },

    /** 页面挂载时一次性通过 HTTP 加载全量基础数据 */
    async initHttpData() {
      this.lastRefreshTime = new Date().toLocaleString()
      this.loading = true
      try {
        // 并行加载 KPI + 节点列表 + 告警
        const [kpiRes, nodeRes, alertRes] = await Promise.all([
          getKpiDashboard().catch(() => ({ data: null })),
          getNodeList().catch(() => ({ data: [] })),
          getAlertList(20).catch(() => ({ data: [] }))
        ])
        // KPI 基数（设备总数、今日采集量等不变值）
        if (kpiRes && kpiRes.data) {
          this.totalDevices = kpiRes.data.totalDevices || 0
          this.todayCollectCount = kpiRes.data.todayCollectCount || 0
          this.activeAlerts = kpiRes.data.activeAlerts || 0
        }
        // 节点列表（含每个节点下的 plcList）
        const nodes = nodeRes.data || []
        // 初始化 MQTT 动态字段的默认值
        nodes.forEach(n => {
          n.isOnline = n.isOnline || false
          n.runningFlows = n.runningFlows || 0
          n.memoryUsageMb = n.memoryUsageMb || 0
        })
        this.nodeList = nodes
        // 告警列表
        this.alertList = alertRes.data || []
      } finally {
        this.loading = false
      }
    },

    /** 手动刷新全部（增量合并节点列表，防止管理员新增设备后看不到） */
    refreshAll() {
      this.lastRefreshTime = new Date().toLocaleString()
      // 始终刷新节点列表（增量合并新节点，保留已有节点的 MQTT 实时字段）
      getNodeList().then(r => {
        if (r.data) {
          r.data.forEach(freshNode => {
            const existing = this.nodeList.find(n => n.id === freshNode.id)
            if (!existing) {
              // 新节点 → 加入列表
              freshNode.isOnline = false
              freshNode.runningFlows = 0
              freshNode.memoryUsageMb = 0
              this.nodeList.push(freshNode)
            } else {
              // 已有节点 → 只更新 HTTP 侧字段（设备数、PLC列表等），保留 MQTT 实时字段
              existing.deviceCount = freshNode.deviceCount
              existing.onlineDeviceCount = freshNode.onlineDeviceCount
              existing.plcList = freshNode.plcList
            }
          })
        }
      })
      getKpiDashboard().then(r => {
        if (r.data) {
          this.totalDevices = r.data.totalDevices || this.totalDevices
          this.todayCollectCount = r.data.todayCollectCount || this.todayCollectCount
          // 服务端返回 0 也要生效，避免计数只增不减
          if (r.data.activeAlerts !== undefined) this.activeAlerts = r.data.activeAlerts
        }
      })
      this.loadAlerts()
    },

    // ==================== MQTT 实时连接 ====================

    /** 初始化 MQTT 连接并订阅主题 */
    async initMqtt() {
      this.mqttClient = createMqttClient({
        url: MQTT_WS_URL,
        username: MQTT_USERNAME,
        password: MQTT_PASSWORD,
        clientIdPrefix: 'edgelink-web',
        reconnectPeriod: 5000
      })

      // 注册消息处理
      this.mqttClient.onMessage((topic, data) => {
        this.handleMqttMessage(topic, data)
      })

      // 连接恢复
      this.mqttClient.onConnect((isOnline) => {
        this.mqttConnected = isOnline
        this.mqttDisconnected = !isOnline
        console.log('[Monitor] MQTT 连接状态:', isOnline ? '在线' : '离线')
      })

      // 断开处理
      this.mqttClient.onOffline(() => {
        this.mqttConnected = false
        this.mqttDisconnected = true
        console.warn('[Monitor] MQTT 连接已断开，数据可能滞后')
      })

      try {
        await this.mqttClient.connect()
        this.mqttConnected = true
        this.mqttDisconnected = false

        // 批量订阅三个 Topic Pattern
        await this.mqttClient.subscribe([
          TOPIC_HEARTBEAT,
          TOPIC_NODE_STATUS,
          TOPIC_ALARM_OFFLINE,
          TOPIC_NOTIFY
        ])
        console.log('[Monitor] MQTT 订阅完成，实时监控已就绪')
      } catch (err) {
        console.error('[Monitor] MQTT 初始化失败，降级为HTTP轮询:', err.message)
        this.mqttConnected = false
        this.mqttDisconnected = true
      }
    },

    /** 处理收到的 MQTT 消息 */
    handleMqttMessage(topic, data) {
      // --- edgelink/notify/broadcast（无 node_id，提前处理）---
      if (topic === 'edgelink/notify/broadcast') {
        this.handleBackendNotification(data)
        return
      }

      // 提取 node_id（注意：/status Topic 最后一段是 'status'，倒数第二段才是 id）
      const parts = topic.split('/')
      let nodeId
      if (topic.startsWith('edgelink/nodes/') && topic.endsWith('/status')) {
        nodeId = parseInt(parts[parts.length - 2], 10)  // edgelink/nodes/123/status → 123
      } else {
        nodeId = parseInt(parts[parts.length - 1], 10)   // edgelink/heartbeat/123 → 123
      }

      if (isNaN(nodeId)) {
        // 无法提取 node_id 时，检查是否为离线告警（topic 不含有效 ID，如 LWT 消息）
        if (topic.startsWith('edgelink/alarm/node_offline')) {
          this.handleNodeOfflineAlarm(0, data)
          return
        }
        console.warn('[Monitor] 无法从Topic提取node_id:', topic)
        return
      }

      // --- edgelink/heartbeat/{node_id} ---
      if (topic.startsWith('edgelink/heartbeat/')) {
        this.handleHeartbeat(nodeId, data)
      }
      // --- edgelink/nodes/{node_id}/status ---
      else if (topic.startsWith('edgelink/nodes/') && topic.endsWith('/status')) {
        this.handleNodeStatus(nodeId, data)
      }
      // --- edgelink/alarm/node_offline/{node_id} ---
      else if (topic.startsWith('edgelink/alarm/node_offline')) {
        this.handleNodeOfflineAlarm(nodeId, data)
      }
    },

    /** 处理心跳消息：更新 lastHeartbeat / isOnline / 运行信息 */
    handleHeartbeat(nodeId, data) {
      let node = this.nodeList.find(n => n.id === nodeId)
      if (!node) {
        // 新节点上线（HTTP初始化时不存在）→ 增量加载
        console.warn('[Monitor] 收到新节点心跳, node_id:', nodeId, '— 触发增量加载')
        this.loadNewNode(nodeId)
        return
      }
      // 更新实时字段，并清除离线告警标记
      node.isOnline = true
      node._offlineAlarmTime = null
      node.lastHeartbeat = data.ts || new Date().toISOString()
      node.runningFlows = data.running_flows || 0
      node.memoryUsageMb = data.memory_usage_mb || 0
      if (data.host_pc_ip) node.hostPcIp = data.host_pc_ip
    },

    /** 增量加载新上线的节点（带加载锁，防止心跳积压时重复请求） */
    loadNewNode(nodeId) {
      if (this._loadingNewNode) return
      this._loadingNewNode = true
      getNodeList().then(r => {
        if (r.data) {
          const newNodes = r.data.filter(n => !this.nodeList.find(ex => ex.id === n.id))
          newNodes.forEach(n => {
            n.isOnline = true  // 既然收到了心跳，肯定在线
            n.runningFlows = 0
            n.memoryUsageMb = 0
          })
          if (newNodes.length > 0) {
            this.nodeList.push(...newNodes)
            console.log('[Monitor] 增量加载了', newNodes.length, '个新节点:', newNodes.map(n => n.id))
          }
        }
      }).catch(() => {}).finally(() => {
        this._loadingNewNode = false
      })
    },

    /** 处理节点状态变化消息（含 Retain 的初始状态） */
    handleNodeStatus(nodeId, data) {
      const node = this.nodeList.find(n => n.id === nodeId)
      if (!node) return
      // Retained 消息可能是旧数据，检查时间戳是否在 90 秒内
      const msgAge = data.ts ? (Date.now() - new Date(data.ts).getTime()) : 999999
      if (data.status === 'online' && msgAge > 90000) return // 🔧 P2-7：阈值统一 90s，过期消息忽略
      node.isOnline = data.status === 'online'
      if (data.ts) node.lastHeartbeat = data.ts
    },

    /** 🔧 Day4：告警弹窗去重——同一告警 60s 内只弹一次（LWT 与后端通知双通道会重复触发） */
    _shouldAlertPopup(key) {
      const now = Date.now()
      if (!this._alertShownAt) this._alertShownAt = {}
      const last = this._alertShownAt[key] || 0
      if (now - last < 60000) return false
      this._alertShownAt[key] = now
      // 防止 map 无限增长（只保留 10 分钟内的）
      Object.keys(this._alertShownAt).forEach(k => {
        if (now - this._alertShownAt[k] > 600000) delete this._alertShownAt[k]
      })
      return true
    },

    /** 处理离线告警（MQTT Last Will 触发，15s内感知） */
    handleNodeOfflineAlarm(nodeId, data) {
      // 先按 topic 的 node_id 匹配；失败则按 payload 的 host_pc_ip 匹配
      let node = this.nodeList.find(n => n.id === nodeId)
      if (!node && data.host_pc_ip) {
        node = this.nodeList.find(n => n.hostPcIp === data.host_pc_ip)
      }

      if (node) {
        // 标记离线并记录告警时间，防止定时器覆盖
        node.isOnline = false
        node._offlineAlarmTime = Date.now()
      }

      // Element UI Notification 弹窗告警（即使无法识别具体节点也弹出；60s 去重防双通道重复）
      if (data.alert_type === 'NODE_OFFLINE' && this._shouldAlertPopup('NODE_OFFLINE:' + nodeId + ':0')) {
        const source = node ? (node.hostPcIp || node.officeNetIp) : (data.host_pc_ip || '未知采集节点')
        this.$notify({
          title: '⚠️ 节点离线告警',
          message: `${source} — ${data.msg || '采集节点异常断开'}`,
          type: 'error',
          duration: 0,
          position: 'top-right'
        })
        this.playAlarmSound()
      }

      // 告警计数以服务端 KPI 为准（防抖刷新），不做本地 +1，避免多用户/漏刷新导致计数漂移
      this.refreshKpiAndAlertsDebounced()
    },

    /** 处理后端 MQTT 消费者发布的 enriched 告警通知 */
    handleBackendNotification(data) {
      if (!data || !data.alert_type) return

      const typeLabel = this.alertTypeLabel(data.alert_type)
      const source = data.node_name || data.device_name || '未知'
      const detail = data.alert_msg || ''
      const host = data.host_pc_ip || ''

      // 🔧 Day4：60s 去重（同一 alert_type+node+device 的弹窗/响铃不重复）
      const dedupKey = data.alert_type + ':' + (data.node_id || 0) + ':' + (data.device_id || 0)
      if (!this._shouldAlertPopup(dedupKey)) {
        this.refreshKpiAndAlertsDebounced()
        return
      }

      // Element UI Notification 弹窗
      this.$notify({
        title: `[${typeLabel}] 告警`,
        message: `${source}${host ? ' (' + host + ')' : ''} — ${detail}`,
        type: this.alertTypeTag(data.alert_type) === 'danger' ? 'error'
          : this.alertTypeTag(data.alert_type) === 'warning' ? 'warning' : 'info',
        duration: 8000,
        position: 'top-right'
      })

      // 节点离线：播放告警音 + 更新 nodeList 在线状态
      if (data.alert_type === 'NODE_OFFLINE') {
        this.playAlarmSound()
        if (data.node_id) {
          const node = this.nodeList.find(n => n.id === data.node_id)
          if (node) node.isOnline = false
        }
      }

      // 告警计数以服务端 KPI 为准（防抖刷新），不做本地 +1，避免多用户/漏刷新导致计数漂移
      this.refreshKpiAndAlertsDebounced()
    },

    /** 播放告警提示音（简短 beep，不重复） */
    playAlarmSound() {
      try {
        if (this._alarmPlaying) return // 防重复播放
        this._alarmPlaying = true
        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.frequency.value = 800
        osc.type = 'square'
        gain.gain.value = 0.1
        osc.start()
        osc.stop(ctx.currentTime + 0.3)
        setTimeout(() => { this._alarmPlaying = false }, 500)
      } catch (e) {
        // 静默失败，不影响主流程
      }
    },

    // ==================== 告警操作（HTTP） ====================

    loadAlerts() {
      getAlertList(20).then(r => { this.alertList = r.data || [] }).catch(() => {
        this.alertList = []
      })
    },
    /** MQTT 告警触发的 KPI/告警刷新（1.5s 防抖，避免消息洪峰时连续请求） */
    refreshKpiAndAlertsDebounced() {
      if (this._kpiRefreshTimer) clearTimeout(this._kpiRefreshTimer)
      this._kpiRefreshTimer = setTimeout(() => {
        getKpiDashboard().then(r => {
          // 以服务端 KPI 为准（包括 0），本地不维护计数
          if (r.data && r.data.activeAlerts !== undefined) this.activeAlerts = r.data.activeAlerts
        }).catch(() => {})
        this.loadAlerts()
      }, 1500)
    },
    /** 10秒定时刷新 KPI + 告警；节点列表仅在 MQTT 断开时全量轮询（MQTT 在线时每 30s 一次保底同步 PLC 通信状态） */
    loadKpiAndAlerts() {
      this.lastRefreshTime = new Date().toLocaleString()
      this._pollTick = (this._pollTick || 0) + 1
      // MQTT 在线时节点/设备状态由推送实时更新，无需 10s 全量轮询；
      // 但 PLC 级 lastSuccessTime 暂无推送通道，每 3 个周期（30s）拉一次保底
      if (!this.mqttConnected || this._pollTick % 3 === 0) {
        // 增量刷新节点列表（只更新HTTP字段，MQTT实时字段不动，不折叠展开行）
        getNodeList().then(r => {
          if (r.data) {
            r.data.forEach(fresh => {
              const node = this.nodeList.find(n => n.id === fresh.id)
              if (node) {
                const now = Date.now()
                // 节点在线 = 90秒内有心跳（🔧 P2-7 阈值统一）
                node.lastHeartbeat = fresh.lastHeartbeat || node.lastHeartbeat
                node.isOnline = node.lastHeartbeat && (now - new Date(node.lastHeartbeat).getTime()) < 90000
                node.deviceCount = fresh.deviceCount
                node.onlineDeviceCount = fresh.onlineDeviceCount
                // PLC在线 = 90秒内有通信成功记录
                node.plcList = (fresh.plcList || []).map(p => {
                  if (p.lastSuccessTime && typeof p.lastSuccessTime === 'string' && p.lastSuccessTime.indexOf('T') > -1) {
                    p.lastSuccessTime = p.lastSuccessTime.replace('T', ' ').substring(0, 19)
                  }
                  p.online = p.lastSuccessTime && (now - new Date(p.lastSuccessTime).getTime()) < 90000
                  return p
                })
              }
            })
          }
        }).catch(() => {})
      }
      getKpiDashboard().then(r => {
        if (r.data) {
          this.totalDevices = r.data.totalDevices || this.totalDevices
          this.todayCollectCount = r.data.todayCollectCount || this.todayCollectCount
          // 服务端返回 0 也要生效（|| 会让 0 被旧值覆盖，导致计数只增不减）
          if (r.data.activeAlerts !== undefined) this.activeAlerts = r.data.activeAlerts
        }
      }).catch(() => {})
      getAlertList(20).then(r => { this.alertList = r.data || [] }).catch(() => {})
    },
    /** 5秒定时检测离线：心跳/设备通信超时即标离线（MQTT秒级感知在线，定时器秒级感知离线） */
    checkOfflineStatus() {
      const now = Date.now()
      const timeout = 90000 // 90秒无心跳/无通信 = 离线（与后端离线判定阈值一致）
      this.nodeList.forEach(node => {
        // 节点离线检测
        if (node.lastHeartbeat) {
          const age = now - new Date(node.lastHeartbeat).getTime()
          // 如果节点已被告警标记为离线，且仍在告警有效期内，不覆盖为在线
          if (node._offlineAlarmTime && (now - node._offlineAlarmTime) < timeout) {
            node.isOnline = false
          } else {
            node.isOnline = age < timeout
          }
        }
        // PLC设备离线检测
        if (node.plcList) {
          node.plcList.forEach(p => {
            if (p.lastSuccessTime) {
              p.online = (now - new Date(p.lastSuccessTime).getTime()) < timeout
            }
          })
        }
      })
    },
    onExpand(row, expandedRows) { /* 展开时数据已由HTTP初始化加载 */ },
    handleConfirm(row) {
      this.$modal.confirm('确认该告警？').then(() => {
        confirmAlert(row.id).then(() => {
          this.loadAlerts()
          // 以数据库 KPI 为准，不本地 -1（避免多用户操作导致计数漂移）
          getKpiDashboard().then(r => {
            if (r.data) this.activeAlerts = r.data.activeAlerts || 0
          })
        }).catch(() => {})
      }).catch(() => {})
    },

    // ==================== 工具方法 ====================

    formatNumber(n) { return (n || 0).toLocaleString() },
    /** Spool 字节数格式化（B/KB/MB） */
    formatSpoolSize(bytes) {
      if (!bytes || bytes <= 0) return '0'
      if (bytes < 1024) return bytes + 'B'
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB'
      return (bytes / 1048576).toFixed(1) + 'MB'
    },
    alertTypeLabel(t) { return { NODE_OFFLINE: '节点离线', PLC_OFFLINE: 'PLC离线', PG_WRITE_LAG: 'PG写入异常' }[t] || t },
    alertTypeTag(t) { return { NODE_OFFLINE: 'danger', PLC_OFFLINE: 'warning', PG_WRITE_LAG: 'info' }[t] || 'info' },
    severityLabel(s) { return { 1: '严重', 2: '一般', 3: '提示' }[s] || '-' },
    severityTag(s) { return { 1: 'danger', 2: 'warning', 3: 'info' }[s] || 'info' }
  }
}
</script>

<style scoped>
.last-refresh { color: #c0c4cc; font-size: 11px; line-height: 28px; letter-spacing: 0.5px; }
.kpi-row { margin-bottom: 16px; }
.kpi-card { border-radius: 8px; padding: 18px 20px; color: #fff; text-align: center; }
.kpi-green  { background: linear-gradient(135deg, #67C23A, #85CE61); }
.kpi-blue   { background: linear-gradient(135deg, #409EFF, #66B1FF); }
.kpi-purple { background: linear-gradient(135deg, #9B59B6, #BB8FCE); }
.kpi-red    { background: linear-gradient(135deg, #F56C6C, #F89898); }
.kpi-value  { font-size: 32px; font-weight: bold; line-height: 1.2; }
.kpi-label  { font-size: 13px; opacity: 0.9; margin-top: 4px; }
.alert-card >>> .el-card__header { padding: 10px 16px; background: #fdf6ec; }
</style>
