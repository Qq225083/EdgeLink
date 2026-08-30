import request from '@/utils/request'

// 登记采集点（生成唯一密钥，明文仅返回一次）
export function addSite(data) {
  return request({
    url: '/site-health/site',
    method: 'post',
    data: data
  })
}

// 查询采集点列表（含在线状态与最新指标）
export function listSite(query) {
  return request({
    url: '/site-health/site/list',
    method: 'get',
    params: query
  })
}

// 查询采集点状态统计（一览卡片）
export function getSiteSummary() {
  return request({
    url: '/site-health/site/summary',
    method: 'get'
  })
}

// 编辑采集点情报（不动密钥）
export function updateSite(siteId, data) {
  return request({
    url: '/site-health/site/' + siteId,
    method: 'put',
    data: data
  })
}

// 查询采集点心跳履历
export function getSiteHistory(siteId, params) {
  return request({
    url: '/site-health/site/' + siteId + '/history',
    method: 'get',
    params: params
  })
}

// 重新生成密钥（旧密钥立即失效，返回新密钥明文仅一次）
export function regenerateSiteKey(siteId) {
  return request({
    url: '/site-health/site/' + siteId + '/regenerate',
    method: 'put'
  })
}

// 启用/停用采集点
export function toggleSiteStatus(siteId, enabled) {
  return request({
    url: '/site-health/site/' + siteId + '/status',
    method: 'put',
    params: { enabled: enabled }
  })
}

// 删除采集点（连同心跳履历）
export function delSite(siteIds) {
  return request({
    url: '/site-health/site/' + siteIds,
    method: 'delete'
  })
}
