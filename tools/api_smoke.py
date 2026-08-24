# -*- coding: utf-8 -*-
"""EdgeLink API 级 smoke 测试（初次部署验收 / 回归用）

覆盖 module_plc 全部 controller 的端点：
  认证与权限（admin / 边缘采集账号 / 无 token）→ 读端点全遍历 →
  写端点「创建→修改→删除」自清理闭环（SMOKETEST_ 前缀临时数据）→
  安全口负向测试（错误 API Key / 无密钥自举）

用法:  python tools/api_smoke.py        (退出码 0=全过, 1=有FAIL)
注意:  凭据从 ruoyi-fastapi-backend/.env.dev 与用户注册表 EDGE_* 运行时读取，不落盘不打印。
       写测试产生的临时数据全部在 finally 中清理；发布测试会真实固化一次快照（版本+1，无副作用内容）。
"""
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import urllib.error
import winreg

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_ENV = os.path.join(REPO, 'ruoyi-fastapi-backend', '.env.dev')
BASE = os.environ.get('SMOKE_BASE', 'http://127.0.0.1:9099')

results = []


def report(name, level, detail):
    results.append((level, name, detail))
    print(f'[{level}] {name} — {detail}')


def PASS(n, d=''): report(n, 'PASS', d)
def FAIL(n, d): report(n, 'FAIL', d)
def WARN(n, d): report(n, 'WARN', d)
def SKIP(n, d): report(n, 'SKIP', d)


def read_env(path):
    out = {}
    if not os.path.exists(path):
        return out
    for line in io.open(path, encoding='utf-8', errors='replace'):
        m = re.match(r"^\s*([A-Z_0-9]+)\s*=\s*'?([^'\n]*)'?", line)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def get_user_env(name):
    try:
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment')
        v, _ = winreg.QueryValueEx(k, name)
        winreg.CloseKey(k)
        return v
    except OSError:
        return None


def req(method, path, token=None, data=None, params=None, api_key=None, form=None):
    """返回 (http_status, parsed_json_or_None, raw_bytes)。永不抛 HTTPError。"""
    url = BASE + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    body = None
    headers = {}
    if form is not None:
        body = urllib.parse.urlencode(form).encode()
    elif data is not None:
        body = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if api_key:
        headers['X-API-Key'] = api_key
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw.decode('utf-8')), raw
            except (ValueError, UnicodeDecodeError):
                return resp.status, None, raw
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode('utf-8')), raw
        except (ValueError, UnicodeDecodeError):
            return e.code, None, raw


def expect_ok(name, st, body):
    if st == 200 and isinstance(body, dict) and body.get('code') == 200:
        PASS(name)
        return True
    FAIL(name, f'HTTP {st}, body={json.dumps(body, ensure_ascii=False)[:160] if body else "(非JSON)"}')
    return False


def expect_denied(name, st, body):
    code = body.get('code') if isinstance(body, dict) else None
    if st in (401, 403) or code in (401, 403):
        PASS(name, f'HTTP {st}/code {code}')
        return True
    FAIL(name, f'未被拒绝: HTTP {st}, code {code}')
    return False


def main():
    env = read_env(BACKEND_ENV)
    api_key = env.get('MONITOR_API_KEY', '')

    # ============ 1. 认证 ============
    st, b, _ = req('POST', '/login', form={'username': 'admin', 'password': 'admin123'})
    token = (((b or {}).get('data') or {}).get('access_token') or (b or {}).get('token')) if b else None
    if token:
        PASS('认证.admin登录')
    else:
        FAIL('认证.admin登录', f'HTTP {st}；后续全部受阻，终止')
        return
    st, b, _ = req('GET', '/plc/device/list', params={'pageNum': 1, 'pageSize': 1})
    expect_denied('认证.无token拒绝', st, b)

    edge_token = None
    eu, ep = get_user_env('EDGE_BACKEND_USER'), get_user_env('EDGE_BACKEND_PASS')
    if eu and ep:
        st, b, _ = req('POST', '/login', form={'username': eu, 'password': ep})
        edge_token = (((b or {}).get('data') or {}).get('access_token') or (b or {}).get('token')) if b else None
        if edge_token:
            PASS('认证.边缘账号登录')
        else:
            FAIL('认证.边缘账号登录', f'HTTP {st}')
    else:
        SKIP('认证.边缘账号登录', '注册表无 EDGE_BACKEND_USER/PASS')

    # ============ 2. 读端点全遍历 ============
    read_eps = [
        ('/plc/device/list', {'pageNum': 1, 'pageSize': 5}),
        ('/plc/tag/global/list', {'pageNum': 1, 'pageSize': 5}),
        ('/plc/tag/list/30', {'pageNum': 1, 'pageSize': 5}),
        ('/plc/tag/template', None),
        ('/plc/config/publish/devices', {'pageNum': 1, 'pageSize': 5}),
        ('/plc/config/snapshot/list', {'pageNum': 1, 'pageSize': 5}),
        ('/plc/publish-log/list', {'pageNum': 1, 'pageSize': 5}),
        ('/plc/change-log/list', {'pageNum': 1, 'pageSize': 5}),
        ('/plc/driver/list', None),
        ('/plc/driver/mitsubishi_mc/schema', None),
        ('/plc/driver/modbus_tcp/schema', None),
        ('/plc/driver-admin/list', {'pageNum': 1, 'pageSize': 5}),
        ('/plc/protocol-compat/all', None),
        ('/plc/protocol-compat-admin/list', {'pageNum': 1, 'pageSize': 5}),
        ('/plc/bootstrap-key/list', {'pageNum': 1, 'pageSize': 5}),
        ('/plc/bootstrap-key/registration-window', None),
        ('/monitor/kpi', None),
        ('/monitor/nodes', {'pageNum': 1, 'pageSize': 5}),
        ('/monitor/alerts', {'pageNum': 1, 'pageSize': 5}),
    ]
    for path, params in read_eps:
        st, b, raw = req('GET', path, token=token, params=params)
        name = f'读.{path}'
        if path.endswith('/template'):
            # 二进制模板下载
            if st == 200 and raw and len(raw) > 100:
                PASS(name, f'{len(raw)}B')
            else:
                FAIL(name, f'HTTP {st}, {len(raw or b"")}B')
            continue
        expect_ok(name, st, b)

    # 发布页 diff  stats 结构完整性（发布即版本 + 变更 diff 功能回归点）
    st, b, _ = req('GET', '/plc/config/publish/devices', token=token, params={'pageNum': 1, 'pageSize': 5})
    s = (b or {}).get('stats') or {}
    need = ['snapshotVersion', 'changedDeviceCount', 'changedBreakdown', 'edgeNodes']
    missing = [k for k in need if k not in s]
    if not missing:
        PASS('读.发布页stats结构', f'快照v{s.get("snapshotVersion")} 变更{s.get("changedDeviceCount")}台')
    else:
        FAIL('读.发布页stats结构', f'缺键: {missing}')

    # ============ 3. 写端点闭环（SMOKETEST_ 临时数据） ============
    dev_id = None
    clone_id = None
    tag_id = None
    calc_id = None
    key_id = None
    drv_id = None
    compat_id = None
    try:
        # --- 设备 CRUD + 克隆 ---
        st, b, _ = req('POST', '/plc/device', token=token, data={
            'deviceName': 'SMOKETEST_DEV', 'plcBrand': 'Mitsubishi', 'plcSeries': 'Q',
            'comType': 'MC_Protocol', 'plcIp': '10.255.255.1', 'plcPort': 59999,
            'hostPcIp': '10.255.255.254:1880', 'mesIp': '10.255.255.1',
            'scanIntervalMs': 1000, 'status': '1', 'driverCode': 'mitsubishi_mc',
        })
        if expect_ok('写.设备新增', st, b):
            st, b, _ = req('GET', '/plc/device/list', token=token,
                           params={'pageNum': 1, 'pageSize': 200, 'deviceName': 'SMOKETEST_DEV'})
            for row in (b or {}).get('rows') or []:
                if row.get('deviceName') == 'SMOKETEST_DEV':
                    dev_id = row.get('id')
        if dev_id:
            st, b, _ = req('GET', f'/plc/device/{dev_id}', token=token)
            expect_ok('写.设备详情', st, b)
            dev = (b or {}).get('data') or {}
            dev['remark'] = 'smoke-update'
            st, b, _ = req('PUT', '/plc/device', token=token, data=dev)
            expect_ok('写.设备编辑', st, b)
            st, b, _ = req('POST', f'/plc/device/clone/{dev_id}', token=token,
                           params={'new_device_name': 'SMOKETEST_CLONE',
                                   'new_device_code': 'SMOKETEST_CLONE',
                                   'new_plc_ip': '10.255.255.2'})
            expect_ok('写.设备克隆', st, b)
            st, b, _ = req('GET', '/plc/device/list', token=token,
                           params={'pageNum': 1, 'pageSize': 200, 'deviceName': 'SMOKETEST_CLONE'})
            for row in (b or {}).get('rows') or []:
                if row.get('deviceName') == 'SMOKETEST_CLONE':
                    clone_id = row.get('id')
            if not clone_id:
                FAIL('写.设备克隆回查', '列表中找不到克隆设备')
            st, b, _ = req('PUT', f'/plc/device/status/{dev_id}', token=token, params={'status': '0'})
            expect_ok('写.设备启停切换', st, b)

        # --- 点位 CRUD（挂在临时设备上，均停用，不影响采集） ---
        if dev_id:
            st, b, _ = req('POST', '/plc/tag', token=token, data={
                'deviceId': dev_id, 'tagName': 'smoke_tag', 'registerType': 'D',
                'registerAddress': '9991', 'dataType': 'UINT16', 'status': '1',
                'sortOrder': 0, 'description': 'smoke',
            })
            if expect_ok('写.点位新增', st, b):
                st, b, _ = req('GET', f'/plc/tag/list/{dev_id}', token=token,
                               params={'pageNum': 1, 'pageSize': 50})
                for row in (b or {}).get('rows') or []:
                    if row.get('tagName') == 'smoke_tag':
                        tag_id = row.get('id')
            if tag_id:
                st, b, _ = req('GET', f'/plc/tag/detail/{tag_id}', token=token)
                expect_ok('写.点位详情', st, b)
                tag = (b or {}).get('data') or {}
                tag['description'] = 'smoke-updated'
                st, b, _ = req('PUT', '/plc/tag', token=token, data=tag)
                expect_ok('写.点位编辑', st, b)
                st, b, _ = req('PUT', f'/plc/tag/status/{tag_id}', token=token, params={'status': '0'})
                expect_ok('写.点位启停', st, b)

        # --- 发布（真实固化一次快照；EMQX 不在时通知降级为轮询兜底，status 字段如实记录） ---
        st, b, _ = req('POST', '/plc/config/publish', token=token, data={})
        d = (b or {}).get('data') or {}
        if st == 200 and (b or {}).get('code') == 200 and d.get('snapshotVersion'):
            PASS('写.配置发布', f'快照v{d.get("snapshotVersion")} 通知状态={d.get("status")}')
        else:
            FAIL('写.配置发布', f'HTTP {st} {json.dumps(b, ensure_ascii=False)[:160]}')

        # --- 边缘节点密钥 + 注册窗口 ---
        st, b, _ = req('POST', '/plc/bootstrap-key', token=token, data={
            'node_key': 'smoketest_key', 'node_name': 'SMOKETEST 节点',
            'host_pc_ip': '10.255.255.254:1880', 'enabled': 0,
        })
        if expect_ok('写.密钥新增', st, b):
            st, b, _ = req('GET', '/plc/bootstrap-key/list', token=token,
                           params={'pageNum': 1, 'pageSize': 100, 'nodeKey': 'smoketest_key'})
            for row in (b or {}).get('rows') or []:
                if row.get('nodeKey') == 'smoketest_key':
                    key_id = row.get('id')
        if key_id:
            st, b, _ = req('PUT', f'/plc/bootstrap-key/status/{key_id}', token=token, params={'enabled': 1})
            expect_ok('写.密钥启停', st, b)
            st, b, _ = req('PUT', f'/plc/bootstrap-key/regenerate/{key_id}', token=token)
            expect_ok('写.密钥重新生成', st, b)
        st, b, _ = req('POST', '/plc/bootstrap-key/registration-window', token=token, params={'minutes': 1})
        expect_ok('写.注册窗口开放', st, b)
        st, b, _ = req('GET', '/plc/bootstrap-key/registration-window', token=token)
        if st == 200 and isinstance(b, dict) and b.get('code') == 200:
            PASS('写.注册窗口查询', json.dumps(b.get('data'), ensure_ascii=False)[:80])
        else:
            FAIL('写.注册窗口查询', f'HTTP {st}')
        st, b, _ = req('DELETE', '/plc/bootstrap-key/registration-window', token=token)
        expect_ok('写.注册窗口关闭', st, b)

        # --- 驱动管理 ---
        st, b, _ = req('POST', '/plc/driver-admin', token=token, data={
            'driver_code': 'smoketest_drv', 'driver_name': 'SMOKETEST 驱动',
            'node_red_node_type': 'smoke-node', 'config_schema': {'fields': []},
            'register_types': [], 'data_types': [], 'enabled': False,
        })
        if expect_ok('写.驱动新增', st, b):
            st, b, _ = req('GET', '/plc/driver-admin/list', token=token,
                           params={'pageNum': 1, 'pageSize': 100, 'driverCode': 'smoketest_drv'})
            for row in (b or {}).get('rows') or []:
                if row.get('driverCode') == 'smoketest_drv':
                    drv_id = row.get('id')
        if drv_id:
            st, b, _ = req('PUT', '/plc/driver-admin', token=token, data={
                'id': drv_id, 'driver_code': 'smoketest_drv', 'driver_name': 'SMOKETEST 驱动改',
                'node_red_node_type': 'smoke-node', 'config_schema': {'fields': []},
                'register_types': [], 'data_types': [], 'enabled': False,
            })
            expect_ok('写.驱动编辑', st, b)
            st, b, _ = req('PUT', f'/plc/driver-admin/status/{drv_id}', token=token, params={'enabled': False})
            expect_ok('写.驱动启停', st, b)

        # --- 协议兼容管理 ---
        st, b, _ = req('POST', '/plc/protocol-compat-admin', token=token, data={
            'plcBrand': 'SMOKETEST', 'plcSeries': 'T1', 'comType': 'SMOKE_CT',
            'driverCode': 'unknown', 'registerType': 'SMOKE_RT', 'registerTypeLabel': '冒烟',
        })
        if expect_ok('写.兼容映射新增', st, b):
            st, b, _ = req('GET', '/plc/protocol-compat-admin/list', token=token,
                           params={'pageNum': 1, 'pageSize': 100, 'plcBrand': 'SMOKETEST'})
            for row in (b or {}).get('rows') or []:
                if row.get('plcBrand') == 'SMOKETEST':
                    compat_id = row.get('id')
        if compat_id:
            st, b, _ = req('PUT', '/plc/protocol-compat-admin', token=token, data={
                'id': compat_id, 'plcBrand': 'SMOKETEST', 'plcSeries': 'T1', 'comType': 'SMOKE_CT',
                'driverCode': 'unknown', 'registerType': 'SMOKE_RT', 'registerTypeLabel': '冒烟改',
            })
            expect_ok('写.兼容映射编辑', st, b)

        # --- 计算点位（源=临时设备上的临时点位；非法算子拒绝） ---
        calc_id = None
        if tag_id:
            st, b, _ = req('POST', '/plc/tag', token=token, data={
                'deviceId': dev_id, 'tagName': 'smoke_calc', 'status': '1',
                'calcOp': 'multiply', 'calcSourceIds': [tag_id],
            })
            code = (b or {}).get('code')
            if st == 200 and code == 500:
                PASS('写.计算点位非法算子拒绝')
            else:
                FAIL('写.计算点位非法算子拒绝', f'HTTP {st} code {code}')
            st, b, _ = req('POST', '/plc/tag', token=token, data={
                'deviceId': dev_id, 'tagName': 'smoke_calc', 'status': '1',
                'calcOp': 'avg', 'calcSourceIds': [tag_id],
            })
            if expect_ok('写.计算点位新增', st, b):
                st, b, _ = req('GET', f'/plc/tag/list/{dev_id}', token=token,
                               params={'pageNum': 1, 'pageSize': 50})
                for row in (b or {}).get('rows') or []:
                    if row.get('tagName') == 'smoke_calc':
                        calc_id = row.get('id')
            if calc_id:
                st, b, _ = req('GET', f'/plc/tag/detail/{calc_id}', token=token)
                calc_tag = (b or {}).get('data') or {}
                ok_shape = calc_tag.get('registerType') == 'CALC' and calc_tag.get('calcOp') == 'avg'
                if ok_shape:
                    PASS('写.计算点位详情回读', f"CALC/{calc_tag.get('calcOp')} sources={calc_tag.get('calcSourceIds')}")
                else:
                    FAIL('写.计算点位详情回读', json.dumps(calc_tag, ensure_ascii=False)[:140])
                calc_tag['description'] = 'smoke-calc-updated'
                st, b, _ = req('PUT', '/plc/tag', token=token, data=calc_tag)
                expect_ok('写.计算点位编辑', st, b)

        # --- 监控告警确认（有待处理告警才测；/monitor/alerts 返回 data 为数组，固定查未处理） ---
        st, b, _ = req('GET', '/monitor/alerts', token=token, params={'limit': 5})
        alerts = (b or {}).get('data') or []
        if alerts:
            aid = alerts[0].get('id')
            st, b, _ = req('PUT', f'/monitor/alerts/{aid}/confirm', token=token)
            expect_ok('写.告警确认', st, b)
        else:
            SKIP('写.告警确认', '当前无待处理告警')

        # --- 导出（二进制流） ---
        st, b, raw = req('POST', '/plc/device/export', token=token, data={})
        if st == 200 and raw and len(raw) > 100:
            PASS('写.设备导出', f'{len(raw)}B')
        else:
            WARN('写.设备导出', f'HTTP {st}（导出为空或参数不适配，人工复核）')

    finally:
        # ===== 清理临时数据（顺序：计算点位→点位→克隆→设备→密钥→驱动→兼容） =====
        for label, method, path in [
            ('计算点位', 'DELETE', f'/plc/tag/{calc_id}' if calc_id else None),
            ('点位', 'DELETE', f'/plc/tag/{tag_id}' if tag_id else None),
            ('克隆设备', 'DELETE', f'/plc/device/{clone_id}' if clone_id else None),
            ('设备', 'DELETE', f'/plc/device/{dev_id}' if dev_id else None),
            ('密钥', 'DELETE', f'/plc/bootstrap-key/{key_id}' if key_id else None),
            ('驱动', 'DELETE', f'/plc/driver-admin/{drv_id}' if drv_id else None),
            ('兼容映射', 'DELETE', f'/plc/protocol-compat-admin/{compat_id}' if compat_id else None),
        ]:
            if not path:
                continue
            st, b, _ = req(method, path, token=token)
            if st == 200 and isinstance(b, dict) and b.get('code') == 200:
                PASS(f'清理.{label}')
            else:
                FAIL(f'清理.{label}', f'HTTP {st}——SMOKETEST_ 数据可能残留，请人工检查')

    # ============ 4. 权限与安全口 ============
    if edge_token:
        st, b, _ = req('GET', '/plc/device/list', token=edge_token, params={'pageNum': 1, 'pageSize': 1})
        expect_denied('权限.边缘账号禁读设备管理', st, b)
        st, b, _ = req('GET', '/plc/config/snapshot/list', token=edge_token,
                       params={'pageNum': 1, 'pageSize': 2})
        expect_ok('权限.边缘账号可读快照(设计如此)', st, b)
    st, b, _ = req('POST', '/monitor/heartbeat', params={'host_pc_ip': '10.255.255.250'},
                   api_key='wrong-key', token=token, data={})
    expect_denied('安全.心跳错误APIKey拒绝', st, b)
    st, b, _ = req('GET', '/plc/config/bootstrap/auto', params={'host_pc_ip': '10.255.255.250:1880'})
    if st in (400, 401, 403, 422) or (isinstance(b, dict) and b.get('code') in (400, 401, 403, 500)):
        PASS('安全.自举口无密钥拒绝', f'HTTP {st}')
    else:
        FAIL('安全.自举口无密钥拒绝', f'HTTP {st} 疑似放行')

    # ============ 汇总 ============
    n_pass = sum(1 for r in results if r[0] == 'PASS')
    n_warn = sum(1 for r in results if r[0] == 'WARN')
    n_skip = sum(1 for r in results if r[0] == 'SKIP')
    n_fail = sum(1 for r in results if r[0] == 'FAIL')
    print()
    print(f'===== API smoke 汇总: {n_pass} PASS / {n_warn} WARN / {n_skip} SKIP / {n_fail} FAIL =====')
    for level, name, detail in results:
        if level == 'FAIL':
            print(f'  失败: {name} — {detail}')
    return n_fail


if __name__ == '__main__':
    sys.exit(1 if main() else 0)
