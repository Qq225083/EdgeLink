"""监控中心 — 数据库操作层"""
from datetime import datetime, timedelta
from typing import Optional, Union

from sqlalchemy import delete, func, select, update, and_, or_, desc
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from module_plc.entity.do.monitor_do import (
    NoderedNode, HeartbeatLog, DeviceCommStatus, PgWriteStatus, MonitorAlert
)
from module_plc.entity.vo.monitor_vo import (
    NoderedNodeModel, DeviceCommStatusModel, PgWriteStatusModel, MonitorAlertModel, KpiDashboardModel
)
from module_plc.entity.do.device_do import PlcDevice
from utils.log_util import logger


class MonitorDao:
    """监控模块数据库操作层"""

    # 持续故障的重通知间隔（防确认疲劳）：同一未恢复告警 30 分钟才提醒一次
    REMIND_INTERVAL_S = 1800

    # ==================== 节点 ====================

    @classmethod
    async def get_all_nodes(cls, db: AsyncSession) -> list[NoderedNode]:
        """获取所有启用的节点（status=1）"""
        result = await db.execute(
            select(NoderedNode).where(NoderedNode.status == 1).order_by(NoderedNode.id)
        )
        return result.scalars().all()

    @classmethod
    async def get_all_nodes_any_status(cls, db: AsyncSession) -> list[NoderedNode]:
        """获取所有节点（不限status），用于同步去重"""
        result = await db.execute(
            select(NoderedNode).order_by(NoderedNode.id)
        )
        return result.scalars().all()

    @classmethod
    async def get_unique_host_ips(cls, db: AsyncSession) -> list[str]:
        """从 plc_device 表获取所有唯一的 host_pc_ip（仅启用的设备）"""
        result = await db.execute(
            select(PlcDevice.host_pc_ip)
            .where(
                PlcDevice.del_flag == '0',
                PlcDevice.status == '0',
                PlcDevice.host_pc_ip.isnot(None),
            )
            .distinct()
            .order_by(PlcDevice.host_pc_ip)
        )
        return [row[0] for row in result.all()]

    @classmethod
    async def get_devices_by_host_ip(cls, db: AsyncSession, host_pc_ip: str) -> list[dict]:
        """获取某 host_pc_ip 下的所有PLC设备及其通信状态（使用命名映射，避免魔数索引）

        修复: LEFT JOIN device_comm_status 时同时匹配 node_id。
        """
        # 查出该 host_pc_ip 对应的 node_id
        node = await cls.get_node_by_host_ip(db, host_pc_ip)
        node_id = node.id if node else None

        result = await db.execute(
            select(
                PlcDevice.id.label('device_id'),
                PlcDevice.device_name,
                PlcDevice.device_code,
                PlcDevice.plc_ip,
                PlcDevice.plc_port,
                PlcDevice.com_type,
                PlcDevice.mc_frame,
                PlcDevice.scan_interval_ms,
                PlcDevice.status,
                DeviceCommStatus.online,
                DeviceCommStatus.last_success_time,
                DeviceCommStatus.last_error_time,
                DeviceCommStatus.consecutive_fails,
                DeviceCommStatus.error_msg,
            )
            .join(DeviceCommStatus,
                  and_(
                      DeviceCommStatus.device_id == PlcDevice.id,
                      DeviceCommStatus.node_id == node_id if node_id else False,
                  ), isouter=True)
            .where(PlcDevice.host_pc_ip == host_pc_ip, PlcDevice.del_flag == '0', PlcDevice.status == '0')
            .order_by(PlcDevice.id)
        )
        # 使用 mappings() 获取可命名的行，避免魔数索引
        return [
            {
                'device_id': row['device_id'],
                'device_name': row['device_name'],
                'device_code': row['device_code'],
                'plc_ip': row['plc_ip'],
                'plc_port': row['plc_port'],
                'com_type': row['com_type'],
                'mc_frame': row['mc_frame'],
                'scan_interval_ms': row['scan_interval_ms'],
                'status': row['status'],
                'online': bool(row['online']) if row['online'] is not None else False,
                'last_success_time': row['last_success_time'],
                'last_error_time': row['last_error_time'],
                'consecutive_fails': row['consecutive_fails'] or 0,
                'error_msg': row['error_msg'] or '',
            }
            for row in result.mappings()
        ]

    @classmethod
    async def get_devices_grouped_by_host_ip(
        cls, db: AsyncSession, host_ips: list[str]
    ) -> dict[str, list[dict]]:
        """一次 JOIN 查询返回 {host_pc_ip: [device_dict, ...]}，避免 N+1 问题。

        修复: LEFT JOIN device_comm_status 时同时匹配 node_id，
        避免不同 node_id 的残留记录造成设备重复显示。
        """
        if not host_ips:
            return {}
        # 先查出这些 host_ip 对应的 node_id（每个 host_pc_ip 唯一对应一个节点）
        node_result = await db.execute(
            select(NoderedNode.host_pc_ip, NoderedNode.id)
            .where(NoderedNode.host_pc_ip.in_(host_ips))
        )
        ip_to_node_id = {row[0]: row[1] for row in node_result}
        valid_node_ids = set(ip_to_node_id.values())

        # device_comm_status 的唯一约束是 (node_id, device_id)，
        # LEFT JOIN 必须加 node_id 条件，否则不同节点的脏数据全匹配
        result = await db.execute(
            select(
                PlcDevice.host_pc_ip,
                PlcDevice.id.label('device_id'),
                PlcDevice.device_name,
                PlcDevice.device_code,
                PlcDevice.plc_ip,
                PlcDevice.plc_port,
                PlcDevice.com_type,
                PlcDevice.mc_frame,
                PlcDevice.scan_interval_ms,
                PlcDevice.status,
                DeviceCommStatus.online,
                DeviceCommStatus.last_success_time,
                DeviceCommStatus.last_error_time,
                DeviceCommStatus.consecutive_fails,
                DeviceCommStatus.error_msg,
            )
            .join(DeviceCommStatus,
                  and_(
                      DeviceCommStatus.device_id == PlcDevice.id,
                      DeviceCommStatus.node_id.in_(valid_node_ids) if valid_node_ids else False,
                  ), isouter=True)
            .where(PlcDevice.host_pc_ip.in_(host_ips), PlcDevice.del_flag == '0', PlcDevice.status == '0')
            .order_by(PlcDevice.host_pc_ip, PlcDevice.id)
        )
        grouped: dict[str, list[dict]] = {ip: [] for ip in host_ips}
        for row in result.mappings():
            ip = row['host_pc_ip']
            if ip not in grouped:
                grouped[ip] = []
            grouped[ip].append({
                'device_id': row['device_id'],
                'device_name': row['device_name'],
                'device_code': row['device_code'],
                'plc_ip': row['plc_ip'],
                'plc_port': row['plc_port'],
                'com_type': row['com_type'],
                'mc_frame': row['mc_frame'],
                'scan_interval_ms': row['scan_interval_ms'],
                'status': row['status'],
                'online': bool(row['online']) if row['online'] is not None else False,
                'last_success_time': row['last_success_time'],
                'last_error_time': row['last_error_time'],
                'consecutive_fails': row['consecutive_fails'] or 0,
                'error_msg': row['error_msg'] or '',
            })
        return grouped

    @classmethod
    async def get_node_by_host_ip(cls, db: AsyncSession, host_pc_ip: str) -> Optional[NoderedNode]:
        """根据 host_pc_ip 查找节点"""
        result = await db.execute(
            select(NoderedNode).where(NoderedNode.host_pc_ip == host_pc_ip)
        )
        return result.scalars().first()

    @classmethod
    async def upsert_heartbeat(
        cls, db: AsyncSession, host_pc_ip: str, node_ip: str,
        running_flows: int = 0, memory_usage_mb: int = 0,
        pg_success_count: int = 0, pg_fail_count: int = 0, spool_bytes: int = 0,
        config_version: int | None = None,
    ) -> tuple[int | None, bool]:
        """接收心跳：更新 last_heartbeat + 健康指标 + 写日志。若节点不存在则自动注册。

        :param config_version: 边缘已应用的配置快照版本；None=旧边缘未上报（不覆盖既有值）
        :return: (node_id, is_new) — node_id 为 None 时注册失败
        """
        now = datetime.now()
        node = await cls.get_node_by_host_ip(db, host_pc_ip)
        is_new = False

        if not node:
            # 自动注册：第一次见到这个 host_pc_ip
            node_name = f'PC-{host_pc_ip}'  # 默认名，后台可改
            node = NoderedNode(
                node_name=node_name,
                office_net_ip=host_pc_ip,
                host_pc_ip=host_pc_ip,
                status=1,
                created_at=now,
                updated_at=now,
            )
            db.add(node)
            try:
                # 🔧 Day9/P2-4：savepoint 隔离并发首报撞唯一键（uk_host_pc_ip），避免整事务回滚冒泡 500
                async with db.begin_nested():
                    await db.flush()
                is_new = True
            except IntegrityError:
                # 并发场景：另一事务已注册该 IP → 回滚 savepoint 后按已存在节点继续（is_new 保持 False）
                node = await cls.get_node_by_host_ip(db, host_pc_ip)
                if not node:
                    raise

        node.last_heartbeat = now
        node.updated_at = now
        # #88: 同步节点健康指标到节点行（当前值，供节点列表/KPI 直读）
        node.running_flows = running_flows
        node.memory_usage_mb = memory_usage_mb
        node.pg_success_count = pg_success_count
        node.pg_fail_count = pg_fail_count
        node.spool_bytes = spool_bytes
        # 边缘已应用的快照版本（None=旧边缘未上报，保留既有值不覆盖）
        if config_version is not None:
            node.config_version = config_version
        # 若上报 IP 与办公网 IP 不同，则视为工业网 IP 更新
        if node_ip and node_ip != host_pc_ip:
            node.indust_net_ip = node_ip
        log = HeartbeatLog(
            node_id=node.id, report_time=now, node_ip=node_ip,
            running_flows=running_flows, memory_usage_mb=memory_usage_mb,
        )
        db.add(log)
        await db.flush()

        return node.id, is_new

    @classmethod
    async def get_node_heartbeat_logs(
        cls, db: AsyncSession, node_id: int, limit: int = 10
    ) -> list[HeartbeatLog]:
        """获取节点最近心跳日志"""
        result = await db.execute(
            select(HeartbeatLog)
            .where(HeartbeatLog.node_id == node_id)
            .order_by(desc(HeartbeatLog.report_time))
            .limit(limit)
        )
        return result.scalars().all()

    @classmethod
    async def clean_old_heartbeat_logs(cls, db: AsyncSession, retention_days: int = 7) -> int:
        """清理超过保留天数的心跳日志

        :param db: orm对象
        :param retention_days: 保留天数，默认7天
        :return: 删除的记录数
        """
        cutoff = datetime.now() - timedelta(days=retention_days)
        result = await db.execute(
            select(func.count()).select_from(HeartbeatLog).where(HeartbeatLog.report_time < cutoff)
        )
        count = result.scalar()
        if count:
            await db.execute(
                delete(HeartbeatLog).where(HeartbeatLog.report_time < cutoff)
            )
            logger.info(f'清理了 {count} 条过期心跳日志（保留 {retention_days} 天）')
        return count or 0

    # ==================== 设备通信状态 ====================

    @classmethod
    async def get_device_comm_by_node(
        cls, db: AsyncSession, node_id: int
    ) -> list[dict]:
        """获取某节点下所有PLC的通信状态（JOIN plc_device），使用命名映射"""
        result = await db.execute(
            select(
                DeviceCommStatus,
                PlcDevice.device_name,
                PlcDevice.plc_ip,
                PlcDevice.plc_port,
                PlcDevice.scan_interval_ms,
            )
            .join(PlcDevice, DeviceCommStatus.device_id == PlcDevice.id, isouter=True)
            .where(DeviceCommStatus.node_id == node_id, PlcDevice.del_flag == '0')
            .order_by(DeviceCommStatus.device_id)
        )
        rows = result.all()
        out = []
        for row in rows:
            dcs, name, ip, port, scan = row
            out.append({
                'id': dcs.id, 'node_id': dcs.node_id, 'device_id': dcs.device_id,
                'online': dcs.online, 'last_success_time': dcs.last_success_time,
                'last_error_time': dcs.last_error_time, 'error_msg': dcs.error_msg,
                'consecutive_fails': dcs.consecutive_fails, 'updated_at': dcs.updated_at,
                'device_name': name, 'plc_ip': ip, 'plc_port': port,
                'scan_interval_ms': scan,
            })
        return out

    @classmethod
    async def upsert_device_comm(
        cls, db: AsyncSession, node_id: int, device_id: int,
        success: bool = True, error_msg: str = '',
    ) -> None:
        """更新设备通信状态（SELECT + INSERT/UPDATE，数据库无关）。

        修复：
          - consecutive_fails 正确递增（修复 C1）
          - 数据库无关（修复 C3，MySQL/PostgreSQL 均可用）
        """
        now = datetime.now()
        # 查询已有记录
        result = await db.execute(
            select(DeviceCommStatus).where(
                DeviceCommStatus.node_id == node_id,
                DeviceCommStatus.device_id == device_id,
            )
        )
        existing = result.scalars().first()

        if existing:
            # 已有记录 → 应用正确的递增逻辑
            cls._apply_device_comm_update(existing, success, now, error_msg)
            existing.updated_at = now
            await db.flush()
        else:
            # 无记录 → 新建（使用 savepoint 防止并发 INSERT 冲突影响外层事务）
            dcs = DeviceCommStatus(
                node_id=node_id, device_id=device_id,
                online=1 if success else 0,
                last_success_time=now if success else None,
                last_error_time=None if success else now,
                error_msg='' if success else error_msg[:500],
                consecutive_fails=0 if success else 1,
                updated_at=now,
            )
            db.add(dcs)
            try:
                async with db.begin_nested():
                    await db.flush()
            except IntegrityError:
                # Savepoint 已自动回滚，外层事务干净。
                # 并发场景：另一请求已插入相同 (node_id, device_id)，重新查询并更新。
                result2 = await db.execute(
                    select(DeviceCommStatus).where(
                        DeviceCommStatus.node_id == node_id,
                        DeviceCommStatus.device_id == device_id,
                    )
                )
                retry = result2.scalars().first()
                if retry:
                    cls._apply_device_comm_update(retry, success, now, error_msg)
                    retry.updated_at = now
                    await db.flush()

    @staticmethod
    def _apply_device_comm_update(
        dcs: DeviceCommStatus, success: bool, now: datetime, error_msg: str
    ) -> None:
        """将通信结果应用到已有的 DeviceCommStatus ORM 对象上

        在线状态统一由时间阈值（90秒无成功通信）判定，consecutive_fails 仅用于触发告警，
        不作为在线状态唯一依据（#12 修复）。
        """
        if success:
            dcs.online = 1
            dcs.last_success_time = now
            dcs.consecutive_fails = 0
            dcs.error_msg = ''
        else:
            dcs.consecutive_fails = (dcs.consecutive_fails or 0) + 1
            dcs.last_error_time = now
            dcs.error_msg = error_msg[:500]
            # 不在这里判定 online=0，由 check_offline_devices 按时间阈值统一判定

    @classmethod
    async def clean_orphan_device_comm(cls, db: AsyncSession) -> int:
        """删除 device_comm_status 中无对应 nodered_node 的残留行。

        场景: 旧 Flow (node_id=999) 的通信状态残留，与新节点重复显示同一设备。
        返回删除行数。
        """
        result = await db.execute(
            delete(DeviceCommStatus).where(
                DeviceCommStatus.node_id.notin_(
                    select(NoderedNode.id)
                )
            )
        )
        deleted = result.rowcount
        if deleted:
            logger.info(f'清理残留设备通信状态: {deleted} 行')
        return deleted

    # ==================== PG 写入状态 ====================

    @classmethod
    async def get_pg_write_status(
        cls, db: AsyncSession, node_id: int
    ) -> Optional[PgWriteStatus]:
        """获取某节点的PG写入状态"""
        result = await db.execute(
            select(PgWriteStatus).where(PgWriteStatus.node_id == node_id)
        )
        return result.scalars().first()

    @classmethod
    async def upsert_pg_write(
        cls, db: AsyncSession, node_id: int, success: bool = True,
        latency_ms: int = 0, write_count: int = 0, error_msg: str = '',
    ) -> None:
        """更新PG写入状态（SELECT + INSERT/UPDATE，数据库无关）。

        修复：
          - today_write_count 跨天自动重置（修复 C2）
          - consecutive_fails 正确递增
          - 数据库无关（修复 C3，MySQL/PostgreSQL 均可用）
        """
        now = datetime.now()
        result = await db.execute(
            select(PgWriteStatus).where(PgWriteStatus.node_id == node_id)
        )
        existing = result.scalars().first()

        if existing:
            cls._apply_pg_write_update(existing, success, now, latency_ms, write_count, error_msg)
            existing.updated_at = now
            await db.flush()
        else:
            pws = PgWriteStatus(
                node_id=node_id,
                last_write_time=now if success else None,
                write_latency_ms=latency_ms,
                today_write_count=write_count,
                consecutive_fails=0 if success else 1,
                error_msg='' if success else error_msg[:500],
                updated_at=now,
            )
            db.add(pws)
            try:
                async with db.begin_nested():
                    await db.flush()
            except IntegrityError:
                # Savepoint 已自动回滚，外层事务干净。
                # 并发场景：另一请求已插入相同 node_id，重新查询并更新。
                result2 = await db.execute(
                    select(PgWriteStatus).where(PgWriteStatus.node_id == node_id)
                )
                retry = result2.scalars().first()
                if retry:
                    cls._apply_pg_write_update(retry, success, now, latency_ms, write_count, error_msg)
                    retry.updated_at = now
                    await db.flush()

    @staticmethod
    def _apply_pg_write_update(
        pws: PgWriteStatus, success: bool, now: datetime,
        latency_ms: int, write_count: int, error_msg: str,
    ) -> None:
        """将写入结果应用到已有的 PgWriteStatus ORM 对象上"""
        if success:
            today = now.date()
            last_date = pws.last_write_time.date() if pws.last_write_time else None
            if last_date != today:
                pws.today_write_count = write_count
            else:
                pws.today_write_count = (pws.today_write_count or 0) + write_count
            pws.last_write_time = now
            pws.write_latency_ms = latency_ms
            pws.consecutive_fails = 0
            pws.error_msg = ''
        else:
            pws.consecutive_fails = (pws.consecutive_fails or 0) + 1
            pws.error_msg = error_msg[:500]

    # ==================== 告警 ====================

    @classmethod
    async def get_active_alerts(
        cls, db: AsyncSession, limit: int = 20
    ) -> list[MonitorAlert]:
        """获取未处理告警"""
        result = await db.execute(
            select(MonitorAlert)
            .where(MonitorAlert.status == 0)
            .order_by(desc(MonitorAlert.created_at))
            .limit(limit)
        )
        return result.scalars().all()

    @classmethod
    async def create_alert(
        cls, db: AsyncSession, alert_type: str, severity: int,
        node_id: int = 0, device_id: int = 0, alert_msg: str = '',
    ) -> MonitorAlert | None:
        """创建告警（自动去重：同类型+同node+同device+未恢复的不重复创建）

        使用 savepoint 隔离 INSERT + 数据库唯一约束防并发重复。
        device_id=0 表示不关联设备（如 NODE_OFFLINE 告警）。
        返回 None 表示已有相同告警存在。

        注意：唯一约束 uq_monitor_alert_dedup 覆盖所有状态（0未处理/1已确认/2已恢复），
        因此：
        - 去重查询必须覆盖 status 0 和 1（已确认未恢复的也不能再插入）
        - 已恢复（status=2）的历史行必须重开（UPDATE）而不是 INSERT 新行
        """
        dedup_conditions = [
            MonitorAlert.alert_type == alert_type,
            MonitorAlert.node_id == node_id,
            MonitorAlert.device_id == device_id,
        ]

        # 先查询是否已有未恢复告警（0未处理 / 1已确认），有则直接返回，避免并发插入冲突
        result = await db.execute(
            select(MonitorAlert).where(and_(*dedup_conditions), MonitorAlert.status.in_([0, 1]))
        )
        existing = result.scalars().first()
        if existing:
            return existing

        # 存在已恢复（status=2）的历史告警 → 重开该行（唯一约束不允许再 INSERT 同 key 行）
        resolved_result = await db.execute(
            select(MonitorAlert).where(and_(*dedup_conditions), MonitorAlert.status == 2)
        )
        resolved_alert = resolved_result.scalars().first()
        if resolved_alert:
            resolved_alert.status = 0
            resolved_alert.severity = severity
            resolved_alert.alert_msg = alert_msg
            resolved_alert.created_at = datetime.now()
            resolved_alert.confirmed_at = None
            resolved_alert.resolved_at = None
            # 🔧 Day3: 重开视为新 episode，重置通知状态（确保会重新通知一次）
            resolved_alert.last_notified_at = None
            resolved_alert.notification_pending = 0
            try:
                async with db.begin_nested():
                    await db.flush()
                return resolved_alert
            except IntegrityError:
                # 并发重开冲突 → 放弃本次，下一轮扫描再试
                return None

        alert = MonitorAlert(
            alert_type=alert_type, severity=severity,
            node_id=node_id, device_id=device_id, alert_msg=alert_msg,
            created_at=datetime.now(),
        )
        db.add(alert)

        # 使用 savepoint 防止并发重复插入导致外层事务回滚
        try:
            async with db.begin_nested():
                await db.flush()
            return alert
        except IntegrityError:
            # 并发已插入相同告警 → savepoint 回滚，重新查询返回已有记录
            # 关键：必须从 session 中移除 pending 对象，否则后续 autoflush 会在
            # savepoint 之外重试 INSERT，污染外层事务（整个扫描任务失败）
            db.expunge(alert)
            result2 = await db.execute(
                select(MonitorAlert).where(and_(*dedup_conditions), MonitorAlert.status.in_([0, 1]))
            )
            return result2.scalars().first()

    @classmethod
    async def resolve_alert(
        cls, db: AsyncSession, alert_type: str, node_id: int = 0, device_id: int = 0
    ) -> None:
        """恢复告警（同类型+同node+同device的未恢复告警标记为已恢复）

        node_id=0 或 device_id=0 表示不过滤该维度。
        status 0（未处理）和 1（已确认）都属于未恢复，都需要可被恢复，
        否则已确认告警会永久残留并阻塞后续同 key 告警（唯一约束覆盖所有状态）。
        """
        if not node_id and not device_id:
            # 🔧 Day3 防御：两个维度都不过滤 = 恢复该类型全部告警，几乎必属误用
            logger.warning(f'[告警] resolve_alert({alert_type}) 以 node_id=0/device_id=0 调用，将恢复该类型全部未恢复告警')
        conditions = [
            MonitorAlert.alert_type == alert_type,
            MonitorAlert.status.in_([0, 1]),
        ]
        if node_id:
            conditions.append(MonitorAlert.node_id == node_id)
        if device_id:
            conditions.append(MonitorAlert.device_id == device_id)
        await db.execute(
            update(MonitorAlert)
            .where(and_(*conditions))
            .values(status=2, resolved_at=datetime.now())
        )

    @classmethod
    async def mark_notify_result(
        cls, db: AsyncSession, success_ids: list[int], failed_ids: list[int]
    ) -> None:
        """通知结果回写（Day3 通知门控配套）

        成功：last_notified_at=now 且 notification_pending=0；
        失败：notification_pending=1，下轮扫描补偿重发。
        """
        now = datetime.now()
        if success_ids:
            await db.execute(
                update(MonitorAlert)
                .where(MonitorAlert.id.in_(success_ids))
                .values(last_notified_at=now, notification_pending=0)
            )
        if failed_ids:
            await db.execute(
                update(MonitorAlert)
                .where(MonitorAlert.id.in_(failed_ids))
                .values(notification_pending=1)
            )

    # ==================== KPI 仪表盘 ====================

    @classmethod
    async def get_kpi_dashboard(cls, db: AsyncSession) -> KpiDashboardModel:
        """计算 KPI 数据 — 节点总数记所有已注册节点，设备列表仍从 plc_device 派生"""
        now = datetime.now()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

        # 节点总数 = 所有 nodered_node（含心跳自动注册、暂无设备的节点）
        total_result = await db.execute(
            select(func.count(NoderedNode.id)).where(NoderedNode.status == 1)
        )
        total_nodes = total_result.scalar() or 0

        # 在线节点数 = 有心跳的 nodered_node 数
        online_nodes_result = await db.execute(
            select(func.count(NoderedNode.id))
            .where(
                NoderedNode.status == 1,
                NoderedNode.last_heartbeat.isnot(None),
                NoderedNode.last_heartbeat > now - timedelta(seconds=90),
            )
        )
        online_nodes = online_nodes_result.scalar() or 0

        # PLC 总数
        plc_total_result = await db.execute(
            select(func.count(PlcDevice.id)).where(PlcDevice.del_flag == '0')
        )
        total_devices = plc_total_result.scalar() or 0

        # 在线 PLC 数（只统计未被删除且未被停用的设备，避免 KPI 虚高）
        online_devices_result = await db.execute(
            select(func.count(DeviceCommStatus.id))
            .join(PlcDevice, DeviceCommStatus.device_id == PlcDevice.id)
            .where(
                DeviceCommStatus.online == 1,
                PlcDevice.del_flag == '0',
                PlcDevice.status == '0',
            )
        )
        online_devices = online_devices_result.scalar() or 0

        # 今日采集数 — 仅统计今日有写入的节点，避免昨日残留数据
        today_collect_result = await db.execute(
            select(func.sum(PgWriteStatus.today_write_count))
            .where(PgWriteStatus.last_write_time >= today_start)
        )
        today_count = today_collect_result.scalar() or 0

        # 未处理告警
        alert_result = await db.execute(
            select(func.count(MonitorAlert.id)).where(MonitorAlert.status == 0)
        )
        active_alerts = alert_result.scalar() or 0

        return KpiDashboardModel(
            total_nodes=total_nodes, online_nodes=online_nodes,
            total_devices=total_devices, online_devices=online_devices,
            today_collect_count=today_count, active_alerts=active_alerts,
        )

    @classmethod
    async def get_all_nodes_with_heartbeat(cls, db: AsyncSession) -> list[NoderedNode]:
        """获取所有启用的节点，带心跳时间用于离线检测（停用节点不扫描）"""
        result = await db.execute(
            select(NoderedNode)
            .where(NoderedNode.status == 1)
            .order_by(NoderedNode.id)
        )
        return result.scalars().all()

    @classmethod
    async def check_offline_nodes(cls, db: AsyncSession) -> tuple[list[dict], list[NoderedNode]]:
        """检测离线/恢复节点，创建或解除 NODE_OFFLINE 告警

        :return: (notify_list, recovered_nodes)
                 notify_list 元素: {alert_id, alert_type, node_id, device_id, severity,
                                    node_name, host_pc_ip, alert_msg, is_reminder}
                 通知门控：仅含 ①本轮新建/重开 ②通知待补偿(pending=1)
                 ③超 REMIND_INTERVAL_S 未通知的持续故障（防告警风暴 + 防确认疲劳）
        """
        now = datetime.now()
        nodes = await cls.get_all_nodes_with_heartbeat(db)

        offline_nodes: list[NoderedNode] = []
        recovered_nodes: list[NoderedNode] = []

        for node in nodes:
            # 从未发过心跳的跳过（自动注册后未真正上线的幽灵节点）
            if node.last_heartbeat is None:
                continue
            is_offline = (now - node.last_heartbeat).total_seconds() > 90
            if is_offline:
                offline_nodes.append(node)
            else:
                recovered_nodes.append(node)

        # 查询离线节点已有的未恢复告警（0未处理/1已确认），区分新建与提醒
        existing_result = await db.execute(
            select(MonitorAlert)
            .where(
                MonitorAlert.alert_type == 'NODE_OFFLINE',
                MonitorAlert.status.in_([0, 1]),
                MonitorAlert.node_id.in_([n.id for n in offline_nodes]) if offline_nodes else False,
            )
        )
        existing_by_node = {a.node_id: a for a in existing_result.scalars().all()}
        remind_before = now - timedelta(seconds=cls.REMIND_INTERVAL_S)

        notify_list: list[dict] = []
        for node in offline_nodes:
            existing = existing_by_node.get(node.id)
            if existing is None:
                # 新建（或重开已恢复行）→ 必通知
                alert = await cls.create_alert(
                    db, alert_type='NODE_OFFLINE', severity=2,
                    node_id=node.id, device_id=0,
                    alert_msg=f'采集节点 {node.node_name}（{node.host_pc_ip}）离线',
                )
                if alert is not None:
                    notify_list.append({
                        'alert_id': alert.id, 'alert_type': 'NODE_OFFLINE',
                        'node_id': node.id, 'device_id': 0, 'severity': 2,
                        'node_name': node.node_name or '', 'host_pc_ip': node.host_pc_ip or '',
                        'alert_msg': f'采集节点 {node.node_name or node.id} 离线',
                        'is_reminder': False,
                    })
            else:
                # 持续故障：补偿重发或间隔提醒（防确认疲劳：不会每轮都通知）
                need_remind = (
                    existing.notification_pending == 1
                    or existing.last_notified_at is None
                    or existing.last_notified_at < remind_before
                )
                if need_remind:
                    notify_list.append({
                        'alert_id': existing.id, 'alert_type': 'NODE_OFFLINE',
                        'node_id': node.id, 'device_id': 0, 'severity': 3,
                        'node_name': node.node_name or '', 'host_pc_ip': node.host_pc_ip or '',
                        'alert_msg': f'[持续] 采集节点 {node.node_name or node.id} 仍处于离线状态',
                        'is_reminder': True,
                    })

        # 批量恢复在线节点告警
        for node in recovered_nodes:
            await cls.resolve_alert(db, 'NODE_OFFLINE', node_id=node.id, device_id=0)

        return notify_list, recovered_nodes

    @classmethod
    async def check_offline_devices(cls, db: AsyncSession) -> tuple[list[dict], list[dict]]:
        """检测设备通信离线：last_success_time > 90s 标记为离线，否则在线。

        同时创建/解除 PLC_OFFLINE 告警（替代原 MQTT 消费者职责）。
        使用 LEFT JOIN 获取 device_name 和 host_pc_ip 用于通知 enrichment。

        :return: (notify_list, recovered_devices)
                 notify_list 元素: {alert_id, alert_type, device_id, node_id, severity,
                                    device_name, host_pc_ip, alert_msg, is_reminder}
                 通知门控同节点侧：新翻转/待补偿/间隔提醒
        """
        now = datetime.now()
        result = await db.execute(
            select(
                DeviceCommStatus,
                PlcDevice.device_name,
                NoderedNode.host_pc_ip,
            )
            .outerjoin(PlcDevice, DeviceCommStatus.device_id == PlcDevice.id)
            .outerjoin(NoderedNode, DeviceCommStatus.node_id == NoderedNode.id)
            .where(PlcDevice.del_flag == '0')
        )
        notify_list: list[dict] = []
        recovered_list: list[dict] = []
        remind_before = now - timedelta(seconds=cls.REMIND_INTERVAL_S)

        for dcs, device_name, host_pc_ip in result.all():
            is_offline = (
                dcs.last_success_time is None
                or (now - dcs.last_success_time).total_seconds() > 90
            )
            info = {
                'device_id': dcs.device_id,
                'node_id': dcs.node_id,
                'device_name': device_name or '',
                'host_pc_ip': host_pc_ip or '',
            }
            if is_offline:
                if dcs.online != 0:
                    dcs.online = 0
                    dcs.consecutive_fails = (dcs.consecutive_fails or 0) + 1
                    # 新翻转：创建告警并必通知
                    alert = await cls.create_alert(
                        db, alert_type='PLC_OFFLINE', severity=2,
                        node_id=dcs.node_id, device_id=dcs.device_id,
                        alert_msg=f'设备 {device_name or dcs.device_id} 通信离线',
                    )
                    if alert is not None:
                        notify_list.append({
                            'alert_id': alert.id, 'alert_type': 'PLC_OFFLINE',
                            'device_id': dcs.device_id, 'node_id': dcs.node_id, 'severity': 2,
                            'device_name': device_name or '', 'host_pc_ip': host_pc_ip or '',
                            'alert_msg': f'设备 {device_name or dcs.device_id} 通信离线',
                            'is_reminder': False,
                        })
                else:
                    # 持续离线：补偿重发或间隔提醒（防风暴/防疲劳）
                    alert_result = await db.execute(
                        select(MonitorAlert).where(
                            MonitorAlert.alert_type == 'PLC_OFFLINE',
                            MonitorAlert.status.in_([0, 1]),
                            MonitorAlert.node_id == dcs.node_id,
                            MonitorAlert.device_id == dcs.device_id,
                            or_(
                                MonitorAlert.notification_pending == 1,
                                MonitorAlert.last_notified_at.is_(None),
                                MonitorAlert.last_notified_at < remind_before,
                            ),
                        )
                    )
                    stale = alert_result.scalars().first()
                    if stale:
                        notify_list.append({
                            'alert_id': stale.id, 'alert_type': 'PLC_OFFLINE',
                            'device_id': dcs.device_id, 'node_id': dcs.node_id, 'severity': 3,
                            'device_name': device_name or '', 'host_pc_ip': host_pc_ip or '',
                            'alert_msg': f'[持续] 设备 {device_name or dcs.device_id} 仍处于通信离线状态',
                            'is_reminder': True,
                        })
            else:
                if dcs.online != 1:
                    dcs.online = 1
                    recovered_list.append(info)
                    await cls.resolve_alert(
                        db, 'PLC_OFFLINE',
                        node_id=dcs.node_id, device_id=dcs.device_id,
                    )
        await db.flush()
        return notify_list, recovered_list

    @classmethod
    async def confirm_alert(cls, db: AsyncSession, alert_id: int) -> None:
        """确认告警（仅允许对未恢复告警生效，已恢复告警不可再确认）"""
        await db.execute(
            update(MonitorAlert)
            .where(
                MonitorAlert.id == alert_id,
                MonitorAlert.status == 0,  # 仅未处理（0）可确认，已恢复（2）不可再确认
            )
            .values(status=1, confirmed_at=datetime.now())
        )

    # ==================== 批量查询工具 ====================

    @classmethod
    async def get_nodes_by_ids(
        cls, db: AsyncSession, node_ids: set[int]
    ) -> dict[int, str]:
        """根据 node_id 集合批量查询节点名称，返回 {id: node_name}"""
        if not node_ids:
            return {}
        result = await db.execute(
            select(NoderedNode.id, NoderedNode.node_name)
            .where(NoderedNode.id.in_(list(node_ids)))
        )
        return {row[0]: row[1] for row in result}

    @classmethod
    async def get_devices_by_ids(
        cls, db: AsyncSession, device_ids: set[int]
    ) -> dict[int, str]:
        """根据 device_id 集合批量查询设备名称，返回 {id: device_name}（含软删除过滤）"""
        if not device_ids:
            return {}
        result = await db.execute(
            select(PlcDevice.id, PlcDevice.device_name)
            .where(
                PlcDevice.id.in_(list(device_ids)),
                PlcDevice.del_flag == '0',
            )
        )
        return {row[0]: row[1] for row in result}

    @classmethod
    async def get_pg_write_status_batch(
        cls, db: AsyncSession, node_ids: list[int]
    ) -> dict[int, PgWriteStatus]:
        """批量查询多个节点的 PG 写入状态，返回 {node_id: PgWriteStatus}"""
        if not node_ids:
            return {}
        result = await db.execute(
            select(PgWriteStatus).where(PgWriteStatus.node_id.in_(node_ids))
        )
        return {pws.node_id: pws for pws in result.scalars().all()}

    @classmethod
    async def get_latest_heartbeat_batch(
        cls, db: AsyncSession, node_ids: list[int]
    ) -> dict[int, HeartbeatLog]:
        """批量查询多个节点的最新心跳日志，返回 {node_id: HeartbeatLog}"""
        if not node_ids:
            return {}
        # 使用子查询获取每个 node_id 的最新 report_time
        subq = (
            select(
                HeartbeatLog.node_id,
                func.max(HeartbeatLog.report_time).label('max_time')
            )
            .where(HeartbeatLog.node_id.in_(node_ids))
            .group_by(HeartbeatLog.node_id)
            .subquery()
        )
        result = await db.execute(
            select(HeartbeatLog)
            .join(subq, and_(
                HeartbeatLog.node_id == subq.c.node_id,
                HeartbeatLog.report_time == subq.c.max_time,
            ))
        )
        return {log.node_id: log for log in result.scalars().all()}
