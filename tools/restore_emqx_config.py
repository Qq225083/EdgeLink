#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""EdgeLink EMQX 配置恢复脚本（评审项 2.8 / Day9）

用途：EMQX 节点重建/迁移后，从声明式备份恢复认证与授权配置。
备份文件：docs/edgelink_emqx_config_backup.json（由 REST API 导出）

恢复内容：
  1. 内置数据库密码认证（password_based:built_in_database）
  2. 三个 MQTT 用户（密码从 ruoyi-fastapi-backend/.env.dev 读取：MQTT_* / EDGE_MQTT_*）
  3. 内置数据库授权源 + 按用户的 ACL 规则
  4. authorization settings（no_match=deny 等）
  5. 删除默认 file 授权源（其 acl.conf 末尾 {allow,all} 会放行一切）

用法（需要 EMQX 已启动 + dashboard 管理员口令）：
  python tools/restore_emqx_config.py --dashboard-password <口令> [--host 127.0.0.1] [--port 18083]

注意：脚本会校验目标 EMQX 是否已有同名配置，幂等可重入。
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP = os.path.join(REPO, 'docs', 'edgelink_emqx_config_backup.json')
ENV_DEV = os.path.join(REPO, 'ruoyi-fastapi-backend', '.env.dev')


def read_env(path):
    env = {}
    for line in open(path, encoding='utf-8-sig'):
        m = re.match(r"^\s*([A-Z_]+)\s*=\s*'?(.*?)'?\s*$", line)
        if m:
            env[m.group(1)] = m.group(2)
    return env


class EmqxApi:
    def __init__(self, host, port, password):
        self.base = f'http://{host}:{port}/api/v5'
        self.token = self._login(password)

    def _login(self, password):
        req = urllib.request.Request(self.base + '/login', method='POST')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, json.dumps({'username': 'admin', 'password': password}).encode(), timeout=10) as r:
            return json.loads(r.read())['token']

    def call(self, method, path, body=None, ok=(200, 201, 204)):
        req = urllib.request.Request(self.base + path, method=method)
        req.add_header('Authorization', 'Bearer ' + self.token)
        req.add_header('Content-Type', 'application/json')
        data = json.dumps(body).encode() if body is not None else None
        try:
            with urllib.request.urlopen(req, data, timeout=10) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            if e.code == 409:  # already exists
                return e.code, None
            raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dashboard-password', required=True, help='EMQX dashboard admin 口令')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=18083)
    args = ap.parse_args()

    backup = json.load(open(BACKUP, encoding='utf-8'))
    env = read_env(ENV_DEV)
    api = EmqxApi(args.host, args.port, args.dashboard_password)

    # 1. 认证
    for authn in backup.get('authentication', []):
        body = {k: v for k, v in authn.items() if k not in ('id', 'backend', 'mechanism') or True}
        for strip in ('id',):
            body.pop(strip, None)
        s, _ = api.call('POST', '/authentication', body)
        print(f'[1] 认证器 {authn.get("mechanism")}/{authn.get("backend")}: HTTP {s}（409=已存在）')

    # 2. 用户（密码来自 .env.dev）
    users = [
        (env.get('MQTT_USERNAME'), env.get('MQTT_PASSWORD')),
        (env.get('EDGE_MQTT_USERNAME'), env.get('EDGE_MQTT_PASSWORD')),
        (env.get('VUE_APP_MQTT_USERNAME') or 'edgelink_frontend', None),
    ]
    # 前端账号密码在前端 env
    fe_env_path = os.path.join(REPO, 'ruoyi-fastapi-frontend', '.env.production')
    fe = read_env(fe_env_path) if os.path.exists(fe_env_path) else {}
    users[2] = (fe.get('VUE_APP_MQTT_USERNAME', 'edgelink_frontend'), fe.get('VUE_APP_MQTT_PASSWORD'))
    for user, pw in users:
        if not user or not pw:
            print(f'[2] 跳过（env 缺账号或密码）: {user}')
            continue
        s, _ = api.call('POST', '/authentication/password_based:built_in_database/users',
                        {'user_id': user, 'password': pw})
        print(f'[2] 用户 {user}: HTTP {s}')

    # 3. 授权源 + 规则
    s, _ = api.call('POST', '/authorization/sources', {'type': 'built_in_database', 'enable': True})
    print(f'[3] 授权源 built_in_database: HTTP {s}（409=已存在）')
    rules = backup.get('authorization_rules_users', {}).get('data', [])
    if rules:
        s, _ = api.call('POST', '/authorization/sources/built_in_database/rules/users', rules)
        print(f'[3] ACL 规则 {len(rules)} 条: HTTP {s}')

    # 4. settings（no_match=deny）
    settings = backup.get('authorization_settings')
    if settings:
        s, _ = api.call('PUT', '/authorization/settings', settings)
        print(f'[4] authorization settings: HTTP {s}')

    # 5. 删除默认 file 授权源
    s, _ = api.call('DELETE', '/authorization/sources/file', ok=(200, 204, 404))
    print(f'[5] 删除 file 授权源: HTTP {s}（404=本来就没有）')

    print('完成。验证：匿名连接应被拒；edgelink_backend 仅可发布 edgelink/notify/#')


if __name__ == '__main__':
    sys.exit(main())
