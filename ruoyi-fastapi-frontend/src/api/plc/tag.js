import request from '@/utils/request'

// 查询指定设备的点位列表
export function listTag(deviceId, query) {
  return request({
    url: '/plc/tag/list/' + deviceId,
    method: 'get',
    params: query
  })
}

// 查询PLC点位详细
export function getTag(tagId) {
  return request({
    url: '/plc/tag/detail/' + tagId,
    method: 'get'
  })
}

// 新增PLC点位
export function addTag(data) {
  return request({
    url: '/plc/tag',
    method: 'post',
    data: data
  })
}

// 修改PLC点位
export function updateTag(data) {
  return request({
    url: '/plc/tag',
    method: 'put',
    data: data
  })
}

// 停用PLC点位（status='1'，可见但不采集）
export function disableTag(tagIds) {
  return request({
    url: '/plc/tag/disable/' + tagIds,
    method: 'put'
  })
}

// 切换点位启停状态
export function toggleTagStatus(tagId, status) {
  return request({
    url: '/plc/tag/status/' + tagId,
    method: 'put',
    params: { status: status }
  })
}

// 删除PLC点位（del_flag='2'，隐藏）
export function delTag(tagIds) {
  return request({
    url: '/plc/tag/' + tagIds,
    method: 'delete'
  })
}

// 下载点位导入模板
export function downloadTagTemplate() {
  return request({
    url: '/plc/tag/template',
    method: 'get',
    responseType: 'blob'
  })
}

// 批量导入点位
export function importTags(deviceId, formData) {
  return request({
    url: '/plc/tag/import/' + deviceId,
    method: 'post',
    data: formData
    // 注意：不手动设置 Content-Type，让 axios 自动处理 boundary
  })
}

// 跨设备全局点位查询
export function listTagGlobal(query) {
  return request({
    url: '/plc/tag/global/list',
    method: 'get',
    params: query
  })
}

// 批量更新点位（P0-6：views/plc/tag/index.vue 的批量修改对话框调用，后端 PUT /plc/tag/batch）
export function batchUpdateTags(data) {
  return request({
    url: '/plc/tag/batch',
    method: 'put',
    data: data
  })
}
