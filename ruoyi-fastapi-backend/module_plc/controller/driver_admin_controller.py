"""PLC 驱动元数据管理接口

提供 plc_driver 表的 CRUD 操作，用于 Web 端维护驱动元数据。
"""
import json
from typing import Annotated, Optional

from fastapi import Path, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from common.annotation.log_annotation import Log
from common.aspect.db_seesion import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.enums import BusinessType
from common.router import APIRouterPro
from common.vo import CrudResponseModel, PageModel
from exceptions.exception import ServiceException
from module_plc.entity.do.driver_do import PlcDriver
from utils.page_util import PageUtil
from utils.response_util import ResponseUtil

driver_admin_controller = APIRouterPro(
    prefix='/plc/driver-admin', order_num=412, tags=['PLC驱动管理'], dependencies=[PreAuthDependency()]
)


class DriverModel(BaseModel):
    """驱动元数据模型"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None, description='ID')
    driver_code: str = Field(description='驱动编码（如 mitsubishi_mc / modbus_tcp）')
    driver_name: str = Field(description='驱动显示名称')
    node_red_node_type: str = Field(description='Node-RED 节点类型名')
    config_schema: dict = Field(description='设备级协议参数 schema')
    register_types: list = Field(description='支持的寄存器类型')
    data_types: list = Field(description='支持的数据类型')
    address_pattern: Optional[str] = Field(default=None, description='寄存器地址校验正则')
    bit_offset_supported: bool = Field(default=False, description='是否支持位偏移')
    byte_order_supported: bool = Field(default=False, description='是否支持字节序')
    word_order_supported: bool = Field(default=False, description='是否支持字序')
    enabled: bool = Field(default=True, description='是否启用')
    schema_version: int = Field(default=1, description='schema 版本')
    sort_order: int = Field(default=0, description='排序')
    remark: Optional[str] = Field(default=None, description='备注')


class DriverPageQueryModel(BaseModel):
    """分页查询模型"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    page_num: int = Field(default=1, ge=1, description='当前页码')  # 🔧 Day9/P2-1
    page_size: int = Field(default=10, ge=1, le=500, description='每页记录数')  # 🔧 Day9/P2-1：防 pageSize=0 除零/超大全表
    driver_code: Optional[str] = Field(default=None, description='驱动编码（模糊）')
    driver_name: Optional[str] = Field(default=None, description='驱动名称（模糊）')
    enabled: Optional[bool] = Field(default=None, description='是否启用')


def _validate_driver_schema(config_schema: dict) -> None:
    """校验 config_schema 结构"""
    if not isinstance(config_schema, dict):
        raise ServiceException(message='config_schema 必须是 JSON 对象')
    fields = config_schema.get('fields')
    if not isinstance(fields, list):
        raise ServiceException(message='config_schema.fields 必须是数组')
    for field in fields:
        if not isinstance(field, dict):
            raise ServiceException(message='config_schema.fields 中的每个元素必须是对象')
        if not field.get('name') or not field.get('type') or not field.get('label'):
            raise ServiceException(message='config_schema.fields 中的每个元素必须包含 name、type、label')


def _validate_register_types(register_types: list, data_types: list) -> None:
    """校验 register_types 和 data_types 结构"""
    if not isinstance(register_types, list):
        raise ServiceException(message='register_types 必须是数组')
    if not isinstance(data_types, list):
        raise ServiceException(message='data_types 必须是数组')

    dt_values = {dt.get('value') for dt in data_types if isinstance(dt, dict)}
    for rt in register_types:
        if not isinstance(rt, dict):
            raise ServiceException(message='register_types 中的每个元素必须是对象')
        if not rt.get('value') or not rt.get('label'):
            raise ServiceException(message='register_types 中的每个元素必须包含 value 和 label')
        rt_data_types = rt.get('dataTypes', [])
        for dt in rt_data_types:
            if dt not in dt_values:
                raise ServiceException(message=f'register_types 中的 dataTypes "{dt}" 在 data_types 中不存在')


@driver_admin_controller.get(
    '/list',
    summary='获取驱动元数据列表',
    response_model=PageModel,
    dependencies=[UserInterfaceAuthDependency('plc:driver-admin:list')],
)
async def get_driver_admin_list(
    request: Request,
    page_query: Annotated[DriverPageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """获取驱动元数据列表。"""
    query = select(PlcDriver)
    if page_query.driver_code:
        query = query.where(PlcDriver.driver_code.contains(page_query.driver_code))
    if page_query.driver_name:
        query = query.where(PlcDriver.driver_name.contains(page_query.driver_name))
    if page_query.enabled is not None:
        query = query.where(PlcDriver.enabled == page_query.enabled)
    query = query.order_by(PlcDriver.sort_order, PlcDriver.id)
    result = await PageUtil.paginate(query_db, query, page_query.page_num, page_query.page_size, is_page=True)
    return ResponseUtil.success(model_content=result)


@driver_admin_controller.post(
    '',
    summary='新增驱动元数据',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:driver-admin:add')],
)
@Log(title='PLC驱动管理', business_type=BusinessType.INSERT)
async def add_driver_admin(
    request: Request,
    model: DriverModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """新增驱动元数据。"""
    # 校验 driver_code 唯一性
    result = await query_db.execute(
        select(PlcDriver).where(PlcDriver.driver_code == model.driver_code)
    )
    if result.scalar_one_or_none():
        raise ServiceException(message=f'驱动编码已存在：{model.driver_code}')

    # 校验 schema 结构
    _validate_driver_schema(model.config_schema)
    _validate_register_types(model.register_types, model.data_types)

    entity = PlcDriver(
        driver_code=model.driver_code,
        driver_name=model.driver_name,
        node_red_node_type=model.node_red_node_type,
        config_schema=model.config_schema,
        register_types=model.register_types,
        data_types=model.data_types,
        address_pattern=model.address_pattern,
        bit_offset_supported=model.bit_offset_supported,
        byte_order_supported=model.byte_order_supported,
        word_order_supported=model.word_order_supported,
        enabled=model.enabled,
        schema_version=model.schema_version,
        sort_order=model.sort_order,
        remark=model.remark,
    )
    query_db.add(entity)
    await query_db.commit()
    return ResponseUtil.success(msg='新增成功')


@driver_admin_controller.put(
    '',
    summary='编辑驱动元数据',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:driver-admin:edit')],
)
@Log(title='PLC驱动管理', business_type=BusinessType.UPDATE)
async def update_driver_admin(
    request: Request,
    model: DriverModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """编辑驱动元数据。"""
    result = await query_db.execute(
        select(PlcDriver).where(PlcDriver.id == model.id)
    )
    entity = result.scalar_one_or_none()
    if not entity:
        raise ServiceException(message='驱动不存在')

    # 校验 driver_code 唯一性（排除自身）
    result = await query_db.execute(
        select(PlcDriver).where(
            PlcDriver.driver_code == model.driver_code,
            PlcDriver.id != model.id,
        )
    )
    if result.scalar_one_or_none():
        raise ServiceException(message=f'驱动编码已存在：{model.driver_code}')

    # 校验 schema 结构
    _validate_driver_schema(model.config_schema)
    _validate_register_types(model.register_types, model.data_types)

    entity.driver_code = model.driver_code
    entity.driver_name = model.driver_name
    entity.node_red_node_type = model.node_red_node_type
    entity.config_schema = model.config_schema
    entity.register_types = model.register_types
    entity.data_types = model.data_types
    entity.address_pattern = model.address_pattern
    entity.bit_offset_supported = model.bit_offset_supported
    entity.byte_order_supported = model.byte_order_supported
    entity.word_order_supported = model.word_order_supported
    entity.enabled = model.enabled
    entity.schema_version = model.schema_version
    entity.sort_order = model.sort_order
    entity.remark = model.remark
    await query_db.commit()
    return ResponseUtil.success(msg='编辑成功')


@driver_admin_controller.put(
    '/status/{driver_id}',
    summary='启用/禁用驱动',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:driver-admin:edit')],
)
@Log(title='PLC驱动管理', business_type=BusinessType.UPDATE)
async def toggle_driver_admin_status(
    request: Request,
    driver_id: Annotated[int, Path(description='驱动ID')],
    enabled: Annotated[bool, Query(description='是否启用')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """启用/禁用驱动。"""
    result = await query_db.execute(
        select(PlcDriver).where(PlcDriver.id == driver_id)
    )
    entity = result.scalar_one_or_none()
    if not entity:
        raise ServiceException(message='驱动不存在')
    entity.enabled = enabled
    await query_db.commit()
    return ResponseUtil.success(msg='操作成功')


@driver_admin_controller.delete(
    '/{driver_ids}',
    summary='删除驱动元数据',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:driver-admin:remove')],
)
@Log(title='PLC驱动管理', business_type=BusinessType.DELETE)
async def delete_driver_admin(
    request: Request,
    driver_ids: Annotated[str, Path(description='驱动ID，多个用逗号分隔')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """删除驱动元数据。"""
    from sqlalchemy import delete as sa_delete
    id_list = [int(x) for x in driver_ids.split(',') if x.strip()]
    if not id_list:
        raise ServiceException(message='传入为空')

    # 检查是否有设备引用
    from module_plc.entity.do.device_do import PlcDevice
    result = await query_db.execute(
        select(func.count(PlcDevice.id)).where(
            PlcDevice.driver_code.in_(
                select(PlcDriver.driver_code).where(PlcDriver.id.in_(id_list))
            ),
            PlcDevice.del_flag == '0',
        )
    )
    device_count = result.scalar() or 0
    if device_count > 0:
        raise ServiceException(message=f'有 {device_count} 台设备正在使用这些驱动，无法删除')

    await query_db.execute(
        sa_delete(PlcDriver).where(PlcDriver.id.in_(id_list))
    )
    await query_db.commit()
    return ResponseUtil.success(msg='删除成功')
