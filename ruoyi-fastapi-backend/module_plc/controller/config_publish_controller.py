"""PLC 配置发布接口

提供手动触发配置下发到 Node-RED 采集节点的入口。
保存设备/点位变更不会自动生效，必须调用本接口进行发布。
"""
from typing import Annotated, Optional

from fastapi import Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from common.annotation.log_annotation import Log
from common.aspect.db_seesion import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import CurrentUserDependency, PreAuthDependency
from common.enums import BusinessType
from common.router import APIRouterPro
from common.vo import ResponseBaseModel
from module_admin.entity.vo.user_vo import CurrentUserModel
from module_plc.entity.vo.device_vo import PlcDevicePageQueryModel
from module_plc.service.config_publish_service import ConfigPublishService
from utils.response_util import ResponseUtil

config_publish_controller = APIRouterPro(
    prefix='/plc/config', order_num=205, tags=['PLC配置发布'], dependencies=[PreAuthDependency()]
)


class PublishConfigModel(BaseModel):
    """发布配置请求体"""
    device_ids: Optional[list[int]] = Field(
        default=None, description='可选：指定要发布的设备 ID 列表；不传则发布全部启用设备'
    )


@config_publish_controller.post(
    '/publish',
    summary='发布PLC配置到采集节点',
    description='手动触发：将当前数据库中的设备/点位配置通过 MQTT 通知下发到对应采集节点。'
                '保存变更不会自动生效，必须调用本接口发布。',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:publish:edit')],
)
@Log(title='PLC配置发布', business_type=BusinessType.UPDATE)
async def publish_plc_config(
    request: Request,
    publish_data: PublishConfigModel,
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """发布PLC配置。"""
    # 🔧 P1-15：request.state.user 从未被赋值（恒 None），改用 CurrentUserDependency 注入
    publish_by = current_user.user.user_name if current_user and current_user.user else None
    publish_result = await ConfigPublishService.publish_device_config(
        query_db, device_ids=publish_data.device_ids, publish_by=publish_by
    )
    node_count = len(publish_result['published_nodes'])
    device_count = publish_result['device_count']
    failed = publish_result['failed_devices']
    # 🔧 P0-3：如实反馈部分/全部失败，不再永远"成功"
    if publish_result['status'] == 'failed':
        msg = f'配置发布失败：{device_count} 台设备全部未送达（MQTT 未连接），边缘将在 30s 轮询后兜底同步'
    elif failed:
        msg = f'配置部分发布成功：{device_count - len(failed)}/{device_count} 台已通知，{len(failed)} 台未送达（详见 data.failedDevices）'
    else:
        msg = f'配置发布成功，已通知 {node_count} 个采集节点，涉及 {device_count} 台设备'
    return ResponseUtil.success(
        msg=msg,
        data={
            'status': publish_result['status'],
            'deviceCount': device_count,
            'nodeCount': node_count,
            'failedDevices': failed,
            'snapshotVersion': publish_result.get('snapshot_version'),
        },
    )


@config_publish_controller.get(
    '/publish/devices',
    summary='获取可发布设备列表',
    description='返回所有已启用、未删除且已绑定采集节点的设备，用于配置发布中心页面。',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:publish:list')],
)
async def get_publish_devices(
    request: Request,
    page_query: Annotated[PlcDevicePageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """获取可发布设备列表及全局统计。"""
    result = await ConfigPublishService.get_publish_device_list(query_db, page_query)
    return ResponseUtil.success(msg='获取成功', dict_content=result)


@config_publish_controller.get(
    '/snapshot/list',
    summary='获取最新已发布配置快照（边缘唯一配置拉取源）',
    description='发布即版本模型：Node-RED 周期性/收到发布通知后从这里拉取配置。'
                '只有点击发布后配置才固化进快照，数据库的未发布修改不会到达边缘。'
                '响应行结构与 /plc/tag/global/list 完全一致，分页行为相同。',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('plc:tag:list')],  # 边缘采集账号沿用点位读取权限，与旧拉取口一致
)
async def get_published_config_snapshot(
    request: Request,
    pageNum: Annotated[int, Query(description='页码')] = 1,
    pageSize: Annotated[int, Query(description='每页条数')] = 200,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """返回最新已发布配置快照（分页）。"""
    from common.vo import PageModel
    from module_plc.entity.do.config_snapshot_do import PlcConfigSnapshot
    from sqlalchemy import select

    result = await query_db.execute(select(PlcConfigSnapshot).order_by(PlcConfigSnapshot.id).limit(1))
    snap = result.scalars().first()
    payload = snap.payload if snap and snap.payload else []
    version = snap.version if snap else 0

    pageNum = max(1, pageNum)
    pageSize = min(max(1, pageSize), 5000)
    total = len(payload)
    start = (pageNum - 1) * pageSize
    page_rows = payload[start:start + pageSize]
    page = PageModel(
        rows=page_rows, total=total, pageNum=pageNum, pageSize=pageSize,
        hasNext=(start + pageSize) < total,
    )
    return ResponseUtil.success(
        msg='获取成功' if snap else '尚未发布过配置（快照为空）',
        model_content=page,
        dict_content={'snapshotVersion': version},
    )
