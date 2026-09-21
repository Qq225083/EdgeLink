"""存量采集点健康监控 — 数据操作层"""
from datetime import datetime, timedelta

from sqlalchemy import delete, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from module_site_health.entity.do.site_health_do import (
    SiteHealthSite,
    SiteHealthHeartbeatLog,
    SiteHealthFlowsUpload,
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
    async def get_memory_trend(db: AsyncSession, site_id: int, hours: int) -> list:
        """内存趋势：按小时分桶（avg/max RSS），用于监控页趋势图。

        注：用 MySQL 的 date_format 分桶（存量监控库是 MySQL）。
        """
        cutoff = datetime.now() - timedelta(hours=hours)
        bucket = func.date_format(SiteHealthHeartbeatLog.report_time, '%Y-%m-%d %H:00')
        result = await db.execute(
            select(
                bucket.label('bucket'),
                func.avg(SiteHealthHeartbeatLog.memory_rss_mb).label('avg_mb'),
                func.max(SiteHealthHeartbeatLog.memory_rss_mb).label('max_mb'),
            )
            .where(
                SiteHealthHeartbeatLog.site_id == site_id,
                SiteHealthHeartbeatLog.report_time >= cutoff,
            )
            .group_by(bucket)
            .order_by(bucket)
        )
        return result.all()

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

    # ==================== flows.json 上传档案 ====================

    @staticmethod
    async def get_uploads(db: AsyncSession, site_id: int) -> list[SiteHealthFlowsUpload]:
        """某采集点的上传档案列表（倒序，content 全文一并取出也无妨：最多 5 份）。"""
        result = await db.execute(
            select(SiteHealthFlowsUpload)
            .where(SiteHealthFlowsUpload.site_id == site_id)
            .order_by(desc(SiteHealthFlowsUpload.id))
        )
        return result.scalars().all()

    @staticmethod
    async def get_upload_by_id(
        db: AsyncSession, site_id: int, upload_id: int
    ) -> SiteHealthFlowsUpload | None:
        """按 ID 取档案（强制带 site_id 条件，防越权下载别的采集点的档案）。"""
        result = await db.execute(
            select(SiteHealthFlowsUpload).where(
                SiteHealthFlowsUpload.id == upload_id,
                SiteHealthFlowsUpload.site_id == site_id,
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def trim_uploads(db: AsyncSession, site_id: int, keep: int = 5) -> int:
        """每站点仅保留最近 keep 份档案，返回删除份数。随写入同事务调用。"""
        keep_ids = (
            await db.execute(
                select(SiteHealthFlowsUpload.id)
                .where(SiteHealthFlowsUpload.site_id == site_id)
                .order_by(desc(SiteHealthFlowsUpload.id))
                .limit(keep)
            )
        ).scalars().all()
        if not keep_ids:
            return 0
        result = await db.execute(
            delete(SiteHealthFlowsUpload).where(
                SiteHealthFlowsUpload.site_id == site_id,
                SiteHealthFlowsUpload.id.not_in(keep_ids),
            )
        )
        return result.rowcount or 0
