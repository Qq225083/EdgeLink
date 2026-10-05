"""生成器黄金快照对拍（防生成器回归）

原理：用一组固定的典型输入（MC 多块 / FX 八进制亚秒 / Modbus / PG 双目标 / api_key / 基础设施）
构建完整 flows，与 scripts/golden/flowgen_golden.json 逐字节比对。
生成器任何一处改动导致产物变化 → diff 失败并打印差异位置，强制人工确认"这次变化是故意的"。

用法：
  正常校验：APP_ENV=dev .venv/Scripts/python.exe scripts/test_flowgen_golden.py
  确认变更后重录快照：UPDATE_GOLDEN=1 ...同上
"""
import difflib
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from module_flowgen.entity.vo.flowgen_vo import FlowGenerateModel, PgTargetModel
from module_flowgen.service import flow_builders as fb
from module_flowgen.service.generator_service import GENERATOR_VERSION, FlowGeneratorService

GOLDEN_PATH = Path(__file__).resolve().parent / 'golden' / 'flowgen_golden.json'


def make_device(**kw):
    base = dict(
        id=101, device_name='冲压线1', host_pc_ip='10.81.8.34', plc_ip='192.168.1.10',
        plc_port=5007, plc_series='Q', mc_frame='3E', station_no=0, network_no=0,
        comm_timeout_ms=3000, scan_interval_ms=1000, trigger_kind=1, driver_code='mitsubishi_mc',
        protocol_params=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def make_tag(id_, addr, dev=101, reg='D', dt='INT16', **kw):
    base = dict(
        id=id_, device_id=dev, tag_name=f'点位{id_}', register_type=reg, register_address=str(addr),
        data_type=dt, unit='', eng_unit='', transform_type='none', transform_slope_a=1.0,
        transform_offset_b=0.0, bit_offset=None, calc_op=None, report_deadband_ms=0,
    )
    base.update(kw)
    return base


def build_canonical_flows() -> list:
    """覆盖生成器主要代码路径的典型输入。"""
    model = FlowGenerateModel(site_id=66, enable_pg=True, topic_prefix='edgelink/gen')
    pg_targets = [
        PgTargetModel(pg_db='ruoyi_pg', pg_schema='public', pg_table='plc_data_log'),
        PgTargetModel(pg_db='ruoyi_pg', pg_schema='edgelink', pg_table='his_log',
                      pg_fields=['tag_id', 'eng_value', 'ts']),
    ]
    gen = FlowGeneratorService
    flows: list = []

    # 设备1：MC Q 系列，多块读（连续 INT16 + FLOAT 前缀块 + BIT 连读）
    tags1 = [
        make_tag(1, 100), make_tag(2, 101), make_tag(3, 102),
        make_tag(4, 110, dt='FLOAT'), make_tag(5, 112, dt='FLOAT'),
        make_tag(6, 200, reg='M', dt='BIT', bit_offset=3),
        make_tag(7, 200, reg='M', dt='BIT', bit_offset=4),
    ]
    flows += gen._build_device_tab(model, 66, make_device(), tags1, api_key='test-key', pg_targets=pg_targets)

    # 设备2：FX 八进制 + 亚秒自循环 + 变化触发
    dev2 = make_device(id=102, device_name='老FX', plc_series='FX3U', scan_interval_ms=200, trigger_kind=2)
    flows += gen._build_device_tab(model, 66, dev2, [make_tag(8, 17, dev=102, reg='X', dt='BIT', bit_offset=0)],
                                   api_key='test-key', pg_targets=pg_targets)

    # 设备3：Modbus TCP 支路
    dev3 = make_device(id=109, device_name='汇川H5U', plc_port=502, driver_code='modbus_tcp',
                       protocol_params={'unitId': 3})
    tags3 = [make_tag(20, 0, dev=109, reg='HR'), make_tag(21, 1, dev=109, reg='HR'),
             make_tag(22, 10, dev=109, reg='HR'), make_tag(23, 0, dev=109, reg='CR', dt='BOOL')]
    flows += gen._build_device_tab_modbus(model, 66, dev3, tags3, api_key='test-key', pg_targets=pg_targets)

    # 基础设施 tab（与 generate() 同路径：排最前、共享配置、flows 上传、心跳支路）
    flows = gen._build_infra_tab(model, 'test-key', '10.81.8.34', pg_targets) + flows
    return flows


def main() -> int:
    flows = build_canonical_flows()
    current = json.dumps(flows, ensure_ascii=False, indent=2, sort_keys=True)

    if os.environ.get('UPDATE_GOLDEN') == '1':
        GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN_PATH.write_text(current, encoding='utf-8')
        print(f'[UPDATE] 黄金快照已重录：{GOLDEN_PATH}（{len(flows)} 节点）')
        return 0

    if not GOLDEN_PATH.exists():
        print(f'[FAIL] 快照不存在：{GOLDEN_PATH}（先 UPDATE_GOLDEN=1 录制）')
        return 1
    golden = GOLDEN_PATH.read_text(encoding='utf-8')
    if current == golden:
        print(f'[OK] 黄金快照一致（{len(flows)} 节点，生成器行为无回归）')
        return 0

    diff = list(difflib.unified_diff(golden.splitlines(), current.splitlines(), 'golden', 'current', n=2))
    print(f'[FAIL] 生成产物与黄金快照不一致（diff 共 {len(diff)} 行，前 60 行）：')
    print('\n'.join(diff[:60]))
    print('\n若此次变化为有意修改：UPDATE_GOLDEN=1 重录快照，并在提交说明里写明原因。')
    return 1


if __name__ == '__main__':
    sys.exit(main())
