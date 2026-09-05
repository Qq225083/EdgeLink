import request from '@/utils/request'

// 查询边缘节点密钥列表
export function listBootstrapKey(query) {
  return request({
    url: '/plc/bootstrap-key/list',
    method: 'get',
    params: query
  })
}

// 新增边缘节点密钥
export function addBootstrapKey(data) {
  return request({
    url: '/plc/bootstrap-key',
    method: 'post',
    data: data
  })
}

// 编辑边缘节点密钥
export function updateBootstrapKey(data) {
  return request({
    url: '/plc/bootstrap-key',
    method: 'put',
    data: data
  })
}

// 启用/禁用边缘节点密钥
export function toggleBootstrapKeyStatus(keyId, enabled) {
  return request({
    url: '/plc/bootstrap-key/status/' + keyId,
    method: 'put',
    params: { enabled: enabled }
  })
}

// 重新生成密钥
export function regenerateBootstrapKey(keyId) {
  return request({
    url: '/plc/bootstrap-key/regenerate/' + keyId,
    method: 'put'
  })
}

// 删除边缘节点密钥
export function delBootstrapKey(keyIds) {
  return request({
    url: '/plc/bootstrap-key/' + keyIds,
    method: 'delete'
  })
}
