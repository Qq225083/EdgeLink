"""监控中心 — 服务层"""
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from common.vo import CrudResponseModel
from module_plc.dao.monitor_dao import MonitorDao
from module_plc.entity.do.monitor_do import MonitorAlert, NoderedNode
from module_plc.entity.vo.monitor_vo import (
    NoderedNodeModel, DeviceCommStatusModel, PgWriteStatusModel, MonitorAlertModel, KpiDashboardModel
)
from utils.common_util import CamelCaseUtil
from utils.log_util import logger


class MonitorService:
    """监控模块服务层"""

    # ==================== 设备通信状态（由 Node-RED 调用） ====================

    @classmethod
    async def report_device_comm(
        cls, db: AsyncSession, node_id: int, device_id: int,
        success: bool = True, error_msg: str = '',
    ) -> CrudResponseModel:
        """Node-RED 上报PLC通信结果"""
        await MonitorDao.upsert_device_comm(
            db, node_id=node_id, device_id=device_id,
            success=success, error_msg=error_msg,
        )
        if not success:
            await MonitorDao.create_alert(
                db, alert_type='PLC_OFFLINE', severity=2,
                node_id=node_id, device_id=device_id,
                alert_msg=error_msg or f'PLC设备{device_id}通信失败',
            )
        else:
            await MonitorDao.resolve_alert(
                db, 'PLC_OFFLINE', node_id=node_id, device_id=device_id,
            )
        await db.commit()
        return CrudResponseModel(is_success=True, message='通信状态已更新')

    # ==================== PG 写入状态（由 Node-RED 调用） ====================

    @classmethod
    async def report_pg_write(
        cls, db: AsyncSession, node_id: int, success: bool = True,
        latency_ms: int = 0, write_count: int = 0, error_msg: str = '',
    ) -> CrudResponseModel:
        """Node-RED 上报PG写入结果"""
        await MonitorDao.upsert_pg_write(
            db, node_id=node_id, success=success,
            latency_ms=latency_ms, write_count=write_count, error_msg=error_msg,
        )
        if not success:
            await MonitorDao.create_alert(
                db, alert_type='PG_WRITE_LAG', severity=2,
                node_id=node_id, alert_msg=error_msg or 'PG写入异常',
            )
        else:
            await MonitorDao.resolve_alert(db, 'PG_WRITE_LAG', node_id=node_id)
        await db.commit()
        return CrudResponseModel(is_success=True, message='PG写入状态已更新')

    # ==================== 查询接口（前端用 — 纯查询，无副作用） ====================

    @classmethod
    async def get_kpi_dashboard(cls, db: AsyncSession) -> KpiDashboardModel:
        return await MonitorDao.get_kpi_dashboard(db)

    @classmethod
    async def get_node_list(cls, db: AsyncSession) -> list[NoderedNodeModel]:
        """获取节点列表 — 自动联动 plc_device。

        节点来源：
          1. nodered_node 表中已注册的记录（由心跳自动注册）
          2. plc_device 中有 host_pc_ip 但尚未注册的，自动创建占位节点
        设备归属：从 plc_device.host_pc_ip 关联，一次批量 JOIN。
        """
        now = datetime.now()

        # 0. 清理残留数据与节点同步已移至后台定时任务（monitor_task.py），GET 接口只读
        # 1. 直接加载节点列表
        all_nodes = await MonitorDao.get_all_nodes(db)

        # 3. 从 plc_device 获取所有唯一 host_pc_ip（与设备管理联动）
        host_ips = await MonitorDao.get_unique_host_ips(db)

        # 4. 构建 IP → node 映射
        node_by_ip = {n.host_pc_ip: n for n in all_nodes if n.host_pc_ip}

        # 5. 收集所有有效的 host_ips，批量查询 PG 状态、设备通信状态、最新心跳
        valid_ips = [ip for ip in host_ips if ip and ip in node_by_ip]
        valid_node_ids = [node_by_ip[ip].id for ip in valid_ips]
        pg_status_map = await MonitorDao.get_pg_write_status_batch(db, valid_node_ids)
        heartbeat_map = await MonitorDao.get_latest_heartbeat_batch(db, valid_node_ids)
        # 一次批量 JOIN 查询所有 IP 的设备，避免 N+1
        devices_by_ip = await MonitorDao.get_devices_grouped_by_host_ip(db, valid_ips)

        # 6. 为每个 host_pc_ip 构建节点 VO
        result = []
        for ip in host_ips:
            if not ip:
                continue
            n = node_by_ip.get(ip)
            if not n:
                continue  # 理论上不会走到这里（_sync_nodes_from_devices 已创建）

            # 🔧 Day4/P2-7：在线阈值全链统一为 90s（与后端离线判定/KPI 一致，消除 60/75/90 三处漂移）
            is_online = bool(
                n.last_heartbeat
                and (now - n.last_heartbeat).total_seconds() < 90
            )

            # 从批量查询结果中获取设备列表（已缓存）
            plc_list = devices_by_ip.get(ip, [])
            online_devices = sum(1 for p in plc_list if p.get('online'))

            # 该节点的今日采集量 + 最新心跳详情
            pg_status = pg_status_map.get(n.id)
            today_count = pg_status.today_write_count if pg_status else 0
            latest_hb = heartbeat_map.get(n.id)
            running_flows = latest_hb.running_flows if latest_hb else 0
            memory_usage_mb = latest_hb.memory_usage_mb if latest_hb else 0

            # 时间戳格式化
            for p in plc_list:
                if p.get('last_success_time'):
                    p['last_success_time'] = p['last_success_time'].isoformat() if hasattr(p['last_success_time'], 'isoformat') else str(p['last_success_time'])
                if p.get('last_error_time'):
                    p['last_error_time'] = p['last_error_time'].isoformat() if hasattr(p['last_error_time'], 'isoformat') else str(p['last_error_time'])

            # 统一为 camelCase，保持与节点列表其他字段契约一致
            plc_list = CamelCaseUtil.transform_result(plc_list)

            result.append(NoderedNodeModel(
                id=n.id,
                node_name=n.node_name,
                host_pc_ip=ip,
                office_net_ip=n.office_net_ip or ip,
                indust_net_ip=n.indust_net_ip,
                running_flows=running_flows,
                memory_usage_mb=memory_usage_mb,
                pg_success_count=n.pg_success_count or 0,
                pg_fail_count=n.pg_fail_count or 0,
                spool_bytes=n.spool_bytes or 0,
                status=n.status,
                last_heartbeat=n.last_heartbeat,
                is_online=is_online,
                device_count=len(plc_list),
                online_device_count=online_devices,
                today_count=today_count,
                plc_list=plc_list,
                created_at=n.created_at,
                updated_at=n.updated_at,
            ))

        return result

    @classmethod
    async def get_alert_list(cls, db: AsyncSession, limit: int = 20) -> list[MonitorAlertModel]:
        """获取最近告警（使用批量查询替代全表加载节点名、设备名）"""
        alerts = await MonitorDao.get_active_alerts(db, limit=limit)

        # 收集告警中涉及的 node_id / device_id，只查询需要的名称
        alert_node_ids = {a.node_id for a in alerts if a.node_id is not None}
        node_name_map = await MonitorDao.get_nodes_by_ids(db, alert_node_ids)
        alert_device_ids = {a.device_id for a in alerts if a.device_id is not None and a.device_id > 0}
        device_name_map = await MonitorDao.get_devices_by_ids(db, alert_device_ids)

        return [
            MonitorAlertModel(
                **CamelCaseUtil.transform_result(a),
                node_name=node_name_map.get(a.node_id, ''),
                device_name=device_name_map.get(a.device_id, ''),
            )
            for a in alerts
        ]

    @classmethod
    async def confirm_alert(cls, db: AsyncSession, alert_id: int) -> CrudResponseModel:
        """确认告警"""
        await MonitorDao.confirm_alert(db, alert_id)
        await db.commit()
        return CrudResponseModel(is_success=True, message='已确认')

    # ==================== 内部工具 ====================

    @classmethod
    async def _sync_nodes_from_devices(cls, db: AsyncSession) -> None:
        """确保 plc_device 中的 host_pc_ip 在 nodered_node 中有对应记录。

        在心跳上报时调用，实现设备与节点的自动联动。
        """
        now = datetime.now()
        host_ips = await MonitorDao.get_unique_host_ips(db)
        # 查询所有节点（不限制status），避免重复创建已存在但被标记为离线的节点
        all_nodes = await MonitorDao.get_all_nodes_any_status(db)
        node_by_ip = {n.host_pc_ip: n for n in all_nodes}

        needs_sync = [ip for ip in host_ips if ip and ip not in node_by_ip]
        synced_count = 0
        for ip in needs_sync:
            new_node = NoderedNode(
                node_name=f'PC-{ip}',
                office_net_ip=ip,
                host_pc_ip=ip,
                status=1,
                created_at=now,
                updated_at=now,
            )
            db.add(new_node)
            try:
                async with db.begin_nested():
                    await db.flush()
                node_by_ip[ip] = new_node
                synced_count += 1
            except IntegrityError:
                # 并发场景：另一事务已为该 IP 创建节点 → savepoint 自动回滚，跳过
                pass

        if synced_count > 0:
            logger.info(f'从 plc_device 自动同步了 {synced_count} 个新节点')
