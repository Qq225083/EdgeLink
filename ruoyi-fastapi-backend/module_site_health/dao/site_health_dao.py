"""存量采集点健康监控 — 数据操作层"""
from datetime import datetime, timedelta

from sqlalchemy import delete, desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from module_site_health.entity.do.site_health_do import (
    SiteHealthSite,
    SiteHealthHeartbeatLog,
    hash_site_key,
)


class SiteHealthDao:
    """存量采集点数据访问层"""

    @staticmethod
    async def get_site_by_key(db: AsyncSession, key: str) -> SiteHealthSite | None:
        """按密钥（哈希比对）查找采集点。"""
        result = await db.execute(
            select(SiteHealthSite).where(SiteHealthSite.site_key_hash == hash_site_key(key))
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def get_site_by_id(db: AsyncSession, site_id: int) -> SiteHealthSite | None:
        """按 ID 查找采集点。"""
        result = await db.execute(select(SiteHealthSite).where(SiteHealthSite.id == site_id))
        return result.scalar_one_or_none()

    @staticmethod
    async def get_site_by_ip_port(db: AsyncSession, office_ip: str, node_port: int | None) -> SiteHealthSite | None:
        """按办公网 IP + 端口查找采集点（登记查重；端口为空按 NULL 匹配）。

        用 first() 而非 scalar_one_or_none()，容忍历史遗留的重复行。
        """
        query = select(SiteHealthSite).where(SiteHealthSite.office_ip == office_ip)
        if node_port is None:
            query = query.where(SiteHealthSite.node_port.is_(None))
        else:
            query = query.where(SiteHealthSite.node_port == node_port)
        result = await db.execute(query.order_by(SiteHealthSite.id))
        return result.scalars().first()

    @staticmethod
    async def get_history(db: AsyncSession, site_id: int, limit: int = 200, offset: int = 0) -> list[SiteHealthHeartbeatLog]:
        """获取某采集点心跳履历（倒序，支持 offset 分页加载更多）。"""
        result = await db.execute(
            select(SiteHealthHeartbeatLog)
            .where(SiteHealthHeartbeatLog.site_id == site_id)
            .order_by(desc(SiteHealthHeartbeatLog.id))
            .limit(limit)
            .offset(offset)
        )
        return result.scalars().all()

    @staticmethod
    async def clean_old_heartbeat_logs(db: AsyncSession, retention_days: int = 7, batch_size: int = 5000) -> int:
        """清理超过保留天数的心跳日志，返回删除总行数。

        分批删除 + 每批独立提交：避免单条大 DELETE 构成长事务（大 undo log、持锁阻塞写入）。
        先查 ID 再按 ID 删，兼容 MySQL/PG；中途失败时已删批次不回滚，下周期继续。
        """
        cutoff = datetime.now() - timedelta(days=retention_days)
        total = 0
        while True:
            ids = (
                await db.execute(
                    select(SiteHealthHeartbeatLog.id)
                    .where(SiteHealthHeartbeatLog.report_time < cutoff)
                    .order_by(SiteHealthHeartbeatLog.id)
                    .limit(batch_size)
                )
            ).scalars().all()
            if not ids:
                break
            await db.execute(delete(SiteHealthHeartbeatLog).where(SiteHealthHeartbeatLog.id.in_(ids)))
            await db.commit()  # 每批独立事务，锁持有时间可控
            total += len(ids)
            if len(ids) < batch_size:
                break
        return total
