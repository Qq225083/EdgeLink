import request from '@/utils/request'
import axios from 'axios'
import { getToken } from '@/utils/auth'

// 生成流程版本（按当前配置快照）
export function generateFlow(data) {
  return request({
    url: '/plc/flowgen/generate',
    method: 'post',
    data: data
  })
}

// 流程版本分页列表
export function listRelease(query) {
  return request({
    url: '/plc/flowgen/release/list',
    method: 'get',
    params: query
  })
}

// 流程版本详情（含 payload 全文）
export function getRelease(releaseId) {
  return request({
    url: '/plc/flowgen/release/' + releaseId,
    method: 'get'
  })
}

// 回滚：以历史版本内容生成新版本
export function rollbackRelease(releaseId) {
  return request({
    url: '/plc/flowgen/release/' + releaseId + '/rollback',
    method: 'post'
  })
}

// 部署到边缘 Node-RED（默认合并部署：只替换 GEN_ 生成标签页；fullReplace=true 全量清空）
export function deployRelease(releaseId, fullReplace) {
  return request({
    url: '/plc/flowgen/release/' + releaseId + '/deploy',
    method: 'post',
    params: { fullReplace: !!fullReplace }
  })
}

// 部署预览：将替换/摘除/新增/保留的标签页清单
export function getDeployPreview(releaseId) {
  return request({
    url: '/plc/flowgen/release/' + releaseId + '/deploy-preview',
    method: 'get'
  })
}

// 手动备份边缘画布快照
export function createSnapshot(siteId) {
  return request({
    url: '/plc/flowgen/snapshot',
    method: 'post',
    params: { siteId }
  })
}

// 画布快照分页列表
export function listSnapshot(query) {
  return request({
    url: '/plc/flowgen/snapshot/list',
    method: 'get',
    params: query
  })
}

// 下载画布快照 flows.json（blob）
export function downloadSnapshot(snapshotId) {
  return axios({
    method: 'get',
    url: process.env.VUE_APP_BASE_API + '/plc/flowgen/snapshot/' + snapshotId + '/download',
    responseType: 'blob',
    headers: { 'Authorization': 'Bearer ' + getToken() }
  })
}

// 边缘漂移检测（在跑画布 vs 最新版本）
export function getDeployStatus(siteId) {
  return request({
    url: '/plc/flowgen/deploy/status',
    method: 'get',
    params: { siteId }
  })
}

// 下载 flows.json（blob，组件内 saveAs 落盘）
export function downloadRelease(releaseId) {
  return axios({
    method: 'get',
    url: process.env.VUE_APP_BASE_API + '/plc/flowgen/release/' + releaseId + '/download',
    responseType: 'blob',
    headers: { 'Authorization': 'Bearer ' + getToken() }
  })
}
