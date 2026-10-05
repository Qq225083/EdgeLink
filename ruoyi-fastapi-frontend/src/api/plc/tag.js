import request from '@/utils/request'
import axios from 'axios'
import { getToken } from '@/utils/auth'

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
  // 显式 multipart 头（覆盖 request.js 的全局 JSON 默认；axios 0.27+ 会自动补 boundary）。
  // 不设会继承 axios.defaults 的 application/json，导致后端解析不到 file 字段（422）。
  // .then(res => res.data)：与封装 request 的返回形态对齐（业务体 {code,msg,data}）
  return axios({
    method: 'post',
    url: process.env.VUE_APP_BASE_API + '/plc/tag/import/' + deviceId,
    data: formData,
    headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'multipart/form-data' }
  }).then(res => res.data)
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
