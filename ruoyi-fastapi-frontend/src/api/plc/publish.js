import request from '@/utils/request'

// 查询可发布设备列表（含全局统计）
export function listPublishDevice(query) {
  return request({
    url: '/plc/config/publish/devices',
    method: 'get',
    params: query
  })
}

// 发布PLC配置到采集节点（手动触发，保存变更不会自动生效）
export function publishConfig(data) {
  return request({
    url: '/plc/config/publish',
    method: 'post',
    data: data || {}
  })
}
