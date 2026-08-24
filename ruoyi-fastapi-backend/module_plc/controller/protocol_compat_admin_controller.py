"""PLC 协议兼容映射管理接口

提供 plc_protocol_compat 表的 CRUD 操作，用于 Web 端维护品牌/系列/通信方式/寄存器类型映射。
"""
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
from module_plc.entity.do.protocol_compat_do import PlcProtocolCompat
from utils.page_util import PageUtil
from utils.response_util import ResponseUtil

protocol_compat_admin_controller = APIRouterPro(
    prefix='/plc/protocol-compat-admin', order_num=413, tags=['PLC协议兼容管理'], dependencies=[PreAuthDependency()]
)


class ProtocolCompatModel(BaseModel):
    """协议兼容映射模型"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None, description='ID')
    plc_brand: str = Field(description='PLC品牌')
    plc_series: str = Field(description='PLC系列')
    com_type: str = Field(description='通信方式')
    driver_code: str = Field(description='驱动编码')
    is_default_com_type: bool = Field(default=False, description='是否默认通信方式')
    register_type: str = Field(description='寄存器类型')
    register_type_label: Optional[str] = Field(default=None, description='寄存器类型标签')
    sort_order: int = Field(default=0, description='排序')


class ProtocolCompatPageQueryModel(BaseModel):
    """分页查询模型"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    page_num: int = Field(default=1, description='当前页码')
    page_size: int = Field(default=10, description='每页记录数')
    plc_brand: Optional[str] = Field(default=None, description='PLC品牌（模糊）')
    plc_series: Optional[str] = Field(default=None, description='PLC系列（模糊）')
    com_type: Optional[str] = Field(default=None, description='通信方式（模糊）')
    driver_code: Optional[str] = Field(default=None, description='驱动编码（模糊）')


@protocol_compat_admin_controller.get(
    '/list',
    summary='获取协议兼容映射列表',
    response_model=PageModel,
    dependencies=[UserInterfaceAuthDependency('plc:protocol-compat-admin:list')],
)
async def get_protocol_compat_admin_list(
    request: Request,
    page_query: Annotated[ProtocolCompatPageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """获取协议兼容映射列表。"""
    query = select(PlcProtocolCompat)
    if page_query.plc_brand:
        query = query.where(PlcProtocolCompat.plc_brand.contains(page_query.plc_brand))
    if page_query.plc_series:
        query = query.where(PlcProtocolCompat.plc_series.contains(page_query.plc_series))
    if page_query.com_type:
        query = query.where(PlcProtocolCompat.com_type.contains(page_query.com_type))
    if page_query.driver_code:
        query = query.where(PlcProtocolCompat.driver_code.contains(page_query.driver_code))
    query = query.order_by(PlcProtocolCompat.plc_brand, PlcProtocolCompat.plc_series, PlcProtocolCompat.sort_order)
    result = await PageUtil.paginate(query_db, query, page_query.page_num, page_query.page_size, is_page=True)
    return ResponseUtil.success(model_content=result)


@protocol_compat_admin_controller.post(
    '',
    summary='新增协议兼容映射',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:protocol-compat-admin:add')],
)
@Log(title='PLC协议兼容管理', business_type=BusinessType.INSERT)
async def add_protocol_compat_admin(
    request: Request,
    model: ProtocolCompatModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """新增协议兼容映射。"""
    # 校验唯一性（brand + series + com_type + register_type）
    result = await query_db.execute(
        select(PlcProtocolCompat).where(
            PlcProtocolCompat.plc_brand == model.plc_brand,
            PlcProtocolCompat.plc_series == model.plc_series,
            PlcProtocolCompat.com_type == model.com_type,
            PlcProtocolCompat.register_type == model.register_type,
        )
    )
    if result.scalar_one_or_none():
        raise ServiceException(message=f'映射已存在：{model.plc_brand}/{model.plc_series}/{model.com_type}/{model.register_type}')

    entity = PlcProtocolCompat(
        plc_brand=model.plc_brand,
        plc_series=model.plc_series,
        com_type=model.com_type,
        driver_code=model.driver_code,
        is_default_com_type=model.is_default_com_type,
        register_type=model.register_type,
        register_type_label=model.register_type_label,
        sort_order=model.sort_order,
    )
    query_db.add(entity)
    await query_db.commit()
    return ResponseUtil.success(msg='新增成功')


@protocol_compat_admin_controller.put(
    '',
    summary='编辑协议兼容映射',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:protocol-compat-admin:edit')],
)
@Log(title='PLC协议兼容管理', business_type=BusinessType.UPDATE)
async def update_protocol_compat_admin(
    request: Request,
    model: ProtocolCompatModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """编辑协议兼容映射。"""
    result = await query_db.execute(
        select(PlcProtocolCompat).where(PlcProtocolCompat.id == model.id)
    )
    entity = result.scalar_one_or_none()
    if not entity:
        raise ServiceException(message='映射不存在')

    # 校验唯一性（排除自身）
    result = await query_db.execute(
        select(PlcProtocolCompat).where(
            PlcProtocolCompat.plc_brand == model.plc_brand,
            PlcProtocolCompat.plc_series == model.plc_series,
            PlcProtocolCompat.com_type == model.com_type,
            PlcProtocolCompat.register_type == model.register_type,
            PlcProtocolCompat.id != model.id,
        )
    )
    if result.scalar_one_or_none():
        raise ServiceException(message=f'映射已存在：{model.plc_brand}/{model.plc_series}/{model.com_type}/{model.register_type}')

    entity.plc_brand = model.plc_brand
    entity.plc_series = model.plc_series
    entity.com_type = model.com_type
    entity.driver_code = model.driver_code
    entity.is_default_com_type = model.is_default_com_type
    entity.register_type = model.register_type
    entity.register_type_label = model.register_type_label
    entity.sort_order = model.sort_order
    await query_db.commit()
    return ResponseUtil.success(msg='编辑成功')


@protocol_compat_admin_controller.delete(
    '/{compat_ids}',
    summary='删除协议兼容映射',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:protocol-compat-admin:remove')],
)
@Log(title='PLC协议兼容管理', business_type=BusinessType.DELETE)
async def delete_protocol_compat_admin(
    request: Request,
    compat_ids: Annotated[str, Path(description='映射ID，多个用逗号分隔')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """删除协议兼容映射。"""
    from sqlalchemy import delete as sa_delete
    id_list = [int(x) for x in compat_ids.split(',') if x.strip()]
    if not id_list:
        raise ServiceException(message='传入为空')
    await query_db.execute(
        sa_delete(PlcProtocolCompat).where(PlcProtocolCompat.id.in_(id_list))
    )
    await query_db.commit()
    return ResponseUtil.success(msg='删除成功')
