"""边缘节点密钥管理接口

提供 edge_bootstrap_key 表的 CRUD 操作，用于管理各采集节点的初始接入密钥。
"""
import secrets
from typing import Annotated, Optional

from fastapi import Path, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from common.annotation.log_annotation import Log
from common.aspect.db_seesion import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.enums import BusinessType
from common.router import APIRouterPro
from common.vo import CrudResponseModel, DataResponseModel, PageModel
from exceptions.exception import ServiceException
from module_plc.entity.do.bootstrap_key_do import EdgeBootstrapKey, hash_bootstrap_secret
from module_plc.mqtt.mqtt_consumer import get_notifier
from utils.log_util import logger
from utils.page_util import PageUtil
from utils.response_util import ResponseUtil

bootstrap_key_controller = APIRouterPro(
    prefix='/plc/bootstrap-key', order_num=207, tags=['边缘节点密钥管理'], dependencies=[PreAuthDependency()]
)

# 节点注册窗口的 Redis key（P0-2 整改：按压配对模式——仅窗口开启时 /auto 允许新节点注册）
REGISTER_WINDOW_KEY = 'edgelink:bootstrap:register_open'


@bootstrap_key_controller.post(
    '/registration-window',
    summary='开放新节点注册窗口（按压配对）',
    description='开放后指定分钟内允许新边缘节点经 /plc/config/bootstrap/auto 注册；默认 10 分钟自动关闭。',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:bootstrap-key:edit')],
)
async def open_registration_window(
    request: Request,
    minutes: Annotated[int, Query(description='开放时长（分钟，1-60）')] = 10,
) -> Response:
    """开放注册窗口。（不加 @Log：该切面要求被装饰函数带 DB session 参数，本端点只用 Redis；已用 logger 留痕）"""
    minutes = max(1, min(minutes, 60))
    await request.app.state.redis.set(REGISTER_WINDOW_KEY, '1', ex=minutes * 60)
    logger.info(f'[bootstrap] 新节点注册窗口已开放 {minutes} 分钟，操作人接口调用')
    return ResponseUtil.success(msg=f'注册窗口已开放，{minutes} 分钟后自动关闭')


@bootstrap_key_controller.get(
    '/registration-window',
    summary='查询注册窗口状态',
    response_model=DataResponseModel[dict],
    dependencies=[UserInterfaceAuthDependency('plc:bootstrap-key:list')],
)
async def get_registration_window(request: Request) -> Response:
    """查询注册窗口状态与剩余秒数。"""
    redis = request.app.state.redis
    open_flag = await redis.get(REGISTER_WINDOW_KEY)
    ttl = await redis.ttl(REGISTER_WINDOW_KEY) if open_flag else 0
    return ResponseUtil.success(data={'open': open_flag == '1', 'remainSeconds': max(ttl, 0)})


@bootstrap_key_controller.delete(
    '/registration-window',
    summary='立即关闭注册窗口',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:bootstrap-key:edit')],
)
async def close_registration_window(request: Request) -> Response:
    """立即关闭注册窗口。（不加 @Log：同上，本端点只用 Redis）"""
    await request.app.state.redis.delete(REGISTER_WINDOW_KEY)
    return ResponseUtil.success(msg='注册窗口已关闭')


class BootstrapKeyModel(BaseModel):
    """边缘节点密钥模型"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None, description='ID')
    node_key: str = Field(description='节点标识（如 pc-001）')
    node_name: Optional[str] = Field(default=None, description='节点名称')
    host_pc_ip: Optional[str] = Field(default=None, description='节点标识（IP:端口）')
    enabled: Optional[int] = Field(default=1, description='是否启用（0停用 1启用）')


class BootstrapKeyPageQueryModel(BaseModel):
    """分页查询模型"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    page_num: int = Field(default=1, description='当前页码')
    page_size: int = Field(default=10, description='每页记录数')
    node_key: Optional[str] = Field(default=None, description='节点标识（模糊）')
    node_name: Optional[str] = Field(default=None, description='节点名称（模糊）')
    enabled: Optional[int] = Field(default=None, description='是否启用')


@bootstrap_key_controller.get(
    '/list',
    summary='获取边缘节点密钥列表',
    response_model=PageModel,
    dependencies=[UserInterfaceAuthDependency('plc:bootstrap-key:list')],
)
async def get_bootstrap_key_list(
    request: Request,
    page_query: Annotated[BootstrapKeyPageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """获取边缘节点密钥列表。"""
    query = select(EdgeBootstrapKey)
    if page_query.node_key:
        query = query.where(EdgeBootstrapKey.node_key.contains(page_query.node_key))
    if page_query.node_name:
        query = query.where(EdgeBootstrapKey.node_name.contains(page_query.node_name))
    if page_query.enabled is not None:
        query = query.where(EdgeBootstrapKey.enabled == page_query.enabled)
    query = query.order_by(EdgeBootstrapKey.id)
    result = await PageUtil.paginate(query_db, query, page_query.page_num, page_query.page_size, is_page=True)
    # 🔧 密钥只存哈希，且列表不下发 secretKey 字段（明文仅创建/重置时返回一次）
    for row in result.rows:
        row.pop('secretKey', None)
    return ResponseUtil.success(model_content=result)


@bootstrap_key_controller.post(
    '',
    summary='新增边缘节点密钥',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:bootstrap-key:add')],
)
@Log(title='边缘节点密钥', business_type=BusinessType.INSERT)
async def add_bootstrap_key(
    request: Request,
    model: BootstrapKeyModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """新增边缘节点密钥。"""
    # 检查 node_key 唯一性
    result = await query_db.execute(
        select(EdgeBootstrapKey).where(EdgeBootstrapKey.node_key == model.node_key)
    )
    if result.scalar_one_or_none():
        raise ServiceException(message=f'节点标识已存在：{model.node_key}')

    # 检查 host_pc_ip 唯一性（非空时）
    if model.host_pc_ip:
        result = await query_db.execute(
            select(EdgeBootstrapKey).where(EdgeBootstrapKey.host_pc_ip == model.host_pc_ip)
        )
        if result.scalar_one_or_none():
            raise ServiceException(message=f'节点地址已被占用：{model.host_pc_ip}，一台 PC 的一个端口只能绑定一个节点')
    # 🔧 Day7/P1-6：禁止空 host_pc_ip（空 host 的 NODE_STATUS 会广播误伤全部节点）
    if not model.host_pc_ip or not model.host_pc_ip.strip():
        raise ServiceException(message='节点地址（IP:端口）不能为空，kill switch 定向依赖该字段')

    # 生成随机密钥（只存哈希；明文随响应返回一次，请提示用户保存）
    secret_key = secrets.token_hex(16)

    entity = EdgeBootstrapKey(
        node_key=model.node_key,
        node_name=model.node_name,
        host_pc_ip=model.host_pc_ip,
        secret_key=hash_bootstrap_secret(secret_key),
        enabled=model.enabled or 1,
    )
    query_db.add(entity)
    await query_db.commit()
    return ResponseUtil.success(msg='新增成功，密钥仅此一次显示，请立即保存', data={'secretKey': secret_key})


@bootstrap_key_controller.put(
    '',
    summary='编辑边缘节点密钥',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:bootstrap-key:edit')],
)
@Log(title='边缘节点密钥', business_type=BusinessType.UPDATE)
async def update_bootstrap_key(
    request: Request,
    model: BootstrapKeyModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """编辑边缘节点密钥。"""
    result = await query_db.execute(
        select(EdgeBootstrapKey).where(EdgeBootstrapKey.id == model.id)
    )
    entity = result.scalar_one_or_none()
    if not entity:
        raise ServiceException(message='节点不存在')

    # 检查 node_key 唯一性（排除自身）
    result = await query_db.execute(
        select(EdgeBootstrapKey).where(
            EdgeBootstrapKey.node_key == model.node_key,
            EdgeBootstrapKey.id != model.id,
        )
    )
    if result.scalar_one_or_none():
        raise ServiceException(message=f'节点标识已存在：{model.node_key}')

    # 检查 host_pc_ip 唯一性（排除自身，非空时）
    if model.host_pc_ip:
        result = await query_db.execute(
            select(EdgeBootstrapKey).where(
                EdgeBootstrapKey.host_pc_ip == model.host_pc_ip,
                EdgeBootstrapKey.id != model.id,
            )
        )
        if result.scalar_one_or_none():
            raise ServiceException(message=f'节点地址已被占用：{model.host_pc_ip}，一台 PC 的一个端口只能绑定一个节点')

    entity.node_key = model.node_key
    entity.node_name = model.node_name
    entity.host_pc_ip = model.host_pc_ip
    entity.enabled = model.enabled
    await query_db.commit()
    return ResponseUtil.success(msg='编辑成功')


@bootstrap_key_controller.put(
    '/status/{key_id}',
    summary='启用/禁用边缘节点密钥',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:bootstrap-key:edit')],
)
@Log(title='边缘节点密钥', business_type=BusinessType.UPDATE)
async def toggle_bootstrap_key_status(
    request: Request,
    key_id: Annotated[int, Path(description='密钥ID')],
    enabled: Annotated[int, Query(description='是否启用（0停用 1启用）')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """启用/禁用边缘节点密钥。"""
    result = await query_db.execute(
        select(EdgeBootstrapKey).where(EdgeBootstrapKey.id == key_id)
    )
    entity = result.scalar_one_or_none()
    if not entity:
        raise ServiceException(message='节点不存在')
    entity.enabled = enabled
    # 🔧 commit 会 expire ORM 对象：先取出后续要用的字段，避免 commit 后访问属性触发懒加载 MissingGreenlet
    notify_host_ip = entity.host_pc_ip or ''
    notify_node_name = entity.node_name or entity.node_key or ''
    await query_db.commit()
    # 🔧 节点停用/启用实时下发：边缘侧收到 NODE_STATUS 后立即停止/恢复采集（kill switch）
    # 🔧 Day7/P1-6：携带 node_id 精确定向（边缘优先按 node_id 匹配，空 host 广播已被边缘拦截）
    notify_node_id = 0
    if notify_host_ip:
        from module_plc.entity.do.monitor_do import NoderedNode
        node_result = await query_db.execute(
            select(NoderedNode.id).where(NoderedNode.host_pc_ip == notify_host_ip)
        )
        notify_node_id = node_result.scalar_one_or_none() or 0
    notifier = get_notifier()
    if notifier:
        try:
            await notifier.publish_notification(
                alert_type='NODE_STATUS',
                severity=1 if enabled == 0 else 3,
                node_id=notify_node_id,
                host_pc_ip=notify_host_ip,
                node_name=notify_node_name,
                alert_msg='disabled' if enabled == 0 else 'enabled',
            )
        except Exception as exc:
            logger.warning(f'节点状态通知发布失败（不影响停用操作本身）: {exc}')
    return ResponseUtil.success(msg='操作成功')


@bootstrap_key_controller.put(
    '/regenerate/{key_id}',
    summary='重新生成密钥',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:bootstrap-key:edit')],
)
@Log(title='边缘节点密钥', business_type=BusinessType.UPDATE)
async def regenerate_bootstrap_key(
    request: Request,
    key_id: Annotated[int, Path(description='密钥ID')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """重新生成密钥。"""
    result = await query_db.execute(
        select(EdgeBootstrapKey).where(EdgeBootstrapKey.id == key_id)
    )
    entity = result.scalar_one_or_none()
    if not entity:
        raise ServiceException(message='节点不存在')

    new_secret = secrets.token_hex(16)
    entity.secret_key = hash_bootstrap_secret(new_secret)
    await query_db.commit()
    return ResponseUtil.success(msg='密钥已重置，新密钥仅此一次显示，请立即保存', data={'secretKey': new_secret})


@bootstrap_key_controller.delete(
    '/{key_ids}',
    summary='删除边缘节点密钥',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('plc:bootstrap-key:remove')],
)
@Log(title='边缘节点密钥', business_type=BusinessType.DELETE)
async def delete_bootstrap_key(
    request: Request,
    key_ids: Annotated[str, Path(description='密钥ID，多个用逗号分隔')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """删除边缘节点密钥。"""
    id_list = [int(x) for x in key_ids.split(',') if x.strip()]
    if not id_list:
        raise ServiceException(message='传入为空')
    await query_db.execute(
        select(EdgeBootstrapKey).where(EdgeBootstrapKey.id.in_(id_list))
    )
    from sqlalchemy import delete as sa_delete
    await query_db.execute(
        sa_delete(EdgeBootstrapKey).where(EdgeBootstrapKey.id.in_(id_list))
    )
    await query_db.commit()
    return ResponseUtil.success(msg='删除成功')
