"""部署中心（节点与文档下载）— 服务层"""
import os
import re
import time

from fastapi import UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from exceptions.exception import ServiceException
from module_downloads.dao.download_dao import DownloadDao
from module_downloads.entity.do.download_do import DownloadItem
from module_downloads.entity.vo.download_vo import DownloadUpdateModel
from utils.common_util import CamelCaseUtil
from utils.log_util import logger

# 上传约束
_ALLOWED_EXTS = {'.zip', '.pdf', '.md', '.txt'}
_MAX_SIZE = 500 * 1024 * 1024  # 500MB（完整部署包场景）
_GROUP_DIRS = {'packages': 'packages', 'nodered-full': 'full', 'nodered-inc': 'inc', 'docs': 'docs'}


class DownloadService:
    """交付物服务层"""

    @classmethod
    def downloads_root(cls) -> str:
        """downloads 目录绝对路径（本文件向上退 4 级：service → module_downloads → backend）。"""
        return os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'downloads')

    # ==================== 查询 ====================

    @classmethod
    async def get_list(cls, db: AsyncSession, group: str | None, keyword: str | None, status: int | None) -> list[dict]:
        rows = await DownloadDao.get_list(db, group, keyword, status)
        return CamelCaseUtil.transform_result(list(rows))

    @classmethod
    async def get_file_path(cls, db: AsyncSession, item_id: int) -> tuple[str, str]:
        """按 ID 解析磁盘文件（返回绝对路径与下载展示文件名）。路径始终约束在 downloads 内。"""
        item = await DownloadDao.get_by_id(db, item_id)
        if not item:
            raise ServiceException(message='交付物不存在')
        root = os.path.realpath(cls.downloads_root())
        target = os.path.realpath(os.path.join(root, item.file_name))
        if not target.startswith(root + os.sep):
            raise ServiceException(message='非法的文件路径')
        if not os.path.isfile(target):
            raise ServiceException(message='交付物文件已丢失，请联系管理员')
        # 下载展示名：优先原始文件名（不带时间戳前缀），兜底存盘名
        display_name = item.origin_name or os.path.basename(target)
        return target, display_name

    # ==================== 维护（上传/编辑/删除） ====================

    @classmethod
    async def upload(
        cls,
        db: AsyncSession,
        *,
        file: UploadFile,
        name: str,
        group_key: str,
        version: str | None,
        description: str | None,
        tags: str | None,
        create_by: str | None,
    ) -> int:
        """上传交付物：校验 → 落盘（downloads/<groupDir>/<时间戳>_<净化名>）→ 写库。"""
        if group_key not in _GROUP_DIRS:
            raise ServiceException(message='类别不合法')
        if not name or not name.strip():
            raise ServiceException(message='名称不能为空')
        raw_name = os.path.basename(file.filename or '')
        ext = os.path.splitext(raw_name)[1].lower()
        if ext not in _ALLOWED_EXTS:
            raise ServiceException(message=f'不支持的文件类型 {ext}，仅允许：{"/".join(sorted(_ALLOWED_EXTS))}')

        # 名称+版本判重：防止同一交付物重复上传产生重复行
        clean_name = name.strip()
        clean_version = (version or '').strip() or None
        existing = await DownloadDao.get_by_name_version(db, clean_name, clean_version)
        if existing:
            raise ServiceException(
                message=f'交付物「{clean_name} v{clean_version or "-"}」已存在（ID: {existing.id}），请在维护页编辑或删除后重传'
            )

        # 文件名净化 + 时间戳防冲突
        safe_stem = re.sub(r'[^A-Za-z0-9._-]', '_', os.path.splitext(raw_name)[0]) or 'package'
        store_name = f'{_GROUP_DIRS[group_key]}/{int(time.time())}_{safe_stem}{ext}'
        target = os.path.join(cls.downloads_root(), store_name)
        os.makedirs(os.path.dirname(target), exist_ok=True)

        # 分块写盘 + 累计大小 + 上限校验
        size = 0
        try:
            with open(target, 'wb') as f:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > _MAX_SIZE:
                        raise ServiceException(message='文件超过 500MB 上限')
                    f.write(chunk)
        except Exception:
            if os.path.exists(target):
                os.remove(target)
            raise

        item = DownloadItem(
            group_key=group_key,
            name=clean_name,
            version=clean_version,
            file_name=store_name,
            origin_name=raw_name,
            size_bytes=size,
            description=(description or '').strip() or None,
            tags=(tags or '').strip() or None,
            status=1,
            create_by=create_by,
        )
        item_id = await DownloadDao.add(db, item)
        await db.commit()
        logger.info(f'交付物上传成功：{name} v{version} → {store_name}（{size} 字节）')
        return item_id

    @classmethod
    async def update_item(cls, db: AsyncSession, item_id: int, model: DownloadUpdateModel, update_by: str | None) -> None:
        """编辑交付物元信息（不动磁盘文件）。"""
        item = await DownloadDao.get_by_id(db, item_id)
        if not item:
            raise ServiceException(message='交付物不存在')
        if model.group_key not in _GROUP_DIRS:
            raise ServiceException(message='类别不合法')
        item.name = model.name.strip()
        item.group_key = model.group_key
        item.version = (model.version or '').strip() or None
        item.description = (model.description or '').strip() or None
        item.tags = (model.tags or '').strip() or None
        item.status = model.status
        item.remark = (model.remark or '').strip() or None
        item.update_by = update_by
        await db.commit()

    @classmethod
    async def delete_item(cls, db: AsyncSession, item_id: int) -> None:
        """删除交付物：删库记录 + 删磁盘文件。"""
        item = await DownloadDao.get_by_id(db, item_id)
        if not item:
            raise ServiceException(message='交付物不存在')
        target = os.path.realpath(os.path.join(os.path.realpath(cls.downloads_root()), item.file_name))
        await DownloadDao.delete_by_id(db, item_id)
        await db.commit()
        try:
            if os.path.isfile(target) and target.startswith(os.path.realpath(cls.downloads_root()) + os.sep):
                os.remove(target)
        except OSError as e:
            logger.warning(f'交付物文件删除失败（记录已删）：{target} {e}')
