/**
 * EdgeLink Node-RED — 心跳 function 节点（30秒定时 inject 触发）
 *
 * 部署位置：inject 节点（每30秒） → 本 function → [mqtt out 节点, http request 节点]
 * 输出两根线：
 *   output[0] → mqtt out 节点（Topic: edgelink/heartbeat/{node_id}）
 *   output[1] → http request 节点（POST /dev-api/monitor/heartbeat，保留存库逻辑）
 *
 * 功能：
 *   1. 从 global 上下文读取 nodeId, hostPcIp, mqttHost
 *   2. 收集 Node-RED 当前运行状态（flows 数量、内存占用）
 *   3. 构建 MQTT 心跳 Payload + HTTP 查询参数
 *   4. 并行输出两条消息到 MQTT 和 HTTP 通道
 */

// ==================== 环境变量 ====================
const BACKEND_HOST = env.get('EDGELINK_BACKEND_HOST') || '127.0.0.1'
const BACKEND_PORT = env.get('EDGELINK_BACKEND_PORT') || '9099'
const API_KEY = env.get('EDGELINK_MONITOR_API_KEY') || ''
const JWT_TOKEN = env.get('EDGELINK_JWT_TOKEN') || ''

// ==================== 从 global 读取上下文 ====================
const nodeId = global.get('nodeId')
const hostPcIp = global.get('hostPcIp')
const mqttHost = global.get('mqttHost')

if (!nodeId) {
    node.warn('[Heartbeat] nodeId 未设置，仅发送 HTTP 心跳（后端会自动注册）')
}
if (!hostPcIp) {
    node.error('[Heartbeat] hostPcIp 未设置，使用 127.0.0.1 兜底')
}

const ip = hostPcIp || '127.0.0.1'
const now = new Date()
const ts = now.toISOString()

// ==================== 收集运行状态 ====================
// 当前运行的 flow 数量（Node-RED 内置 RED.nodes）
let runningFlows = 0
try {
    runningFlows = RED.nodes.eachNode ? RED.nodes.eachNode(() => {}) : 0
    // 更准确的方式：统计 activity
    if (typeof runningFlows !== 'number') runningFlows = Object.keys(RED.nodes._nodes || {}).length
} catch (e) {
    runningFlows = 0
}

// 内存占用（MB）
let memoryUsageMb = 0
try {
    const mem = process.memoryUsage()
    memoryUsageMb = Math.round(mem.heapUsed / 1024 / 1024)
} catch (e) {
    memoryUsageMb = 0
}

// ==================== 构建输出消息 ====================

// --- 消息1：MQTT 心跳（msg[0]）---
const mqttMsg = {
    topic: nodeId ? `edgelink/heartbeat/${nodeId}` : null,
    payload: JSON.stringify({
        node_id: nodeId || 0,
        host_pc_ip: ip,
        node_ip: ip,
        running_flows: runningFlows,
        memory_usage_mb: memoryUsageMb,
        status: 'online',
        ts: ts
    }),
    qos: 1,
    retain: false
}

// 如果 nodeId 未设置，mqttMsg.topic 为 null，mqtt out 节点将跳过发送
if (!mqttMsg.topic) {
    node.warn('[Heartbeat] MQTT topic 为空，跳过 MQTT 发送')
}

// --- 消息2：HTTP 心跳（msg[1]）---
// 保留原有 HTTP POST 到 /dev-api/monitor/heartbeat，用于后端存库和自动注册
const httpUrl = `http://${BACKEND_HOST}:${BACKEND_PORT}/dev-api/monitor/heartbeat`
const httpParams = new URLSearchParams({
    host_pc_ip: ip,
    node_ip: ip,
    running_flows: runningFlows,
    memory_usage_mb: memoryUsageMb
})

const httpMsg = {
    url: `${httpUrl}?${httpParams.toString()}`,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${JWT_TOKEN}`,
        'X-API-Key': API_KEY
    },
    // Node-RED http request 节点的 payload（POST body，可为空对象）
    payload: {}
}

// ==================== 调试日志 ====================
node.status({ fill: 'green', shape: 'dot', text: `OK ${ts.substring(11, 19)}` })
node.trace(`[Heartbeat] node_id=${nodeId} flows=${runningFlows} mem=${memoryUsageMb}MB`)

// ==================== 返回数组（fan out 到两根输出线） ====================
// output[0] → mqtt out
// output[1] → http request
return [mqttMsg, httpMsg]
