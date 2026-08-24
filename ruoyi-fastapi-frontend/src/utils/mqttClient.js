/**
 * EdgeLink MQTT 客户端封装
 *
 * 依赖：public/index.html 中通过 CDN 加载的 mqtt.js（window.mqtt）
 * CDN: <script src="https://unpkg.com/mqtt@5.15.1/dist/mqtt.min.js"></script>
 *
 * 使用方式：
 *   import { createMqttClient } from '@/utils/mqttClient'
 *   const client = createMqttClient({ url: 'ws://127.0.0.1:8083/mqtt', ... })
 *   client.onMessage((topic, payload) => { ... })
 *   client.connect()
 */

/**
 * 创建 MQTT 客户端
 * @param {Object} options
 * @param {string} options.url           - MQTT WebSocket 地址，如 ws://192.168.1.100:8083/mqtt
 * @param {string} options.username      - 用户名（前端只读账号）
 * @param {string} options.password      - 密码
 * @param {string} [options.clientIdPrefix] - ClientId 前缀，默认 'edgelink-web'
 * @param {number} [options.reconnectPeriod] - 重连间隔 ms，默认 5000
 * @returns {{ connect, disconnect, subscribe, unsubscribe, isConnected, onMessage, onOffline, onConnect }}
 */
export function createMqttClient(options = {}) {
  const mqtt = window.mqtt
  if (!mqtt) {
    console.error('[MQTT] window.mqtt 未加载，请检查 public/index.html 中的 CDN script 标签')
    throw new Error('MQTT SDK 未加载')
  }

  const {
    url,
    username,
    password,
    clientIdPrefix = 'edgelink-web',
    reconnectPeriod = 5000
  } = options

  if (!url) {
    console.error('[MQTT] url 参数为必填项')
    throw new Error('MQTT url 参数为必填项')
  }

  // 生成稳定 ClientId：同一标签页内重连复用（sessionStorage 持久），
  // 不同标签页互不相同（避免互相踢线），Broker 侧可追踪会话
  function getTabId() {
    const key = 'edgelink_mqtt_tab_id'
    try {
      let tabId = sessionStorage.getItem(key)
      if (!tabId) {
        tabId = (window.crypto && crypto.randomUUID)
          ? crypto.randomUUID()
          : Date.now().toString(36) + Math.random().toString(36).substring(2, 10)
        sessionStorage.setItem(key, tabId)
      }
      return tabId
    } catch (e) {
      // sessionStorage 不可用（隐私模式）时退化为一次性随机值
      return Date.now().toString(36) + Math.random().toString(36).substring(2, 10)
    }
  }
  const clientId = clientIdPrefix + '-' + getTabId()

  let client = null
  let connected = false
  let connectPromise = null
  let messageHandler = null
  let offlineHandler = null
  let connectHandler = null

  /**
   * 连接到 EMQX
   * @returns {Promise<void>}
   */
  function connect() {
    if (connectPromise) return connectPromise

    connectPromise = new Promise((resolve, reject) => {
      console.log('[MQTT] 正在连接', url, 'ClientId:', clientId)

      client = mqtt.connect(url, {
        clientId,
        clean: true,
        reconnectPeriod,
        connectTimeout: 10000,
        resubscribe: true,
        username,
        password
      })

      client.on('connect', () => {
        connected = true
        console.log('[MQTT] 已连接，ClientId:', clientId)
        if (connectHandler) connectHandler(true)
        resolve()
      })

      client.on('message', (topic, payload) => {
        try {
          const str = payload.toString()
          const data = JSON.parse(str)
          if (messageHandler) {
            messageHandler(topic, data, str)
          }
        } catch (e) {
          // 非 JSON 消息忽略，打印原始数据便于调试
          console.warn('[MQTT] 收到非JSON消息:', topic, payload.toString().substring(0, 100))
        }
      })

      client.on('reconnect', () => {
        console.log('[MQTT] 正在重连...')
      })

      client.on('close', () => {
        if (connected) {
          connected = false
          console.warn('[MQTT] 连接已断开')
          if (offlineHandler) offlineHandler('close')
        }
      })

      client.on('offline', () => {
        if (connected) {
          connected = false
          console.warn('[MQTT] 客户端离线')
          if (offlineHandler) offlineHandler('offline')
        }
      })

      client.on('error', (err) => {
        console.error('[MQTT] 连接错误:', err.message)
        if (!connected) {
          reject(err)
        }
      })

      // 连接超时处理
      setTimeout(() => {
        if (!connected) {
          reject(new Error('MQTT 连接超时 (10s)'))
        }
      }, 10000)
    })

    return connectPromise
  }

  /**
   * 断开连接
   */
  function disconnect() {
    if (client) {
      client.end(true)
      client = null
      connected = false
      connectPromise = null
      console.log('[MQTT] 已主动断开')
    }
  }

  /**
   * 检查是否已连接
   */
  function isConnected() {
    return connected
  }

  /**
   * 订阅主题
   * @param {string|string[]} topics - 主题（支持通配符 + / #）
   * @param {Object} [opts] - 订阅选项 { qos: 1 }
   * @returns {Promise<void>}
   */
  function subscribe(topics, opts = { qos: 1 }) {
    if (!client || !connected) {
      console.warn('[MQTT] 尚未连接，无法订阅')
      return Promise.reject(new Error('MQTT 尚未连接'))
    }
    const topicList = Array.isArray(topics) ? topics : [topics]
    return new Promise((resolve, reject) => {
      client.subscribe(topicList, opts, (err) => {
        if (err) {
          console.error('[MQTT] 订阅失败:', topicList, err.message)
          reject(err)
        } else {
          console.log('[MQTT] 已订阅:', topicList)
          resolve()
        }
      })
    })
  }

  /**
   * 取消订阅主题
   * @param {string|string[]} topics
   * @returns {Promise<void>}
   */
  function unsubscribe(topics) {
    if (!client || !connected) return Promise.resolve()
    const topicList = Array.isArray(topics) ? topics : [topics]
    return new Promise((resolve, reject) => {
      client.unsubscribe(topicList, (err) => {
        if (err) {
          console.error('[MQTT] 取消订阅失败:', topicList, err.message)
          reject(err)
        } else {
          console.log('[MQTT] 已取消订阅:', topicList)
          resolve()
        }
      })
    })
  }

  /**
   * 注册消息回调
   * @param {(topic: string, data: Object, raw: string) => void} handler
   */
  function onMessage(handler) {
    messageHandler = handler
  }

  /**
   * 注册离线回调（连接断开时触发）
   * @param {(reason: string) => void} handler
   */
  function onOffline(handler) {
    offlineHandler = handler
  }

  /**
   * 注册连接成功回调（含重连恢复）
   * @param {(isOnline: boolean) => void} handler
   */
  function onConnect(handler) {
    connectHandler = handler
  }

  return { connect, disconnect, subscribe, unsubscribe, isConnected, onMessage, onOffline, onConnect }
}
