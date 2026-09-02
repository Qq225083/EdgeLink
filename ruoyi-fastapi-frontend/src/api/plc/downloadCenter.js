import request from '@/utils/request'

// 交付物列表
export function listDownloads(params) {
  return request({ url: '/common/downloads/list', method: 'get', params })
}

// 上传交付物（multipart）
// 注意：大文件传输耗时可能超过默认 30s 超时，这里放宽到 10 分钟
export function uploadDownload(formData) {
  return request({
    url: '/common/downloads/upload',
    method: 'post',
    data: formData,
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 600000
  })
}

// 分片上传：初始化会话
export function initDownloadUpload(data) {
  return request({ url: '/common/downloads/upload/init', method: 'post', data })
}

// 分片上传：上传单片（multipart）
export function uploadDownloadChunk(formData) {
  return request({
    url: '/common/downloads/upload/chunk',
    method: 'post',
    data: formData,
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000
  })
}

// 分片上传：合并入库
export function mergeDownloadUpload(data) {
  return request({ url: '/common/downloads/upload/merge', method: 'post', data, timeout: 300000 })
}

// 编辑交付物元信息
export function updateDownload(id, data) {
  return request({ url: '/common/downloads/' + id, method: 'put', data })
}

// 删除交付物
export function deleteDownload(id) {
  return request({ url: '/common/downloads/' + id, method: 'delete' })
}
