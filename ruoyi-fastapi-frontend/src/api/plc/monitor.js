import request from '@/utils/request'

// KPI 仪表盘
export function getKpiDashboard() {
  return request({ url: '/monitor/kpi', method: 'get' })
}

// 采集节点列表（含下级PLC状态）
export function getNodeList() {
  return request({ url: '/monitor/nodes', method: 'get' })
}

// 告警列表
export function getAlertList(limit) {
  return request({ url: '/monitor/alerts', method: 'get', params: { limit: limit || 20 } })
}

// 确认告警
export function confirmAlert(alertId) {
  return request({ url: '/monitor/alerts/' + alertId + '/confirm', method: 'put' })
}
