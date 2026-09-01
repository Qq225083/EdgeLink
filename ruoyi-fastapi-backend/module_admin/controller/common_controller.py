import os
from typing import Annotated

from fastapi import BackgroundTasks, File, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from common.aspect.pre_auth import PreAuthDependency
from common.router import APIRouterPro
from common.vo import DynamicResponseModel
from module_admin.entity.vo.common_vo import UploadResponseModel
from module_admin.service.common_service import CommonService
from utils.log_util import logger
from utils.response_util import ResponseUtil

common_controller = APIRouterPro(prefix='/common', order_num=16, tags=['通用模块'], dependencies=[PreAuthDependency()])


@common_controller.post(
    '/upload',
    summary='通用文件上传接口',
    description='用于上传文件',
    response_model=DynamicResponseModel[UploadResponseModel],
)
async def common_upload(request: Request, file: Annotated[UploadFile, File(...)]) -> Response:
    upload_result = await CommonService.upload_service(request, file)
    logger.info('上传成功')

    return ResponseUtil.success(model_content=upload_result.result)


@common_controller.get(
    '/download',
    summary='通用文件下载接口',
    description='用于下载下载目录中的文件',
    response_class=StreamingResponse,
    responses={
        200: {
            'description': '流式返回文件',
            'content': {
                'application/octet-stream': {},
            },
        }
    },
)
async def common_download(
    request: Request,
    background_tasks: BackgroundTasks,
    file_name: Annotated[str, Query(alias='fileName')],
    delete: Annotated[bool, Query()],
) -> Response:
    download_result = await CommonService.download_services(background_tasks, file_name, delete)
    logger.info(download_result.message)

    return ResponseUtil.streaming(data=download_result.result)


@common_controller.get(
    '/download/resource',
    summary='通用资源文件下载接口',
    description='用于下载上传目录中的资源文件',
    response_class=StreamingResponse,
    responses={
        200: {
            'description': '流式返回文件',
            'content': {
                'application/octet-stream': {},
            },
        }
    },
)
async def common_download_resource(request: Request, resource: Annotated[str, Query()]) -> Response:
    download_resource_result = await CommonService.download_resource_services(resource)
    logger.info(download_resource_result.message)

    return ResponseUtil.streaming(data=download_resource_result.result)


# ===== 存量监控节点包下载（采集登记页「采集节点部署」卡片使用） =====

@common_controller.get(
    '/download/site-health-node',
    summary='下载存量监控 Node-RED 节点包',
    description='返回 downloads 目录下的 node-red-contrib-edgelink-site-health.zip，供现场解压安装到 Node-RED 的 node_modules',
    response_class=FileResponse,
)
async def download_site_health_node(request: Request) -> Response:
    # 从本文件向上退 3 级：controller → module_admin → ruoyi-fastapi-backend
    backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    file_path = os.path.join(backend_dir, 'downloads', 'packages', 'node-red-contrib-edgelink-site-health.zip')
    if not os.path.exists(file_path):
        return {'code': 404, 'msg': '节点包文件不存在，请联系管理员'}
    return FileResponse(
        path=file_path,
        filename='node-red-contrib-edgelink-site-health.zip',
        media_type='application/zip',
    )


# 部署中心（交付物清单/下载/上传/维护）已由 module_downloads 模块接管，
# 此处的 manifest/package 临时接口已删除（避免与新模块路由冲突）。
