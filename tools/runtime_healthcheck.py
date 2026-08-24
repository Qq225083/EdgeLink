# -*- coding: utf-8 -*-
"""EdgeLink 运行时符合性体检（整改后防漂移一键检查）

覆盖今日人工排查发现的所有漂移面：
  服务端口 / Node-RED 实际加载的流文件与仓库权威版一致性 / EDGE_* 环境变量 /
  flows_cred broker 凭据实测 / EMQX 三账号 ACL 与前端订阅清单交叉核对 /
  后端登录 / 状态API / 静态页key / DB心跳新鲜度 / PG写入新鲜度 / spool积压

用法:  python tools/runtime_healthcheck.py        (退出码 0=全过, 1=有FAIL)
注意:  只读检查，不修改任何状态；凭据从本地 .env / 用户注册表运行时读取，不落盘不打印。
"""
import io
import json
import os
import re
import socket
import subprocess
import sys
import winreg
import hashlib
import urllib.request
import urllib.error

# ---------------- 配置（按部署机器调整） ----------------
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_ENV = os.path.join(REPO, 'ruoyi-fastapi-backend', '.env.dev')
FRONTEND_ENV = os.path.join(REPO, 'ruoyi-fastapi-frontend', '.env.development')
V12_FLOW = os.path.join(REPO, 'docs', 'V12', 'edgelink_v12_main_flow.json')
NR_SETTINGS = 'D:/nodered/data/settings.js'
NR_USERDIR = 'D:/nodered/data'
NR_STATIC_PAGE = 'D:/nodered/data/static/index.html'
NR_SPOOL_DIR = 'D:/nodered/data/edgelink_pg_spool'
NODE_EXE = 'D:/nodered/node.exe'
MQTT_PROBE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mqtt_probe.js')
PSQL = 'D:/PostgreSQL/bin/psql'
FRONTEND_MONITOR_VUE = os.path.join(REPO, 'ruoyi-fastapi-frontend', 'src', 'views', 'plc', 'monitor', 'index.vue')

EDGE_ENV_VARS = ['EDGE_API_KEY', 'EDGE_BACKEND_USER', 'EDGE_BACKEND_PASS', 'EDGE_BOOTSTRAP_SECRET',
                 'EDGE_PG_PASSWORD', 'EDGE_MQTT_USERNAME', 'EDGE_MQTT_PASSWORD']

results = []


def report(name, level, detail):
    results.append((level, name, detail))
    print(f"[{level}] {name} — {detail}")


def PASS(n, d): report(n, 'PASS', d)
def WARN(n, d): report(n, 'WARN', d)
def FAIL(n, d): report(n, 'FAIL', d)


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


def port_listening(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect(('127.0.0.1', port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def http_json(url, headers=None, method='GET', data=None, timeout=5):
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode('utf-8'))


def md5(path):
    return hashlib.md5(io.open(path, 'rb').read()).hexdigest()


def run_probe(args, timeout=15):
    p = subprocess.run([NODE_EXE, MQTT_PROBE] + args, capture_output=True, text=True, timeout=timeout)
    return p.stdout.strip().splitlines()


def main():
    backend_env = read_env(BACKEND_ENV)
    frontend_env = read_env(FRONTEND_ENV)
    api_key = backend_env.get('MONITOR_API_KEY', '')

    # A. 服务端口
    for port, name in [(9099, '后端'), (1880, 'Node-RED'), (1883, 'EMQX')]:
        if port_listening(port):
            PASS(f'端口 {port}', f'{name} 在听')
        else:
            FAIL(f'端口 {port}', f'{name} 未监听')

    # B. Node-RED 实际加载流文件 vs 仓库权威版
    settings_src = io.open(NR_SETTINGS, encoding='utf-8', errors='replace').read() if os.path.exists(NR_SETTINGS) else ''
    # 排除注释行里的 flowFile 示例
    uncommented = '\n'.join(l for l in settings_src.splitlines() if not l.strip().startswith('//'))
    m = re.search(r"flowFile\s*:\s*'([^']+)", uncommented)
    live_flow = m.group(1) if m else 'flows.json'
    if not os.path.isabs(live_flow):
        live_flow = os.path.join(NR_USERDIR, live_flow)
    if os.path.exists(live_flow) and os.path.exists(V12_FLOW):
        if md5(live_flow) == md5(V12_FLOW):
            PASS('流文件一致性', f'{live_flow} == 仓库V12权威版')
        else:
            FAIL('流文件一致性', f'{live_flow} 与仓库V12不一致（存在部署漂移）')
    else:
        FAIL('流文件一致性', f'文件缺失: {live_flow} 或 {V12_FLOW}')
    # 候选副本漂移告警（历史教训：D:\nodered\flows.json 与 data\flows.json 双副本漂移）
    for other in ['D:/nodered/flows.json', os.path.join(NR_USERDIR, 'flows.json')]:
        if os.path.abspath(other) != os.path.abspath(live_flow) and os.path.exists(other):
            if md5(other) == md5(live_flow):
                PASS(f'副本 {os.path.basename(os.path.dirname(other))}/flows.json', '与线上流一致（无害副本）')
            else:
                WARN(f'副本 {other}', '与线上流不一致——注意它可能因启动目录不同而被误加载')

    # C. EDGE_* 环境变量
    env_ok = True
    for v in EDGE_ENV_VARS:
        val = get_user_env(v)
        if val:
            PASS(f'环境变量 {v}', f'已设置 (len={len(val)})')
        else:
            FAIL(f'环境变量 {v}', '未在用户环境变量中设置')
            env_ok = False
    reg_key = get_user_env('EDGE_API_KEY')
    if reg_key and api_key:
        if reg_key == api_key:
            PASS('EDGE_API_KEY 一致性', '与后端 MONITOR_API_KEY 一致')
        else:
            FAIL('EDGE_API_KEY 一致性', '与后端 MONITOR_API_KEY 不一致（轮换漂移）')

    # D. 后端登录（边缘账号）
    if port_listening(9099) and env_ok:
        try:
            data = urllib.parse.urlencode({'username': get_user_env('EDGE_BACKEND_USER') or 'admin',
                                           'password': get_user_env('EDGE_BACKEND_PASS') or ''}).encode()
            st, body = http_json('http://127.0.0.1:9099/login', method='POST', data=data,
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
            if st == 200 and body.get('code') == 200:
                PASS('边缘后端登录', 'EDGE_BACKEND_USER/PASS 登录成功')
            else:
                FAIL('边缘后端登录', f'HTTP {st} code={body.get("code")}')
        except Exception as e:
            FAIL('边缘后端登录', f'异常: {e}')

    # E. flows_cred broker 凭据实测
    if port_listening(1883) and os.path.exists(V12_FLOW):
        flow = json.load(io.open(V12_FLOW, encoding='utf-8'))
        broker_id = next((n['id'] for n in flow if n.get('type') == 'mqtt-broker'), None)
        edge_user = get_user_env('EDGE_MQTT_USERNAME') or ''
        try:
            lines = run_probe(['brokercred', broker_id, edge_user])
            txt = ' | '.join(lines)
            if any('CRED_CONN_OK' in l for l in lines) and 'CRED_USER_MATCH=true' in txt:
                PASS('flows_cred broker凭据', '解密成功、与EDGE_MQTT_*一致、实测可连EMQX')
            elif any('CRED_MISSING' in l for l in lines):
                FAIL('flows_cred broker凭据', 'flows_cred.json 中没有该broker的凭据（匿名必被EMQX拒）')
            else:
                FAIL('flows_cred broker凭据', txt)
        except Exception as e:
            FAIL('flows_cred broker凭据', f'探针异常: {e}')

    # F. EMQX ACL vs 前端订阅清单（从 monitor/index.vue 实时读取订阅常量）
    if port_listening(1883):
        vue = io.open(FRONTEND_MONITOR_VUE, encoding='utf-8', errors='replace').read() if os.path.exists(FRONTEND_MONITOR_VUE) else ''
        topics = re.findall(r"TOPIC_\w+\s*=\s*'([^']+)'", vue)
        fu, fp = frontend_env.get('VUE_APP_MQTT_USERNAME', ''), frontend_env.get('VUE_APP_MQTT_PASSWORD', '')
        if topics and fu:
            try:
                lines = run_probe(['sub', fu, fp, ','.join(topics)])
                denied = [l.split()[-1] for l in lines if ' SUB DENIED ' in l]
                if denied:
                    FAIL('前端MQTT订阅权限', f'被拒: {denied}（批量订阅会整体失败→静默降级轮询）')
                elif any(' CONN_ERR ' in l for l in lines):
                    FAIL('前端MQTT订阅权限', '前端账号连接失败: ' + ' | '.join(lines))
                else:
                    PASS('前端MQTT订阅权限', f'{len(topics)}个topic全部可订阅')
            except Exception as e:
                FAIL('前端MQTT订阅权限', f'探针异常: {e}')
        # G. 后端→边缘 notify 端到端回路
        eu, ep = backend_env.get('EDGE_MQTT_USERNAME', ''), backend_env.get('EDGE_MQTT_PASSWORD', '')
        bu, bp = backend_env.get('MQTT_USERNAME', ''), backend_env.get('MQTT_PASSWORD', '')
        if eu and bu:
            try:
                lines = run_probe(['pubsub', bu, bp, eu, ep], timeout=20)
                if any('ROUNDTRIP_OK' in l for l in lines):
                    PASS('后端→边缘MQTT回路', 'notify/broadcast 收发正常')
                else:
                    FAIL('后端→边缘MQTT回路', ' | '.join(lines))
            except Exception as e:
                FAIL('后端→边缘MQTT回路', f'探针异常: {e}')

    # H. Node-RED 状态API
    if port_listening(1880) and api_key:
        try:
            st, d = http_json('http://127.0.0.1:1880/api/v10/monitor/status', headers={'x-api-key': api_key})
            if d.get('configReady'):
                PASS('边缘状态API', f"configReady=true, 设备 {d.get('onlineCount')}/{d.get('deviceCount')} 在线, PG成功 {d.get('pgSuccessCount')} 失败 {d.get('pgFailCount')}")
            else:
                FAIL('边缘状态API', f'configReady=false（配置未就绪，查kill switch/登录）')
            if (d.get('pgFailCount') or 0) > 0:
                WARN('PG写入失败计数', f"pgFailCount={d.get('pgFailCount')}")
        except urllib.error.HTTPError as e:
            FAIL('边缘状态API', f'HTTP {e.code}（检查页面/边缘apiKey一致性）')
        except Exception as e:
            FAIL('边缘状态API', f'异常: {e}')

    # I. 静态页 API key 一致性
    if os.path.exists(NR_STATIC_PAGE) and api_key:
        page = io.open(NR_STATIC_PAGE, encoding='utf-8', errors='replace').read()
        pm = re.search(r"var API_KEY = '([^']*)'", page)
        if pm and pm.group(1) == api_key:
            PASS('静态页API key', '与后端 MONITOR_API_KEY 一致')
        else:
            FAIL('静态页API key', '与后端不一致（轮换后未同步→页面401无数据）')

    # J. DB 心跳新鲜度
    try:
        import pymysql
        conn = pymysql.connect(host=backend_env.get('DB_HOST', '127.0.0.1'),
                               port=int(backend_env.get('DB_PORT', '3306')),
                               user=backend_env.get('DB_USERNAME', 'root'),
                               password=backend_env.get('DB_PASSWORD', ''),
                               database=backend_env.get('DB_DATABASE', 'ruoyi'))
        cur = conn.cursor()
        cur.execute("SELECT id, TIMESTAMPDIFF(SECOND, last_heartbeat, NOW()) FROM nodered_node WHERE last_heartbeat IS NOT NULL ORDER BY last_heartbeat DESC LIMIT 1")
        row = cur.fetchone()
        conn.close()
        if row and row[1] is not None and row[1] < 120:
            PASS('DB心跳新鲜度', f'node {row[0]} 心跳 {row[1]}s 前')
        elif row:
            FAIL('DB心跳新鲜度', f'node {row[0]} 心跳 {row[1]}s 前（>120s，边缘心跳链断裂）')
        else:
            WARN('DB心跳新鲜度', '无任何心跳记录')
    except Exception as e:
        FAIL('DB心跳新鲜度', f'异常: {e}')

    # K. PG 写入新鲜度（psql 回退，密码取注册表 EDGE_PG_PASSWORD）
    pg_pw = get_user_env('EDGE_PG_PASSWORD') or ''
    try:
        env = dict(os.environ, PGPASSWORD=pg_pw, PGCLIENTENCODING='UTF8')
        out = subprocess.run([PSQL, '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres',
                              '-t', '-c', 'SELECT EXTRACT(EPOCH FROM NOW()-MAX(insert_time))::int FROM edgelink.plc_data;'],
                             capture_output=True, text=True, timeout=10, env=env)
        age = int(out.stdout.strip())
        if age < 120:
            PASS('PG写入新鲜度', f'最新数据 {age}s 前')
        else:
            FAIL('PG写入新鲜度', f'最新数据 {age}s 前（>120s，采集/入库链断裂）')
    except Exception as e:
        WARN('PG写入新鲜度', f'无法检查: {e}')

    # L. spool 积压
    if os.path.isdir(NR_SPOOL_DIR):
        total = sum(os.path.getsize(os.path.join(NR_SPOOL_DIR, f)) for f in os.listdir(NR_SPOOL_DIR))
        if total == 0:
            PASS('PG spool积压', '0 字节')
        else:
            WARN('PG spool积压', f'{total/1048576:.1f} MB（PG故障兜底中，需关注）')

    # 汇总
    fails = [r for r in results if r[0] == 'FAIL']
    warns = [r for r in results if r[0] == 'WARN']
    print()
    print(f"===== 体检汇总: {len(results)-len(fails)-len(warns)} PASS / {len(warns)} WARN / {len(fails)} FAIL =====")
    for lv, n, d in fails:
        print(f"  待修: {n} — {d}")
    return 1 if fails else 0


if __name__ == '__main__':
    import urllib.parse
    sys.exit(main())
