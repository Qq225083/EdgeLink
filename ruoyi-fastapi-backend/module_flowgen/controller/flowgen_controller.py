"""过渡版流程生成器 — Controller

M1：生成 / 列表 / 详情 / 下载。部署与回滚（Admin API 推送）在 M3。
"""
from typing import Annotated

from fastapi import Path, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from common.annotation.log_annotation import Log
from common.aspect.db_seesion import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.enums import BusinessType
from common.router import APIRouterPro
from common.vo import CrudResponseModel, DataResponseModel, PageModel
from exceptions.exception import ServiceException
from module_flowgen.dao.flowgen_dao import FlowgenDao
from module_flowgen.entity.vo.flowgen_vo import FlowGenerateModel, FlowReleasePageQueryModel
from module_flowgen.service.deploy_service import FlowDeployService
from module_flowgen.service.generator_service import FlowGeneratorService
from utils.response_util import ResponseUtil

flowgen_controller = APIRouterPro(
    prefix='/plc/flowgen', order_num=210, tags=['流程生成与发布'], dependencies=[PreAuthDependency()]
)


@flowgen_controller.post(
    '/generate',
    summary='生成流程版本（按当前配置快照）',
    response_model=DataResponseModel[dict],
    dependencies=[UserInterfaceAuthDependency('flow:release:generate')],
)
@Log(title='流程生成器', business_type=BusinessType.INSERT)
async def generate_flow(
    request: Request,
    model: FlowGenerateModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    gen_by = request.headers.get('x-user-name', '')
    result = await FlowGeneratorService.generate(query_db, model, gen_by=gen_by)
    msg = '生成成功' if result['created'] else '内容与最新版本一致，未重复建版'
    return ResponseUtil.success(msg=msg, data=result)


@flowgen_controller.get(
    '/release/list',
    summary='流程版本分页列表（不含 payload）',
    response_model=PageModel,
    dependencies=[UserInterfaceAuthDependency('flow:release:list')],
)
async def get_release_list(
    request: Request,
    page_query: Annotated[FlowReleasePageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    result = await FlowgenDao.get_release_page(query_db, page_query)
    return ResponseUtil.success(model_content=result)


@flowgen_controller.get(
    '/release/{release_id}',
    summary='流程版本详情（含 payload 全文）',
    response_model=DataResponseModel[dict],
    dependencies=[UserInterfaceAuthDependency('flow:release:list')],
)
async def get_release_detail(
    request: Request,
    release_id: Annotated[int, Path(description='流程版本ID')],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    release = await FlowgenDao.get_release_by_id(query_db, release_id)
    if not release:
        raise ServiceException(message='流程版本不存在')
    return ResponseUtil.success(
        data={
            'id': release.id,
            'siteId': release.site_id,
            'configVersion': release.config_version,
            'version': release.version,
            'payload': release.payload,
            'sha256': release.sha256,
            'deviceCount': release.device_count,
            'nodeCount': release.node_count,
            'status': release.status,
            'remark': release.remark,
            'createBy': release.create_by,
            'createTime': release.create_time.isoformat() if release.create_time else None,
        }
    )


@flowgen_controller.get(
    '/release/{release_id}/download',
    summary='下载 flows.json（手工导入场景）',
    dependencies=[UserInterfaceAuthDependency('flow:release:download')],
)
async def download_release(
    request: Request,
    release_id: Annotated[int, Path(description='流程版本ID')],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    release = await FlowgenDao.get_release_by_id(query_db, release_id)
    if not release:
        raise ServiceException(message='流程版本不存在')
    filename = f'flows_site{release.site_id}_v{release.version}.json'
    return Response(
        content=release.payload,
        media_type='application/json',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


@flowgen_controller.post(
    '/release/{release_id}/rollback',
    summary='回滚：以历史版本内容生成新版本（版本链只前进不后退）',
    response_model=DataResponseModel[dict],
    dependencies=[UserInterfaceAuthDependency('flow:release:generate')],
)
@Log(title='流程生成器', business_type=BusinessType.INSERT)
async def rollback_release(
    request: Request,
    release_id: Annotated[int, Path(description='回滚源版本ID')],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    gen_by = request.headers.get('x-user-name', '')
    result = await FlowGeneratorService.rollback(query_db, release_id, gen_by=gen_by)
    msg = f"已回滚为新版本 v{result['version']}" if result['created'] else '内容与最新版本一致，无需回滚'
    return ResponseUtil.success(msg=msg, data=result)


@flowgen_controller.post(
    '/release/{release_id}/deploy',
    summary='部署到边缘 Node-RED（Admin API 全量替换）',
    response_model=DataResponseModel[dict],
    dependencies=[UserInterfaceAuthDependency('flow:release:generate')],
)
@Log(title='流程生成器', business_type=BusinessType.UPDATE)
async def deploy_release(
    request: Request,
    release_id: Annotated[int, Path(description='部署的版本ID')],
    full_replace: Annotated[bool, Query(alias='fullReplace', description='true=全量清空替换（默认 false=只替换 GEN_ 生成标签页）')] = False,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    deploy_by = request.headers.get('x-user-name', '')
    result = await FlowDeployService.deploy_release(query_db, release_id, deploy_by=deploy_by, full_replace=full_replace)
    return ResponseUtil.success(msg=f"v{result['version']} 已部署到边缘", data=result)


@flowgen_controller.get(
    '/release/{release_id}/deploy-preview',
    summary='部署预览：将替换/摘除/新增/保留的标签页清单',
    response_model=DataResponseModel[dict],
    dependencies=[UserInterfaceAuthDependency('flow:release:list')],
)
async def get_deploy_preview(
    request: Request,
    release_id: Annotated[int, Path(description='版本ID')],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    result = await FlowDeployService.deploy_preview(query_db, release_id)
    return ResponseUtil.success(data=result)


@flowgen_controller.get(
    '/deploy/status',
    summary='边缘漂移检测：在跑画布 vs 最新版本（含节点包版本留痕）',
    response_model=DataResponseModel[dict],
    dependencies=[UserInterfaceAuthDependency('flow:release:list')],
)
async def get_deploy_status(
    request: Request,
    site_id: Annotated[int, Query(alias='siteId')],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    result = await FlowDeployService.drift_status(query_db, site_id)
    return ResponseUtil.success(data=result)


@flowgen_controller.post(
    '/snapshot',
    summary='手动备份边缘画布快照',
    response_model=DataResponseModel[dict],
    dependencies=[UserInterfaceAuthDependency('flow:release:generate')],
)
@Log(title='流程生成器', business_type=BusinessType.INSERT)
async def create_snapshot(
    request: Request,
    site_id: Annotated[int, Query(alias='siteId')],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    snap_id = await FlowDeployService.snapshot_canvas(
        query_db, site_id, source='manual', create_by=request.headers.get('x-user-name', '')
    )
    return ResponseUtil.success(msg='画布快照已保存', data={'snapshotId': snap_id})


@flowgen_controller.get(
    '/snapshot/list',
    summary='画布快照分页列表（不含 payload）',
    response_model=PageModel,
    dependencies=[UserInterfaceAuthDependency('flow:release:list')],
)
async def get_snapshot_list(
    request: Request,
    page_query: Annotated[FlowReleasePageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    result = await FlowgenDao.get_snapshot_page(query_db, page_query)
    return ResponseUtil.success(model_content=result)


@flowgen_controller.get(
    '/snapshot/{snapshot_id}/download',
    summary='下载画布快照 flows.json（误删/换机恢复用）',
    dependencies=[UserInterfaceAuthDependency('flow:release:download')],
)
async def download_snapshot(
    request: Request,
    snapshot_id: Annotated[int, Path(description='快照ID')],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    snap = await FlowgenDao.get_snapshot_by_id(query_db, snapshot_id)
    if not snap:
        raise ServiceException(message='快照不存在')
    filename = f'canvas_snapshot_site{snap.site_id}_{snap.id}.json'
    return Response(
        content=snap.payload,
        media_type='application/json',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )
