from datetime import datetime
from typing import Annotated

from fastapi import File, Form, Path, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from common.annotation.log_annotation import Log
from common.aspect.db_seesion import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import CurrentUserDependency, PreAuthDependency
from common.enums import BusinessType
from common.router import APIRouterPro
from common.vo import DataResponseModel, PageResponseModel, ResponseBaseModel
from exceptions.exception import ServiceException
from module_admin.entity.vo.user_vo import CurrentUserModel
from module_plc.entity.vo.tag_vo import DeleteTagModel, TagBatchUpdateModel, TagImportResult, TagModel, TagPageQueryModel
from module_plc.service.tag_service import TagService
from utils.common_util import bytes2file_response
from utils.log_util import logger
from utils.response_util import ResponseUtil

# 创建点位管理路由
tag_controller = APIRouterPro(
    prefix='/plc/tag', order_num=201, tags=['PLC点位管理'], dependencies=[PreAuthDependency()]
)


# ==================== 静态路径路由 —— 必须定义在参数化路由之前 ====================

@tag_controller.get(
    '/template',
    summary='下载点位导入模板（Excel）',
    description='下载包含下拉校验（寄存器类型、数据类型）的Excel导入模板',
    response_class=StreamingResponse,
    responses={200: {'description': '流式返回点位模板Excel文件', 'content': {'application/octet-stream': {}}}},
    dependencies=[UserInterfaceAuthDependency('plc:tag:add')],
)
async def download_tag_template() -> Response:
    """下载点位导入模板Excel"""
    template_data = TagService.get_tag_template_services()
    logger.info('下载点位导入模板')
    return ResponseUtil.streaming(data=bytes2file_response(template_data))


@tag_controller.get(
    '/global/list',
    summary='跨设备点位全局查询',
    description='跨所有设备查询点位列表，支持按寄存器类型、地址、设备ID、设备名称筛选',
    response_model=PageResponseModel[TagModel],
    dependencies=[UserInterfaceAuthDependency('plc:tag:list')],
)
async def get_plc_tag_global_list(
    request: Request,
    tag_page_query: Annotated[TagPageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """跨设备全局查询点位列表"""
    # 兼容 Node-RED 侧的 snake_case 分页参数（FastAPI 查询参数按 alias 绑定 camelCase，
    # snake_case 默认被忽略——会导致边缘侧永远拿到第1页并无限翻页）
    qp = request.query_params
    try:
        if 'page_num' in qp:
            tag_page_query.page_num = max(1, int(qp['page_num']))
        if 'page_size' in qp:
            tag_page_query.page_size = min(max(1, int(qp['page_size'])), 5000)
    except ValueError:
        raise ServiceException(message='分页参数 page_num/page_size 格式不正确，必须为正整数')
    tag_page_query_result = await TagService.get_tag_global_list_services(
        query_db, tag_page_query, is_page=True
    )
    logger.info('获取全局点位列表成功')
    return ResponseUtil.success(model_content=tag_page_query_result)


@tag_controller.post(
    '/export',
    summary='导出点位列表（Excel）',
    description='导出当前筛选条件下的点位列表为Excel文件（含设备名称），支持按寄存器类型、地址、设备ID筛选',
    response_class=StreamingResponse,
    responses={200: {'description': '流式返回点位列表Excel文件', 'content': {'application/octet-stream': {}}}},
    dependencies=[UserInterfaceAuthDependency('plc:tag:list')],
)
@Log(title='PLC点位管理', business_type=BusinessType.EXPORT)
async def export_plc_tag_list(
    request: Request,
    tag_page_query: Annotated[TagPageQueryModel, Form()],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """导出点位列表为 Excel"""
    tag_export_result = await TagService.export_tag_list_services(query_db, tag_page_query)
    logger.info('导出PLC点位列表成功')
    return ResponseUtil.streaming(data=bytes2file_response(tag_export_result))


@tag_controller.post(
    '/import/{device_id}',
    summary='批量导入点位（Excel/JSON）',
    description='上传Excel或JSON文件批量导入点位到指定设备，返回结构化结果（成功数/失败数/失败明细）',
    response_model=DataResponseModel[TagImportResult],
    dependencies=[UserInterfaceAuthDependency('plc:tag:add')],
)
@Log(title='PLC点位管理', business_type=BusinessType.IMPORT)
async def import_plc_tags(
    request: Request,
    device_id: Annotated[int, Path(description='目标设备ID')],
    file: Annotated[UploadFile, File(description='Excel或JSON文件')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """批量导入点位（纯 openpyxl 解析，零 pandas 依赖）"""
    # 服务端扩展名校验
    filename = file.filename or ''
    if not filename.lower().endswith(('.xlsx', '.json')):
        raise ServiceException(message='仅支持 .xlsx 或 .json 文件')
    # 分块流式读取 + 10MB 硬上限，避免大文件一次性读入内存导致 OOM
    max_size = 10 * 1024 * 1024
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(1024 * 1024):
        total += len(chunk)
        if total > max_size:
            raise ServiceException(message='文件大小超过 10MB 限制')
        chunks.append(chunk)
    content = b''.join(chunks)
    if not content:
        raise ServiceException(message='文件内容为空')
    tag_list = TagService.parse_import_file(content, filename)
    if not tag_list:
        raise ServiceException(message='文件中未解析到任何点位数据')

    import_result = await TagService.import_tag_services(
        query_db, device_id, tag_list,
        create_by=current_user.user.user_name if current_user else '',
    )
    return ResponseUtil.success(data=import_result)


@tag_controller.put(
    '/batch',
    summary='批量更新点位',
    description='批量更新点位（支持同时修改寄存器类型、数据类型、单位、状态）',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:tag:edit')],
)
@Log(title='PLC点位管理', business_type=BusinessType.UPDATE)
async def batch_update_plc_tags(
    request: Request,
    batch_data: TagBatchUpdateModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """批量更新点位"""
    batch_result = await TagService.batch_update_tag_services(
        query_db, batch_data,
        update_by=current_user.user.user_name if current_user else '',
        update_time=datetime.now(),
    )
    logger.info(batch_result.message)
    return ResponseUtil.success(msg=batch_result.message)


@tag_controller.get(
    '/list/{device_id}',
    summary='获取指定设备的点位分页列表',
    description='根据设备ID获取该设备下所有未删除的采集点位分页列表',
    response_model=PageResponseModel[TagModel],
    dependencies=[UserInterfaceAuthDependency('plc:tag:list')],
)
async def get_plc_tag_list(
    request: Request,
    device_id: Annotated[int, Path(description='PLC设备ID')],
    tag_page_query: Annotated[TagPageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """分页查询指定设备的采集点位列表（仅返回del_flag='0'）"""
    tag_page_query_result = await TagService.get_tag_list_services(
        query_db, device_id, tag_page_query, is_page=True
    )
    logger.info(f'获取设备id={device_id}的点位列表成功')
    return ResponseUtil.success(model_content=tag_page_query_result)


@tag_controller.get(
    '/detail/{tag_id}',
    summary='获取PLC点位详情',
    description='获取指定未删除点位的详细信息',
    response_model=DataResponseModel[TagModel],
    dependencies=[UserInterfaceAuthDependency('plc:tag:list')],
)
async def get_plc_tag_detail(
    request: Request,
    tag_id: Annotated[int, Path(description='点位ID')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """查询单个点位详情"""
    tag_detail_result = await TagService.tag_detail_services(query_db, tag_id)
    logger.info(f'获取点位id={tag_id}的详情成功')
    return ResponseUtil.success(data=tag_detail_result)


@tag_controller.post(
    '',
    summary='新增PLC采集点位',
    description='新增PLC采集点位，自动校验寄存器类型和数据类型的有效性',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:tag:add')],
)
@Log(title='PLC点位管理', business_type=BusinessType.INSERT)
async def add_plc_tag(
    request: Request,
    add_tag: TagModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """新增PLC采集点位"""
    add_tag.create_by = current_user.user.user_name if current_user else ''
    add_tag.create_time = datetime.now()
    add_tag.update_by = current_user.user.user_name if current_user else ''
    add_tag.update_time = datetime.now()
    add_tag_result = await TagService.add_tag_services(query_db, add_tag)
    logger.info(add_tag_result.message)
    return ResponseUtil.success(msg=add_tag_result.message)


@tag_controller.put(
    '',
    summary='编辑PLC采集点位',
    description='编辑PLC采集点位信息，自动校验寄存器类型和数据类型的有效性',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:tag:edit')],
)
@Log(title='PLC点位管理', business_type=BusinessType.UPDATE)
async def edit_plc_tag(
    request: Request,
    edit_tag: TagModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """编辑PLC采集点位"""
    edit_tag.update_by = current_user.user.user_name if current_user else ''
    edit_tag.update_time = datetime.now()
    edit_tag_result = await TagService.edit_tag_services(query_db, edit_tag)
    logger.info(edit_tag_result.message)
    return ResponseUtil.success(msg=edit_tag_result.message)


# ==================== 参数化路由 —— 定义在静态路由之后 ====================

@tag_controller.put(
    '/status/{tag_id}',
    summary='切换点位启停状态',
    description='直接设置点位的启用/停用状态（status字段）',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:tag:edit')],
)
@Log(title='PLC点位管理', business_type=BusinessType.UPDATE)
async def toggle_tag_status(
    request: Request,
    tag_id: Annotated[int, Path(description='点位ID')],
    status: Annotated[str, Query(description='目标状态：0=启用 1=停用')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """切换点位状态"""
    await TagService.set_tag_status(
        query_db, tag_id, status,
        update_by=current_user.user.user_name if current_user else '',
        update_time=datetime.now(),
    )
    return ResponseUtil.success(msg='状态更新成功')


@tag_controller.put(
    '/disable/{tag_ids}',
    summary='停用PLC采集点位',
    description='停用PLC采集点位（设置status=1），Node-RED不再采集但仍可查看编辑。多个ID用逗号分隔',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:tag:remove')],
)
@Log(title='PLC点位管理', business_type=BusinessType.UPDATE)
async def disable_plc_tag(
    request: Request,
    tag_ids: Annotated[str, Path(description='需要停用的点位ID，多个用逗号分隔')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """停用PLC采集点位（设置status='1'，保留数据，Node-RED不再采集）"""
    disable_info = DeleteTagModel(ids=tag_ids)
    disable_result = await TagService.disable_tag_services(
        query_db, disable_info,
        update_by=current_user.user.user_name if current_user else '',
        update_time=datetime.now(),
    )
    logger.info(disable_result.message)
    return ResponseUtil.success(msg=disable_result.message)


@tag_controller.delete(
    '/{tag_ids}',
    summary='删除PLC采集点位（软删除）',
    description='软删除PLC采集点位（设置del_flag=2），数据不可恢复但保留在数据库中。多个ID用逗号分隔',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:tag:remove')],
)
@Log(title='PLC点位管理', business_type=BusinessType.DELETE)
async def delete_plc_tag(
    request: Request,
    tag_ids: Annotated[str, Path(description='需要删除的点位ID，多个用逗号分隔')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """软删除PLC采集点位（设置del_flag='2'）"""
    delete_info = DeleteTagModel(ids=tag_ids)
    delete_tag_result = await TagService.soft_delete_tag_services(
        query_db, delete_info,
        update_by=current_user.user.user_name if current_user else '',
        update_time=datetime.now(),
    )
    logger.info(delete_tag_result.message)
    return ResponseUtil.success(msg=delete_tag_result.message)
