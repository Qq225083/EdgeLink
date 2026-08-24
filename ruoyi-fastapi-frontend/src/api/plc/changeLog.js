import request from '@/utils/request'

// 查询修改履历列表
export function listChangeLog(query) {
  return request({
    url: '/plc/change-log/list',
    method: 'get',
    params: query
  })
}
