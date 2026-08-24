import request from '@/utils/request'

// 查询PLC设备列表
export function listDevice(query) {
  return request({
    url: '/plc/device/list',
    method: 'get',
    params: query
  })
}

// 查询PLC设备详细（含点位列表）
export function getDevice(deviceId) {
  return request({
    url: '/plc/device/' + deviceId,
    method: 'get'
  })
}

// 新增PLC设备
export function addDevice(data) {
  return request({
    url: '/plc/device',
    method: 'post',
    data: data
  })
}

// 修改PLC设备
export function updateDevice(data) {
  return request({
    url: '/plc/device',
    method: 'put',
    data: data
  })
}

// 停用PLC设备（status='1'，可见但不采集）
export function disableDevice(deviceIds) {
  return request({
    url: '/plc/device/disable/' + deviceIds,
    method: 'put'
  })
}

// 切换设备启停状态
export function toggleDeviceStatus(deviceId, status) {
  return request({
    url: '/plc/device/status/' + deviceId,
    method: 'put',
    params: { status: status }
  })
}

// 删除PLC设备（del_flag='2'，隐藏）
export function delDevice(deviceIds) {
  return request({
    url: '/plc/device/' + deviceIds,
    method: 'delete'
  })
}

// 克隆PLC设备
export function cloneDevice(deviceId, params) {
  return request({
    url: '/plc/device/clone/' + deviceId,
    method: 'post',
    params: params
  })
}

// 查询PLC协议兼容配置（品牌/系列/通信方式/寄存器类型级联）
export function getProtocolCompat() {
  return request({
    url: '/plc/protocol-compat/all',
    method: 'get'
  })
}

// 查询指定驱动的 schema（config_schema / register_types / data_types）
export function getDriverSchema(driverCode) {
  return request({
    url: '/plc/driver/' + driverCode + '/schema',
    method: 'get'
  })
}
