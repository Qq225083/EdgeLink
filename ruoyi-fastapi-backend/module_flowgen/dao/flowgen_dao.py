"""过渡版流程生成器 — 数据操作层"""
from sqlalchemy import delete, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from module_flowgen.entity.do.flowgen_do import PlcFlowCanvasSnapshot, PlcFlowRelease
from module_flowgen.entity.vo.flowgen_vo import FlowReleasePageQueryModel
from utils.page_util import PageUtil


class FlowgenDao:
    """流程版本数据访问层"""

    # 列表不取 payload 全文（MEDIUMTEXT），避免列表页负载过重
    _LIST_COLUMNS = (
        PlcFlowRelease.id,
        PlcFlowRelease.site_id,
        PlcFlowRelease.config_version,
        PlcFlowRelease.version,
        PlcFlowRelease.sha256,
        PlcFlowRelease.device_count,
        PlcFlowRelease.node_count,
        PlcFlowRelease.status,
        PlcFlowRelease.deploy_time,
        PlcFlowRelease.deploy_by,
        PlcFlowRelease.deploy_msg,
        PlcFlowRelease.remark,
        PlcFlowRelease.create_by,
        PlcFlowRelease.create_time,
        PlcFlowRelease.update_time,
    )

    @classmethod
    async def get_release_page(cls, db: AsyncSession, query_object: FlowReleasePageQueryModel):
        """流程版本分页查询（不含 payload）。"""
        query = (
            select(*cls._LIST_COLUMNS)
            .where(PlcFlowRelease.site_id == query_object.site_id if query_object.site_id is not None else True)
            .order_by(desc(PlcFlowRelease.id))
        )
        return await PageUtil.paginate(db, query, query_object.page_num, query_object.page_size, is_page=True)

    @staticmethod
    async def get_release_by_id(db: AsyncSession, release_id: int) -> PlcFlowRelease | None:
        """按 ID 取版本（含 payload 全文）。"""
        result = await db.execute(select(PlcFlowRelease).where(PlcFlowRelease.id == release_id))
        return result.scalar_one_or_none()

    @staticmethod
    async def get_latest_release(db: AsyncSession, site_id: int) -> PlcFlowRelease | None:
        """取某现场最新一个版本（幂等比对用）。"""
        result = await db.execute(
            select(PlcFlowRelease)
            .where(PlcFlowRelease.site_id == site_id)
            .order_by(desc(PlcFlowRelease.version))
            .limit(1)
        )
        return result.scalars().first()

    @staticmethod
    async def get_max_version(db: AsyncSession, site_id: int) -> int:
        """取某现场当前最大版本号（无记录返回 0）。"""
        result = await db.execute(select(func.max(PlcFlowRelease.version)).where(PlcFlowRelease.site_id == site_id))
        return result.scalar() or 0

    # ==================== 画布快照 ====================

    _SNAP_LIST_COLUMNS = (
        PlcFlowCanvasSnapshot.id,
        PlcFlowCanvasSnapshot.site_id,
        PlcFlowCanvasSnapshot.release_id,
        PlcFlowCanvasSnapshot.rev,
        PlcFlowCanvasSnapshot.node_count,
        PlcFlowCanvasSnapshot.source,
        PlcFlowCanvasSnapshot.create_by,
        PlcFlowCanvasSnapshot.create_time,
    )

    @classmethod
    async def get_snapshot_page(cls, db: AsyncSession, query_object: FlowReleasePageQueryModel):
        """画布快照分页查询（不含 payload）。"""
        query = (
            select(*cls._SNAP_LIST_COLUMNS)
            .where(PlcFlowCanvasSnapshot.site_id == query_object.site_id if query_object.site_id is not None else True)
            .order_by(desc(PlcFlowCanvasSnapshot.id))
        )
        return await PageUtil.paginate(db, query, query_object.page_num, query_object.page_size, is_page=True)

    @staticmethod
    async def get_snapshot_by_id(db: AsyncSession, snapshot_id: int) -> PlcFlowCanvasSnapshot | None:
        """按 ID 取快照（含 payload 全文）。"""
        result = await db.execute(select(PlcFlowCanvasSnapshot).where(PlcFlowCanvasSnapshot.id == snapshot_id))
        return result.scalar_one_or_none()
