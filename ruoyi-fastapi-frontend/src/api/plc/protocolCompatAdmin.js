import request from '@/utils/request'

// 查询协议兼容映射列表
export function listProtocolCompatAdmin(query) {
  return request({
    url: '/plc/protocol-compat-admin/list',
    method: 'get',
    params: query
  })
}

// 新增协议兼容映射
export function addProtocolCompatAdmin(data) {
  return request({
    url: '/plc/protocol-compat-admin',
    method: 'post',
    data: data
  })
}

// 编辑协议兼容映射
export function updateProtocolCompatAdmin(data) {
  return request({
    url: '/plc/protocol-compat-admin',
    method: 'put',
    data: data
  })
}

// 删除协议兼容映射
export function delProtocolCompatAdmin(compatIds) {
  return request({
    url: '/plc/protocol-compat-admin/' + compatIds,
    method: 'delete'
  })
}
