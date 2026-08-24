import request from '@/utils/request'

// 查询驱动元数据列表
export function listDriverAdmin(query) {
  return request({
    url: '/plc/driver-admin/list',
    method: 'get',
    params: query
  })
}

// 新增驱动元数据
export function addDriverAdmin(data) {
  return request({
    url: '/plc/driver-admin',
    method: 'post',
    data: data
  })
}

// 编辑驱动元数据
export function updateDriverAdmin(data) {
  return request({
    url: '/plc/driver-admin',
    method: 'put',
    data: data
  })
}

// 启用/禁用驱动
export function toggleDriverAdminStatus(driverId, enabled) {
  return request({
    url: '/plc/driver-admin/status/' + driverId,
    method: 'put',
    params: { enabled: enabled }
  })
}

// 删除驱动元数据
export function delDriverAdmin(driverIds) {
  return request({
    url: '/plc/driver-admin/' + driverIds,
    method: 'delete'
  })
}
