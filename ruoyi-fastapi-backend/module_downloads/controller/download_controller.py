"""部署中心（节点与文档下载）— Controller

下载视图（deploy:center:list）与交付物维护（deploy:center:edit）两级权限。
"""
from typing import Annotated, Optional

from fastapi import File, Form, Path, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from common.annotation.log_annotation import Log
from common.aspect.db_seesion import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.context import RequestContext
from common.enums import BusinessType
from common.router import APIRouterPro
from common.vo import CrudResponseModel, DataResponseModel
from module_downloads.entity.vo.download_vo import ChunkInitModel, ChunkMergeModel, DownloadQueryModel, DownloadUpdateModel
from module_downloads.service.download_service import DownloadService
from utils.response_util import ResponseUtil

download_controller = APIRouterPro(
    prefix='/common', order_num=17, tags=['部署中心'], dependencies=[PreAuthDependency()]
)


@download_controller.get(
    '/downloads/list',
    summary='交付物列表',
    response_model=DataResponseModel[list],
    dependencies=[UserInterfaceAuthDependency('deploy:center:list')],
)
async def get_download_list(
    request: Request,
    query: Annotated[DownloadQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    rows = await DownloadService.get_list(query_db, query.group, query.keyword, query.status)
    return ResponseUtil.success(data=rows)


@download_controller.get(
    '/download/package',
    summary='按 ID 下载交付物',
    response_class=FileResponse,
    dependencies=[UserInterfaceAuthDependency('deploy:center:list')],
)
async def download_package(
    request: Request,
    id: Annotated[int, Query(description='交付物ID', ge=1)],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    target, filename = await DownloadService.get_file_path(query_db, id)
    return FileResponse(path=target, filename=filename, media_type='application/octet-stream')


@download_controller.post(
    '/downloads/upload',
    summary='上传交付物',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('deploy:center:edit')],
)
@Log(title='部署中心', business_type=BusinessType.INSERT)
async def upload_download(
    request: Request,
    file: Annotated[UploadFile, File(description='交付物文件')],
    # 参数名避开 @Log 注解反射工具的 'name' 形参冲突：表单字段仍叫 name（alias 保持契约）
    item_name: Annotated[str, Form(max_length=100, alias='name')],
    groupKey: Annotated[str, Form(max_length=30)],
    version: Annotated[Optional[str], Form(max_length=20)] = None,
    description: Annotated[Optional[str], Form(max_length=500)] = None,
    tags: Annotated[Optional[str], Form(max_length=200)] = None,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    item_id = await DownloadService.upload(
        query_db,
        file=file,
        name=item_name,
        group_key=groupKey,
        version=version,
        description=description,
        tags=tags,
        create_by=RequestContext.get_current_user().user.user_name,
    )
    return ResponseUtil.success(msg='上传成功', data={'id': item_id})


@download_controller.put(
    '/downloads/{item_id}',
    summary='编辑交付物元信息',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('deploy:center:edit')],
)
@Log(title='部署中心', business_type=BusinessType.UPDATE)
async def update_download(
    request: Request,
    item_id: Annotated[int, Path(description='交付物ID')],
    model: DownloadUpdateModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    await DownloadService.update_item(query_db, item_id, model, update_by=RequestContext.get_current_user().user.user_name)
    return ResponseUtil.success(msg='修改成功')


@download_controller.delete(
    '/downloads/{item_id}',
    summary='删除交付物',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('deploy:center:edit')],
)
@Log(title='部署中心', business_type=BusinessType.DELETE)
async def delete_download(
    request: Request,
    item_id: Annotated[int, Path(description='交付物ID')],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    await DownloadService.delete_item(query_db, item_id)
    return ResponseUtil.success(msg='删除成功')


# ==================== 分片上传（大文件，绕企业安全软件上传拦截） ====================
# 流程：init 建会话 → chunk×N 逐片上传 → merge 校验合并入库。
# 注意：@Log 注解的参数反射工具不接受名为 name 的参数，Form 字段用 alias 保持契约。

@download_controller.post(
    '/downloads/upload/init',
    summary='分片上传：初始化会话',
    response_model=DataResponseModel[dict],
    dependencies=[UserInterfaceAuthDependency('deploy:center:edit')],
)
async def upload_chunk_init(
    request: Request,
    model: ChunkInitModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    upload_id = await DownloadService.init_chunk_session(
        query_db,
        file_name=model.file_name,
        size_bytes=model.size_bytes,
        total_chunks=model.total_chunks,
        name=model.name,
        group_key=model.group_key,
        version=model.version,
    )
    return ResponseUtil.success(data={'uploadId': upload_id})


@download_controller.post(
    '/downloads/upload/chunk',
    summary='分片上传：上传单片',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('deploy:center:edit')],
)
async def upload_chunk(
    request: Request,
    file: Annotated[UploadFile, File(description='分片数据')],
    uploadId: Annotated[str, Form(max_length=64)],
    chunkIndex: Annotated[int, Form(ge=0)],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    await DownloadService.save_chunk(uploadId, chunkIndex, file)
    return ResponseUtil.success(msg='分片已接收')


@download_controller.post(
    '/downloads/upload/merge',
    summary='分片上传：合并入库',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('deploy:center:edit')],
)
@Log(title='部署中心', business_type=BusinessType.INSERT)
async def upload_chunk_merge(
    request: Request,
    model: ChunkMergeModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    item_id = await DownloadService.merge_chunk_session(
        query_db,
        model.upload_id,
        description=model.description,
        tags=model.tags,
        create_by=RequestContext.get_current_user().user.user_name,
    )
    return ResponseUtil.success(msg='上传成功', data={'id': item_id})
