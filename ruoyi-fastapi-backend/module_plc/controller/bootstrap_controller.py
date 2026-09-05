"""边缘节点 Bootstrap 配置接口 v3.0（仅预分配模式）

设计变更（v3.0）：
  - 取消「开放注册模式」（注册窗口已下线），只保留预分配模式；
  - /auto 必须携带 secretKey：按哈希查记录 → 启用校验 → 本机IP:端口严格比对登记值；
  - 机器指纹仅记录（供后续换机告警），不作为拒绝条件。
"""
import time
from datetime import datetime
from typing import Annotated, Optional

from fastapi import Query, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from common.aspect.db_seesion import DBSessionDependency
from common.router import APIRouterPro
from common.vo import DataResponseModel
from config.env import AppConfig
from exceptions.exception import ServiceException
from module_plc.entity.do.bootstrap_key_do import EdgeBootstrapKey, hash_bootstrap_secret
from utils.log_util import logger
from utils.response_util import ResponseUtil

bootstrap_controller = APIRouterPro(
    prefix='/plc/config', order_num=206, tags=['PLC配置发布']
)

# 轻量 IP 限流（内存桶，无新依赖）：/auto 与 /bootstrap 各 20 次/分钟/IP
_RATE_BUCKETS: dict[str, list[float]] = {}


def _check_rate_limit(request: Request, bucket: str, limit: int = 20, window_s: int = 60) -> None:
    ip = request.client.host if request.client else 'unknown'
    key = f'{bucket}:{ip}'
    now = time.time()
    ts = [t for t in _RATE_BUCKETS.get(key, []) if now - t < window_s]
    if len(ts) >= limit:
        raise ServiceException(message='请求过于频繁，请稍后再试')
    ts.append(now)
    _RATE_BUCKETS[key] = ts


@bootstrap_controller.get(
    '/bootstrap/auto',
    summary='Node-RED 预分配激活（阶段 1）',
    description='节点携带 secretKey + 本机IP:端口 激活：密钥查记录 → 启用校验 → IP:端口严格比对登记值。'
                '不返回业务凭据（业务配置走 /bootstrap 阶段 2）。',
    response_model=DataResponseModel[dict],
)
async def bootstrap_auto(
    request: Request,
    host_pc_ip: Annotated[str, Query(description='当前节点标识（IP:端口）')],
    secret_key: Annotated[str, Query(description='预分配密钥（管理端创建时下发）')],
    fingerprint: Annotated[Optional[str], Query(description='机器指纹 SHA256(hostname+MACs)')] = None,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """Node-RED 预分配激活（仅预分配模式，开放注册已下线）。"""
    _check_rate_limit(request, 'auto')

    # 1. 按密钥（哈希）查记录——未预分配直接拒绝
    result = await query_db.execute(
        select(EdgeBootstrapKey).where(EdgeBootstrapKey.secret_key == hash_bootstrap_secret(secret_key))
    )
    record = result.scalar_one_or_none()
    if not record:
        raise ServiceException(message='密钥无效或未预分配，请先在管理端登记该采集节点')

    # 2. 启用状态校验
    if record.enabled == 0:
        raise ServiceException(message='节点已停用，请在边缘节点管理中重新启用')

    # 3. 严格校验：本机IP:端口 必须等于登记值
    if host_pc_ip != record.host_pc_ip:
        client_ip = request.client.host if request.client else 'unknown'
        logger.warning(
            f'[bootstrap] 密钥与机器不匹配：nodeKey={record.node_key} 登记={record.host_pc_ip} '
            f'实际上报={host_pc_ip} 来源IP={client_ip}'
        )
        raise ServiceException(
            message=f'密钥与机器不匹配，预期：{record.host_pc_ip}，实际：{host_pc_ip}'
        )

    # 4. 校验通过：激活（记录最后心跳时间；指纹仅记录，不作为拒绝条件）
    record.last_heartbeat = datetime.now()
    if fingerprint and not record.machine_fingerprint:
        record.machine_fingerprint = fingerprint
    await query_db.commit()

    return ResponseUtil.success(data={
        'nodeKey': record.node_key,
        'nodeName': record.node_name or record.node_key,
        'hostPcIp': record.host_pc_ip,
        'secretKey': None,  # 只存哈希不再回显
        'isNew': False,
    })


@bootstrap_controller.get(
    '/bootstrap',
    summary='Node-RED 获取业务配置（阶段 2）',
    description='Node-RED 用 node_key + secret_key 获取业务配置（API Key、后端地址、MQTT 配置等）。'
                '后续配置变更通过发布中心下发，Node-RED 重新调用本接口即可。',
    response_model=DataResponseModel[dict],
)
async def get_bootstrap_config(
    request: Request,
    host_pc_ip: Annotated[str, Query(description='节点标识（IP:端口）')],
    secret_key: Annotated[str, Query(description='节点密钥')],
    query_db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """Node-RED 获取业务配置（阶段 2）。"""
    _check_rate_limit(request, 'bootstrap')
    # 先按 host_pc_ip 查密钥存在性，区分「已停用」与「无效」：
    # 已停用要返回独立文案，边缘侧据此进入停用态（kill switch 的重启持久化路径）
    key_result = await query_db.execute(
        select(EdgeBootstrapKey).where(EdgeBootstrapKey.host_pc_ip == host_pc_ip)
    )
    existing_key = key_result.scalars().first()
    if existing_key and existing_key.enabled == 0:
        raise ServiceException(message='节点已停用，请在边缘节点管理中重新启用')

    # 校验节点密钥（库中只存 SHA-256 哈希，按哈希比对）
    result = await query_db.execute(
        select(EdgeBootstrapKey).where(
            EdgeBootstrapKey.host_pc_ip == host_pc_ip,
            EdgeBootstrapKey.secret_key == hash_bootstrap_secret(secret_key),
            EdgeBootstrapKey.enabled == 1,
        )
    )
    bootstrap_key = result.scalar_one_or_none()
    if not bootstrap_key:
        raise ServiceException(message='节点标识或密钥无效')
    # 未配置采集账号密码时不下发半成品配置（避免 Node-RED 拿到错误凭据陷入认证死循环）
    if not AppConfig.edge_collector_password:
        raise ServiceException(message='服务端未配置 EDGE_COLLECTOR_PASSWORD，无法下发采集账号配置')

    # 组装配置（不返回 secret_key）
    config = {
        'nodeKey': bootstrap_key.node_key,
        'nodeName': bootstrap_key.node_name or bootstrap_key.node_key,
        'hostPcIp': bootstrap_key.host_pc_ip,
        'backendHost': AppConfig.app_host,
        'backendPort': AppConfig.app_port,
        'apiKey': AppConfig.monitor_api_key,
        'backendUser': 'edge_collector',  # 采集节点专用角色，不给 admin 权限
        'backendPass': AppConfig.edge_collector_password,
        'mqtt': {
            'host': AppConfig.mqtt_host,
            'port': AppConfig.mqtt_port,
            'wsPort': AppConfig.mqtt_ws_port,
            # 🔧 边缘与后端账号分离（P1-10）；未配置边缘账号时回退主账号，保持兼容
            'username': AppConfig.edge_mqtt_username or AppConfig.mqtt_username,
            'password': AppConfig.edge_mqtt_password or AppConfig.mqtt_password,
        },
        'collect': {
            'defaultScanIntervalMs': 1000,
            'defaultCommTimeoutMs': 3000,
            'defaultRetryCount': 2,
            'defaultRetryIntervalMs': 500,
        }
    }

    return ResponseUtil.success(data=config)
