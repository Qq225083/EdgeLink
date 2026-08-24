"""PLC 发布履历查询接口

提供 plc_publish_log 表的查询操作，用于 Web 端查看每次配置下发的历史记录。
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
from module_plc.entity.do.publish_log_do import PlcPublishLog
from utils.page_util import PageUtil
from utils.response_util import ResponseUtil

publish_log_controller = APIRouterPro(
    prefix='/plc/publish-log', order_num=208, tags=['PLC发布履历'], dependencies=[PreAuthDependency()]
)


class PublishLogPageQueryModel(BaseModel):
    """分页查询模型"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    page_num: int = Field(default=1, ge=1, description='当前页码')  # 🔧 Day9/P2-1
    page_size: int = Field(default=10, ge=1, le=500, description='每页记录数')  # 🔧 Day9/P2-1：防 pageSize=0 除零/超大全表
    publish_by: Optional[str] = Field(default=None, description='发布人（模糊）')
    start_time: Optional[str] = Field(default=None, description='开始时间（YYYY-MM-DD）')
    end_time: Optional[str] = Field(default=None, description='结束时间（YYYY-MM-DD）')


@publish_log_controller.get(
    '/list',
    summary='获取发布履历列表',
    description='返回每次配置下发的历史记录（时间、发布人、影响设备数、影响节点数、发布内容）。',
    response_model=PageModel,
    dependencies=[UserInterfaceAuthDependency('plc:publish-log:list')],
)
async def get_publish_log_list(
    request: Request,
    page_query: Annotated[PublishLogPageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """获取发布履历列表。"""
    from datetime import datetime
    query = select(PlcPublishLog)
    if page_query.publish_by:
        query = query.where(PlcPublishLog.publish_by.contains(page_query.publish_by))
    if page_query.start_time:
        start = datetime.strptime(page_query.start_time, '%Y-%m-%d')
        query = query.where(PlcPublishLog.publish_time >= start)
    if page_query.end_time:
        end = datetime.strptime(page_query.end_time + ' 23:59:59', '%Y-%m-%d %H:%M:%S')
        query = query.where(PlcPublishLog.publish_time <= end)
    query = query.order_by(PlcPublishLog.publish_time.desc())
    result = await PageUtil.paginate(query_db, query, page_query.page_num, page_query.page_size, is_page=True)
    return ResponseUtil.success(model_content=result)
