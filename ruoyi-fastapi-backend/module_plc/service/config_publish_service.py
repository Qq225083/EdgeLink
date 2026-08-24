"""PLC 配置发布服务

提供手动发布能力：操作员在 Web 端保存设备/点位变更后，
点击【发布配置】按钮，后端通过 MQTT 通知对应采集节点重新拉取配置。

设计原则（发布即版本）：
- 保存 ≠ 发布：数据库变更不会直接到达边缘；点击发布时先把当前全部启用配置
  固化为 plc_config_snapshot 新快照（版本号+1），再 MQTT 通知边缘
- 边缘拉取源唯一：Node-RED 只从 /plc/config/snapshot/list 拉取快照，
  未发布的修改永远不会到达采集现场
- 失败不阻塞业务：快照固化成功后，MQTT 通知失败只记录日志，边缘 30s 轮询兜底收敛
- 发布中心只展示「当前配置 vs 最新快照」有差异的设备（新增/修改/删除），
  无变更的设备不出现在列表中（diff 基准与快照固化为同一数据源）
"""
import json
from typing import Any, Optional
from datetime import datetime

from fastapi.encoders import jsonable_encoder
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from module_plc.entity.do.device_do import PlcDevice
from module_plc.entity.do.monitor_do import NoderedNode
from module_plc.entity.do.publish_log_do import PlcPublishLog
from module_plc.entity.do.config_snapshot_do import PlcConfigSnapshot
from module_plc.entity.do.tag_do import PlcTag
from module_plc.entity.vo.device_vo import PlcDevicePageQueryModel
from module_plc.mqtt.mqtt_consumer import publish_config_refresh
from module_plc.service.driver_service import DriverService
from utils.log_util import logger


class ConfigPublishService:
    """PLC 配置发布服务"""

    # 快照行比较时剔除的易变键：保存即变但不影响边缘行为，避免误报「修改」
    _DIFF_IGNORE_KEYS = frozenset({'createBy', 'createTime', 'updateBy', 'updateTime'})

    # 快照行内嵌的设备级字段（JOIN 拍平；用于变更摘要。protocolParams1=设备级协议参数，SQL 同名列去重后的既有键名）
    _DEVICE_LEVEL_KEYS = (
        'deviceName', 'hostPcIp', 'backupPcIp', 'plcIp', 'plcPort', 'comType', 'mcFrame',
        'plcSeries', 'stationNo', 'networkNo', 'scanIntervalMs', 'commTimeoutMs',
        'retryCount', 'retryIntervalMs', 'triggerKind', 'status', 'protocolParams1',
    )

    @classmethod
    def _publish_device_filter(cls):
        """可发布设备的统一过滤条件：启用、未删除、已绑定采集节点。"""
        return (
            PlcDevice.del_flag == '0',
            PlcDevice.status == '0',
            PlcDevice.host_pc_ip.isnot(None),
        )

    @classmethod
    async def _build_current_config_payload(cls, query_db: AsyncSession) -> list[dict]:
        """构建「若现在发布会固化」的配置内容——与 rebuild_config_snapshot 同一数据源。"""
        from module_plc.dao.tag_dao import TagDao
        from module_plc.entity.vo.tag_vo import TagPageQueryModel

        rows = await TagDao.get_tag_global_list(query_db, TagPageQueryModel(status='0'), is_page=False)
        return jsonable_encoder(rows)

    @classmethod
    def _row_signature(cls, row: dict) -> str:
        """快照行规范化签名：剔除易变键后按键序序列化，用于内容等价比较。"""
        normalized = {k: v for k, v in row.items() if k not in cls._DIFF_IGNORE_KEYS}
        return json.dumps(normalized, sort_keys=True, ensure_ascii=False, default=str)

    @classmethod
    def _group_rows_by_device(cls, payload: list[dict]) -> dict[int, list[dict]]:
        groups: dict[int, list[dict]] = {}
        for row in payload or []:
            device_id = row.get('deviceId')
            if device_id is not None:
                groups.setdefault(device_id, []).append(row)
        return groups

    @classmethod
    def _diff_device_group(cls, cur_rows: list[dict], snap_rows: list[dict]) -> Optional[dict]:
        """比较单台设备的当前行集与快照行集，返回变更摘要；无差异返回 None。"""
        cur_by_id = {r.get('id'): r for r in cur_rows}
        snap_by_id = {r.get('id'): r for r in snap_rows}
        tags_added = sum(1 for i in cur_by_id if i not in snap_by_id)
        tags_removed = sum(1 for i in snap_by_id if i not in cur_by_id)
        tags_modified = sum(
            1 for i in cur_by_id.keys() & snap_by_id.keys()
            if cls._row_signature(cur_by_id[i]) != cls._row_signature(snap_by_id[i])
        )
        # 设备级字段嵌在每行里且同设备一致，各取一行对比即可
        cur_dev = {k: cur_rows[0].get(k) for k in cls._DEVICE_LEVEL_KEYS}
        snap_dev = {k: snap_rows[0].get(k) for k in cls._DEVICE_LEVEL_KEYS}
        changed_device_fields = [
            k for k in cls._DEVICE_LEVEL_KEYS
            if json.dumps(cur_dev.get(k), default=str, sort_keys=True)
            != json.dumps(snap_dev.get(k), default=str, sort_keys=True)
        ]
        if not (tags_added or tags_removed or tags_modified or changed_device_fields):
            return None
        return {
            'deviceFields': changed_device_fields,
            'tagsAdded': tags_added,
            'tagsRemoved': tags_removed,
            'tagsModified': tags_modified,
        }

    @classmethod
    async def _compute_config_diff(cls, query_db: AsyncSession) -> dict[str, Any]:
        """计算当前配置与最新已发布快照的设备级差异。

        :return: {'snapshot_version': int, 'published_at': datetime|None,
                  'changes': {device_id: {'changeType': 'added'|'modified'|'deleted',
                                          'changeSummary': dict|None, 'snapRows': list, 'curRows': list}}}
        """
        current_payload = await cls._build_current_config_payload(query_db)
        result = await query_db.execute(select(PlcConfigSnapshot).order_by(PlcConfigSnapshot.id).limit(1))
        snap = result.scalars().first()
        snap_payload = (snap.payload if snap and snap.payload else []) or []
        snapshot_version = snap.version if snap else 0
        published_at = snap.published_at if snap else None

        cur_groups = cls._group_rows_by_device(current_payload)
        snap_groups = cls._group_rows_by_device(snap_payload)

        changes: dict[int, dict] = {}
        for device_id, cur_rows in cur_groups.items():
            snap_rows = snap_groups.get(device_id)
            if snap_rows is None:
                changes[device_id] = {'changeType': 'added', 'changeSummary': None,
                                      'curRows': cur_rows, 'snapRows': []}
            else:
                summary = cls._diff_device_group(cur_rows, snap_rows)
                if summary:
                    changes[device_id] = {'changeType': 'modified', 'changeSummary': summary,
                                          'curRows': cur_rows, 'snapRows': snap_rows}
        for device_id, snap_rows in snap_groups.items():
            if device_id not in cur_groups:
                # 删除/停用/点位清空墓碑：发布后边缘将摘掉该设备
                changes[device_id] = {'changeType': 'deleted', 'changeSummary': None,
                                      'curRows': [], 'snapRows': snap_rows}
        return {'snapshot_version': snapshot_version, 'published_at': published_at, 'changes': changes}

    @classmethod
    async def _describe_deleted_devices(cls, query_db: AsyncSession, device_ids: list[int]) -> dict[int, dict]:
        """为删除墓碑补充设备信息与原因（含已软删设备，故不过滤 del_flag）。"""
        if not device_ids:
            return {}
        result = await query_db.execute(
            select(PlcDevice.id, PlcDevice.device_name, PlcDevice.device_code,
                   PlcDevice.host_pc_ip, PlcDevice.del_flag, PlcDevice.status)
            .where(PlcDevice.id.in_(device_ids))
        )
        info: dict[int, dict] = {}
        for row in result.all():
            if row.del_flag != '0':
                reason = '设备已删除'
            elif row.status != '0':
                reason = '设备已停用'
            else:
                reason = '点位已全部删除/停用'
            info[row.id] = {
                'deviceName': row.device_name, 'deviceCode': row.device_code,
                'hostPcIp': row.host_pc_ip, 'deleteReason': reason,
            }
        return info

    @classmethod
    async def get_publish_device_list(
        cls, query_db: AsyncSession, page_query: PlcDevicePageQueryModel
    ) -> dict[str, Any]:
        """获取待发布变更设备列表及全局统计。

        只返回「当前配置 vs 最新已发布快照」有差异的设备（新增/修改/删除墓碑），
        无变更设备不出现；无快照（从未发布）时全部设备视为新增。

        :param query_db: 数据库会话
        :param page_query: 分页参数
        :return: {'rows': [...], 'total': int, 'pageNum': int, 'pageSize': int,
                  'hasNext': bool, 'stats': {...}}
        """
        # 1) 计算当前配置 vs 最新快照的设备级 diff
        diff = await cls._compute_config_diff(query_db)
        changes = diff['changes']

        # 2) 新增/修改设备：取设备表当前行组装展示数据（diff 为准，不再叠加启用/绑定过滤——
        #    停用设备的启停切换本身也是待发布变更，需要可见）
        alive_ids = [did for did, c in changes.items() if c['changeType'] in ('added', 'modified')]
        device_rows: dict[int, dict] = {}
        if alive_ids:
            result = await query_db.execute(
                select(
                    PlcDevice.id,
                    PlcDevice.device_name,
                    PlcDevice.device_code,
                    PlcDevice.host_pc_ip,
                    PlcDevice.plc_brand,
                    PlcDevice.plc_series,
                    PlcDevice.com_type,
                    PlcDevice.driver_code,
                    PlcDevice.update_time,
                )
                .where(PlcDevice.id.in_(alive_ids))
            )
            for row in result.all():
                device_rows[row.id] = {
                    'id': row.id,
                    'deviceName': row.device_name,
                    'deviceCode': row.device_code,
                    'hostPcIp': row.host_pc_ip,
                    'plcBrand': row.plc_brand,
                    'plcSeries': row.plc_series,
                    'comType': row.com_type,
                    'driverCode': row.driver_code,
                    'updateTime': row.update_time.isoformat() if row.update_time else None,
                }

        # 3) 删除墓碑：设备信息（含软删记录）+ 原因
        deleted_ids = [did for did, c in changes.items() if c['changeType'] == 'deleted']
        deleted_info = await cls._describe_deleted_devices(query_db, deleted_ids)

        # 4) 组装最终行（tagCount 取 diff 行数=启用点位数；墓碑取快照点位数）
        rows: list[dict] = []
        for device_id in sorted(changes):
            change = changes[device_id]
            change_type = change['changeType']
            if change_type in ('added', 'modified'):
                base = device_rows.get(device_id)
                if not base:
                    continue
                base['tagCount'] = len(change['curRows'])
            else:
                snap_row = change['snapRows'][0] if change['snapRows'] else {}
                info = deleted_info.get(device_id, {})
                base = {
                    'id': device_id,
                    'deviceName': info.get('deviceName') or snap_row.get('deviceName'),
                    'deviceCode': info.get('deviceCode'),
                    'hostPcIp': info.get('hostPcIp') or snap_row.get('hostPcIp'),
                    'updateTime': None,
                    'tagCount': len(change['snapRows']),
                }
                summary = dict(change['changeSummary'] or {})
                summary['deleteReason'] = info.get('deleteReason', '设备已删除')
                change['changeSummary'] = summary
            base['changeType'] = change_type
            base['changeSummary'] = change['changeSummary']
            rows.append(base)

        # 5) 内存分页（变更设备数量级小，且 diff 本就需全量计算）
        total = len(rows)
        page_num = max(1, page_query.page_num or 1)
        page_size = max(1, page_query.page_size or 10)
        start = (page_num - 1) * page_size
        page_rows = rows[start:start + page_size]

        # 6) 全局统计（保留原 KPI 键，新增快照版本与变更计数）
        total_enabled_devices = (
            await query_db.execute(
                select(func.count(PlcDevice.id)).where(*cls._publish_device_filter())
            )
        ).scalar() or 0

        total_enabled_tags = (
            await query_db.execute(
                select(func.count(PlcTag.id)).where(
                    PlcTag.del_flag == '0',
                    PlcTag.status == '0',
                )
            )
        ).scalar() or 0

        affected_host_count = (
            await query_db.execute(
                select(func.count(func.distinct(PlcDevice.host_pc_ip))).where(
                    *cls._publish_device_filter()
                )
            )
        ).scalar() or 0

        # 最近一次发布时间
        last_publish_time = (
            await query_db.execute(
                select(PlcPublishLog.publish_time).order_by(PlcPublishLog.publish_time.desc()).limit(1)
            )
        ).scalar()

        # 变更维度统计（发布中心 KPI：只与「待发布变更」相关，不看全量库存）
        breakdown = {'added': 0, 'modified': 0, 'deleted': 0}
        for change in changes.values():
            breakdown[change['changeType']] += 1
        changed_affected_hosts = {r['hostPcIp'] for r in rows if r.get('hostPcIp')}
        changed_tag_count = 0
        for change in changes.values():
            if change['changeType'] == 'added':
                changed_tag_count += len(change['curRows'])
            elif change['changeType'] == 'deleted':
                changed_tag_count += len(change['snapRows'])
            else:
                s = change['changeSummary'] or {}
                changed_tag_count += s.get('tagsAdded', 0) + s.get('tagsRemoved', 0) + s.get('tagsModified', 0)

        # 边缘节点在线状态 + 已应用快照版本（发布后能否收敛/是否已收敛的前提信号）
        node_rows = (
            await query_db.execute(
                select(NoderedNode.host_pc_ip, NoderedNode.last_heartbeat,
                       NoderedNode.heartbeat_interval, NoderedNode.config_version)
                .where(NoderedNode.status == 1)
            )
        ).all()
        now = datetime.now()
        online_nodes = 0
        latest_heartbeat = None
        node_details: list[dict] = []
        applied_versions_online: list[int] = []
        for host_ip, hb, interval, cfg_ver in node_rows:
            online = bool(hb) and (now - hb).total_seconds() <= max((interval or 30) * 3, 90)
            if online:
                online_nodes += 1
                if cfg_ver is not None:
                    applied_versions_online.append(cfg_ver)
            if hb and (latest_heartbeat is None or hb > latest_heartbeat):
                latest_heartbeat = hb
            node_details.append({'hostPcIp': host_ip, 'online': online, 'configVersion': cfg_ver})
        edge_nodes = {
            'total': len(node_rows),
            'online': online_nodes,
            'lastHeartbeatAgoSec': int((now - latest_heartbeat).total_seconds()) if latest_heartbeat else None,
            # 在线节点中最旧的已应用版本；无任何上报时为 None（前端显示「版本未上报」）
            'appliedVersionMin': min(applied_versions_online) if applied_versions_online else None,
            'nodes': node_details,
        }

        stats = {
            'totalEnabledDevices': total_enabled_devices,
            'totalEnabledTags': total_enabled_tags,
            'affectedHostCount': affected_host_count,
            'lastPublishTime': last_publish_time.isoformat() if last_publish_time else None,
            'snapshotVersion': diff['snapshot_version'],
            'changedDeviceCount': total,
            'changedBreakdown': breakdown,
            'changedAffectedHostCount': len(changed_affected_hosts),
            'changedTagCount': changed_tag_count,
            'edgeNodes': edge_nodes,
        }

        return {
            'rows': page_rows,
            'total': total,
            'pageNum': page_num,
            'pageSize': page_size,
            'hasNext': (start + page_size) < total,
            'stats': stats,
        }

    @classmethod
    async def rebuild_config_snapshot(cls, query_db: AsyncSession, publish_by: Optional[str] = None) -> int:
        """发布即版本：把当前全部启用配置固化为新快照（边缘节点的唯一配置拉取源）。

        快照内容与边缘此前拉取的 /plc/tag/global/list?status=0 行结构完全一致（camelCase），
        边缘切换拉取源后解析逻辑无需改动。

        :param query_db: 数据库会话
        :param publish_by: 发布人
        :return: 新版本号
        """
        from module_plc.dao.tag_dao import TagDao
        from module_plc.entity.vo.tag_vo import TagPageQueryModel

        rows = await TagDao.get_tag_global_list(query_db, TagPageQueryModel(status='0'), is_page=False)
        # jsonable_encoder：datetime 等类型转 JSON 可序列化（ISO 字符串）
        payload = jsonable_encoder(rows)

        result = await query_db.execute(select(PlcConfigSnapshot).order_by(PlcConfigSnapshot.id).limit(1))
        snap = result.scalars().first()
        if snap:
            snap.version = (snap.version or 0) + 1
            snap.payload = payload
            snap.published_by = publish_by or ''
            snap.published_at = datetime.now()
        else:
            snap = PlcConfigSnapshot(version=1, payload=payload, published_by=publish_by or '')
            query_db.add(snap)
        await query_db.flush()
        logger.info(f'配置快照已固化：version={snap.version}, rows={len(payload)}, by={publish_by or "system"}')
        return snap.version

    @classmethod
    async def publish_device_config(
        cls, query_db: AsyncSession, device_ids: Optional[list[int]] = None, publish_by: Optional[str] = None
    ) -> dict:
        """手动发布配置到采集节点。

        :param query_db: 数据库会话
        :param device_ids: 指定设备 ID 列表；为空则发布全部启用且未删除的设备
        :param publish_by: 发布人（用于写入发布日志）
        :return: {'published_ips', 'published_nodes', 'device_count', 'failed_devices', 'status'}
        """
        stmt = (
            select(PlcDevice)
            .where(
                PlcDevice.del_flag == '0',
                PlcDevice.status == '0',
                PlcDevice.host_pc_ip.isnot(None),
            )
        )
        if device_ids:
            stmt = stmt.where(PlcDevice.id.in_(device_ids))

        result = await query_db.execute(stmt)
        devices = result.scalars().all()

        # 🔧 发布即版本：先把当前全部启用配置固化为新快照（边缘唯一拉取源），再下发通知。
        # 快照固化失败则整个发布中止——不允许出现"通知已发但快照是旧的"的不一致窗口。
        snapshot_version = await cls.rebuild_config_snapshot(query_db, publish_by)

        # 按 host_pc_ip 查询已注册且启用的采集节点，建立 ip -> node_id 映射
        host_pc_ips = {device.host_pc_ip for device in devices if device.host_pc_ip}
        node_id_map: dict[str, int] = {}
        if host_pc_ips:
            node_result = await query_db.execute(
                select(NoderedNode.host_pc_ip, NoderedNode.id)
                .where(
                    NoderedNode.host_pc_ip.in_(host_pc_ips),
                    NoderedNode.status == 1,
                )
            )
            node_id_map = {row[0]: row[1] for row in node_result.all()}

        published_ips = set()
        published_nodes = set()
        # 🔧 P0-3：真实成败收集（publish_config_refresh 返回 bool，MQTT 未连接/异常 = False）
        failed_devices: list[dict] = []
        for device in devices:
            host_pc_ip = device.host_pc_ip
            node_id = node_id_map.get(host_pc_ip, 0)
            driver_code = device.driver_code or 'UNKNOWN'
            if driver_code == 'UNKNOWN':
                # 🔧 Day9/P2-12：驱动未识别的设备不下发（边缘 13 分流只会 warn 丢弃，下发无意义还误导操作员）
                failed_devices.append({
                    'deviceId': device.id, 'deviceName': device.device_name,
                    'hostPcIp': host_pc_ip, 'nodeId': node_id, 'reason': 'driver_code=UNKNOWN',
                })
                logger.warning(f'跳过发布（driver_code=UNKNOWN）：device_id={device.id} {device.device_name}')
                continue
            driver_config = DriverService.build_driver_config(device)
            try:
                ok = await publish_config_refresh(
                    host_pc_ip=host_pc_ip,
                    node_id=node_id,
                    device_id=device.id,
                    driver_code=driver_code,
                    driver_config=driver_config,
                )
            except Exception as exc:
                ok = False
                logger.warning(
                    f'配置发布通知异常：host_pc_ip={host_pc_ip}, node_id={node_id}, '
                    f'device_id={device.id}, error={exc}'
                )
            if ok:
                published_ips.add(host_pc_ip)
                if node_id:
                    published_nodes.add(node_id)
                logger.info(
                    f'配置发布通知已发送：host_pc_ip={host_pc_ip}, node_id={node_id}, '
                    f'device_id={device.id}, driver_code={driver_code}'
                )
            else:
                failed_devices.append({
                    'deviceId': device.id,
                    'deviceName': device.device_name,
                    'hostPcIp': host_pc_ip,
                    'nodeId': node_id,
                })
                logger.warning(
                    f'配置发布通知未送达：host_pc_ip={host_pc_ip}, device_id={device.id}'
                    f'（MQTT 未连接/未初始化，边缘 30s 轮询将兜底同步）'
                )

        # 🔧 P1-NEW-1：发布时配置快照（设备 + 点位关键字段，供审计/回滚依据）
        dev_ids = [d.id for d in devices]
        tags_by_dev: dict[int, list[dict]] = {}
        if dev_ids:
            tag_result = await query_db.execute(
                select(PlcTag).where(PlcTag.device_id.in_(dev_ids), PlcTag.del_flag == '0')
            )
            for t in tag_result.scalars().all():
                tags_by_dev.setdefault(t.device_id, []).append({
                    'id': t.id, 'tagName': t.tag_name,
                    'registerType': t.register_type, 'registerAddress': t.register_address,
                    'dataType': t.data_type, 'bitOffset': t.bit_offset,
                    'byteOrder': t.byte_order, 'wordOrder': t.word_order,
                    'transformType': t.transform_type,
                    'transformSlopeA': t.transform_slope_a, 'transformOffsetB': t.transform_offset_b,
                    'reportDeadbandMs': t.report_deadband_ms,
                    'reportForceIntervalMs': t.report_force_interval_ms,
                    'status': t.status,
                })
        config_snapshot = [
            {
                'deviceId': d.id, 'deviceName': d.device_name, 'hostPcIp': d.host_pc_ip,
                'plcIp': d.plc_ip, 'plcPort': d.plc_port, 'comType': d.com_type,
                'driverCode': d.driver_code, 'mcFrame': d.mc_frame,
                'stationNo': d.station_no, 'networkNo': d.network_no,
                'scanIntervalMs': d.scan_interval_ms,
                'protocolParams': d.protocol_params,
                'tags': tags_by_dev.get(d.id, []),
            }
            for d in devices
        ]

        status = 'failed' if (devices and len(failed_devices) == len(devices)) else (
            'partial' if failed_devices else 'success'
        )

        # 写入发布日志（🔧 P0-3：记录真实成败；device_ids 记录实际发布的设备）
        try:
            log = PlcPublishLog(
                publish_by=publish_by,
                device_count=len(devices),
                node_count=len(published_nodes),
                ip_count=len(published_ips),
                device_ids=dev_ids,
                status=status,
                fail_detail=failed_devices or None,
                config_snapshot=config_snapshot,
            )
            query_db.add(log)
            await query_db.commit()
        except Exception as exc:
            await query_db.rollback()
            logger.warning(f'发布日志写入失败: {exc}')

        return {
            'published_ips': sorted(published_ips),
            'published_nodes': sorted(published_nodes),
            'device_count': len(devices),
            'failed_devices': failed_devices,
            'status': status,
            'snapshot_version': snapshot_version,
        }
