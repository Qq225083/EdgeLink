"""监控中心 — Controller"""
from typing import Annotated, Optional

from fastapi import Header, Path, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from common.aspect.db_seesion import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.router import APIRouterPro
from common.vo import DataResponseModel, ResponseBaseModel
from config.env import AppConfig
from exceptions.exception import AuthException, ServiceException
from module_plc.entity.vo.monitor_vo import (
    NoderedNodeModel, MonitorAlertModel, KpiDashboardModel
)
from module_plc.dao.monitor_dao import MonitorDao
from module_plc.service.device_service import DeviceService
from module_plc.service.monitor_service import MonitorService
from utils.log_util import logger
from utils.response_util import ResponseUtil

monitor_controller = APIRouterPro(
    prefix='/monitor', order_num=300, tags=['采集节点监控'], dependencies=[PreAuthDependency()]
)


# ==================== Node-RED 上报专用 API Key 鉴权 ====================

async def _verify_monitor_api_key(request: Request) -> None:
    """Node-RED 上报接口的 API Key 校验。

    从 Request 直接读取 Header。生产环境 MONITOR_API_KEY 必须非空，
    否则启动时会因 pydantic 校验失败。
    """
    x_api_key = request.headers.get('X-API-Key')
    configured_key = AppConfig.monitor_api_key
    if not x_api_key or x_api_key != configured_key:
        raise AuthException(message='API Key 无效，Node-RED 上报接口需要有效的 X-API-Key')


# ==================== Node-RED 上报接口（API Key + PreAuth 双重保护） ====================

@monitor_controller.post(
    '/heartbeat',
    summary='Node-RED 心跳上报',
    description='采集节点的 Node-RED 每30秒上报一次心跳（需 X-API-Key + JWT）',
    response_model=ResponseBaseModel,
    dependencies=[PreAuthDependency()],
)
async def heartbeat_report(
    request: Request,
    host_pc_ip: Annotated[str, Query(description='本机节点标识（IP 或 IP:端口）')],
    node_ip: Annotated[str, Query(description='上报IP', max_length=20)] = '',  # 🔧 Day9/P2-5：超长防 DataError（indust_net_ip String(20)）
    running_flows: Annotated[int, Query(description='运行流数量', ge=0)] = 0,
    memory_usage_mb: Annotated[int, Query(description='内存占用MB', ge=0)] = 0,
    pg_success_count: Annotated[int, Query(description='PG累计写入成功条数', ge=0)] = 0,
    pg_fail_count: Annotated[int, Query(description='PG累计写入失败条数', ge=0)] = 0,
    spool_bytes: Annotated[int, Query(description='磁盘spool积压字节数', ge=0)] = 0,
    config_version: Annotated[Optional[int], Query(description='边缘已应用的配置快照版本（旧边缘不上报）', ge=0)] = None,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """Node-RED 心跳上报（自动注册新节点 + 检测离线/恢复）"""
    await _verify_monitor_api_key(request)
    # 校验 host_pc_ip 格式（IP 或 IP:端口），防止非法/空值写入 nodered_node 造成节点混乱
    if not host_pc_ip or not host_pc_ip.strip():
        raise ServiceException(message='host_pc_ip 不能为空')
    DeviceService._validate_ip(host_pc_ip.strip(), allow_port=True)
    node_id, is_new = await MonitorDao.upsert_heartbeat(
        query_db, host_pc_ip=host_pc_ip.strip(), node_ip=node_ip,
        running_flows=running_flows, memory_usage_mb=memory_usage_mb,
        pg_success_count=pg_success_count, pg_fail_count=pg_fail_count,
        spool_bytes=spool_bytes, config_version=config_version,
    )
    if is_new:
        logger.info(f'新采集节点自动注册: {host_pc_ip} → node_id={node_id}')
    if node_id:
        # 心跳到达即在线 → 消除离线告警
        await MonitorDao.resolve_alert(query_db, 'NODE_OFFLINE', node_id=node_id, device_id=0)
    # 🔧 Day7/P1-6：kill switch 轮询兜底——心跳响应携带密钥停用标志，边缘每周期比对
    from module_plc.entity.do.bootstrap_key_do import EdgeBootstrapKey
    from sqlalchemy import select as _select
    key_result = await query_db.execute(
        _select(EdgeBootstrapKey.enabled).where(EdgeBootstrapKey.host_pc_ip == host_pc_ip.strip())
    )
    key_enabled = key_result.scalar_one_or_none()
    node_disabled = (key_enabled == 0)
    # 关键：提交事务，否则 last_heartbeat 不会持久化
    await query_db.commit()
    return ResponseUtil.success(data={'node_id': node_id, 'disabled': node_disabled})


@monitor_controller.post(
    '/device-comm',
    summary='PLC通信状态上报',
    description='Node-RED 上报每台PLC的采集通信结果（需 X-API-Key + JWT）',
    response_model=ResponseBaseModel,
    dependencies=[PreAuthDependency()],
)
async def report_device_comm(
    request: Request,
    node_id: Annotated[int, Query(description='节点ID')],
    device_id: Annotated[int, Query(description='PLC设备ID')],
    success: Annotated[bool, Query(description='是否成功')] = True,
    error_msg: Annotated[str, Query(description='错误信息')] = '',
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """Node-RED 上报 PLC 通信结果"""
    await _verify_monitor_api_key(request)
    result = await MonitorService.report_device_comm(
        query_db, node_id=node_id, device_id=device_id,
        success=success, error_msg=error_msg,
    )
    return ResponseUtil.success(msg=result.message)


@monitor_controller.post(
    '/pg-write',
    summary='PG写入状态上报',
    description='Node-RED 上报PG数据库写入结果（需 X-API-Key + JWT）',
    response_model=ResponseBaseModel,
    dependencies=[PreAuthDependency()],
)
async def report_pg_write(
    request: Request,
    node_id: Annotated[int, Query(description='节点ID')],
    success: Annotated[bool, Query(description='是否成功')] = True,
    latency_ms: Annotated[int, Query(description='写入延迟ms')] = 0,
    write_count: Annotated[int, Query(description='本次写入条数')] = 0,
    error_msg: Annotated[str, Query(description='错误信息')] = '',
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """Node-RED 上报 PG 写入结果"""
    await _verify_monitor_api_key(request)
    result = await MonitorService.report_pg_write(
        query_db, node_id=node_id, success=success,
        latency_ms=latency_ms, write_count=write_count, error_msg=error_msg,
    )
    return ResponseUtil.success(msg=result.message)


# ==================== 前端查询接口 ====================

@monitor_controller.get(
    '/kpi',
    summary='KPI 仪表盘',
    description='监控中心顶部 KPI 卡片数据',
    response_model=DataResponseModel[KpiDashboardModel],
    dependencies=[UserInterfaceAuthDependency('monitor:center:list')],
)
async def get_kpi(
    request: Request,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    data = await MonitorService.get_kpi_dashboard(query_db)
    return ResponseUtil.success(data=data)


@monitor_controller.get(
    '/nodes',
    summary='采集节点列表',
    description='所有采集节点及其下级PLC状态',
    response_model=DataResponseModel[list[NoderedNodeModel]],
    dependencies=[UserInterfaceAuthDependency('monitor:center:list')],
)
async def get_nodes(
    request: Request,
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    data = await MonitorService.get_node_list(query_db)
    return ResponseUtil.success(data=data)


@monitor_controller.get(
    '/alerts',
    summary='告警列表',
    description='最近20条未处理告警',
    response_model=DataResponseModel[list[MonitorAlertModel]],
    dependencies=[UserInterfaceAuthDependency('monitor:center:list')],
)
async def get_alerts(
    request: Request,
    limit: Annotated[int, Query(description='条数', ge=1, le=500)] = 20,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    data = await MonitorService.get_alert_list(query_db, limit=limit)
    return ResponseUtil.success(data=data)


@monitor_controller.put(
    '/alerts/{alert_id}/confirm',
    summary='确认告警',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('monitor:center:edit')],
)
async def confirm_alert(
    request: Request,
    alert_id: Annotated[int, Path(description='告警ID')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    result = await MonitorService.confirm_alert(query_db, alert_id)
    return ResponseUtil.success(msg=result.message)
