"""边缘节点 Bootstrap 配置接口 v2.0

两阶段设计：
  阶段 1（/auto）：Node-RED 首次启动时自动注册，只返回 node_key + secret_key，不返回业务凭据
  阶段 2（/bootstrap）：Node-RED 用 node_key + secret_key 获取业务配置（API Key、MQTT 配置等）

安全性：
  - /auto 不返回业务凭据，攻击者拿到 secret_key 也无法直接获取配置
  - edge_collector 专用角色，不给 admin 权限
  - machine_fingerprint 处理 IP 变更，自动映射不创建僵尸记录
"""
import secrets
import time
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
from utils.response_util import ResponseUtil

bootstrap_controller = APIRouterPro(
    prefix='/plc/config', order_num=206, tags=['PLC配置发布']
)

# 与 bootstrap_key_controller 中 REGISTER_WINDOW_KEY 一致（按压配对窗口）
REGISTER_WINDOW_KEY = 'edgelink:bootstrap:register_open'

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


def _generate_node_key(host_pc_ip: str) -> str:
    """根据 host_pc_ip 生成 node_key（如 pc-192168000179-1880）"""
    parts = host_pc_ip.replace('.', '').replace(':', '-')
    return f'pc-{parts}'


@bootstrap_controller.get(
    '/bootstrap/auto',
    summary='Node-RED 自动注册（阶段 1）',
    description='Node-RED 首次启动时自动注册，只返回 node_key + secret_key。'
                '不返回业务凭据，攻击者拿到 secret_key 也无法直接获取配置。',
    response_model=DataResponseModel[dict],
)
async def bootstrap_auto(
    request: Request,
    host_pc_ip: Annotated[str, Query(description='当前节点标识（IP:端口）')],
    fingerprint: Annotated[Optional[str], Query(description='机器指纹 SHA256(hostname+MACs)')] = None,
    query_db: Annotated[AsyncSession, DBSessionDependency()] = None,
) -> Response:
    """Node-RED 自动注册（阶段 1）。"""
    _check_rate_limit(request, 'auto')
    # 1. 先按 fingerprint 查找（处理 IP 变更）
    if fingerprint:
        result = await query_db.execute(
            select(EdgeBootstrapKey).where(
                EdgeBootstrapKey.machine_fingerprint == fingerprint,
                EdgeBootstrapKey.enabled == 1,
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            # 🔧 密钥只存哈希无法回显，fingerprint 命中仅确认身份；
            # 不再直接改写 host_pc_ip（指纹伪造可劫持节点映射），IP 变更改走管理端确认流程
            return ResponseUtil.success(data={
                'nodeKey': existing.node_key,
                'nodeName': existing.node_name or existing.node_key,
                'hostPcIp': existing.host_pc_ip,
                'secretKey': None,
                'isNew': False,
            })

    # 2. 按 host_pc_ip 查找
    result = await query_db.execute(
        select(EdgeBootstrapKey).where(
            EdgeBootstrapKey.host_pc_ip == host_pc_ip,
            EdgeBootstrapKey.enabled == 1,
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        return ResponseUtil.success(data={
            'nodeKey': existing.node_key,
            'nodeName': existing.node_name or existing.node_key,
            'hostPcIp': existing.host_pc_ip,
            'secretKey': None,  # 🔧 只存哈希不再回显；请使用首次注册/重置时保存的密钥
            'isNew': False,
        })

    # 3. 全新注册 —— 🔧 P0-2 整改：仅注册窗口开启时允许（按压配对），否则任何人可注册新节点并领取全套凭据
    redis = request.app.state.redis
    try:
        open_flag = await redis.get(REGISTER_WINDOW_KEY)
    except Exception:
        open_flag = None  # Redis 故障时 fail-closed（拒绝新注册）
    if open_flag != '1':
        raise ServiceException(message='节点注册窗口未开启，请先在管理端"边缘节点密钥"页开放注册')
    node_key = _generate_node_key(host_pc_ip)
    secret_key = secrets.token_hex(32)
    entity = EdgeBootstrapKey(
        node_key=node_key,
        node_name=f'采集节点-{host_pc_ip}',
        host_pc_ip=host_pc_ip,
        secret_key=hash_bootstrap_secret(secret_key),
        machine_fingerprint=fingerprint,
        enabled=1,
    )
    query_db.add(entity)
    await query_db.commit()

    return ResponseUtil.success(data={
        'nodeKey': node_key,
        'nodeName': f'采集节点-{host_pc_ip}',
        'hostPcIp': host_pc_ip,
        'secretKey': secret_key,  # 明文仅此一次返回
        'isNew': True,
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
