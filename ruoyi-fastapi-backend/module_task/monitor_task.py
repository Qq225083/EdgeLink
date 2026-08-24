"""EdgeLink 监控中心 — 内置后台任务

这些任务由 SchedulerUtil 在应用启动时自动注册，不依赖数据库中的定时任务配置。

离线检测架构（简化版）：
  第1层（秒级）：MQTT Last Will — Node-RED TCP断开15s后 EMQX自动发布告警 → 前端秒级感知
  第2层（30s级）：本任务 APScheduler — 扫描 last_heartbeat > 60s 节点/设备，写DB告警 + 发MQTT通知

两者并行运行，互不依赖。告警去重由 monitor_alert 唯一约束 + create_alert savepoint 双重保护。

多实例部署时，周期性扫描任务通过 Redis 分布式锁保证同一时刻只有一个实例执行，
避免重复扫描、重复告警。
"""
from sqlalchemy.exc import SQLAlchemyError

from config.database import AsyncSessionLocal
from config.get_redis import RedisUtil
from module_plc.dao.monitor_dao import MonitorDao
from module_plc.mqtt.mqtt_consumer import get_notifier
from utils.log_util import logger

# ==================== Redis 分布式锁（多实例部署保护） ====================

_redis_client = None


async def _get_redis():
    """延迟获取 Redis 客户端（模块级缓存，避免每个周期新建连接）"""
    global _redis_client
    if _redis_client is None:
        _redis_client = await RedisUtil.create_redis_pool()
    return _redis_client


async def _try_acquire_lock(lock_key: str, ttl_sec: int) -> bool:
    """尝试获取 Redis 分布式锁（SET NX EX）。

    锁不主动释放：任务执行耗时远小于 TTL，到期自动过期，实例 crash 也不会死锁。
    Redis 不可用时降级为无锁执行（返回 True），避免 Redis 单点故障导致监控任务整体停摆。
    """
    try:
        redis = await _get_redis()
        return bool(await redis.set(lock_key, '1', nx=True, ex=ttl_sec))
    except Exception as exc:
        logger.warning(f'[分布式锁] Redis 异常，降级为本实例直接执行：{exc}')
        return True


async def check_offline_nodes_task() -> None:
    """第2层：周期性扫描离线节点并发布前端通知（每30秒）

    与 MQTT Last Will（第1层）并行：
      - MQTT Last Will 负责秒级实时告警（Node-RED断网 → 15s内前端弹窗）
      - 本任务负责兜底 + 向前端发布 enriched 通知（复用扫描结果，零额外DB查询）
    """
    if not await _try_acquire_lock('edgelink:lock:check_offline_nodes', ttl_sec=20):
        return  # 其他实例正在执行，本周期跳过
    async with AsyncSessionLocal() as db:
        try:
            notify_list, recovered_nodes = await MonitorDao.check_offline_nodes(db)

            # 🔧 Day3 通知门控：仅新建/重开、待补偿、间隔提醒三类才通知（防风暴+防确认疲劳）
            notifier = get_notifier()
            success_ids: list[int] = []
            failed_ids: list[int] = []
            if notifier and notify_list:
                for item in notify_list:
                    ok = await notifier.publish_notification(
                        alert_type=item['alert_type'],
                        severity=item.get('severity', 2),
                        node_id=item['node_id'],
                        device_id=item.get('device_id', 0),
                        node_name=item.get('node_name', ''),
                        host_pc_ip=item.get('host_pc_ip', ''),
                        alert_msg=item.get('alert_msg', ''),
                    )
                    (success_ids if ok else failed_ids).append(item['alert_id'])
            if success_ids or failed_ids:
                await MonitorDao.mark_notify_result(db, success_ids, failed_ids)

            if notify_list or recovered_nodes:
                logger.info(
                    f'[第2层兜底] 离线扫描：通知 {len(notify_list)} 条'
                    f'（新建/提醒/补偿），{len(recovered_nodes)} 个节点恢复'
                )
            await db.commit()
        except SQLAlchemyError as exc:
            # 数据库异常（连接中断/死锁等）：本周期放弃，下周期自动重试
            await db.rollback()
            logger.error(f'[第2层兜底] 离线检测任务 DB 异常（下周期重试）：{exc}')
        except Exception:
            # 未预期异常：记录完整堆栈便于排查
            await db.rollback()
            logger.exception('[第2层兜底] 离线检测任务出现未预期异常')


async def sync_nodes_from_devices_task() -> None:
    """定期同步 plc_device 中的 host_pc_ip 到 nodered_node（每5分钟）

    原在 get_node_list GET 接口中调用，有写副作用，移到后台任务。
    """
    async with AsyncSessionLocal() as db:
        try:
            from module_plc.service.monitor_service import MonitorService
            await MonitorService._sync_nodes_from_devices(db)
            await db.commit()
            logger.debug('[节点同步] plc_device → nodered_node 同步完成')
        except SQLAlchemyError as exc:
            await db.rollback()
            logger.error(f'[节点同步] 任务 DB 异常（下周期重试）：{exc}')
        except Exception:
            await db.rollback()
            logger.exception('[节点同步] 任务出现未预期异常')


async def clean_orphan_device_comm_task() -> None:
    """定期清理 device_comm_status 中无对应节点的脏行（每10分钟）

    原在 get_node_list GET 接口中调用，有写副作用，移到后台任务。
    """
    async with AsyncSessionLocal() as db:
        try:
            deleted = await MonitorDao.clean_orphan_device_comm(db)
            if deleted:
                logger.info(f'[清理残留] 删除 {deleted} 条无对应节点的 device_comm_status 记录')
            await db.commit()
        except SQLAlchemyError as exc:
            await db.rollback()
            logger.error(f'[清理残留] 任务 DB 异常（下周期重试）：{exc}')
        except Exception:
            await db.rollback()
            logger.exception('[清理残留] 任务出现未预期异常')


async def check_offline_devices_task() -> None:
    """检测设备通信离线并发布前端通知（每30秒）

    扫描 device_comm_status 表，last_success_time > 60s 标记为离线。
    告警创建 + 通知发布均由本任务统一负责（原 MQTT 消费者职责已合并）。
    """
    if not await _try_acquire_lock('edgelink:lock:check_offline_devices', ttl_sec=20):
        return  # 其他实例正在执行，本周期跳过
    async with AsyncSessionLocal() as db:
        try:
            notify_list, recovered_devices = await MonitorDao.check_offline_devices(db)

            # 🔧 Day3 通知门控：仅新翻转/待补偿/间隔提醒才通知
            notifier = get_notifier()
            success_ids: list[int] = []
            failed_ids: list[int] = []
            if notifier and notify_list:
                for item in notify_list:
                    ok = await notifier.publish_notification(
                        alert_type=item['alert_type'],
                        severity=item.get('severity', 2),
                        node_id=item['node_id'],
                        device_id=item.get('device_id', 0),
                        device_name=item.get('device_name', ''),
                        host_pc_ip=item.get('host_pc_ip', ''),
                        alert_msg=item.get('alert_msg', ''),
                    )
                    (success_ids if ok else failed_ids).append(item['alert_id'])
            if success_ids or failed_ids:
                await MonitorDao.mark_notify_result(db, success_ids, failed_ids)

            if notify_list or recovered_devices:
                logger.info(
                    f'[设备离线扫描] 通知 {len(notify_list)} 条, '
                    f'{len(recovered_devices)} 个设备恢复'
                )
            await db.commit()
        except SQLAlchemyError as exc:
            await db.rollback()
            logger.error(f'[设备离线扫描] DB 异常（下周期重试）：{exc}')
        except Exception:
            await db.rollback()
            logger.exception('[设备离线扫描] 出现未预期异常')


async def clean_heartbeat_logs_task() -> None:
    """每天凌晨清理超过7天的心跳日志

    防止 HeartbeatLog 表数据无限膨胀。
    """
    async with AsyncSessionLocal() as db:
        try:
            count = await MonitorDao.clean_old_heartbeat_logs(db, retention_days=7)
            if count:
                logger.info(f'心跳日志清理完成：删除了 {count} 条过期记录')
            await db.commit()
        except SQLAlchemyError as exc:
            await db.rollback()
            logger.error(f'心跳日志清理任务 DB 异常（下周期重试）：{exc}')
        except Exception:
            await db.rollback()
            logger.exception('心跳日志清理任务出现未预期异常')
