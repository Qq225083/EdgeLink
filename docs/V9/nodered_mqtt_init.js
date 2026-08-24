/**
 * EdgeLink Node-RED — 启动初始化 function 节点
 *
 * 部署位置：Node-RED flow 顶部，inject 节点（系统启动时执行一次）
 * 或作为 "启动时" inject 节点的 function payload
 *
 * 功能：
 *   1. 检测本机 IPv4 → MySQL 反查 host_pc_ip → 获取/缓存 node_id
 *   2. 设置 global 变量（mqttHost, nodeId, hostPcIp）供后续心跳节点使用
 *   3. 连接 EMQX（通过 mqtt out 节点的连接配置）
 *   4. 设置 Last Will（在 mqtt out 节点中配置）
 *   5. 连接成功后发布 edgelink/nodes/{node_id}/status Retain=true
 *
 * 输出：msg（继续流向后续节点）
 */

// ==================== 环境变量 ====================
const MQTT_HOST = env.get('EDGELINK_MQTT_HOST') || '127.0.0.1'
const MQTT_PORT = parseInt(env.get('EDGELINK_MQTT_PORT') || '1883', 10)
const MQTT_USERNAME = env.get('EDGELINK_MQTT_USERNAME') || 'nodered_pub'
const MQTT_PASSWORD = env.get('EDGELINK_MQTT_PASSWORD') || ''
// 如果之前在 global 中已设置 node_id（如手动注入），优先使用
const PRE_SET_NODE_ID = env.get('EDGELINK_NODE_ID') || global.get('node_id') || null

// ==================== 检测本机所有 IPv4 地址 ====================
const os = require('os')
const interfaces = os.networkInterfaces()
const localIPv4s = []

for (const [name, ifaceList] of Object.entries(interfaces)) {
    for (const iface of ifaceList) {
        // 只取 IPv4，排除内部回环地址
        if (iface.family === 'IPv4' && !iface.internal) {
            localIPv4s.push({ name, address: iface.address })
            node.warn(`[EdgeLink-Init] 检测到网卡: ${name} → ${iface.address}`)
        }
    }
}

if (localIPv4s.length === 0) {
    node.error('[EdgeLink-Init] 未检测到任何有效 IPv4 地址，使用 127.0.0.1 兜底')
    localIPv4s.push({ name: 'loopback', address: '127.0.0.1' })
}

// 优先取 NIC1（办公网），可通过环境变量 EDGELINK_NIC_PRIORITY 指定网卡名
const nicPriority = (env.get('EDGELINK_NIC_PRIORITY') || '').split(',')
let hostPcIp = localIPv4s[0].address

// 按优先级匹配网卡名称（如 "以太网,eth0,Ethernet"）
if (nicPriority.length > 0 && nicPriority[0]) {
    for (const nicName of nicPriority) {
        const match = localIPv4s.find(iface => iface.name.includes(nicName))
        if (match) {
            hostPcIp = match.address
            node.warn(`[EdgeLink-Init] 按优先级匹配网卡: ${match.name} → ${hostPcIp}`)
            break
        }
    }
}

node.warn(`[EdgeLink-Init] 选定 hostPcIp: ${hostPcIp}`)

// ==================== 存储到 global ====================
global.set('hostPcIp', hostPcIp)
global.set('mqttHost', MQTT_HOST)
global.set('mqttPort', MQTT_PORT)

// 如果已有预置 node_id，直接使用
if (PRE_SET_NODE_ID) {
    global.set('nodeId', parseInt(PRE_SET_NODE_ID, 10))
    node.warn(`[EdgeLink-Init] 使用预置 node_id: ${PRE_SET_NODE_ID}`)
    // 直接跳到 MQTT 连接准备
    return buildMqttStatusMsg()
}

// ==================== MySQL 反查 host_pc_ip → node_id ====================
// 构造 SQL 查询
const sql = `SELECT id FROM nodered_node WHERE host_pc_ip = '${hostPcIp}' AND del_flag = '0' LIMIT 1`

node.warn(`[EdgeLink-Init] 执行 MySQL 反查: ${sql}`)

// 将 SQL 查询请求发送给 mysql 节点（需在前方连接一个 mysql 输入节点）
msg.topic = sql
msg._init_phase = 'mysql_lookup' // 标记当前阶段，便于后续节点识别

return msg


// ==================== 辅助函数：构建 MQTT 状态消息 ====================
function buildMqttStatusMsg() {
    const nodeId = global.get('nodeId')
    const ip = global.get('hostPcIp')

    if (!nodeId) {
        node.error('[EdgeLink-Init] nodeId 为空，跳过 MQTT 状态发布')
        return null
    }

    // 构建 online 状态的 Retain 消息
    const ts = new Date().toISOString()
    msg.topic = `edgelink/nodes/${nodeId}/status`
    msg.payload = JSON.stringify({
        node_id: nodeId,
        host_pc_ip: ip,
        status: 'online',
        ts: ts
    })
    msg.qos = 1
    msg.retain = true
    msg._init_phase = 'mqtt_status'

    node.warn(`[EdgeLink-Init] MQTT 状态消息已构建: ${msg.topic} → ${msg.payload}`)
    return msg
}
