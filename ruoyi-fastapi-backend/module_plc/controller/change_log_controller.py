"""PLC 修改履历查询接口

提供 plc_change_log 表的查询操作，用于 Web 端查看设备/点位变更的历史记录。
"""
from typing import Annotated, Optional

from fastapi import Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from common.aspect.db_seesion import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.router import APIRouterPro
from common.vo import PageModel
from module_plc.entity.do.change_log_do import PlcChangeLog
from utils.page_util import PageUtil
from utils.response_util import ResponseUtil

change_log_controller = APIRouterPro(
    prefix='/plc/change-log', order_num=209, tags=['PLC修改履历'], dependencies=[PreAuthDependency()]
)


class ChangeLogPageQueryModel(BaseModel):
    """分页查询模型"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    page_num: int = Field(default=1, ge=1, description='当前页码')  # 🔧 Day9/P2-1
    page_size: int = Field(default=10, ge=1, le=500, description='每页记录数')  # 🔧 Day9/P2-1：防 pageSize=0 除零/超大全表
    target_type: Optional[str] = Field(default=None, description='对象类型（device/tag）')
    target_name: Optional[str] = Field(default=None, description='对象名称（模糊）')
    change_by: Optional[str] = Field(default=None, description='操作人（模糊）')
    change_type: Optional[str] = Field(default=None, description='操作类型（add/update/disable/delete/enable）')
    start_time: Optional[str] = Field(default=None, description='开始时间（YYYY-MM-DD）')
    end_time: Optional[str] = Field(default=None, description='结束时间（YYYY-MM-DD）')


@change_log_controller.get(
    '/list',
    summary='获取修改履历列表',
    description='返回设备/点位变更的历史记录（时间、操作人、对象类型、对象名称、操作类型、变更前后值）。',
    response_model=PageModel,
    dependencies=[UserInterfaceAuthDependency('plc:change-log:list')],
)
async def get_change_log_list(
    request: Request,
    page_query: Annotated[ChangeLogPageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """获取修改履历列表。"""
    from datetime import datetime
    query = select(PlcChangeLog)
    if page_query.target_type:
        query = query.where(PlcChangeLog.target_type == page_query.target_type)
    if page_query.target_name:
        query = query.where(PlcChangeLog.target_name.contains(page_query.target_name))
    if page_query.change_by:
        query = query.where(PlcChangeLog.change_by.contains(page_query.change_by))
    if page_query.change_type:
        query = query.where(PlcChangeLog.change_type == page_query.change_type)
    if page_query.start_time:
        start = datetime.strptime(page_query.start_time, '%Y-%m-%d')
        query = query.where(PlcChangeLog.change_time >= start)
    if page_query.end_time:
        end = datetime.strptime(page_query.end_time + ' 23:59:59', '%Y-%m-%d %H:%M:%S')
        query = query.where(PlcChangeLog.change_time <= end)
    query = query.order_by(PlcChangeLog.change_time.desc())
    result = await PageUtil.paginate(query_db, query, page_query.page_num, page_query.page_size, is_page=True)
    return ResponseUtil.success(model_content=result)
