"""存量采集点健康监控 — 服务层"""
import hashlib
import ipaddress
import json
import secrets
from datetime import datetime
from typing import Any

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from common.vo import PageModel
from exceptions.exception import ServiceException
from module_site_health.dao.site_health_dao import SiteHealthDao
from module_site_health.entity.do.site_health_do import (
    SiteHealthSite,
    SiteHealthHeartbeatLog,
    SiteHealthFlowsUpload,
    hash_site_key,
)
from module_site_health.entity.vo.site_health_vo import (
    SiteRegisterModel,
    SiteUpdateModel,
    SiteHealthPageQueryModel,
)
from utils.common_util import CamelCaseUtil
from utils.log_util import logger
from utils.page_util import PageUtil


class SiteHealthService:
    """存量采集点健康监控服务层"""

    # 错误快照上限：每次上报最多 10 条，单条消息截断 500 字（防爆量/含堆栈的长文本）
    _MAX_ERRORS_PER_REPORT = 10
    _ERR_MSG_MAX_LEN = 500
    # flows.json 上传上限 10MB，每站点仅保留最近 5 份
    _FLOWS_MAX_BYTES = 10 * 1024 * 1024
    _FLOWS_KEEP = 5

    @staticmethod
    def _validate_ipv4(value: str, label: str) -> None:
        """严格校验 IPv4 格式（0-255 四段），不合法直接抛业务异常。"""
        try:
            ipaddress.IPv4Address(value)
        except ValueError:
            raise ServiceException(message=f'{label}格式不正确，应为 IPv4 地址（如 192.168.1.10）')

    # ==================== 登记 / 管理 ====================

    @classmethod
    async def register_site(cls, db: AsyncSession, model: SiteRegisterModel) -> tuple[str, int]:
        """登记采集点 → 生成唯一密钥（明文仅返回一次），返回 (key, site_id)。"""
        office_ip = model.office_ip.strip()
        indust_ip = model.indust_ip.strip() if model.indust_ip else None
        site_name = model.site_name.strip()
        if not office_ip:
            raise ServiceException(message='办公网IP不能为空')
        if not site_name:
            raise ServiceException(message='采集场所不能为空')
        cls._validate_ipv4(office_ip, '办公网IP')
        if indust_ip:
            cls._validate_ipv4(indust_ip, '工业网IP')

        # 同一办公网 IP + 端口视为同一实例，拒绝重复登记（避免旧 Key 的僵尸行一直显示「未接入」）
        existing = await SiteHealthDao.get_site_by_ip_port(db, office_ip, model.node_port)
        if existing:
            raise ServiceException(
                message=f'该采集点已登记（ID: {existing.id}，{existing.site_name}），如需更换密钥请到监控页重置'
            )

        secret = secrets.token_hex(16)
        entity = SiteHealthSite(
            site_key_hash=hash_site_key(secret),
            office_ip=office_ip,
            indust_ip=indust_ip,
            site_name=site_name,
            building=model.building.strip(),
            floor=model.floor.strip(),
            process_stage=model.process_stage.strip(),
            contact=model.contact.strip() if model.contact else None,
            remark=model.remark.strip() if model.remark else None,
            node_port=model.node_port,
            status=1,
        )
        db.add(entity)
        await db.flush()
        site_id = entity.id
        await db.commit()
        return secret, site_id

    @classmethod
    async def update_site(cls, db: AsyncSession, site_id: int, model: SiteUpdateModel) -> None:
        """编辑采集点情报字段（办公/工业 IP、端口、场所、联系人、备注）。

        不涉及密钥（只能走重置）与启停状态（走 toggle_status）；
        改「办公网 IP + 端口」时查重（排除自身），保证组合唯一。
        """
        site = await SiteHealthDao.get_site_by_id(db, site_id)
        if not site:
            raise ServiceException(message='采集点不存在')
        office_ip = model.office_ip.strip()
        indust_ip = model.indust_ip.strip() if model.indust_ip else None
        site_name = model.site_name.strip()
        if not office_ip:
            raise ServiceException(message='办公网IP不能为空')
        if not site_name:
            raise ServiceException(message='采集场所不能为空')
        cls._validate_ipv4(office_ip, '办公网IP')
        if indust_ip:
            cls._validate_ipv4(indust_ip, '工业网IP')

        existing = await SiteHealthDao.get_site_by_ip_port(db, office_ip, model.node_port)
        if existing and existing.id != site_id:
            raise ServiceException(
                message=f'办公网IP+端口已被采集点（ID: {existing.id}，{existing.site_name}）占用'
            )

        site.office_ip = office_ip
        site.indust_ip = indust_ip
        site.site_name = site_name
        site.building = model.building.strip()
        site.floor = model.floor.strip()
        site.process_stage = model.process_stage.strip()
        site.contact = model.contact.strip() if model.contact else None
        site.remark = model.remark.strip() if model.remark else None
        site.node_port = model.node_port
        await db.commit()

    @classmethod
    async def regenerate_key(cls, db: AsyncSession, site_id: int) -> str:
        """重新生成密钥，旧密钥立即失效，返回新密钥明文（仅一次）。"""
        site = await SiteHealthDao.get_site_by_id(db, site_id)
        if not site:
            raise ServiceException(message='采集点不存在')
        new_secret = secrets.token_hex(16)
        site.site_key_hash = hash_site_key(new_secret)
        await db.commit()
        return new_secret

    @classmethod
    async def toggle_status(cls, db: AsyncSession, site_id: int, enabled: int) -> None:
        """启用/停用采集点。停用后节点上报返回 disabled，边缘侧据此退避。"""
        site = await SiteHealthDao.get_site_by_id(db, site_id)
        if not site:
            raise ServiceException(message='采集点不存在')
        site.status = enabled
        await db.commit()

    @classmethod
    async def delete_sites(cls, db: AsyncSession, id_list: list[int]) -> None:
        """删除采集点及其心跳履历、flows.json 上传档案。"""
        if not id_list:
            raise ServiceException(message='传入为空')
        await db.execute(delete(SiteHealthSite).where(SiteHealthSite.id.in_(id_list)))
        await db.execute(delete(SiteHealthHeartbeatLog).where(SiteHealthHeartbeatLog.site_id.in_(id_list)))
        await db.execute(delete(SiteHealthFlowsUpload).where(SiteHealthFlowsUpload.site_id.in_(id_list)))
        await db.commit()

    # ==================== Node-RED 心跳上报 ====================

    @classmethod
    async def _resolve_site_by_key(
        cls, db: AsyncSession, key: str, report_ip: str, node_port: int
    ) -> tuple[SiteHealthSite | None, dict | None]:
        """心跳/上传共用的身份校验：key → 站点、启停、IP 绑定、端口绑定。

        通过返回 (site, None)；拒绝返回 (None, 响应 dict)，响应语义与节点侧状态机一一对应。
        """
        site = await SiteHealthDao.get_site_by_key(db, key)
        if not site:
            return None, {'ok': False, 'disabled': False, 'reason': 'invalid_key', 'message': '密钥无效，请核对节点配置中的 Key'}
        if site.status == 0:
            return None, {'ok': False, 'disabled': True, 'reason': 'disabled', 'message': '采集点已停用，请在前端启用'}

        # 密钥与登记情报绑定：上报来源 IP 必须是登记的办公网 IP（或工业网 IP）。
        # 防止把 A 采集点的 Key 错配/盗用到 B 机器 → B 的指标盖到 A 头上、A 假在线。
        normalized_ip = (report_ip or '').strip()
        if normalized_ip.startswith('::ffff:'):  # IPv6 映射的 IPv4 归一化
            normalized_ip = normalized_ip[7:]
        allowed_ips = {ip for ip in (site.office_ip, site.indust_ip) if ip}
        if normalized_ip and normalized_ip not in allowed_ips:
            logger.warning(
                f'存量采集点上报被拒绝：site_id={site.id} 登记IP={sorted(allowed_ips)} 实际上报IP={normalized_ip}'
            )
            return None, {
                'ok': False, 'disabled': False, 'reason': 'ip_mismatch',
                'message': f'上报来源IP({normalized_ip})与登记不符，请检查节点密钥是否配错采集点',
            }

        # 端口同样是身份的一部分：登记端口与节点实际上报端口（uiPort）不一致 → 拒绝。
        # 场景：登记后被改成别的端口 / 节点装错实例。不报警放行会导致监控页显示与实际部署脱节。
        if (
            site.node_port is not None
            and node_port and 0 < node_port <= 65535
            and node_port != site.node_port
        ):
            logger.warning(
                f'存量采集点上报被拒绝：site_id={site.id} 登记端口={site.node_port} 实际上报端口={node_port}'
            )
            return None, {
                'ok': False, 'disabled': False, 'reason': 'port_mismatch',
                'message': f'上报端口({node_port})与登记端口({site.node_port})不一致，请检查登记信息或节点部署',
            }
        return site, None

    @classmethod
    def _normalize_errors(cls, errors: list | None, now: datetime) -> str | None:
        """把节点上报的 errors 归一化为 [{ts,msg,count}] JSON 字符串；无错误返回 None（清空快照）。

        count：节点侧去重计数（同 msg 重复出现只记一条），服务端兜底钳制 1~99999。
        """
        if not errors:
            return None
        fallback_ts = now.strftime('%Y-%m-%d %H:%M:%S')
        items = []
        for item in errors[: cls._MAX_ERRORS_PER_REPORT]:
            count = 1
            if isinstance(item, dict):
                ts = str(item.get('ts') or fallback_ts)[:32]
                msg = str(item.get('msg') or '')[: cls._ERR_MSG_MAX_LEN]
                try:
                    count = max(1, min(99999, int(item.get('count') or 1)))
                except (TypeError, ValueError):
                    count = 1
            else:
                ts = fallback_ts
                msg = str(item)[: cls._ERR_MSG_MAX_LEN]
            if msg:
                items.append({'ts': ts, 'msg': msg, 'count': count})
        return json.dumps(items, ensure_ascii=False) if items else None

    @classmethod
    async def report_heartbeat(
        cls,
        db: AsyncSession,
        *,
        key: str,
        interval: int,
        report_ip: str,
        node_port: int,
        memory_rss_mb: int,
        memory_total_mb: int,
        memory_free_mb: int,
        running_flows: int,
        node_red_version: str,
        uptime_sec: int,
        errors: list | None = None,
    ) -> dict:
        """节点心跳上报：校验密钥 → 更新采集点最新指标 → 写一条履历。

        errors（v1.1.0+ 节点经 POST body 携带）：上次上报以来的 error 级日志，
        覆盖式写入 last_errors 快照；旧节点不带 body（errors=None）时不动该字段。
        """
        site, reject = await cls._resolve_site_by_key(db, key, report_ip, node_port)
        if reject:
            return reject

        normalized_ip = (report_ip or '').strip()
        if normalized_ip.startswith('::ffff:'):
            normalized_ip = normalized_ip[7:]

        site_id = site.id
        interval = max(10, min(180, int(interval or 30)))
        now = datetime.now()
        version = (node_red_version or '')[:20] or None
        report_ip = normalized_ip[:50] or None

        # 更新采集点最新指标（与 nodered_node 的 #88 健康指标同思路，避免每次列表 N+1）
        site.last_heartbeat = now
        site.report_ip = report_ip
        # 端口是「办公网IP+端口」唯一身份的一部分：登记必填，心跳只在存量行端口为空时回填，
        # 不用 uiPort 覆盖登记值（uiPort 未个性化配置时默认 1880，会错误改写已登记端口）
        if site.node_port is None and node_port and 0 < node_port <= 65535:
            site.node_port = node_port
        site.heartbeat_interval = interval
        site.memory_rss_mb = int(memory_rss_mb or 0)
        site.memory_total_mb = int(memory_total_mb or 0)
        site.memory_free_mb = int(memory_free_mb or 0)
        site.running_flows = int(running_flows or 0)
        site.node_red_version = version
        site.uptime_sec = int(uptime_sec or 0)
        if errors is not None:
            site.last_errors = cls._normalize_errors(errors, now)

        db.add(
            SiteHealthHeartbeatLog(
                site_id=site_id,
                report_time=now,
                report_ip=report_ip,
                memory_rss_mb=int(memory_rss_mb or 0),
                memory_total_mb=int(memory_total_mb or 0),
                memory_free_mb=int(memory_free_mb or 0),
                running_flows=int(running_flows or 0),
                node_red_version=version,
                uptime_sec=int(uptime_sec or 0),
            )
        )
        await db.commit()
        return {'ok': True, 'disabled': False, 'site_id': site_id}

    # ==================== flows.json 上传档案 ====================

    @classmethod
    async def upload_flows(
        cls,
        db: AsyncSession,
        *,
        key: str,
        reason: str,
        content: str,
        sha256: str | None,
        node_port: int,
        report_ip: str,
    ) -> dict:
        """flows.json 上传：与心跳同一套身份校验，写入档案并裁剪到每站点最近 5 份。"""
        site, reject = await cls._resolve_site_by_key(db, key, report_ip, node_port)
        if reject:
            return reject

        reason = (reason or '').strip()[:200]
        if not reason:
            return {'ok': False, 'disabled': False, 'reason': 'invalid_reason', 'message': '上传原因不能为空'}
        size_bytes = len(content.encode('utf-8'))
        if size_bytes > cls._FLOWS_MAX_BYTES:
            return {
                'ok': False, 'disabled': False, 'reason': 'too_large',
                'message': f'flows.json 大小({size_bytes // 1024}KB)超过 10MB 上限',
            }
        if sha256:
            actual = hashlib.sha256(content.encode('utf-8')).hexdigest()
            if actual != sha256.strip().lower():
                return {
                    'ok': False, 'disabled': False, 'reason': 'sha256_mismatch',
                    'message': '内容校验（SHA-256）不一致，传输可能损坏，请重试',
                }

        entity = SiteHealthFlowsUpload(
            site_id=site.id,
            reason=reason,
            content=content,
            size_bytes=size_bytes,
            sha256=(sha256 or '').strip().lower() or None,
            created_at=datetime.now(),
        )
        db.add(entity)
        await db.flush()
        upload_id = entity.id
        await SiteHealthDao.trim_uploads(db, site.id, keep=cls._FLOWS_KEEP)
        await db.commit()
        return {'ok': True, 'disabled': False, 'upload_id': upload_id, 'message': '上传成功'}

    @classmethod
    async def get_uploads(cls, db: AsyncSession, site_id: int) -> list[dict]:
        """某采集点上传档案列表（倒序，不含 content 全文）。"""
        site = await SiteHealthDao.get_site_by_id(db, site_id)
        if not site:
            raise ServiceException(message='采集点不存在')
        rows = await SiteHealthDao.get_uploads(db, site_id)
        result = CamelCaseUtil.transform_result(list(rows))
        for row in result:
            row.pop('content', None)  # 列表不下发全文，下载走单独接口
        return result

    @classmethod
    async def get_upload_file(cls, db: AsyncSession, site_id: int, upload_id: int) -> tuple[str, str]:
        """取档案全文与下载文件名（强制 site_id 归属校验，防越权下载）。"""
        upload = await SiteHealthDao.get_upload_by_id(db, site_id, upload_id)
        if not upload:
            raise ServiceException(message='上传记录不存在')
        filename = f'flows-site{site_id}-{upload.created_at.strftime("%Y%m%d%H%M%S")}.json'
        return upload.content, filename

    # ==================== 查询 ====================

    @staticmethod
    def _decorate_row(row: dict, now: datetime) -> dict:
        """给列表行补充运行时计算字段（在线状态/是否上报过/整机已用内存），并抹除密钥哈希。"""
        row.pop('siteKeyHash', None)  # 密钥哈希永不下发
        last_hb = row.get('lastHeartbeat')
        row['hasReported'] = last_hb is not None
        interval = row.get('heartbeatInterval') or 30
        # 在线判定：3 × 心跳间隔内未上报即判离线
        row['isOnline'] = bool(last_hb and (now - last_hb).total_seconds() < 3 * interval)
        total_mb = row.get('memoryTotalMb')
        free_mb = row.get('memoryFreeMb')
        row['memoryUsedMb'] = (total_mb - free_mb) if (total_mb is not None and free_mb is not None) else None
        # 错误快照：存储层是 JSON 字符串，下发前解析成列表（解析失败按无错误处理）
        raw_errors = row.get('lastErrors')
        parsed = []
        if raw_errors:
            try:
                parsed = json.loads(raw_errors) or []
            except (ValueError, TypeError):
                parsed = []
            if not isinstance(parsed, list):
                parsed = []
        row['lastErrors'] = parsed
        return row

    @classmethod
    async def get_site_list(cls, db: AsyncSession, page_query: SiteHealthPageQueryModel):
        """分页查询采集点列表（支持状态过滤），附带在线状态与最新指标。"""
        query = select(SiteHealthSite)
        if page_query.keyword and page_query.keyword.strip():
            kw = f'%{page_query.keyword.strip()}%'
            query = query.where(
                or_(
                    SiteHealthSite.site_name.like(kw),
                    SiteHealthSite.office_ip.like(kw),
                    SiteHealthSite.indust_ip.like(kw),
                    SiteHealthSite.contact.like(kw),
                )
            )
        query = query.order_by(SiteHealthSite.id.desc())
        now = datetime.now()
        state = page_query.state

        # 停用/未接入可直接下推 SQL；在线/离线依赖「3×心跳间隔」的逐行计算，无法跨库（MySQL/PG）下推，
        # 采集点量级小（几十~几百），取关键字过滤后的全量在内存里过滤再手动分页
        if state == 'disabled':
            query = query.where(SiteHealthSite.status == 0)
        elif state == 'notConnected':
            query = query.where(SiteHealthSite.status == 1, SiteHealthSite.last_heartbeat.is_(None))

        if state in ('online', 'offline'):
            query_result = await db.execute(query.where(SiteHealthSite.status == 1))
            entities = [row[0] for row in query_result.all()]
            rows = [cls._decorate_row(r, now) for r in CamelCaseUtil.transform_result(entities)]
            want_online = state == 'online'
            rows = [r for r in rows if r['hasReported'] and r['isOnline'] == want_online]
            total = len(rows)
            start = (page_query.page_num - 1) * page_query.page_size
            return PageModel[Any](
                rows=rows[start:start + page_query.page_size],
                pageNum=page_query.page_num,
                pageSize=page_query.page_size,
                total=total,
                hasNext=total > start + page_query.page_size,
            )

        result = await PageUtil.paginate(db, query, page_query.page_num, page_query.page_size, is_page=True)
        for row in result.rows:
            cls._decorate_row(row, now)
        return result

    @classmethod
    async def get_summary(cls, db: AsyncSession) -> dict:
        """全局状态统计（监控页一览卡片）：总数/在线/离线/未接入/已停用。"""
        result = await db.execute(
            select(SiteHealthSite.status, SiteHealthSite.last_heartbeat, SiteHealthSite.heartbeat_interval)
        )
        now = datetime.now()
        summary = {'total': 0, 'online': 0, 'offline': 0, 'notConnected': 0, 'disabled': 0}
        for status, last_hb, hb_interval in result.all():
            summary['total'] += 1
            if status == 0:
                summary['disabled'] += 1
            elif last_hb is None:
                summary['notConnected'] += 1
            elif (now - last_hb).total_seconds() < 3 * (hb_interval or 30):
                summary['online'] += 1
            else:
                summary['offline'] += 1
        return summary

    @classmethod
    async def get_history(cls, db: AsyncSession, site_id: int, limit: int, offset: int) -> list[dict]:
        """获取某采集点心跳履历（camelCase 字典列表，供前端直接渲染）。"""
        logs = await SiteHealthDao.get_history(db, site_id, limit, offset)
        return CamelCaseUtil.transform_result(list(logs))

    @classmethod
    async def get_memory_trend(cls, db: AsyncSession, site_id: int, hours: int) -> list[dict]:
        """内存趋势（按小时分桶，avg/max RSS MB），供趋势图渲染。"""
        rows = await SiteHealthDao.get_memory_trend(db, site_id, hours)
        return [
            {
                'bucket': r.bucket,
                'avgMb': round(float(r.avg_mb), 1) if r.avg_mb is not None else None,
                'maxMb': int(r.max_mb) if r.max_mb is not None else None,
            }
            for r in rows
        ]
