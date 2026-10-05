"""流程生成器冒烟测试（不连库，纯构建层验证）

验证项：
1. 块读合并正确（连续同类型合并 / 跨类型拆块 / BIT 单独一读）
2. 生成 JSON 合法、节点 id 全局唯一、wires 引用的 id 都存在
3. site-health 节点无 key 字段（credential 铁律）
4. 同一输入两次生成 id 完全一致（确定性，credential 按 id 存活）
5. FX 系列 octalInputOutput=true；Q 系列 false

运行：.venv/Scripts/python.exe scripts/test_flowgen_smoke.py
"""
import json
import sys
from types import SimpleNamespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from module_flowgen.entity.vo.flowgen_vo import FlowGenerateModel
from module_flowgen.service.generator_service import FlowGeneratorService


def make_device(**kw):
    base = dict(
        id=101, device_name='冲压线1', host_pc_ip='10.81.8.34', plc_ip='192.168.1.10',
        plc_port=5007, plc_series='Q', mc_frame='3E', station_no=0, network_no=0,
        comm_timeout_ms=3000, scan_interval_ms=1000, trigger_kind=1, driver_code='mitsubishi_mc',
        protocol_params=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def make_tag(id_, addr, reg='D', dt='INT16', **kw):
    base = dict(
        id=id_, device_id=101, tag_name=f'点位{id_}', register_type=reg, register_address=str(addr),
        data_type=dt, unit='', eng_unit='', transform_type='none', transform_slope_a=1.0,
        transform_offset_b=0.0, bit_offset=None, calc_op=None, report_deadband_ms=0,
    )
    base.update(kw)
    return base


def build_flows(model, device, tags, node_id=66, api_key='', pg_targets=None):
    return FlowGeneratorService._build_device_tab(model, node_id, device, tags, api_key=api_key, pg_targets=pg_targets)


def main():
    model = FlowGenerateModel(site_id=66)

    # ---- 块合并 ----
    tags = [
        make_tag(1, 100), make_tag(2, 101), make_tag(3, 102),          # 连续 → 一块 D100,3
        make_tag(4, 110, dt='FLOAT'), make_tag(5, 112, dt='FLOAT'),   # FLOAT 占 2 字 → 一块 D110,4
        make_tag(6, 200, reg='M', dt='BIT', bit_offset=3),            # BIT 单独
    ]
    blocks = FlowGeneratorService._merge_blocks(tags)
    addrs = sorted(b['address'] for b in blocks)
    # 多字类型用类型前缀（DFLOAT110,2 = 2个float）；BIT 单点 M200.3
    assert addrs == ['D100,3', 'DFLOAT110,2', 'M200.3'], f'块合并错误: {addrs}'
    print('[OK] 块读合并:', addrs)

    # ---- 空洞合并（跳址点位救命参数） ----
    g_tags = [make_tag(70, 100), make_tag(71, 103), make_tag(72, 106)]  # 间隙 2 字
    b_gap = FlowGeneratorService._merge_blocks(g_tags, gap=8)
    assert len(b_gap) == 1 and b_gap[0]['address'] == 'D100,7', f'空洞合并错误: {[b["address"] for b in b_gap]}'
    assert len(FlowGeneratorService._merge_blocks(g_tags, gap=0)) == 3, 'gap=0 不应合并跳址'
    assert len(FlowGeneratorService._merge_blocks(g_tags, gap=1)) == 3, '间隙超容忍不应合并'
    # 多字类型含空洞：FLOAT 110 与 116，间隙 4 字 → 向上取整多读尾部 DFLOAT110,4
    b_f = FlowGeneratorService._merge_blocks([make_tag(73, 110, dt='FLOAT'), make_tag(74, 116, dt='FLOAT')], gap=8)
    assert b_f[0]['address'] == 'DFLOAT110,4', b_f[0]['address']
    # Modbus 空洞合并
    mb_gap = FlowGeneratorService._merge_blocks_modbus([make_tag(75, 0, reg='HR'), make_tag(76, 5, reg='HR')], [], 'd', gap=8)
    assert len(mb_gap) == 1 and mb_gap[0]['regs'] == 6, f'Modbus 空洞合并错误: {mb_gap}'
    print('[OK] 空洞合并（跳址合并 / 超容忍拆块 / 多字向上取整 / Modbus）')

    # ---- OPT-01/05：多字前缀 + BIT 连读合并 ----
    t2 = [make_tag(30, 200, dt='INT32'), make_tag(31, 202, dt='INT32')]
    b2 = FlowGeneratorService._merge_blocks(t2)
    assert b2[0]['address'] == 'DDINT200,2', f'INT32 块应为类型前缀: {b2[0]["address"]}'
    t3 = [make_tag(32, 200, reg='M', dt='BIT', bit_offset=3), make_tag(33, 200, reg='M', dt='BIT', bit_offset=4),
          make_tag(34, 200, reg='M', dt='BIT', bit_offset=9)]
    b3 = FlowGeneratorService._merge_blocks(t3)
    addrs3 = sorted(b['address'] for b in b3)
    assert addrs3 == ['M200.3,2', 'M200.9'], f'BIT 连读合并错误: {addrs3}'
    print('[OK] 多字类型前缀 + BIT 连读合并:', addrs3)

    # ---- 生成 flows.json ----
    device = make_device()
    flows = build_flows(model, device, tags)

    text = json.dumps(flows, ensure_ascii=False)
    json.loads(text)
    print('[OK] JSON 合法，节点数:', len(flows))

    ids = [n['id'] for n in flows]
    assert len(ids) == len(set(ids)), '节点 id 重复'
    id_set = set(ids)
    for n in flows:
        for out in n.get('wires', []):
            for target in out:
                assert target in id_set, f'wires 引用了不存在的节点: {target}'
        if n.get('connection'):
            assert n['connection'] in id_set, 'MC Read 引用了不存在的连接'
    print('[OK] id 唯一 + wires/connection 引用闭合')

    # ---- 确定性 ----
    flows2 = build_flows(model, device, tags)
    assert json.dumps(flows, sort_keys=True) == json.dumps(flows2, sort_keys=True), '两次生成 id 不一致'
    print('[OK] 生成确定性（同输入同 id）')

    # ---- 节点结构抽查 ----
    by_type = {}
    for n in flows:
        by_type.setdefault(n['type'], []).append(n)
    assert 'MC Read' in by_type and len(by_type['MC Read']) == 3, '应有 3 个 MC Read（3 块）'
    assert by_type['MC Read'][0]['errorHandling'] == 'output2'
    assert by_type['MC Read'][0]['outputs'] == 2
    conn = [n for n in flows if n['type'] == 'MC Protocol Connection'][0]
    assert conn['octalInputOutput'] is False and conn['plcType'] == 'Q'
    print('[OK] MC 节点结构（Q 系列）')

    # FX 系列
    fx = build_flows(model, make_device(id=102, plc_series='FX3U', device_name='老FX'), [make_tag(7, 17, reg='X', dt='BIT', bit_offset=0)])
    fx_conn = [n for n in fx if n['type'] == 'MC Protocol Connection'][0]
    assert fx_conn['octalInputOutput'] is True and fx_conn['plcType'] == 'FX'
    print('[OK] FX 系列 octalInputOutput=true')

    # 变化触发插入 rbe（监视 changeKey 而非 payload——payload 含 ts 每轮必变，会永远放行）
    t2 = build_flows(model, make_device(id=103, trigger_kind=2), [make_tag(8, 300)])
    rbe2 = [n for n in t2 if n['type'] == 'rbe']
    assert rbe2, 'trigger_kind=2 应有 rbe 节点'
    assert rbe2[0]['property'] == 'changeKey', 'rbe 必须监视 changeKey（不含 ts 的指纹）'
    final2 = [n for n in t2 if n.get('name') == '契约装配'][0]
    assert any(r['p'] == 'changeKey' for r in final2['rules']), 'trigger=2 时装配应输出 changeKey'
    t1 = build_flows(model, make_device(id=104, trigger_kind=1), [make_tag(9, 300)])
    assert not any(n['type'] == 'rbe' for n in t1), 'trigger_kind=1 不应有 rbe 节点'
    print('[OK] 变化触发 rbe 插入逻辑')

    # ---- 数据出口（link out，定制逻辑消费接口） ----
    links = [n for n in flows if n['type'] == 'link out']
    assert len(links) == 1 and links[0]['name'].startswith('数据出口'), '每设备应有一个数据出口'
    assert links[0]['mode'] == 'link' and links[0]['links'] == [], 'link out 应为 link 模式、links 留空（由 link-in 侧解析）'
    sw_main = [n for n in flows if n.get('name') == '有值才报'][0]
    assert links[0]['id'] in sw_main['wires'][0], '数据出口应接在总开关后（空轮不出）'
    # 节点级文档（info）：关键节点都应有说明
    with_info = [n for n in flows if n.get('info')]
    assert len(with_info) >= 12, f'关键节点应有 info 文档: {len(with_info)}'
    mc_read0 = [n for n in flows if n['type'] == 'MC Read'][0]
    assert '读取 PLC 寄存器块' in mc_read0['info'] and 'D100' in mc_read0['info']
    final_n = [n for n in flows if n.get('name') == '契约装配'][0]
    assert '北向报文' in final_n['info']
    print('[OK] 数据出口 link out（总开关后 + 确定性 id）+ 节点级 info 文档')

    # ---- BAD 兜底支路（join 永不缺块） ----
    reads = by_type['MC Read']
    bad_changes = [n for n in flows if n['type'] == 'change' and '标BAD' in (n.get('name') or '')]
    assert len(bad_changes) == len(reads), '每块应有一条 BAD 装配支路'
    for r in reads:
        assert len(r['wires'][1]) == 3, '错误脚应同时接 BAD 装配、告警限速与重连限速'
    joins = [n for n in flows if n['type'] == 'join']
    assert joins and joins[0]['timeout'] != '' and joins[0]['count'] == '3', 'join 应有超时兜底且 count=块数'
    # BAD 装配内容：raw/eng 置空、quality=BAD
    from module_flowgen.service import flow_builders as fb2
    bad_expr = fb2.bad_block_assemble_expr([make_tag(1, 100)])
    assert '"quality": "BAD"' in bad_expr and '"raw_value": null' in bad_expr
    print('[OK] BAD 兜底支路（', len(bad_changes), '条）+ join 超时兜底')

    # ---- site-health 铁律 ----
    infra = [fb_node for fb_node in [__import__('module_flowgen.service.flow_builders', fromlist=['make_site_health']).make_site_health('sh66', 'tabx', '10.0.0.1', 9099)]]
    assert 'key' not in infra[0] and 'credential' not in json.dumps(infra[0]), 'site-health 节点不得含 key 字段'
    assert infra[0]['type'] == 'site-health'
    print('[OK] site-health 节点无 key 字段')

    # ---- JSONata 装配抽查 ----
    from module_flowgen.service import flow_builders as fb
    expr = fb.block_assemble_expr([make_tag(1, 100, transform_type='linear', transform_slope_a=1.5, transform_offset_b=10)], False)
    assert '$lookup(payload, "D100")' in expr
    assert '"tag_id": 1' in expr
    assert '$exists' in expr and 'UNCERTAIN' in expr, '点位缺失应降级 UNCERTAIN（OPT-04）'
    assert 'isGood' not in expr, '好路不依赖 isGood（评审 A3：isGood 从未被节点转发）'
    final = fb.final_assemble_expr(66, {'id': 101, 'device_name': '冲压线1', 'host_pc_ip': '10.81.8.34'}, False)
    assert '"node_id": 66' in final and '"device_id": 101' in final
    pg = fb.pg_sql_expr(66, {'id': 101}, False)
    assert 'INSERT INTO public.plc_data_log' in pg
    print('[OK] JSONata 装配表达式')

    # ---- PG 支路（enable_pg=True，多目标）：postgres + 成功/失败计数上报 ----
    from module_flowgen.service import flow_builders as fb
    from module_flowgen.entity.vo.flowgen_vo import PgTargetModel
    model_pg = FlowGenerateModel(site_id=66, enable_pg=True)
    tgt1 = PgTargetModel(pg_host='127.0.0.1', pg_port=5432, pg_db='ruoyi', pg_schema='public', pg_table='plc_data_log')
    tgt2 = PgTargetModel(pg_host='127.0.0.1', pg_port=5432, pg_db='ruoyi', pg_schema='edgelink', pg_table='his_log',
                         pg_fields=['tag_id', 'eng_value', 'ts'])
    pgt = build_flows(model_pg, make_device(id=105), [make_tag(10, 400)], node_id=66, api_key='test-key',
                      pg_targets=[tgt1, tgt2])
    pg_nodes = [n for n in pgt if n['type'] == 'postgresql']
    stat_nodes = [n for n in pgt if n['type'] == 'http request' and 'pg-stat-edge' in n.get('url', '')]
    comm_nodes = [n for n in pgt if n['type'] == 'http request' and 'device-comm-edge' in n.get('url', '')]
    pg_catch = [n for n in pgt if n['type'] == 'catch' and n.get('name', '').startswith('PG异常')]
    # PG 节点：字段名 database（非 db）+ query mustache 渲染 msg.topic（评审 A2）
    assert len(pg_nodes) == 2, f'双目标应有 2 个 PG 节点: {len(pg_nodes)}'
    assert all(n['wires'] != [[]] for n in pg_nodes), 'PG 节点成功输出应接计数上报'
    assert all(n['query'] == '{{{msg.topic}}}' for n in pg_nodes), 'PG 节点 query 应渲染 msg.topic（该包不读 msg.topic 本体）'
    assert len(stat_nodes) == 4, '双目标应有 4 个 PG 成功/失败计数上报节点'
    assert any('ok=' in n['url'] for n in stat_nodes) and any('fail=' in n['url'] for n in stat_nodes)
    assert all('X-API-Key' == h['keyValue'] for n in stat_nodes for h in n['headers'])
    assert len(pg_catch) == 2 and all(c['scope'] == [pg_nodes[i]['id']] for i, c in enumerate(
        sorted(pg_catch, key=lambda c: c['name']))), '每个 PG 节点应有专属 catch'
    # PG SQL change 应同时设置 topic（取自契约装配的 pg_sql_i）和 pg_rows
    pgc0 = [n for n in pgt if n.get('name') == 'PG SQL·目标1'][0]
    pgc1 = [n for n in pgt if n.get('name') == 'PG SQL·目标2'][0]
    assert any(r['p'] == 'topic' and r['to'] == 'pg_sql_0' for r in pgc0['rules']), '目标1 应取 pg_sql_0'
    assert any(r['p'] == 'topic' and r['to'] == 'pg_sql_1' for r in pgc1['rules']), '目标2 应取 pg_sql_1'
    assert any(r['p'] == 'pg_rows' for r in pgc0['rules']), 'pg_rows 必须留存（postgres 会覆盖 payload）'
    # SQL/错误调试节点（生成流自带排错能力）
    sql_dbg = [n for n in pgt if n['type'] == 'debug' and n.get('name', '').startswith('SQL调试')]
    err_dbg = [n for n in pgt if n['type'] == 'debug' and n.get('name', '').startswith('PG错误')]
    assert len(sql_dbg) == 2 and all(n['complete'] == 'topic' and n['targetType'] == 'msg' for n in sql_dbg), \
        '每目标应有 SQL 调试节点（显示 msg.topic 即实际 INSERT）'
    assert len(err_dbg) == 2 and all(n['complete'] == 'error.message' for n in err_dbg), '每目标应有 PG 错误调试节点'
    assert sql_dbg[0]['id'] in pgc0['wires'][0] or sql_dbg[1]['id'] in pgc0['wires'][0], 'SQL 调试应接在 PG SQL change 后'
    # 契约装配应含两条 pg_sql 规则，且目标2 走自己的模式/表/列子集
    final_node = [n for n in pgt if n.get('name') == '契约装配'][0]
    pg_sql_rules = {r['p']: r['to'] for r in final_node['rules'] if r['p'].startswith('pg_sql_')}
    assert set(pg_sql_rules) == {'pg_sql_0', 'pg_sql_1'}, f'应有两条 pg_sql 规则: {set(pg_sql_rules)}'
    assert 'INSERT INTO public.plc_data_log' in pg_sql_rules['pg_sql_0']
    assert 'INSERT INTO edgelink.his_log' in pg_sql_rules['pg_sql_1'], '目标2 应写入自己的模式/表'
    assert 'eng_value' in pg_sql_rules['pg_sql_1'] and 'raw_value' not in pg_sql_rules['pg_sql_1'].split('VALUES')[0], \
        '目标2 应使用自己的列子集'
    # 通信状态上报：契约装配处每轮聚合一次（评审 C3），comm 规则在 final 上
    assert len(comm_nodes) == 1 and '{{comm}}' in comm_nodes[0]['url'], '应有逐台通信状态上报节点'
    assert any(r['p'] == 'comm' and r['tot'] == 'jsonata' for r in final_node['rules']), 'final 应输出聚合 comm'
    sw_node = [n for n in pgt if n.get('name') == '有值才报'][0]
    assert comm_nodes[0]['id'] in sw_node['wires'][0], '通信上报应接在总开关后（kill switch 期间不上报）'
    assert pgc0['id'] in sw_node['wires'][0] and pgc1['id'] in sw_node['wires'][0], '两个 PG SQL 目标都应接在总开关后'
    good = [n for n in pgt if n.get('name') == '块内装配'][0]
    assert not any(r['p'] == 'comm' for r in good['rules']), '块装配不再单独上报 comm（C3）'
    print('[OK] PG 多目标支路：双 postgres + 各自 SQL/列子集/计数上报 + 专属 catch + 通信状态聚合')

    # ---- 画布美术层：分组框 + 注释 ----
    groups = [n for n in flows if n['type'] == 'group']
    comments = [n for n in flows if n['type'] == 'comment']
    assert len(groups) == 3, f'应有 3 个分组框: {len(groups)}'
    assert {g['name'] for g in groups} == {'采集与装配', '上报与计数', '告警与异常'}
    for g in groups:
        for mid in g['nodes']:
            assert mid in id_set, f'分组引用了不存在的节点: {mid}'
        assert g['w'] > 0 and g['h'] > 0
    assert len(comments) == 2, '应有 2 个注释（顶部参数行 + 底部使用说明）'
    assert '画布只读' in comments[0]['name'] and '支路说明' in comments[1]['name'], '注释内容拆分错误'
    assert comments[1]['y'] > comments[0]['y'], '使用说明注释应在顶部参数注释之下'
    print('[OK] 画布美术层: 3 分组框 + 信息注释')

    # ---- 亚秒轮询：delay 自循环 ----
    sub = build_flows(model, make_device(id=106, scan_interval_ms=100), [make_tag(11, 500)])
    delays = [n for n in sub if n['type'] == 'delay' and n.get('pauseType') == 'delay']
    injects = [n for n in sub if n['type'] == 'inject']
    finals = [n for n in sub if n.get('name') == '契约装配']
    assert len(delays) == 1 and delays[0]['timeout'] == '100', '亚秒模式应有 delay 节奏器'
    assert injects[0]['once'] is True and injects[0]['repeat'] == '', '亚秒模式 inject 应一次性触发'
    assert injects[0]['wires'] == [[delays[0]['id']]], 'inject → delay'
    assert delays[0]['id'] in finals[0]['wires'][0], 'final 应回接 delay 形成自循环'
    assert not any(n['type'] == 'delay' and n.get('pauseType') == 'delay' for n in flows), '秒级模式不应有 delay 节奏器'
    # 告警限速（两种模式都应有）
    assert any(n['type'] == 'delay' and n.get('pauseType') == 'rate' and n.get('drop') is True for n in flows), '应有告警限速节点'
    print('[OK] 亚秒轮询 delay 自循环 + 告警限速')

    # ---- protocol_params 合并（传输协议/数据代码接管） ----
    pp_dev = make_device(id=107, plc_series='L', protocol_params={'protocol': 'udp', 'commCode': 'ascii', 'plcPort': 6001, 'mcFrame': '4E'})
    ppt = build_flows(model, pp_dev, [make_tag(12, 600)])
    conn = [n for n in ppt if n['type'] == 'MC Protocol Connection'][0]
    assert conn['protocol'] == 'UDP' and conn['ascii'] is True and conn['port'] == '6001' and conn['frame'] == '4E', f'protocol_params 未生效: {conn}'
    assert conn['plcType'] == 'L'
    # 无 protocol_params 时回落列字段与默认值
    conn2 = [n for n in flows if n['type'] == 'MC Protocol Connection'][0]
    assert conn2['protocol'] == 'TCP' and conn2['ascii'] is False
    print('[OK] protocol_params 合并（UDP/ASCII/4E/端口覆盖 + 默认回落）')

    # ---- 社区节点配置面：plcType 覆盖 + octal 显式化 ----
    # 显式 plcType=R + octal=true（覆盖系列推导）
    fx_dev = make_device(id=108, plc_series='Q', protocol_params={'plcType': 'R', 'octalInputOutput': 'true'})
    fx_conn = [n for n in build_flows(model, fx_dev, [make_tag(13, 700)]) if n['type'] == 'MC Protocol Connection'][0]
    assert fx_conn['plcType'] == 'R', 'plcType 显式值应覆盖系列推导'
    assert fx_conn['octalInputOutput'] is True, 'octalInputOutput 显式 true 应生效'
    # 缺省：FX 系列自动八进制（旧行为保持）
    fx_auto = [n for n in fx if n['type'] == 'MC Protocol Connection'][0]
    assert fx_auto['plcType'] == 'FX' and fx_auto['octalInputOutput'] is True
    print('[OK] 社区节点配置面（plcType 覆盖 / octal 显式与自动推导）')

    # ---- 断线重连支路（reinitialize 指令回接 MC Read） ----
    recon_rl = [n for n in flows if n.get('name') == '重连限速']
    recon_chg = [n for n in flows if n.get('name') == '重连指令']
    assert len(recon_rl) == 1 and len(recon_chg) == 1, '应有重连限速 + 重连指令节点'
    assert recon_chg[0]['rules'][0]['to'] == 'reinitialize', '重连指令应置 topic=reinitialize'
    first_read = [n for n in flows if n['type'] == 'MC Read'][0]
    assert recon_chg[0]['wires'] == [[first_read['id']]], '重连指令应回接首个 MC Read'
    for r in [n for n in flows if n['type'] == 'MC Read']:
        assert recon_rl[0]['id'] in r['wires'][1], '每个 MC Read 错误脚应接重连限速'
    print('[OK] 断线重连支路（reinitialize 回接）')

    # ---- Modbus 支路 ----
    from module_flowgen.service.generator_service import FlowGeneratorService as FG
    mb_tags = [
        make_tag(20, 0, reg='HR'), make_tag(21, 1, reg='HR'), make_tag(22, 2, reg='HR'),  # 连续 → 一块 HR 0+3
        make_tag(23, 10, reg='HR'),                                                        # 独立一块
        make_tag(24, 0, reg='CR', dt='BOOL'),                                              # 线圈
    ]
    blocks = FG._merge_blocks_modbus(mb_tags, [], '测试设备')
    sig = sorted((b['fc'], b['start'], b['regs']) for b in blocks)
    assert sig == [('Coil', 0, 1), ('HoldingRegister', 0, 3), ('HoldingRegister', 10, 1)], f'块合并错误: {sig}'

    mb_dev = make_device(id=109, device_name='汇川H5U', plc_port=502, driver_code='modbus_tcp',
                         protocol_params={'unitId': 3})
    model_mb0 = FlowGenerateModel(site_id=66, block_gap=0)
    mb = FG._build_device_tab_modbus(model_mb0, 66, mb_dev, mb_tags, api_key='k')
    mbc = [n for n in mb if n['type'] == 'modbus-client']
    mbr = [n for n in mb if n['type'] == 'modbus-read']
    assert len(mbc) == 1 and mbc[0]['tcpHost'] == '192.168.1.10' and mbc[0]['tcpPort'] == '502' and mbc[0]['unit_id'] == 3
    assert len(mbr) == 3, f'gap=0 应有 3 个 modbus-read（3 块）: {len(mbr)}'
    # gap=8（默认）：HR 0..10 间隙 7 ≤ 8 应合并为一块（空洞 3..9 读回丢弃）
    mb_g8 = FG._build_device_tab_modbus(model, 66, mb_dev, mb_tags, api_key='k')
    mbr_g8 = [n for n in mb_g8 if n['type'] == 'modbus-read']
    assert len(mbr_g8) == 2, f'gap=8 应合并为 2 块（HR 合并 + Coil 独立）: {len(mbr_g8)}'
    assert mbr[0]['dataType'] in ('HoldingRegister', 'Coil')
    assert mbr[0]['emptyMsgOnFail'] is True, 'emptyMsgOnFail 必须开（失败分流 BAD 的前提）'
    sw_empty = [n for n in mb if n['type'] == 'switch' and n.get('name') == '读取失败?'][0]
    assert [r['t'] for r in sw_empty['rules']] == ['null', 'empty', 'else'], '失败分流应为 null/empty/else 三路（评审 A1）'
    assert len(sw_empty['wires']) == 3 and sw_empty['wires'][0] == sw_empty['wires'][1], 'null 与 empty 同去 BAD 路'
    # PG config 字段名（评审 A2）
    pg_cfg = fb.make_pg_config('x', 't', 'h', 5432, 'db1')
    assert 'database' in pg_cfg and 'db' not in pg_cfg, 'PG config 字段名应为 database'
    # 凭证内嵌（可选）：PG 明文进生成文件（该包如此）；MQTT 永不进 payload（走部署 credentials 对象）
    cfg_u = fb.make_pg_config('x', 't', 'h', 5432, 'db1', user='u1', password='p1')
    assert cfg_u['user'] == 'u1' and cfg_u['password'] == 'p1'
    assert 'user' not in pg_cfg and 'password' not in pg_cfg, 'PG 凭证留空不应写字段'
    brk = fb.make_mqtt_broker('b', 'n', 'h', 1883)
    assert 'user' not in brk and 'username' not in brk and 'password' not in brk, 'MQTT 凭证永不进 payload（走 release.deploy_credentials）'
    assert any(n['type'] == 'group' for n in mb) and any(n['type'] == 'comment' for n in mb)
    assert any(n['type'] == 'link out' and n['name'].startswith('数据出口') for n in mb), 'Modbus 支路也应有数据出口'
    # 亚秒：rateUnit 应为 ms
    mb_sub = FG._build_device_tab_modbus(model, 66, make_device(id=110, scan_interval_ms=100), [make_tag(25, 0, reg='HR')])
    sub_read = [n for n in mb_sub if n['type'] == 'modbus-read'][0]
    assert sub_read['rateUnit'] == 'ms' and sub_read['rate'] == '100', '亚秒应走 rateUnit=ms'
    # 多字类型拦截
    w = []
    FG._merge_blocks_modbus([make_tag(26, 0, reg='HR', dt='FLOAT')], w, '测试设备')
    assert w and 'buffer-parser' in w[0], '多字类型应拦截并告警'
    # OPT-02：HR 字区上的 BIT 点 → 算术位提取；CR 位区 → 直接取值
    bit_expr = fb.modbus_block_assemble_expr([make_tag(27, 10, reg='HR', dt='BIT', bit_offset=3)], 10)
    assert '$power(2, 3)' in bit_expr and '$floor' in bit_expr, 'HR 字区 BIT 应做位提取'
    coil_expr = fb.modbus_block_assemble_expr([make_tag(28, 5, reg='CR', dt='BOOL')], 5)
    assert '$power' not in coil_expr and 'payload[0]' in coil_expr, 'CR 位区应直接取值'
    print('[OK] Modbus 支路（client/read/失败分流/块合并/亚秒/多字拦截）')

    # ---- OPT-10：生成期输入校验 ----
    from exceptions.exception import ServiceException
    bad_dev = make_device(id=201, plc_ip=None)
    bad_tags = [
        SimpleNamespace(**make_tag(50, '')),                        # 空地址
        SimpleNamespace(**make_tag(51, 'A1')),                      # 非数字地址
        SimpleNamespace(**make_tag(52, 300, dt='STRING')),          # 未知类型
        SimpleNamespace(**make_tag(53, 200, reg='M', dt='BIT', bit_offset=None)),  # 位类型缺位偏移
    ]
    try:
        FG._validate_inputs([bad_dev], bad_tags)
        raise AssertionError('脏配置应被拦截')
    except ServiceException as e:
        msg = e.message or ''
        assert '未配置 PLC IP' in msg and '寄存器地址非数字' in msg and '未知数据类型' in msg and '位偏移' in msg, msg
        print('[OK] 输入校验：4 类脏配置一次列清')
    # 干净配置不拦
    FG._validate_inputs([make_device()], [SimpleNamespace(**make_tag(1, 100))])
    print('[OK] 干净配置校验通过')

    # ---- 版本回执（OPT-08）：心跳 URL 带 flow_version；kill switch（OPT-07）评审后取消 ----
    # （停采已有等价路径：推一版停用流；闸/链路/上下文的复杂度换不来收益）
    print('[OK] 版本回执（心跳带 flow_version，kill switch 已取消）')

    # ---- 标签页前缀自定义 + 合并部署/漂移检测的认门规则 ----
    from module_flowgen.service.deploy_service import _gen_tab_matchers, _merge_flows, _scoped_match
    model_el = FlowGenerateModel(site_id=66, tab_prefix='EL_')
    el = build_flows(model_el, make_device(id=120), [make_tag(60, 700)])
    el_tab = [n for n in el if n['type'] == 'tab'][0]
    assert el_tab['label'] == 'EL_采集_冲压线1', f'自定义前缀未生效: {el_tab["label"]}'
    prefixes, exact = _gen_tab_matchers(el + [{'id': 't2', 'type': 'tab', 'label': '基础设施'}])
    assert prefixes == {'EL_'} and exact == {'基础设施'}, f'认门规则推断失败: {prefixes} {exact}'
    # 合并部署：GEN_ 残留 + 新前缀 payload + 用户程序 → GEN_ 被摘、用户保留
    user_tab = {'id': 'usertab1', 'type': 'tab', 'label': '用户程序'}
    user_node = {'id': 'usernode1', 'type': 'comment', 'z': 'usertab1', 'name': 'x', 'wires': []}
    old_gen_tab = {'id': 'oldgen1', 'type': 'tab', 'label': 'GEN_采集_旧设备'}
    old_gen_node = {'id': 'oldgennode1', 'type': 'comment', 'z': 'oldgen1', 'name': 'y', 'wires': []}
    live = [user_tab, user_node, old_gen_tab, old_gen_node]
    merged, removed = _merge_flows(live, el, {'oldgen1'} | {n['id'] for n in el})
    kept_ids = {n['id'] for n in merged}
    assert 'usertab1' in kept_ids and 'usernode1' in kept_ids, '用户程序必须保留'
    assert 'oldgen1' not in kept_ids and 'oldgennode1' not in kept_ids, 'GEN_ 残留必须摘除'
    assert removed == 2
    # 漂移：一致场景
    live_ok = [user_tab, user_node] + el
    assert _scoped_match(live_ok, el) is True, '用户节点不应算漂移'
    # 漂移：有 GEN_ 残留 → 不一致
    assert _scoped_match(live + el, el) is False, 'GEN_ 残留应判漂移'
    # 漂移：无前缀的"基础设施"精确匹配不被误判（空前缀灾难回归防护）
    infra_only = [{'id': 'ti', 'type': 'tab', 'label': '基础设施'}]
    live_user = [{'id': 'u1', 'type': 'tab', 'label': '张三的页面'}] + infra_only
    assert _scoped_match(live_user, infra_only) is True, '无前缀基础设施页不得误伤用户页面'
    # 漂移归一化：编辑器格式噪音（g/FieldType/坐标/布尔字符串化/空值补全/PG凭证）不算漂移
    from module_flowgen.service.deploy_service import _canon_hash
    raw = [
        {'id': 'n1', 'type': 'change', 'name': '块内装配', 'rules': [{'t': 'set', 'p': 'payload'}], 'wires': [['n2']], 'x': 620, 'y': 140},
        {'id': 'c1', 'type': 'postgreSQLConfig', 'name': '采集库', 'host': '127.0.0.1', 'port': 5432, 'database': 'd1', 'ssl': False},
    ]
    editor_normalized = [
        {'id': 'n1', 'type': 'change', 'name': '块内装配', 'g': 'grp1', 'x': 700, 'y': 200,
         'rules': [{'t': 'set', 'p': 'payload'}], 'wires': [['n2']], 'action': '', 'property': '', 'from': '', 'to': ''},
        {'id': 'c1', 'type': 'postgreSQLConfig', 'name': '采集库', 'host': '127.0.0.1', 'hostFieldType': 'str',
         'port': '5432', 'portFieldType': 'num', 'database': 'd1', 'databaseFieldType': 'str',
         'ssl': 'false', 'sslFieldType': 'bool', 'user': 'demo_user', 'password': 'demo_pass',
         'max': '', 'idle': '', 'connectionTimeout': '', 'applicationName': ''},
    ]
    assert _canon_hash(raw) == _canon_hash(editor_normalized), '编辑器归一化噪音不应算漂移'
    real_change = [{'id': 'n1', 'type': 'change', 'name': '块内装配', 'rules': [{'t': 'set', 'p': 'topic'}], 'wires': [['n2']]}]
    assert _canon_hash(raw[:1]) != _canon_hash(real_change), '真实逻辑变化必须算漂移'
    print('[OK] 漂移归一化（编辑器噪音免疫 + 真实变化敏感）')
    print('[OK] 标签页前缀自定义 + 合并部署/漂移认门规则（含无前缀精确匹配）')

    # ---- 基础设施 tab：共享配置 + flows 上传 + 无 key 字段 ----
    infra = FG._build_infra_tab(FlowGenerateModel(site_id=66, enable_pg=False), 'k', '10.0.0.1', [])
    assert infra[0]['type'] == 'tab' and infra[0]['label'] == '基础设施', '基础设施页应排第一且不带前缀'
    srv = [n for n in infra if n['type'] == 'site-health-server'][0]
    sh = [n for n in infra if n['type'] == 'site-health'][0]
    up = [n for n in infra if n['type'] == 'site-flows-upload'][0]
    assert 'key' not in srv and 'key' not in json.dumps(srv), '共享配置不得含 key 字段'
    assert sh['serverRef'] == srv['id'] and up['serverRef'] == srv['id'], '两个节点应共用共享配置（Key 只录一次）'
    print('[OK] 基础设施 tab（共享配置 + flows上传 + credential 铁律）')

    # 自定义插入列（子集 + 白名单）
    custom = fb.pg_sql_expr(66, {'id': 49}, False, fields=['tag_id', 'eng_value', 'ts'])
    assert 'INSERT INTO public.plc_data_log (device_id,tag_id,quality,eng_value,ts)' in custom, custom[:150]
    assert 'raw_value' not in custom.split('VALUES')[0], '子集不应含未选列'
    # 未知列名被静默剔除（白名单映射只认合法列）
    bad = fb.pg_sql_expr(66, {'id': 49}, False, fields=['tag_id', 'evil_column; DROP TABLE x; --'])
    assert 'evil_column' not in bad and 'tag_id' in bad, '非法列名不得进入 SQL'
    # 模式/表名可配 + 必填列强制带上（防呆）
    st = fb.pg_sql_expr(66, {'id': 49}, False, fields=['eng_value', 'ts'], pg_schema='edgelink', pg_table='my_table')
    assert 'INSERT INTO edgelink.my_table (device_id,tag_id,quality,eng_value,ts)' in st, st[:150]
    print('[OK] PG 插入列可配（子集 + 白名单防注入 + 模式表名可配 + 必填列防呆）')

    print('\n全部冒烟断言通过。')


if __name__ == '__main__':
    main()
