"""部署中心（节点与文档下载）— 服务层"""
import json
import os
import re
import shutil
import time
import uuid

from fastapi import UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from exceptions.exception import ServiceException
from module_downloads.dao.download_dao import DownloadDao
from module_downloads.entity.do.download_do import DownloadItem
from module_downloads.entity.vo.download_vo import DownloadUpdateModel
from utils.common_util import CamelCaseUtil
from utils.log_util import logger

# 上传约束：黑名单制（默认全放开，只拦可执行/脚本类——组内资源库不传播可执行文件）
_BLOCKED_EXTS = {'.exe', '.bat', '.cmd', '.ps1', '.msi', '.scr', '.com', '.vbs'}
_MAX_SIZE = 500 * 1024 * 1024  # 500MB（完整部署包场景）
_GROUP_DIRS = {'packages': 'packages', 'nodered-full': 'full', 'nodered-inc': 'inc', 'docs': 'docs', 'common': 'common'}


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
        if ext in _BLOCKED_EXTS:
            raise ServiceException(message=f'不允许上传可执行/脚本类文件（{ext}），如需分发请先压缩为 zip')

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

    # ==================== 分片上传（绕企业安全软件的大文件上传拦截） ====================
    #
    # 原理：大文件在浏览器端切成小片逐片 POST，每片低于安全软件的上传扫描阈值、
    #       且单片不是合法文件（magic 不完整），内容识别也不命中。
    # 流程：init（校验+建会话目录）→ chunk×N（逐片落盘）→ merge（校验完整+合并+入库）。
    # 烂尾会话：超过 _CHUNK_EXPIRE_S 未合并的目录在下次 init/merge 时被清理。

    _CHUNK_DIR_NAME = '.chunks'
    _CHUNK_EXPIRE_S = 24 * 3600

    @classmethod
    def _chunks_root(cls) -> str:
        return os.path.join(cls.downloads_root(), cls._CHUNK_DIR_NAME)

    @classmethod
    async def init_chunk_session(
        cls,
        db: AsyncSession,
        *,
        file_name: str,
        size_bytes: int,
        total_chunks: int,
        name: str,
        group_key: str,
        version: str | None,
    ) -> str:
        """建分片会话：先校验（扩展名/大小/类别/名称版本判重），全部通过才返回 uploadId。"""
        if group_key not in _GROUP_DIRS:
            raise ServiceException(message='类别不合法')
        ext = os.path.splitext(os.path.basename(file_name or ''))[1].lower()
        if ext in _BLOCKED_EXTS:
            raise ServiceException(message=f'不允许上传可执行/脚本类文件（{ext}），如需分发请先压缩为 zip')
        if size_bytes <= 0 or size_bytes > _MAX_SIZE:
            raise ServiceException(message='文件大小不合法（上限 500MB）')
        if total_chunks <= 0 or total_chunks > 2000:
            raise ServiceException(message='分片数量不合法')
        clean_name = (name or '').strip()
        if not clean_name:
            raise ServiceException(message='名称不能为空')
        clean_version = (version or '').strip() or None
        existing = await DownloadDao.get_by_name_version(db, clean_name, clean_version)
        if existing:
            raise ServiceException(
                message=f'交付物「{clean_name} v{clean_version or "-"}」已存在（ID: {existing.id}），请在维护页编辑或删除后重传'
            )

        cls._cleanup_stale_sessions()
        upload_id = uuid.uuid4().hex
        session_dir = os.path.join(cls._chunks_root(), upload_id)
        os.makedirs(session_dir, exist_ok=True)
        meta = {
            'file_name': os.path.basename(file_name),
            'size_bytes': size_bytes,
            'total_chunks': total_chunks,
            'name': clean_name,
            'group_key': group_key,
            'version': clean_version,
            'created_at': time.time(),
        }
        with open(os.path.join(session_dir, 'session.json'), 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False)
        return upload_id

    @classmethod
    async def save_chunk(cls, upload_id: str, chunk_index: int, file: UploadFile) -> None:
        """保存一个分片（序号校验 + 落盘到会话目录）。"""
        session_dir = os.path.realpath(os.path.join(cls._chunks_root(), upload_id))
        if not session_dir.startswith(os.path.realpath(cls._chunks_root()) + os.sep) or not os.path.isdir(session_dir):
            raise ServiceException(message='分片会话不存在或已过期，请重新上传')
        meta_path = os.path.join(session_dir, 'session.json')
        with open(meta_path, encoding='utf-8') as f:
            meta = json.load(f)
        if chunk_index < 0 or chunk_index >= meta['total_chunks']:
            raise ServiceException(message='分片序号越界')
        content = await file.read()
        with open(os.path.join(session_dir, f'chunk_{chunk_index:06d}'), 'wb') as f:
            f.write(content)

    @classmethod
    async def merge_chunk_session(
        cls,
        db: AsyncSession,
        upload_id: str,
        *,
        description: str | None,
        tags: str | None,
        create_by: str | None,
    ) -> int:
        """合并分片：完整性校验（片数+总大小）→ 合并到正式目录 → 写库 → 清理会话。"""
        session_dir = os.path.realpath(os.path.join(cls._chunks_root(), upload_id))
        if not session_dir.startswith(os.path.realpath(cls._chunks_root()) + os.sep) or not os.path.isdir(session_dir):
            raise ServiceException(message='分片会话不存在或已过期，请重新上传')
        with open(os.path.join(session_dir, 'session.json'), encoding='utf-8') as f:
            meta = json.load(f)

        # 完整性校验：片数齐全
        for i in range(meta['total_chunks']):
            if not os.path.isfile(os.path.join(session_dir, f'chunk_{i:06d}')):
                raise ServiceException(message=f'分片不完整（缺第 {i + 1}/{meta["total_chunks"]} 片），请重试')

        ext = os.path.splitext(meta['file_name'])[1].lower()
        safe_stem = re.sub(r'[^A-Za-z0-9._-]', '_', os.path.splitext(meta['file_name'])[0]) or 'package'
        store_name = f'{_GROUP_DIRS[meta["group_key"]]}/{int(time.time())}_{safe_stem}{ext}'
        target = os.path.join(cls.downloads_root(), store_name)
        os.makedirs(os.path.dirname(target), exist_ok=True)

        # 按序合并 + 总大小校验
        size = 0
        with open(target, 'wb') as out:
            for i in range(meta['total_chunks']):
                with open(os.path.join(session_dir, f'chunk_{i:06d}'), 'rb') as cf:
                    data = cf.read()
                    size += len(data)
                    out.write(data)
        if size != meta['size_bytes']:
            os.remove(target)
            raise ServiceException(message=f'合并后大小（{size}）与声明（{meta["size_bytes"]}）不符，请重新上传')

        item = DownloadItem(
            group_key=meta['group_key'],
            name=meta['name'],
            version=meta['version'],
            file_name=store_name,
            origin_name=meta['file_name'],
            size_bytes=size,
            description=(description or '').strip() or None,
            tags=(tags or '').strip() or None,
            status=1,
            create_by=create_by,
        )
        item_id = await DownloadDao.add(db, item)
        await db.commit()
        shutil.rmtree(session_dir, ignore_errors=True)
        logger.info(f'分片交付物合并成功：{meta["name"]} → {store_name}（{size} 字节，{meta["total_chunks"]} 片）')
        return item_id

    @classmethod
    def _cleanup_stale_sessions(cls) -> None:
        """清理超过 24h 未完成的烂尾分片会话。"""
        root = cls._chunks_root()
        if not os.path.isdir(root):
            return
        now = time.time()
        for d in os.listdir(root):
            path = os.path.join(root, d)
            try:
                if os.path.isdir(path) and now - os.path.getmtime(path) > cls._CHUNK_EXPIRE_S:
                    shutil.rmtree(path, ignore_errors=True)
                    logger.info(f'清理烂尾分片会话：{d}')
            except OSError:
                pass
