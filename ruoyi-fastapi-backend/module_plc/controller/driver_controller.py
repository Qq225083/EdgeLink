"""PLC 驱动元数据接口

提供动态驱动能力查询：
  - /plc/driver/list        列出所有可用驱动
  - /plc/driver/{driver_code}/schema  获取驱动 schema（前端动态渲染、Node-RED 分发）
"""

from typing import Annotated, Any

from fastapi import Path, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from common.aspect.db_seesion import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.router import APIRouterPro
from common.vo import DataResponseModel
from module_plc.service.driver_service import DriverService
from utils.response_util import ResponseUtil

driver_controller = APIRouterPro(
    prefix='/plc/driver', order_num=411, tags=['PLC驱动'], dependencies=[PreAuthDependency()]
)


@driver_controller.get(
    '/list',
    summary='列出所有可用驱动',
    description='返回驱动编码、显示名称、Node-RED 节点类型及能力标识（是否支持位偏移/字节序/字序）。',
    response_model=DataResponseModel[list[dict[str, Any]]],
    dependencies=[UserInterfaceAuthDependency('plc:driver:list')],
)
async def get_driver_list(
    request: Request,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """列出所有启用的驱动元数据。"""
    data = await DriverService.list_drivers(query_db)
    return ResponseUtil.success(data=data)


@driver_controller.get(
    '/{driver_code}/schema',
    summary='获取驱动 schema',
    description='返回指定驱动的配置参数 schema、寄存器类型、数据类型、地址校验规则。前端据此动态渲染设备/点位表单。',
    response_model=DataResponseModel[dict[str, Any]],
    dependencies=[UserInterfaceAuthDependency('plc:driver:list')],
)
async def get_driver_schema(
    request: Request,
    driver_code: Annotated[str, Path(description='驱动编码，如 mitsubishi_mc / modbus_tcp')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """获取指定驱动的完整 schema。"""
    schema = await DriverService.get_driver_schema(query_db, driver_code)
    return ResponseUtil.success(data=schema)
