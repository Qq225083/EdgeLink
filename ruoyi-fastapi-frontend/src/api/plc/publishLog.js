import request from '@/utils/request'

// 查询发布履历列表
export function listPublishLog(query) {
  return request({
    url: '/plc/publish-log/list',
    method: 'get',
    params: query
  })
}
