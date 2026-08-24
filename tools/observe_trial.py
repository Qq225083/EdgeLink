#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""EdgeLink 试运行 24h 观察采样脚本（外部评审 P2-NEW-3 / 准入检查单第 5 节配套）

每小时采样一次：KPI（采集成功率相关）、PG 行数与增速、spool 积压、后端进程内存。
输出 CSV 到 logs/trial_observe_YYYYMMDD.csv，24h 后人工核对准入检查单第 5 节。

用法（后端运行期间）：
  python tools/observe_trial.py            # 每小时采样，持续运行
  python tools/observe_trial.py --once     # 只采一次（冒烟）
"""
import argparse
import csv
import json
import os
import time
import urllib.request
from datetime import datetime

if not os.getenv('PG_PASSWORD'):
    raise SystemExit('请先设置环境变量 PG_PASSWORD（凭据不入库）')

BACKEND = os.getenv('EL_BACKEND', 'http://127.0.0.1:9099')
PG = dict(host=os.getenv('PG_HOST', '127.0.0.1'), port=5432, dbname='postgres',
          user='postgres', password=os.getenv('PG_PASSWORD', ''))  # 🔧 凭据不入库：必须显式传 PG_PASSWORD
LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'logs')


def login():
    req = urllib.request.Request(BACKEND + '/login', method='POST',
                                 data=('username=admin&password=' + os.environ.get('EL_ADMIN_PASSWORD', '')).encode(),
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
    return json.loads(urllib.request.urlopen(req, timeout=8).read())['token']


def sample(token):
    row = {'ts': datetime.now().isoformat(timespec='seconds')}
    # KPI（后端接口）
    try:
        req = urllib.request.Request(BACKEND + '/monitor/kpi')
        req.add_header('Authorization', 'Bearer ' + token)
        d = json.loads(urllib.request.urlopen(req, timeout=8).read())
        kpi = d.get('data') or {}
        row['online_nodes'] = kpi.get('onlineNodes')
        row['total_nodes'] = kpi.get('totalNodes')
        row['active_alerts'] = kpi.get('activeAlerts')
        row['today_points'] = kpi.get('todayWriteCount')
    except Exception as e:
        row['kpi_error'] = str(e)[:80]
    # PG 行数与 spool
    try:
        import psycopg2  # 后端 venv 无 psycopg2 时用 psql 兜底
        conn = psycopg2.connect(**PG)
        cur = conn.cursor()
        cur.execute('SELECT count(*) FROM edgelink.plc_data')
        row['pg_rows'] = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM edgelink.plc_data WHERE insert_time > now() - interval '1 hour'")
        row['pg_rows_last_1h'] = cur.fetchone()[0]
        conn.close()
    except ImportError:
        import subprocess
        out = subprocess.run(
            ['D:/PostgreSQL/bin/psql', '-h', PG['host'], '-U', PG['user'], '-d', PG['dbname'], '-tAc',
             "SELECT count(*) FROM edgelink.plc_data"],
            env=dict(os.environ, PGPASSWORD=PG['password']), capture_output=True, text=True)
        row['pg_rows'] = out.stdout.strip()
    # spool 积压
    spool_dir = os.getenv('EL_SPOOL_DIR', 'D:/nodered/data/edgelink_pg_spool')
    total = 0
    if os.path.isdir(spool_dir):
        for f in os.listdir(spool_dir):
            try:
                total += os.path.getsize(os.path.join(spool_dir, f))
            except OSError:
                pass
    row['spool_bytes'] = total
    # 后端内存（netstat 不可知，用 KPI 的 memory 或跳过）
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--once', action='store_true')
    ap.add_argument('--interval-min', type=int, default=60)
    args = ap.parse_args()
    os.makedirs(LOG_DIR, exist_ok=True)
    csv_path = os.path.join(LOG_DIR, 'trial_observe_' + datetime.now().strftime('%Y%m%d') + '.csv')
    is_new = not os.path.exists(csv_path)
    token = login()
    while True:
        row = sample(token)
        if row.get('kpi_error'):  # token 过期重登一次
            try:
                token = login()
                row = sample(token)
            except Exception:
                pass
        with open(csv_path, 'a', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=sorted(row.keys()))
            if is_new:
                w.writeheader()
                is_new = False
            w.writerow(row)
        print(row.get('ts'), json.dumps(row, ensure_ascii=False))
        if args.once:
            break
        time.sleep(args.interval_min * 60)


if __name__ == '__main__':
    main()
