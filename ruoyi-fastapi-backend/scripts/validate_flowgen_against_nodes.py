"""字段级 lint：生成产物 vs 真实节点包字段核对（OPT-14 / 评审 C9 机器守门）

输入：生成的 flows.json（或 --demo 用构建器现场生成一份全要素产物）
做法：
  1. 扫描节点包目录（默认 D:/nodered/data/node_modules + D:/nodered/node_modules），
     从各包 package.json 的 node-red.nodes 找到节点文件，从 .html 的 defaults 块抽合法字段名；
     核心节点从 @node-red/nodes/core 抽；
  2. switch 节点额外校验规则名（从 10-switch.js 的 operators 抽白名单）；
  3. 断言生成产物每个节点的字段名 ⊆ 合法字段（+ 通用字段），规则名 ⊆ 白名单；
  4. 节点类型未注册（包未安装）单独报错。

用法：
  cd ruoyi-fastapi-backend
  APP_ENV=dev .venv/Scripts/python.exe scripts/validate_flowgen_against_nodes.py            # demo 产物全量校验
  ...  validate_flowgen_against_nodes.py --flow path/to/flows.json                        # 校验指定产物
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 所有节点都允许的通用字段（Node-RED 运行时字段 + 编辑器字段）
UNIVERSAL_FIELDS = {
    'id', 'type', 'z', 'g', 'd', 'name', 'x', 'y', 'wires', 'outputs', 'inputs',
    'info', 'disabled', 'env', 'label', 'style', 'nodes', 'w', 'h', 'l',
}

# 编辑器/工作区级类型（不进任何节点包，属 Node-RED 内建结构）
BUILTIN_TYPES = {'tab', 'group', 'comment', 'subflow', 'subflow-env'}

NODE_MODULES_DIRS = [
    Path('D:/nodered/data/node_modules'),
    Path('D:/nodered/node_modules'),
]
CORE_NODES_DIR = Path('D:/nodered/node_modules/@node-red/nodes/core')


def extract_defaults_fields(html_path: Path) -> set:
    """从节点 .html 的 defaults: {...} 块抽顶层字段名（按最小缩进判定顶层键）。"""
    text = html_path.read_text(encoding='utf-8', errors='ignore')
    m = re.search(r'defaults\s*:\s*\{', text)
    if not m:
        return set()
    # 花括号配平取块文本
    i = m.end() - 1
    depth = 0
    end = len(text)
    for pos in range(i, len(text)):
        if text[pos] == '{':
            depth += 1
        elif text[pos] == '}':
            depth -= 1
            if depth == 0:
                end = pos
                break
    block = text[i:end]
    key_lines = []
    for line in block.split('\n')[1:]:
        km = re.match(r'(\s*)(\w+)\s*:', line)
        if km:
            key_lines.append((len(km.group(1)), km.group(2)))
    if not key_lines:
        return set()
    min_indent = min(ind for ind, _ in key_lines)
    return {k for ind, k in key_lines if ind == min_indent}


def extract_js_config_fields(js_path: Path) -> set:
    """从节点 .js 抽运行时接受的配置字段（config.X / n.X 读取模式）。

    依据：html defaults 只约束编辑器表单；运行时节点真正读的是构造参数
    （如 inject 的 repeat/crontab 在 2.x 已从 defaults 移除但运行时照读）。
    """
    text = js_path.read_text(encoding='utf-8', errors='ignore')
    fields = set(re.findall(r'\bconfig\.(\w+)', text))
    fields |= set(re.findall(r'\bn\.(\w+)', text))
    return fields


def build_type_index() -> tuple:
    """type 名 → (字段集合, 来源路径)；以及 switch 规则白名单。"""
    index: dict[str, tuple] = {}
    switch_ops: set = set()

    def scan_package(pkg_dir: Path):
        pkg_json = pkg_dir / 'package.json'
        if not pkg_json.exists():
            return
        try:
            pkg = json.loads(pkg_json.read_text(encoding='utf-8', errors='ignore'))
        except Exception:
            return
        nodes_map = (pkg.get('node-red') or {}).get('nodes') or {}
        for _name, rel in nodes_map.items():
            js_path = pkg_dir / rel
            html_path = js_path.with_suffix('.html')
            if not js_path.exists():
                continue
            js_text = js_path.read_text(encoding='utf-8', errors='ignore')
            js_fields = extract_js_config_fields(js_path)
            for tm in re.finditer(r"registerType\(['\"]([^'\"]+)['\"]", js_text):
                type_name = tm.group(1)
                fields = set(js_fields)
                if html_path.exists():
                    fields |= extract_defaults_fields(html_path)
                index[type_name] = (fields, str(js_path))

    for base in NODE_MODULES_DIRS:
        if not base.exists():
            continue
        for pkg_dir in base.iterdir():
            if pkg_dir.is_dir() and not pkg_dir.name.startswith('.') and not pkg_dir.name.startswith('@'):
                scan_package(pkg_dir)

    # 核心节点：core/**/*.html 都有 defaults；registerType 在 core/**/*.js
    if CORE_NODES_DIR.exists():
        for js_path in CORE_NODES_DIR.rglob('*.js'):
            js_text = js_path.read_text(encoding='utf-8', errors='ignore')
            js_fields = extract_js_config_fields(js_path)
            for tm in re.finditer(r"registerType\(['\"]([^'\"]+)['\"]", js_text):
                type_name = tm.group(1)
                html_path = js_path.with_suffix('.html')
                fields = set(js_fields)
                if html_path.exists():
                    fields |= extract_defaults_fields(html_path)
                index.setdefault(type_name, (fields, str(js_path)))
        # switch 规则白名单
        switch_js = CORE_NODES_DIR / 'function' / '10-switch.js'
        if switch_js.exists():
            text = switch_js.read_text(encoding='utf-8', errors='ignore')
            ops_m = re.search(r'var operators\s*=\s*\{(.*?)\n\s*\};', text, re.S)
            if ops_m:
                switch_ops = set(re.findall(r"'(\w+)'\s*:\s*function", ops_m.group(1)))

    return index, switch_ops


def build_demo_flow() -> list:
    """全要素 demo 产物：MC 支路 + Modbus 支路 + PG + 亚秒 + 基础设施（不连库）。"""
    from types import SimpleNamespace
    from module_flowgen.entity.vo.flowgen_vo import FlowGenerateModel
    from module_flowgen.service.generator_service import FlowGeneratorService as FG

    model = FlowGenerateModel(site_id=66, enable_pg=True)
    tag = dict(id=1, device_id=101, tag_name='t1', register_type='D', register_address='100',
               data_type='INT16', unit='', eng_unit='', transform_type='linear',
               transform_slope_a=1.5, transform_offset_b=0, bit_offset=None)
    bit_tag = dict(id=2, device_id=101, tag_name='b1', register_type='M', register_address='200',
                   data_type='BIT', unit='', eng_unit='', transform_type='none',
                   transform_slope_a=1.0, transform_offset_b=0, bit_offset=3)
    mc_dev = SimpleNamespace(id=101, device_name='MC测试', host_pc_ip='10.0.0.1:1880',
                             plc_ip='192.168.1.10', plc_port=5007, plc_series='FX3U', mc_frame='3E',
                             station_no=0, network_no=0, comm_timeout_ms=3000, scan_interval_ms=100,
                             trigger_kind=2, driver_code='mitsubishi_mc', protocol_params={'plcType': 'FX'})
    mb_dev = SimpleNamespace(id=102, device_name='MB测试', host_pc_ip='10.0.0.1:1880',
                             plc_ip='192.168.1.20', plc_port=502, plc_series='Q', mc_frame=None,
                             station_no=0, network_no=0, comm_timeout_ms=3000, scan_interval_ms=2000,
                             trigger_kind=1, driver_code='modbus_tcp', protocol_params={'unitId': 3})

    flows = []
    flows += FG._build_device_tab(model, 66, mc_dev, [tag, bit_tag], api_key='k')
    flows += FG._build_device_tab_modbus(model, 66, mb_dev, [tag], api_key='k')
    # 基础设施 tab（site-health + 心跳 + broker + pg config）
    from module_flowgen.service import flow_builders as fb
    infra_tab = fb.nid(66, 'tab', 'infra')
    flows.append(fb.make_tab(infra_tab, 'GEN_基础设施'))
    flows.append(fb.make_site_health(fb.nid('sh', 66), infra_tab, '127.0.0.1', 9099))
    flows.append(fb.make_mqtt_broker(fb.nid(66, 'broker'), 'MQTT broker', '127.0.0.1', 1883))
    flows.append(fb.make_pg_config(fb.nid(66, 'pgcfg'), '采集库', '127.0.0.1', 5432, 'ruoyi_pg'))
    fb.make_heartbeat_branch(flows, 66, infra_tab, '127.0.0.1', 9099, '10.0.0.1:1880', 'k', '1')
    return flows


def validate(flows: list, index: dict, switch_ops: set) -> list:
    """逐节点校验，返回问题清单（空 = 通过）。"""
    problems = []
    ids = set()
    for n in flows:
        nid_ = n.get('id', '?')
        ntype = n.get('type', '?')
        label = f'[{ntype}] {n.get("name") or nid_}'

        if nid_ in ids:
            problems.append(f'{label}: id 重复')
        ids.add(nid_)

        if ntype == 'comment':
            continue  # 注释节点只有通用字段

        if ntype in BUILTIN_TYPES:
            continue  # 编辑器/工作区级类型（tab/group 等），无节点包

        if ntype not in index:
            problems.append(f'{label}: 节点类型未注册（对应节点包未安装）')
            continue

        allowed, src = index[ntype]
        unknown = set(n.keys()) - allowed - UNIVERSAL_FIELDS
        if unknown:
            problems.append(f'{label}: 字段不被节点包接受 {sorted(unknown)}（{Path(src).name}）')

        if ntype == 'switch' and switch_ops:
            for rule in n.get('rules', []):
                if rule.get('t') not in switch_ops:
                    problems.append(f'{label}: 非法 switch 规则 {rule.get("t")}（白名单 {sorted(switch_ops)}）')

        # wires 引用闭合
        for out in n.get('wires', []):
            for target in out:
                if target not in ids and not any(f.get('id') == target for f in flows):
                    problems.append(f'{label}: wires 引用不存在的节点 {target}')
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--flow', help='flows.json 路径（缺省用构建器生成全要素 demo）')
    args = parser.parse_args()

    if args.flow:
        flows = json.loads(Path(args.flow).read_text(encoding='utf-8'))
        print(f'校验产物: {args.flow}（{len(flows)} 节点）')
    else:
        flows = build_demo_flow()
        print(f'校验 demo 产物（{len(flows)} 节点，含 MC/Modbus/PG/亚秒/基础设施全要素）')

    index, switch_ops = build_type_index()
    print(f'节点类型索引: {len(index)} 个类型（{len(switch_ops)} 个 switch 合法规则）')

    problems = validate(flows, index, switch_ops)
    if problems:
        print(f'\n发现 {len(problems)} 个问题:')
        for p in problems:
            print('  ✗', p)
        return 1
    print('✓ 全部通过：产物字段与已安装节点包完全吻合')
    return 0


if __name__ == '__main__':
    sys.exit(main())
