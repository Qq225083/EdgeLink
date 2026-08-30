"""存量采集点健康监控 — Controller

与 V12 的「采集节点监控」完全独立：旧版 Node-RED 不做 JWT 登录、不经 MQTT，
仅凭登记时下发的一次性密钥（key）上报心跳。上报路由单独挂载、不启用 PreAuth，
用密钥哈希校验替代登录态。
"""
import time
from typing import Annotated, Optional

from fastapi import Path, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from common.annotation.log_annotation import Log
from common.aspect.db_seesion import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.enums import BusinessType
from common.router import APIRouterPro
from common.vo import CrudResponseModel, DataResponseModel, PageModel
from exceptions.exception import ServiceException
from module_site_health.entity.vo.site_health_vo import (
    SiteRegisterModel,
    SiteUpdateModel,
    SiteHealthPageQueryModel,
    SiteHeartbeatLogModel,
)
from module_site_health.service.site_health_service import SiteHealthService
from utils.response_util import ResponseUtil

# 管理端接口：需 JWT（PreAuth）+ 接口权限
site_health_controller = APIRouterPro(
    prefix='/site-health', order_num=208, tags=['存量采集点监控'], dependencies=[PreAuthDependency()]
)

# Node-RED 上报专用路由：无 PreAuth（旧版节点不做 JWT 登录），仅靠 key 校验 + IP 限流
site_health_report_controller = APIRouterPro(
    prefix='/site-health', order_num=209, tags=['存量采集点监控']
)

# 上报接口轻量内存限流（无新依赖），双层：
#   1) 按 IP 粗防泛洪（高阈值，不误伤「同一 IP 部署多个 Node-RED 实例」的场景）；
#   2) 按 key 精确限流（每个采集点独立配额，同 IP 多实例互不干扰）。
_RATE_BUCKETS: dict[str, list[float]] = {}
# 内存桶数量上限：超过后触发一次全量清理，驱逐已过期条目，防止字典无界增长（慢内存泄漏）
_RATE_MAX_BUCKETS = 10000
# 心跳正常频率 ≤ 6 次/分（最短 10s 间隔），key 配额放宽到 20/分，留出重试/突发余量
_REPORT_IP_LIMIT = 600
_REPORT_KEY_LIMIT = 20
_REPORT_WINDOW_S = 60


def _extract_bearer_key(request: Request) -> Optional[str]:
    """从 Authorization: Bearer 头读取 key（密钥不走 URL，避免落入反向代理访问日志）。"""
    auth = request.headers.get('authorization')
    if auth and auth.lower().startswith('bearer '):
        return auth[7:].strip()
    return None


def _prune_rate_buckets(now: float, window_s: int) -> None:
    """驱逐限流桶中已过期条目，把内存控制在 _RATE_MAX_BUCKETS 之内。"""
    for bucket_key in list(_RATE_BUCKETS.keys()):
        _RATE_BUCKETS[bucket_key] = [t for t in _RATE_BUCKETS[bucket_key] if now - t < window_s]
        if not _RATE_BUCKETS[bucket_key]:
            del _RATE_BUCKETS[bucket_key]


def _rate_limit(bucket_key: str, limit: int, window_s: int) -> None:
    """按桶 key 限流，超过 limit 次/窗口则抛 ServiceException。"""
    now = time.time()
    ts = [t for t in _RATE_BUCKETS.get(bucket_key, []) if now - t < window_s]
    if len(ts) >= limit:
        raise ServiceException(message='请求过于频繁，请稍后再试')
    ts.append(now)
    _RATE_BUCKETS[bucket_key] = ts
    if len(_RATE_BUCKETS) > _RATE_MAX_BUCKETS:
        _prune_rate_buckets(now, window_s)


def _check_report_rate_limit(request: Request, key: str) -> None:
    """报告接口限流：先按 IP 粗防泛洪，再按 key 精确限流（同 IP 多 Node-RED 实例互不干扰）。"""
    ip = request.client.host if request.client else 'unknown'
    _rate_limit(f'ip:{ip}', _REPORT_IP_LIMIT, _REPORT_WINDOW_S)
    if key:
        _rate_limit(f'key:{key}', _REPORT_KEY_LIMIT, _REPORT_WINDOW_S)


# ==================== 采集点登记 / 管理（前端） ====================

@site_health_controller.post(
    '/site',
    summary='登记采集点（生成唯一密钥）',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('site:health:add')],
)
@Log(title='存量采集点', business_type=BusinessType.INSERT)
async def register_site(
    request: Request,
    model: SiteRegisterModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """登记采集点，返回一次性密钥（明文仅此一次，请提示用户立即保存）。"""
    secret, site_id = await SiteHealthService.register_site(query_db, model)
    return ResponseUtil.success(msg='登记成功，密钥仅此一次显示，请立即保存', data={'siteId': site_id, 'key': secret})


@site_health_controller.get(
    '/site/list',
    summary='采集点列表（含在线状态与最新指标）',
    response_model=PageModel,
    dependencies=[UserInterfaceAuthDependency('site:health:list')],
)
async def get_site_list(
    request: Request,
    page_query: Annotated[SiteHealthPageQueryModel, Query()],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    result = await SiteHealthService.get_site_list(query_db, page_query)
    return ResponseUtil.success(model_content=result)


@site_health_controller.get(
    '/site/summary',
    summary='采集点状态统计（一览卡片）',
    response_model=DataResponseModel[dict],
    dependencies=[UserInterfaceAuthDependency('site:health:list')],
)
async def get_site_summary(
    request: Request,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    summary = await SiteHealthService.get_summary(query_db)
    return ResponseUtil.success(data=summary)


@site_health_controller.put(
    '/site/{site_id}',
    summary='编辑采集点情报（不动密钥）',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('site:health:edit')],
)
@Log(title='存量采集点', business_type=BusinessType.UPDATE)
async def update_site(
    request: Request,
    site_id: Annotated[int, Path(description='采集点ID')],
    model: SiteUpdateModel,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """编辑情报字段（办公/工业 IP、端口、场所、联系人、备注）；密钥只能走重置。"""
    await SiteHealthService.update_site(query_db, site_id, model)
    return ResponseUtil.success(msg='修改成功')


@site_health_controller.get(
    '/site/{site_id}/history',
    summary='采集点心跳履历',
    response_model=DataResponseModel[list[SiteHeartbeatLogModel]],
    dependencies=[UserInterfaceAuthDependency('site:health:list')],
)
async def get_site_history(
    request: Request,
    site_id: Annotated[int, Path(description='采集点ID')],
    limit: Annotated[int, Query(description='条数', ge=1, le=500)] = 200,
    offset: Annotated[int, Query(description='偏移（加载更多用）', ge=0)] = 0,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    rows = await SiteHealthService.get_history(query_db, site_id, limit, offset)
    return ResponseUtil.success(data=rows)


@site_health_controller.put(
    '/site/{site_id}/regenerate',
    summary='重新生成密钥',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('site:health:edit')],
)
@Log(title='存量采集点', business_type=BusinessType.UPDATE)
async def regenerate_site_key(
    request: Request,
    site_id: Annotated[int, Path(description='采集点ID')],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """重新生成密钥，旧密钥立即失效，返回新密钥明文（仅一次）。"""
    new_secret = await SiteHealthService.regenerate_key(query_db, site_id)
    return ResponseUtil.success(msg='密钥已重置，新密钥仅此一次显示，请立即保存', data={'key': new_secret})


@site_health_controller.put(
    '/site/{site_id}/status',
    summary='启用/停用采集点',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('site:health:edit')],
)
@Log(title='存量采集点', business_type=BusinessType.UPDATE)
async def toggle_site_status(
    request: Request,
    site_id: Annotated[int, Path(description='采集点ID')],
    enabled: Annotated[int, Query(description='0停用 1启用', ge=0, le=1)],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    await SiteHealthService.toggle_status(query_db, site_id, enabled)
    return ResponseUtil.success(msg='操作成功')


@site_health_controller.delete(
    '/site/{site_ids}',
    summary='删除采集点',
    response_model=CrudResponseModel,
    dependencies=[UserInterfaceAuthDependency('site:health:remove')],
)
@Log(title='存量采集点', business_type=BusinessType.DELETE)
async def delete_sites(
    request: Request,
    site_ids: Annotated[str, Path(description='采集点ID，多个用逗号分隔')],
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    id_list = [int(x) for x in site_ids.split(',') if x.strip()]
    await SiteHealthService.delete_sites(query_db, id_list)
    return ResponseUtil.success(msg='删除成功')


# ==================== Node-RED 心跳上报（无 JWT） ====================

@site_health_report_controller.post(
    '/report',
    summary='采集点心跳上报',
    description='旧版 Node-RED 健康监视节点定期上报（仅凭 key，无 JWT）。',
    response_model=DataResponseModel[dict],
)
async def report_heartbeat(
    request: Request,
    key: Annotated[Optional[str], Query(description='登记时生成的密钥（兼容保留，优先用 Authorization 头）')] = None,
    interval: Annotated[int, Query(description='心跳间隔秒（10-180）')] = 30,
    memory_rss_mb: Annotated[int, Query(description='Node进程内存MB', ge=0)] = 0,
    memory_total_mb: Annotated[int, Query(description='整机总内存MB', ge=0)] = 0,
    memory_free_mb: Annotated[int, Query(description='整机空闲内存MB', ge=0)] = 0,
    running_flows: Annotated[int, Query(description='运行流数量', ge=0)] = 0,
    node_red_version: Annotated[str, Query(description='Node-RED版本', max_length=50)] = '',
    uptime_sec: Annotated[int, Query(description='Node-RED运行时长秒', ge=0)] = 0,
    node_port: Annotated[int, Query(description='Node-RED监听端口（用于区分同 IP 多实例）', ge=0, le=65535)] = 0,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """心跳上报（key 校验 + IP/key 双层限流，无 JWT）。"""
    # 优先从 Authorization: Bearer 读取 key（不落 URL），query 参数仅作兼容保留
    bearer = _extract_bearer_key(request)
    if bearer:
        key = bearer
    _check_report_rate_limit(request, (key or '').strip())
    if not key or not key.strip():
        return ResponseUtil.success(
            msg='密钥无效', data={'ok': False, 'disabled': False, 'reason': 'invalid_key', 'message': '密钥不能为空'}
        )
    report_ip = request.client.host if request.client else ''
    result = await SiteHealthService.report_heartbeat(
        query_db,
        key=key.strip(),
        interval=interval,
        report_ip=report_ip,
        node_port=node_port,
        memory_rss_mb=memory_rss_mb,
        memory_total_mb=memory_total_mb,
        memory_free_mb=memory_free_mb,
        running_flows=running_flows,
        node_red_version=node_red_version,
        uptime_sec=uptime_sec,
    )
    return ResponseUtil.success(msg=result.get('message', '上报成功'), data=result)
