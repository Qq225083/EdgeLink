"""部署中心（节点与文档下载）— 数据操作层"""
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from module_downloads.entity.do.download_do import DownloadItem


class DownloadDao:
    """交付物数据访问层"""

    @staticmethod
    async def get_list(db: AsyncSession, group: str | None, keyword: str | None, status: int | None) -> list[DownloadItem]:
        """按类别/关键字/状态查询交付物（按更新时间倒序）。"""
        query = select(DownloadItem)
        if group:
            query = query.where(DownloadItem.group_key == group)
        if status is not None:
            query = query.where(DownloadItem.status == status)
        if keyword and keyword.strip():
            kw = f'%{keyword.strip()}%'
            query = query.where(or_(DownloadItem.name.like(kw), DownloadItem.description.like(kw)))
        query = query.order_by(DownloadItem.update_time.desc(), DownloadItem.id.desc())
        result = await db.execute(query)
        return result.scalars().all()

    @staticmethod
    async def get_by_id(db: AsyncSession, item_id: int) -> DownloadItem | None:
        result = await db.execute(select(DownloadItem).where(DownloadItem.id == item_id))
        return result.scalar_one_or_none()

    @staticmethod
    async def get_by_name_version(db: AsyncSession, name: str, version: str | None) -> DownloadItem | None:
        """按 名称+版本 查重（防止同一交付物重复上传）。"""
        result = await db.execute(
            select(DownloadItem).where(DownloadItem.name == name, DownloadItem.version == (version or None))
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def add(db: AsyncSession, item: DownloadItem) -> int:
        db.add(item)
        await db.flush()
        return item.id

    @staticmethod
    async def delete_by_id(db: AsyncSession, item_id: int) -> int:
        result = await db.execute(delete(DownloadItem).where(DownloadItem.id == item_id))
        return result.rowcount
