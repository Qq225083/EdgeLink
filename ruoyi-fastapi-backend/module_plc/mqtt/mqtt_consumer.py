"""EdgeLink MQTT 通知发布器

仅维护 MQTT 长连接用于向前端发布 enriched 通知（edgelink/notify/broadcast）。
告警检测与创建统一由 APScheduler 扫描器（monitor_task）负责，
不再订阅 edgelink/alarm/# — 消除 MQTT 消息洪峰时的连接池压力。

模块级 singleton 设计：scanner 任务通过 get_notifier() 获取实例，
无 DB 依赖（enrichment 数据由调用方传入）。
"""
import asyncio
import json
import os
from datetime import datetime
from typing import Optional

from gmqtt import Client as MQTTClient
from gmqtt.mqtt.constants import MQTTv311

from config.env import AppConfig
from utils.log_util import logger

# 通知 Topic（前端 WebSocket 订阅此 Topic 接收告警弹窗）
NOTIFY_TOPIC = 'edgelink/notify/broadcast'

# 模块级 singleton，供 scanner 任务直接使用
_notifier: Optional['MqttNotifier'] = None


def get_notifier() -> Optional['MqttNotifier']:
    """获取模块级 MqttNotifier 实例（scanner 任务入口）"""
    return _notifier


async def publish_config_refresh(
    host_pc_ip: str,
    node_id: int = 0,
    device_id: int = 0,
    driver_code: str = '',
    driver_config: dict | None = None,
) -> bool:
    """设备/点位配置变更后通知采集节点刷新。

    Node-RED config-manager 订阅 `edgelink/notify/broadcast`，
    当 alert_type='CONFIG_REFRESH' 且 node_id 匹配本机时立即重新拉取全局点位。
    payload 中携带 driverCode 与 driverConfig，便于边缘侧直接路由到对应驱动节点。

    :return: True=通知已发出；False=notifier 未初始化/未连接（🔧 P0-3：返回值供发布日志记真实成败）
    """
    notifier = get_notifier()
    if not notifier:
        logger.warning('[MQTT通知] Notifier 未初始化，跳过配置刷新推送')
        return False
    return await notifier.publish_notification(
        alert_type='CONFIG_REFRESH',
        severity=3,
        node_id=node_id,
        device_id=device_id,
        host_pc_ip=host_pc_ip,
        alert_msg='PLC 配置已变更，请立即刷新采集配置',
        driver_code=driver_code,
        driver_config=driver_config,
    )


class MqttNotifier:
    """MQTT 通知发布器（只发布，不订阅）"""

    def __init__(self):
        client_id = f'edgelink-backend-{os.getpid()}'
        self.client = MQTTClient(client_id)

        # 禁用 gmqtt 固定间隔自动重连，改由 _reconnect_loop 以指数退避方式执行
        # （固定 5s 重连在网络长期故障时会产生日志洪峰并持续冲击 Broker）
        self.client.set_config({
            'reconnect_retries': 0,
        })
        self._reconnect_task = None

        self.client.on_connect = self._on_connect_sync
        self.client.on_disconnect = self._on_disconnect_sync

        if AppConfig.mqtt_username:
            self.client.set_auth_credentials(
                AppConfig.mqtt_username, AppConfig.mqtt_password
            )

        self._running = False

    # ==================== 生命周期 ====================

    async def start(self) -> None:
        """启动：连接 EMQX。失败不阻塞应用启动。

        🔧 P1-9/Day3：全局单例在连接前先注册（publish_notification 对未连接返回 False，不会误发），
        且启动即失败时也进入指数退避重连链（旧实现启动失败 → 永不重连 + 单例永不注册）。
        """
        # P1#25: 生产环境 MQTT 凭据校验
        if AppConfig.app_env == 'prod' and not AppConfig.mqtt_username:
            logger.error('[MQTT通知] 生产环境必须配置 mqtt_username / mqtt_password')
            self._running = False
            return

        self._running = True
        global _notifier
        _notifier = self  # 先注册：未连接时 publish 返回 False，由 notification_pending 补偿
        try:
            await self.client.connect(
                AppConfig.mqtt_host,
                AppConfig.mqtt_port,
                version=MQTTv311,
                keepalive=30,
            )
            logger.info(
                f'[MQTT通知] 已连接 {AppConfig.mqtt_host}:{AppConfig.mqtt_port}'
            )
        except Exception as exc:
            logger.error(f'[MQTT通知] 连接失败: {exc}，进入退避重连')
            self._schedule_reconnect()

    async def stop(self) -> None:
        """停止：断开 MQTT 连接"""
        self._running = False
        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()
        global _notifier
        _notifier = None
        try:
            await self.client.disconnect()
            logger.info('[MQTT通知] 已断开')
        except Exception as exc:
            logger.warning(f'[MQTT通知] 断开异常 (可忽略): {exc}')

    # ==================== gmqtt 同步回调 ====================

    def _on_connect_sync(self, client, flags, rc, properties) -> None:
        asyncio.ensure_future(self._on_connect(client, flags, rc, properties))

    def _on_disconnect_sync(self, client, packet, exc=None) -> None:
        asyncio.ensure_future(self._on_disconnect(client, packet, exc))

    # ==================== MQTT 异步回调 ====================

    async def _on_connect(self, client, flags, rc, properties) -> None:
        logger.info('[MQTT通知] 连接就绪')

    async def _on_disconnect(self, client, packet, exc=None) -> None:
        if not self._running:
            logger.info('[MQTT通知] 已断开（主动停止）')
            return
        if exc:
            logger.warning(f'[MQTT通知] 异常断开: {exc}')
        else:
            logger.info('[MQTT通知] 连接已断开')
        self._schedule_reconnect()

    # ==================== 指数退避重连 ====================

    def _schedule_reconnect(self) -> None:
        """调度指数退避重连（已有重连任务在跑时不重复调度）"""
        if self._reconnect_task and not self._reconnect_task.done():
            return
        self._reconnect_task = asyncio.ensure_future(self._reconnect_loop())

    async def _reconnect_loop(self) -> None:
        """指数退避重连：5s 起步，每次翻倍，上限 300s，直到连接恢复或主动停止"""
        delay = 5
        attempt = 0
        while self._running and not self.client.is_connected:
            attempt += 1
            logger.warning(f'[MQTT通知] {delay}s 后进行第 {attempt} 次重连...')
            await asyncio.sleep(delay)
            if not self._running:
                return
            try:
                await self.client.connect(
                    AppConfig.mqtt_host,
                    AppConfig.mqtt_port,
                    version=MQTTv311,
                    keepalive=30,
                )
                logger.info(f'[MQTT通知] 重连成功（第 {attempt} 次）')
                return
            except Exception as exc:
                logger.warning(f'[MQTT通知] 第 {attempt} 次重连失败: {exc}')
                delay = min(delay * 2, 300)

    # ==================== 通知发布 ====================

    async def publish_notification(
        self,
        alert_type: str,
        node_id: int = 0,
        device_id: int = 0,
        alert_msg: str = '',
        node_name: str = '',
        device_name: str = '',
        host_pc_ip: str = '',
        severity: int = 2,
        driver_code: str = '',
        driver_config: dict | None = None,
    ) -> bool:
        """发布 enriched 通知到 edgelink/notify/broadcast

        所有 enrichment 字段由调用方传入（scanner 持有节点/设备信息），
        本方法不访问数据库，零连接开销。
        :return: True=已发出（gmqtt 不等待 PUBACK，仅代表写入 socket 成功）；False=未连接/异常跳过
        """
        notify_payload = {
            'alert_type': alert_type,
            'severity': severity,
            'node_id': node_id,
            'device_id': device_id,
            'node_name': node_name,
            'device_name': device_name,
            'alert_msg': alert_msg,
            'host_pc_ip': host_pc_ip,
            'driver_code': driver_code,
            'driver_config': driver_config or {},
            'timestamp': datetime.now().isoformat(),
        }
        try:
            if not self._running:
                logger.warning(f'[MQTT通知] 连接未就绪，跳过: {alert_type}')
                return False
            if not self.client.is_connected:
                logger.warning(f'[MQTT通知] MQTT 客户端未连接，跳过: {alert_type}')
                return False
            self.client.publish(
                NOTIFY_TOPIC,
                json.dumps(notify_payload, ensure_ascii=False),
                qos=1,
                retain=False,
            )
            logger.info(
                f'[MQTT通知] {alert_type} node={node_id} device={device_id}'
            )
            return True
        except Exception as exc:
            logger.error(f'[MQTT通知] 发送失败: {exc}')
            return False
