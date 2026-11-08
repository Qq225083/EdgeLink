"""敏感信息输出脱敏：只处理接口/下载返回副本，不回写数据库。"""
import copy
import json
from typing import Any


REDACTED_VALUE = '__REDACTED__'
_CREDENTIAL_PLACEHOLDER = '__PWRD__'
_RESPONSE_SECRET_KEYS = {'teamswebhook', 'teams_webhook', 'notifytarget'}
_FLOW_SECRET_KEYS = {'password', 'apikey', 'api_key', 'x-api-key'}


def _redact(value: Any) -> Any:
    if value in (None, '', _CREDENTIAL_PLACEHOLDER, REDACTED_VALUE):
        return value
    return REDACTED_VALUE


def redact_response_data(value: Any) -> Any:
    """递归脱敏响应对象中的通知地址；用于管理端 JSON 响应。"""
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if str(key).lower() in _RESPONSE_SECRET_KEYS:
                result[key] = _redact(item)
            else:
                result[key] = redact_response_data(item)
        return result
    if isinstance(value, list):
        return [redact_response_data(item) for item in value]
    return value


def _redact_flow_node(node: dict) -> dict:
    current = redact_response_data(copy.deepcopy(node))
    node_type = current.get('type')

    if node_type == 'postgreSQLConfig':
        for field in ('user', 'password'):
            if field in current:
                current[field] = _redact(current[field])
    elif node_type == 'mqtt-broker':
        for field in ('user', 'username', 'password'):
            if field in current:
                current[field] = _redact(current[field])
    elif node_type in {'site-health', 'site-health-server', 'site-flows-upload'}:
        for field in ('key', 'siteKey'):
            if field in current:
                current[field] = _redact(current[field])

    for header in current.get('headers') or []:
        if isinstance(header, dict) and str(header.get('keyValue', '')).lower() == 'x-api-key':
            header['valueValue'] = _redact(header.get('valueValue'))

    for key, item in list(current.items()):
        if str(key).lower() in _FLOW_SECRET_KEYS:
            current[key] = _redact(item)
    return current


def redact_flows(flows: list) -> list:
    """脱敏 flows 节点数组；返回新列表，不修改调用方对象。"""
    return [_redact_flow_node(node) if isinstance(node, dict) else copy.deepcopy(node) for node in flows]


def redact_flows_json(payload: str) -> str:
    """脱敏 flows.json 文本；非法 JSON 直接报错，避免泄露内容被原样返回。"""
    flows = json.loads(payload)
    if not isinstance(flows, list):
        raise ValueError('flows payload 必须是节点数组')
    return json.dumps(redact_flows(flows), ensure_ascii=False)
