from datetime import datetime
from typing import Annotated

from fastapi import Form, Path, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from common.annotation.log_annotation import Log
from common.aspect.db_seesion import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import CurrentUserDependency, PreAuthDependency
from common.enums import BusinessType
from common.router import APIRouterPro
from common.vo import DataResponseModel, PageResponseModel, ResponseBaseModel
from module_admin.entity.vo.user_vo import CurrentUserModel
from module_plc.entity.vo.device_vo import (
    DeletePlcDeviceModel,
    PlcDeviceModel,
    PlcDevicePageQueryModel,
)
from module_plc.service.device_service import DeviceService
from utils.common_util import bytes2file_response
from utils.log_util import logger
from utils.response_util import ResponseUtil

# 创建设备管理路由
device_controller = APIRouterPro(
    prefix='/plc/device', order_num=200, tags=['PLC设备管理'], dependencies=[PreAuthDependency()]
)


@device_controller.get(
    '/list',
    summary='获取PLC设备分页列表',
    description='用于获取未删除的PLC设备分页列表，支持按设备名称（模糊）、IP（精确）、状态、品牌筛选',
    response_model=PageResponseModel[PlcDeviceModel],
    dependencies=[UserInterfaceAuthDependency('plc:device:list')],
)
async def get_plc_device_list(
    request: Request,
    device_page_query: Annotated[PlcDevicePageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """分页查询PLC设备列表（仅返回del_flag='0'的记录）"""
    device_page_query_result = await DeviceService.get_device_list_services(
        query_db, device_page_query, is_page=True
    )
    logger.info('获取PLC设备列表成功')
    return ResponseUtil.success(model_content=device_page_query_result)


@device_controller.get(
    '/{device_id}',
    summary='获取PLC设备详情',
    description='获取指定PLC设备的详细信息，包含该设备下所有未删除的采集点位',
    response_model=DataResponseModel[PlcDeviceModel],
    dependencies=[UserInterfaceAuthDependency('plc:device:list')],
)
async def get_plc_device_detail(
    request: Request,
    device_id: Annotated[int, Path(description='PLC设备ID')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """查询单个PLC设备详情（含点位明细）"""
    device_detail_result = await DeviceService.device_detail_services(query_db, device_id)
    logger.info(f'获取PLC设备id={device_id}的详情成功')
    return ResponseUtil.success(data=device_detail_result)


@device_controller.post(
    '',
    summary='新增PLC设备',
    description='新增PLC设备，自动校验IP格式、端口范围、系列与帧格式兼容性',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:device:add')],
)
@Log(title='PLC设备管理', business_type=BusinessType.INSERT)
async def add_plc_device(
    request: Request,
    add_device: PlcDeviceModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """新增PLC设备"""
    add_device.create_by = current_user.user.user_name if current_user else ''
    add_device.create_time = datetime.now()
    add_device.update_by = current_user.user.user_name if current_user else ''
    add_device.update_time = datetime.now()
    add_device_result = await DeviceService.add_device_services(query_db, add_device)
    logger.info(add_device_result.message)
    return ResponseUtil.success(msg=add_device_result.message)


@device_controller.put(
    '',
    summary='编辑PLC设备',
    description='编辑PLC设备信息，自动校验IP格式、端口范围、系列与帧格式兼容性',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:device:edit')],
)
@Log(title='PLC设备管理', business_type=BusinessType.UPDATE)
async def edit_plc_device(
    request: Request,
    edit_device: PlcDeviceModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """编辑PLC设备"""
    edit_device.update_by = current_user.user.user_name if current_user else ''
    edit_device.update_time = datetime.now()
    edit_device_result = await DeviceService.edit_device_services(query_db, edit_device)
    logger.info(edit_device_result.message)
    return ResponseUtil.success(msg=edit_device_result.message)


@device_controller.put(
    '/disable/{device_ids}',
    summary='停用PLC设备',
    description='停用PLC设备（设置status=1），Node-RED停止采集但数据保留可见。多个ID用逗号分隔',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:device:remove')],
)
@Log(title='PLC设备管理', business_type=BusinessType.UPDATE)
async def disable_plc_device(
    request: Request,
    device_ids: Annotated[str, Path(description='需要停用的设备ID，多个用逗号分隔')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """停用PLC设备（设置status='1'，Node-RED 不再采集）"""
    disable_info = DeletePlcDeviceModel(ids=device_ids)
    disable_result = await DeviceService.disable_device_services(
        query_db, disable_info,
        update_by=current_user.user.user_name if current_user else '',
        update_time=datetime.now(),
    )
    logger.info(disable_result.message)
    return ResponseUtil.success(msg=disable_result.message)


@device_controller.put(
    '/status/{device_id}',
    summary='切换设备启停状态',
    description='直接设置设备的启用/停用状态（status字段）',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:device:edit')],
)
@Log(title='PLC设备管理', business_type=BusinessType.UPDATE)
async def toggle_device_status(
    request: Request,
    device_id: Annotated[int, Path(description='设备ID')],
    status: Annotated[str, Query(description='目标状态：0=启用 1=停用')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """切换设备状态"""
    await DeviceService.set_device_status(
        query_db, device_id, status,
        update_by=current_user.user.user_name if current_user else '',
        update_time=datetime.now(),
    )
    return ResponseUtil.success(msg='状态更新成功')


@device_controller.delete(
    '/{device_ids}',
    summary='删除PLC设备（软删除）',
    description='软删除PLC设备（设置del_flag=2），同时软删除其下所有点位。数据不可恢复但保留在数据库中。多个ID用逗号分隔',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:device:remove')],
)
@Log(title='PLC设备管理', business_type=BusinessType.DELETE)
async def delete_plc_device(
    request: Request,
    device_ids: Annotated[str, Path(description='需要删除的设备ID，多个用逗号分隔')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """软删除PLC设备（设置del_flag='2'）"""
    delete_info = DeletePlcDeviceModel(ids=device_ids)
    delete_device_result = await DeviceService.soft_delete_device_services(
        query_db, delete_info,
        update_by=current_user.user.user_name if current_user else '',
        update_time=datetime.now(),
    )
    logger.info(delete_device_result.message)
    return ResponseUtil.success(msg=delete_device_result.message)


# ==================== 克隆 & 导出 ====================

@device_controller.post(
    '/clone/{device_id}',
    summary='克隆PLC设备',
    description='复制指定设备及其所有未删除点位，需提供新设备名称、编号和IP',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:device:add')],
)
@Log(title='PLC设备管理', business_type=BusinessType.INSERT)
async def clone_plc_device(
    request: Request,
    device_id: Annotated[int, Path(description='源设备ID')],
    new_device_name: Annotated[str, Query(description='新设备名称')],
    new_device_code: Annotated[str, Query(description='新设备编号')],
    new_plc_ip: Annotated[str, Query(description='新设备IP')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    """克隆PLC设备：复制设备 + 全部点位"""
    clone_result = await DeviceService.clone_device_services(
        query_db, device_id, new_device_name, new_device_code, new_plc_ip,
        create_by=current_user.user.user_name if current_user else '',
    )
    logger.info(clone_result.message)
    return ResponseUtil.success(msg=clone_result.message)


@device_controller.post(
    '/export',
    summary='导出PLC设备列表（Excel）',
    description='导出当前筛选条件下的PLC设备列表为Excel文件',
    response_class=StreamingResponse,
    responses={200: {'description': '流式返回设备列表Excel文件', 'content': {'application/octet-stream': {}}}},
    dependencies=[UserInterfaceAuthDependency('plc:device:list')],
)
@Log(title='PLC设备管理', business_type=BusinessType.EXPORT)
async def export_plc_device_list(
    request: Request,
    device_page_query: Annotated[PlcDevicePageQueryModel, Form()],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """导出PLC设备列表"""
    device_export_result = await DeviceService.export_device_list_services(query_db, device_page_query)
    logger.info('导出PLC设备列表成功')
    return ResponseUtil.streaming(data=bytes2file_response(device_export_result))
