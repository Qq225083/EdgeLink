import request from '@/utils/request'

// 交付物列表
export function listDownloads(params) {
  return request({ url: '/common/downloads/list', method: 'get', params })
}

// 上传交付物（multipart）
export function uploadDownload(formData) {
  return request({
    url: '/common/downloads/upload',
    method: 'post',
    data: formData,
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}

// 编辑交付物元信息
export function updateDownload(id, data) {
  return request({ url: '/common/downloads/' + id, method: 'put', data })
}

// 删除交付物
export function deleteDownload(id) {
  return request({ url: '/common/downloads/' + id, method: 'delete' })
}
