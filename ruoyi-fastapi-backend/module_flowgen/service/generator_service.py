"""过渡版流程生成器 — 生成服务

职责：读配置（plc_device/plc_tag/plc_driver + site_health_site + plc_config_snapshot），
调 flow_builders 纯函数组装完整 flows.json（全量目标状态），sha256 幂等落库 plc_flow_release。

纪律：
- 北向契约（MQTT topic 结构/payload 字段）与 V13 完全一致（topic 前缀参数化）；
- 任何密钥/密码不写入生成 JSON（site-health key、MQTT/PG 凭证均为 credential，现场录入一次）；
- 一 PLC 一条独立支路（独立 tab + 独立 MC 连接 config 节点）。
"""
import hashlib
import json
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from exceptions.exception import ServiceException
from module_flowgen.dao.flowgen_dao import FlowgenDao
from module_flowgen.entity.do.flowgen_do import PlcFlowRelease
from module_flowgen.entity.vo.flowgen_vo import FlowGenerateModel
from module_flowgen.service import flow_builders as fb
from module_plc.entity.do.config_snapshot_do import PlcConfigSnapshot
from module_plc.entity.do.device_do import PlcDevice
from module_plc.entity.do.driver_do import PlcDriver
from module_plc.entity.do.monitor_do import NoderedNode
from module_plc.entity.do.tag_do import PlcTag
from module_site_health.entity.do.site_health_do import SiteHealthSite

# 各数据类型占用寄存器字数（块读合并用）
_WORDS_PER_TYPE = {'INT16': 1, 'UINT16': 1, 'INT32': 2, 'UINT32': 2, 'FLOAT': 2, 'DOUBLE': 4}
# MC 库类型名前缀（多字类型地址串用，探针实证：DFLOAT100,2 返回解析后数组）
_MC_TYPE_PREFIX = {'INT32': 'DINT', 'UINT32': 'DWORD', 'FLOAT': 'FLOAT', 'DOUBLE': 'REAL'}
# 单块寄存器数上限（MC 3E 一帧上限 960 字，保守取半）
_BLOCK_MAX_REGS = 480
# 部署性能警戒值（社区实测 500+ 节点部署 20-30s）
_NODE_COUNT_WARN = 500

# 生成器版本（OPT-13 留痕：release.remark + 产物注释节点）
GENERATOR_VERSION = '1.1.1'


class FlowGeneratorService:
    """流程生成服务"""

    # ==================== 取数 ====================

    @classmethod
    async def _load_site(cls, db: AsyncSession, site_id: int) -> SiteHealthSite:
        result = await db.execute(select(SiteHealthSite).where(SiteHealthSite.id == site_id))
        site = result.scalar_one_or_none()
        if not site:
            raise ServiceException(message=f'采集点不存在：site_id={site_id}')
        if not site.office_ip:
            raise ServiceException(message='采集点未登记办公网IP，无法匹配设备')
        return site

    @classmethod
    async def _load_devices(cls, db: AsyncSession, site: SiteHealthSite) -> tuple[list[PlcDevice], list[str]]:
        """按 host_pc_ip = 办公网IP（或 办公网IP:端口）匹配该现场的启用设备。"""
        host_keys = [site.office_ip]
        if site.node_port:
            host_keys.append(f'{site.office_ip}:{site.node_port}')
        result = await db.execute(
            select(PlcDevice)
            .where(
                PlcDevice.del_flag == '0',
                PlcDevice.status == '0',
                PlcDevice.host_pc_ip.in_(host_keys),
            )
            .order_by(PlcDevice.id)
        )
        return result.scalars().all(), host_keys

    @classmethod
    async def _load_tags(cls, db: AsyncSession, device_ids: list[int]) -> list[PlcTag]:
        if not device_ids:
            return []
        result = await db.execute(
            select(PlcTag)
            .where(PlcTag.del_flag == '0', PlcTag.status == '0', PlcTag.device_id.in_(device_ids))
            .order_by(PlcTag.device_id, PlcTag.sort_order, PlcTag.id)
        )
        return result.scalars().all()

    @classmethod
    async def _load_drivers(cls, db: AsyncSession) -> dict:
        result = await db.execute(select(PlcDriver))
        return {d.driver_code: d for d in result.scalars().all()}

    @classmethod
    async def _load_config_version(cls, db: AsyncSession) -> int:
        result = await db.execute(select(PlcConfigSnapshot).order_by(PlcConfigSnapshot.id).limit(1))
        snap = result.scalars().first()
        return snap.version if snap else 0

    # ==================== 生成期输入校验（OPT-10：脏配置一次性列清单，不 500、不产生 release） ====================

    @classmethod
    def _validate_inputs(cls, devices: list, tags: list) -> None:
        """生成前前置校验：收集全部问题一次性报错（而非第一个就 ValueError 500）。"""
        errors: list[str] = []
        valid_types = set(_WORDS_PER_TYPE) | {'BIT', 'BOOL'}

        for d in devices:
            if not d.plc_ip:
                errors.append(f'设备[{d.device_name}](id={d.id}) 未配置 PLC IP')
            try:
                int(d.plc_port or 0)
            except (TypeError, ValueError):
                errors.append(f'设备[{d.device_name}](id={d.id}) PLC 端口非数字：「{d.plc_port}」')

        for t in tags:
            addr = (t.register_address or '').strip()
            try:
                int(addr)
            except (TypeError, ValueError):
                errors.append(f'点位[{t.tag_name}](id={t.id}) 寄存器地址非数字：「{t.register_address}」')
            dt = (t.data_type or '').upper()
            if dt not in valid_types:
                errors.append(f'点位[{t.tag_name}](id={t.id}) 未知数据类型：「{t.data_type}」（支持 {"、".join(sorted(valid_types))}）')
            if dt in ('BIT', 'BOOL') and t.bit_offset is None:
                errors.append(f'点位[{t.tag_name}](id={t.id}) 位类型未填位偏移（0-15）')

        # 多字类型的字节序/字序同设备一致性（块读合并假定一致，与 OPT-01 联动）
        by_dev: dict[int, dict] = {}
        for t in tags:
            dt = (t.data_type or '').upper()
            if _WORDS_PER_TYPE.get(dt, 1) > 1:
                dev_set = by_dev.setdefault(t.device_id, {'bo': set(), 'wo': set(), 'name': t.tag_name})
                dev_set['bo'].add(t.byte_order or '')
                dev_set['wo'].add(t.word_order or '')
        for dev_id, s in by_dev.items():
            if len(s['bo']) > 1 or len(s['wo']) > 1:
                errors.append(f'设备 id={dev_id} 的多字点位字节序/字序不一致（块读要求同设备一致）')

        if errors:
            raise ServiceException(message='配置校验未通过（未生成任何版本）：\n' + '\n'.join(errors))

    @classmethod
    async def _resolve_node_id(cls, db: AsyncSession, site: SiteHealthSite, host_keys: list[str], warnings: list) -> tuple[int, str]:
        """解析契约用的 node_id（nodered_node.id，与 V12/V13 一致；不是 site_health_site.id）。

        按 host_pc_ip 查采集节点注册表；没有则预注册（与心跳自动注册同语义），
        保证生成报文里的 node_id 是真实注册 id。
        """
        result = await db.execute(select(NoderedNode).where(NoderedNode.host_pc_ip.in_(host_keys)))
        node = result.scalars().first()
        host_key = node.host_pc_ip if node else host_keys[-1]
        if not node:
            node = NoderedNode(
                node_name=site.site_name,
                office_net_ip=site.office_ip,
                host_pc_ip=host_key,
                status=1,
                created_at=datetime.now(),
                updated_at=datetime.now(),
            )
            db.add(node)
            await db.flush()
            warnings.append(f'采集节点未注册，已预注册：{host_key} → node_id={node.id}')
        return node.id, host_key

    # ==================== 块读合并（生成期完成，V13 是运行期做） ====================

    @staticmethod
    def _merge_blocks(tags: list[dict], gap: int = 0) -> list[dict]:
        """把点位按 寄存器类型分组 → 地址排序 → 连续（或间隙≤gap 字）同类型合并为块。

        BIT/BOOL 不参与合并（单个一读，位号进地址串）。
        gap>0 时允许块内带空洞（跳址点位的救命参数：多读几字丢弃，换少几百次请求）；
        空洞计入块字数（受 _BLOCK_MAX_REGS 上限约束），装配只取登记点位。
        返回 [{address, tags}]，address 即 MC Read 的地址串。
        """
        groups: dict[str, list[dict]] = {}
        for tag in tags:
            groups.setdefault(tag['register_type'], []).append(tag)

        blocks = []
        for reg_type, group in groups.items():
            group.sort(key=lambda t: int(t['register_address']))
            # BIT/BOOL：同寄存器类型内按 (字地址, 位号) 排序，连续位合并连读（M200.3,4 式，探针实证可用）
            bit_tags = [t for t in group if (t.get('data_type') or '').upper() in ('BIT', 'BOOL')]
            word_tags = [t for t in group if (t.get('data_type') or '').upper() not in ('BIT', 'BOOL')]
            if bit_tags:
                bit_tags.sort(key=lambda t: int(t['register_address']) * 16 + int(t.get('bit_offset') or 0))
                cur_bits = None
                for tag in bit_tags:
                    bit_idx = int(tag['register_address']) * 16 + int(tag.get('bit_offset') or 0)
                    if cur_bits and bit_idx == cur_bits['end_bit'] and cur_bits['count'] + 1 <= _BLOCK_MAX_REGS:
                        cur_bits['tags'].append(tag)
                        cur_bits['end_bit'] = bit_idx + 1
                        cur_bits['count'] += 1
                    else:
                        cur_bits = {'start_addr': int(tag['register_address']), 'start_bit': int(tag.get('bit_offset') or 0),
                                    'end_bit': bit_idx + 1, 'count': 1, 'tags': [tag]}
                        blocks.append(cur_bits)
            cur = None
            for tag in word_tags:
                data_type = (tag.get('data_type') or 'INT16').upper()
                words = _WORDS_PER_TYPE.get(data_type, 1)
                addr = int(tag['register_address'])
                hole = addr - cur['end'] if cur else 0
                if (
                    cur
                    and cur['data_type'] == data_type
                    and 0 <= hole <= gap
                    and cur['regs'] + hole + words <= _BLOCK_MAX_REGS
                ):
                    cur['tags'].append(tag)
                    cur['end'] = addr + words
                    cur['regs'] += hole + words
                else:
                    cur = {'data_type': data_type, 'start': addr, 'end': addr + words, 'regs': words, 'tags': [tag]}
                    blocks.append(cur)
        # 汇总块地址串
        result = []
        for b in blocks:
            if 'address' in b:
                result.append(b)  # 单个 BIT（A4 修复时已成型）
            elif 'start_bit' in b:
                # BIT 连读块：类型+字地址.起始位,位数（探针实证：M200.3,4 返回布尔数组）
                addr = f'{b["tags"][0]["register_type"]}{b["start_addr"]}.{b["start_bit"]:X}'
                if b['count'] > 1:
                    addr += f',{b["count"]}'
                result.append({'address': addr, 'tags': b['tags']})
            else:
                dt = b['data_type']
                prefix = _MC_TYPE_PREFIX.get(dt, '')
                start = b['start']
                if prefix and _WORDS_PER_TYPE.get(dt, 1) > 1:
                    # 多字类型：类型前缀地址串（OPT-01，探针实证 DFLOAT100,2 → 解析后数组）
                    # 计数单位=条目数（非寄存器数）；含空洞时向上取整多读尾部，装配按地址取值不受影响
                    items = -(-b['regs'] // _WORDS_PER_TYPE[dt])
                    result.append({'address': f'{b["tags"][0]["register_type"]}{prefix}{start},{items}', 'tags': b['tags']})
                else:
                    result.append({'address': f'{b["tags"][0]["register_type"]}{start},{b["regs"]}', 'tags': b['tags']})
        return result

    # ==================== 支路组装 ====================

    @staticmethod
    def _resolve_dev(device: PlcDevice) -> dict:
        """设备参数解析（MC/Modbus 共用）：protocol_params JSON 优先，列字段兜底。"""
        pp = device.protocol_params or {}
        if isinstance(pp, str):
            try:
                import json as _json
                pp = _json.loads(pp)
            except Exception:
                pp = {}
        plc_series_upper = (device.plc_series or 'Q').upper()
        plc_type = pp.get('plcType') or ('FX' if 'FX' in plc_series_upper else ('L' if 'L' in plc_series_upper else 'Q'))
        octal_raw = pp.get('octalInputOutput')
        octal = (plc_type == 'FX') if octal_raw in (None, '') else str(octal_raw).lower() == 'true'
        return {
            'id': device.id,
            'device_name': device.device_name,
            'host_pc_ip': device.host_pc_ip,
            'plc_ip': device.plc_ip,
            'plc_port': pp.get('plcPort') or device.plc_port,
            'plc_series': device.plc_series,
            'plc_type': plc_type,
            'octal_input_output': octal,
            'mc_frame': pp.get('mcFrame') or device.mc_frame,
            'station_no': pp.get('stationNo', device.station_no),
            'network_no': pp.get('networkNo', device.network_no),
            'comm_timeout_ms': device.comm_timeout_ms,
            # 传输协议/通信数据代码：TCP/UDP、二进制/ASCII（community 节点原生支持）
            'protocol': str(pp.get('protocol') or 'TCP').upper(),
            'ascii': str(pp.get('commCode') or 'binary').lower() == 'ascii',
            # Modbus 从站号
            'unit_id': pp.get('unitId') or 1,
        }

    @classmethod
    def _build_device_tab(cls, model: FlowGenerateModel, node_id: int, device: PlcDevice, tags: list[dict],
                          api_key: str = '', warnings: list | None = None, pg_targets: list | None = None) -> list:
        """一台 PLC = 一个 tab 的完整节点列表（含连线）。"""
        dev = cls._resolve_dev(device)
        site_id = model.site_id
        tab_id = fb.nid(site_id, 'tab', device.id)
        conn_id = fb.nid(site_id, 'conn', device.id)
        inject_id = fb.nid(site_id, 'inject', device.id)
        final_id = fb.nid(site_id, 'final', device.id)
        rbe_id = fb.nid(site_id, 'rbe', device.id)
        switch_id = fb.nid(site_id, 'switch', device.id)
        mqtt_id = fb.nid(site_id, 'mqtt', device.id)
        alarm_change_id = fb.nid(site_id, 'alarmc', device.id)
        alarm_tpl_id = fb.nid(site_id, 'alarmt', device.id)
        alarm_mqtt_id = fb.nid(site_id, 'alarmm', device.id)
        catch_id = fb.nid(site_id, 'catch', device.id)
        broker_id = fb.nid(site_id, 'broker')

        octal_xy = dev['octal_input_output']
        blocks = cls._merge_blocks(tags, model.block_gap)
        multi = len(blocks) > 1
        # 亚秒轮询：inject 最低 1 秒，<1000ms 改用 delay 自循环（自背压：周期=管道耗时+延迟）
        sub_second = (device.scan_interval_ms or 1000) < 1000
        block_read_ids = [fb.nid(site_id, 'read', device.id, i) for i in range(len(blocks))]
        block_change_ids = [fb.nid(site_id, 'bchg', device.id, i) for i in range(len(blocks))]
        block_bad_ids = [fb.nid(site_id, 'bbad', device.id, i) for i in range(len(blocks))]
        join_id = fb.nid(site_id, 'join', device.id)
        delay_id = fb.nid(site_id, 'delay', device.id)
        alarm_rl_id = fb.nid(site_id, 'alarmrl', device.id)
        recon_rl_id = fb.nid(site_id, 'reconrl', device.id)
        recon_change_id = fb.nid(site_id, 'recon', device.id)

        trigger_change = (device.trigger_kind or 1) == 2

        nodes = [fb.make_tab(tab_id, f'{model.tab_prefix}采集_{device.device_name}')]

        # 连接（每 PLC 独立）+ 轮询（≥1s 用 inject 周期；<1s 用 inject 一次性 + delay 自循环）
        nodes.append(fb.make_mc_connection(conn_id, tab_id, f'{device.device_name} 连接', dev))
        if sub_second:
            nodes.append(fb.make_inject(inject_id, tab_id, f'[{device.device_name}] 启动', device.scan_interval_ms, [[delay_id]], once=True))
            nodes.append(fb.make_delay(delay_id, tab_id, f'节奏 {device.scan_interval_ms}ms', device.scan_interval_ms, [block_read_ids]))
        else:
            nodes.append(fb.make_inject(inject_id, tab_id, f'[{device.device_name}] 轮询', device.scan_interval_ms, [block_read_ids]))

        # 块读 + 块内装配（好路）+ BAD 装配（坏路：join 永远收得齐块数，杜绝静默丢轮）
        # 通信状态在契约装配处每轮聚合上报一次（评审 C3：原为每块每轮一次，K 块 K 次 POST 且后写覆盖语义错）
        comm_http_id = fb.nid(site_id, 'comm', device.id)
        for i, block in enumerate(blocks):
            read_wires = [[block_change_ids[i]], [block_bad_ids[i], alarm_rl_id, recon_rl_id]]
            nodes.append(
                fb.make_mc_read(
                    block_read_ids[i], tab_id, f'[{device.device_name}] 读 {block["address"]}', conn_id, block['address'], read_wires
                )
            )
            rules = [fb.rule_set_jsonata('payload', fb.block_assemble_expr(block['tags'], octal_xy))]
            if multi:
                rules.append(fb.rule_set_str('topic', f'block{i:02d}'))
            nodes.append(fb.make_change(block_change_ids[i], tab_id, '块内装配', rules, [[join_id if multi else final_id]]))

            bad_rules = [fb.rule_set_jsonata('payload', fb.bad_block_assemble_expr(block['tags']))]
            if multi:
                bad_rules.append(fb.rule_set_str('topic', f'block{i:02d}'))
            bad_node = fb.make_change(block_bad_ids[i], tab_id, f'块{i}失败标BAD', bad_rules, [[join_id if multi else final_id]])
            bad_node['y'] = 40
            nodes.append(bad_node)

        if api_key:
            nodes.append(fb.make_comm_stat_node(comm_http_id, tab_id, '通信状态上报', model.backend_host, model.backend_port, node_id, device.id, api_key))

        if multi:
            # 超时兜底：2 倍通信超时（秒），正常路径坏块由 BAD 装配保证不依赖它
            join_timeout_s = max(2, round((device.comm_timeout_ms or 3000) * 2 / 1000))
            nodes.append(fb.make_join(join_id, tab_id, len(blocks), [[final_id]], timeout_s=join_timeout_s))

        # 最终装配（MQTT 契约 + 变化指纹 + 可选 PG SQL）——node_id 用 nodered_node.id（V12/V13 契约）
        final_rules = []
        if model.enable_pg:
            # 先暂存未剥离 transform_type 的 values，供 pg_sql 拼 INSERT 用（须在规则1 之前）
            final_rules.append(fb.rule_set_jsonata('pg_values', fb.pg_values_expr(multi)))
        final_rules.append(fb.rule_set_jsonata('payload', fb.final_assemble_expr(node_id, dev, multi)))
        if trigger_change:
            # changeKey 不含 ts：rbe 监视它才有意义（payload 里 ts 每轮必变，直接监视会永远放行）
            final_rules.append(fb.rule_set_jsonata('changeKey', fb.change_key_expr(multi)))
        if api_key:
            # 设备级通信状态：每轮一次，任一块 BAD 即离线（评审 C3）
            final_rules.append(fb.rule_set_jsonata('comm', fb.comm_expr(multi)))
        if model.enable_pg and pg_targets:
            # 多目标写库：每个目标一条 pg_sql_i（字段子集/模式/表各自独立）
            for ti, tgt in enumerate(pg_targets):
                final_rules.append(fb.rule_set_jsonata(f'pg_sql_{ti}', fb.pg_sql_expr(
                    node_id, dev, multi, fields=tgt.pg_fields, pg_schema=tgt.pg_schema, pg_table=tgt.pg_table)))
        downstream = rbe_id if trigger_change else switch_id
        # 亚秒自循环：final 每轮必触发（join 有 BAD 兜底），从它回接 delay 重启下一轮
        final_wires = [downstream] + ([delay_id] if sub_second else [])
        nodes.append(fb.make_change(final_id, tab_id, '契约装配', final_rules, [final_wires], x=1010 if not multi else 1000))

        if trigger_change:
            nodes.append(fb.make_rbe(rbe_id, tab_id, [[switch_id]]))

        # 空轮过滤 → 两路输出 + 通信状态上报 + 数据出口（接在总开关后，空轮不出）
        link_id = fb.nid(site_id, 'link', device.id)
        fan_out = [mqtt_id] + ([fb.nid(site_id, 'pgc', device.id, ti) for ti in range(len(pg_targets or []))] if model.enable_pg and pg_targets else []) + ([comm_http_id] if api_key else []) + [link_id]
        nodes.append(fb.make_switch_nonempty(switch_id, tab_id, [fan_out], x=1230))
        # 数据出口（link out）：定制逻辑消费接口，用户在自己标签页 link in 连它（确定性 id，重部署连线存活）
        nodes.append(fb.make_link_out(link_id, tab_id, f'数据出口·{device.device_name}'))

        topic = f'{model.topic_prefix}/data/{node_id}/{device.id}'
        nodes.append(fb.make_mqtt_out(mqtt_id, tab_id, 'MQTT 上报', topic, broker_id, x=1470))

        pg_branch_ids = []  # 供分组框收集
        if model.enable_pg and pg_targets:
            for ti, tgt in enumerate(pg_targets):
                pgc = fb.nid(site_id, 'pgc', device.id, ti)
                pgn = fb.nid(site_id, 'pg', device.id, ti)
                pgcatch = fb.nid(site_id, 'pgcatch', device.id, ti)
                pgok = fb.nid(site_id, 'pgok', device.id, ti)
                pgfail = fb.nid(site_id, 'pgfail', device.id, ti)
                pgdbg = fb.nid(site_id, 'pgdbg', device.id, ti)
                pgedbg = fb.nid(site_id, 'pgedbg', device.id, ti)
                pg_branch_ids += [pgc, pgn, pgcatch, pgdbg, pgedbg] + ([pgok, pgfail] if api_key else [])
                pg_rules = [fb.rule_set_jsonata('topic', f'pg_sql_{ti}'), fb.rule_set_jsonata('pg_rows', 'payload.value_count')]
                nodes.append(fb.make_change(pgc, tab_id, f'PG SQL·目标{ti + 1}', pg_rules, [[pgn, pgdbg]]))
                # SQL 调试：把实际 INSERT 语句打到调试侧栏（排错用，可在编辑器关停）
                nodes.append(fb.make_debug(pgdbg, tab_id, f'SQL调试·目标{ti + 1}', 'topic'))
                nodes.append(fb.make_pg_node(pgn, tab_id, f'写采集历史·目标{ti + 1}', fb.nid(site_id, 'pgcfg', ti)))
                if api_key:
                    nodes[-1]['wires'] = [[pgok]]
                    nodes.append(fb.make_pg_stat_node(pgok, tab_id, f'PG成功计数·目标{ti + 1}', model.backend_host, model.backend_port, node_id, device.id, 'ok', api_key))
                    nodes.append(fb.make_pg_stat_node(pgfail, tab_id, f'PG失败计数·目标{ti + 1}', model.backend_host, model.backend_port, node_id, device.id, 'fail', api_key))
                    nodes.append(fb.make_catch(pgcatch, tab_id, f'PG异常·目标{ti + 1}', [pgn], [[pgfail, pgedbg]]))
                else:
                    # 无 key 时 PG 失败走告警链（与 api_key 解耦，评审 C6）
                    nodes.append(fb.make_catch(pgcatch, tab_id, f'PG异常·目标{ti + 1}', [pgn], [[alarm_rl_id, pgedbg]]))
                # 错误调试：把 PG 报错原文打到调试侧栏（解决"只计数看不到原因"）
                nodes.append(fb.make_debug(pgedbg, tab_id, f'PG错误·目标{ti + 1}', 'error.message'))

        # 告警支路：MC Read 错误脚 + catch → 限速（30s/条，防洪）→ ts → template → mqtt
        nodes.append(fb.make_rate_limit(alarm_rl_id, tab_id, '告警限速', 30, [[alarm_change_id]]))
        # 断线重连支路：错误脚 → 限速（15s/次）→ reinitialize 指令 → 回接首个 MC Read（连接池按设备共享，重建一次即可）
        nodes.append(fb.make_rate_limit(recon_rl_id, tab_id, '重连限速', 15, [[recon_change_id]]))
        nodes.append(fb.make_reconnect_change(recon_change_id, tab_id, [[block_read_ids[0]]]))
        nodes.append(fb.make_change(alarm_change_id, tab_id, '告警时间戳', [fb.rule_set_jsonata('ts', fb.TS_EXPR)], [[alarm_tpl_id]], x=570, y=160))
        nodes.append(fb.make_template(alarm_tpl_id, tab_id, '告警报文', fb.alarm_template_text(node_id, dev), [[alarm_mqtt_id]], x=790, y=160))
        alarm_topic = f'{model.topic_prefix}/alarm/plc_offline/{device.id}'
        nodes.append(fb.make_mqtt_out(alarm_mqtt_id, tab_id, '告警上报', alarm_topic, broker_id, x=1010, y=160))

        catch_scope = (
            [inject_id, final_id, switch_id, mqtt_id]
            + block_read_ids
            + block_change_ids
            + block_bad_ids
            + ([join_id] if multi else [])
            + ([rbe_id] if trigger_change else [])
        )
        nodes.append(fb.make_catch(catch_id, tab_id, '支路异常', catch_scope, [[alarm_rl_id]]))

        # ==================== 画布布局（分组框 + 注释，纯美术层） ====================
        K = len(blocks)
        y0 = 140
        row_h = 110
        center_y = y0 + (K - 1) * row_h // 2
        up_y = y0 + K * row_h + 90      # 上报行
        n_pg = len(pg_targets) if (model.enable_pg and pg_targets) else 0
        alarm_y = up_y + max(100, n_pg * 80 + 20)   # 告警/异常行（PG 目标多时下移让位）

        coords = {inject_id: (140, center_y)}
        if sub_second:
            coords[delay_id] = (140, center_y + 48)
        for i in range(K):
            coords[block_read_ids[i]] = (380, y0 + i * row_h)
            coords[block_change_ids[i]] = (620, y0 + i * row_h)
            coords[block_bad_ids[i]] = (620, y0 + i * row_h + 48)
        if multi:
            coords[join_id] = (860, center_y)
        coords[final_id] = (1080, center_y)
        if trigger_change:
            coords[rbe_id] = (1300, center_y)
        coords[switch_id] = (1300 if not trigger_change else 1520, center_y)
        coords[mqtt_id] = (1780, up_y)
        coords[link_id] = (2010, up_y)
        if api_key:
            coords[comm_http_id] = (620, up_y)
        if model.enable_pg and pg_targets:
            for ti in range(len(pg_targets)):
                coords[fb.nid(site_id, 'pgc', device.id, ti)] = (1080, up_y + ti * 80)
                coords[fb.nid(site_id, 'pg', device.id, ti)] = (1300, up_y + ti * 80)
                coords[fb.nid(site_id, 'pgdbg', device.id, ti)] = (1300, up_y + ti * 80 + 40)
                if api_key:
                    coords[fb.nid(site_id, 'pgok', device.id, ti)] = (1520, up_y + ti * 80)
                    coords[fb.nid(site_id, 'pgfail', device.id, ti)] = (1300, alarm_y + ti * 80)
                coords[fb.nid(site_id, 'pgcatch', device.id, ti)] = (1080, alarm_y + ti * 80)
                coords[fb.nid(site_id, 'pgedbg', device.id, ti)] = (1300, alarm_y + ti * 80 + 40)
        coords[catch_id] = (140, alarm_y)
        coords[alarm_rl_id] = (460, alarm_y)
        coords[alarm_change_id] = (660, alarm_y)
        coords[alarm_tpl_id] = (860, alarm_y)
        coords[alarm_mqtt_id] = (1060, alarm_y)
        coords[recon_rl_id] = (460, alarm_y + 48)
        coords[recon_change_id] = (660, alarm_y + 48)

        for n in nodes:
            if n['id'] in coords:
                n['x'], n['y'] = coords[n['id']]

        def _bbox(member_ids):
            pts = [coords[i] for i in member_ids if i in coords]
            minx = min(p[0] for p in pts)
            maxx = max(p[0] for p in pts)
            miny = min(p[1] for p in pts)
            maxy = max(p[1] for p in pts)
            return (minx - 50, miny - 45, maxx - minx + 250, maxy - miny + 130)

        g1 = (
            [inject_id]
            + ([delay_id] if sub_second else [])
            + block_read_ids
            + block_change_ids
            + block_bad_ids
            + ([join_id] if multi else [])
            + [final_id]
            + ([rbe_id] if trigger_change else [])
            + [switch_id]
        )
        nodes.append(fb.make_group(fb.nid(site_id, 'grp1', device.id), tab_id, '采集与装配', g1, _bbox(g1), '#e8f4fd'))

        g2 = (
            ([comm_http_id] if api_key else [])
            + (pg_branch_ids if (model.enable_pg and pg_targets) else [])
            + [mqtt_id, link_id]
        )
        nodes.append(fb.make_group(fb.nid(site_id, 'grp2', device.id), tab_id, '上报与计数', g2, _bbox(g2), '#e9f7e8'))

        g3 = [catch_id, alarm_rl_id, alarm_change_id, alarm_tpl_id, alarm_mqtt_id, recon_rl_id, recon_change_id]
        nodes.append(fb.make_group(fb.nid(site_id, 'grp3', device.id), tab_id, '告警与异常', g3, _bbox(g3), '#fdecea'))

        # 顶部信息注释（一行设备参数，对齐管道列）；底部使用说明（逐阶段工作原理教程）
        trigger_label = '变化触发' if trigger_change else '固定周期'
        gap_note = f' | 空洞容忍 {model.block_gap}字' if model.block_gap > 0 else ''
        info_head = (
            f'📦 {device.device_name} | PLC {device.plc_ip}:{device.plc_port} | 周期 {device.scan_interval_ms}ms'
            f' | 点位 {len(tags)} | 块读 {K}{gap_note} | {trigger_label}\n'
            '流程版本 __FLOWVER__ · EdgeLink 生成器产物 · 画布只读，配置变更请到后台重新生成部署'
        )
        info_guide = (
            '【支路说明】这个页面是怎么工作的\n'
            f'① 轮询：inject 每 {device.scan_interval_ms}ms 触发一轮（变化触发模式先过 rbe，值没变整条静默）\n'
            '② 块读：每个 MC Read 按地址串读一块寄存器（如 D100,4 = D100~D103 共 4 字；含空洞时多读回来再丢弃）\n'
            '③ 块内装配：把原始值按点位拆成 values[]（工程值换算 + quality=GOOD/UNCERTAIN）；\n'
            '   失败标BAD：该块读取失败时造一块全 BAD 空值，保证下游 join 永远收得齐块数，不会静默丢轮\n'
            '④ join 合并：各块按 topic=blockNN 拼回一个对象（超时兜底防卡死）\n'
            '⑤ 契约装配：拼成北向报文（node_id/device_id/values[]/quality），顺带生成 PG SQL 与通信状态\n'
            '⑥ 有值才报：空轮过滤后四路输出——MQTT 上报（实时数据）、PG 写库（SQL调试/PG错误 两个观察口）、\n'
            '   通信状态上报（任一块 BAD 即报离线）、数据出口·' + device.device_name + '（link out）\n'
            '⑦ 告警与异常（下方红区）：错误脚 → 限速30s → MQTT 告警；重连限速15s → reinitialize 指令回接首个 MC Read\n'
            '【定制逻辑】新建自己的标签页，用 link in 连「数据出口·' + device.device_name + '」拿每轮数据，勿改本页——下次部署会被覆盖'
        )
        nodes.append(fb.make_comment(fb.nid(site_id, 'note', device.id), tab_id, info_head, 380, 50))
        nodes.append(fb.make_comment(fb.nid(site_id, 'note2', device.id), tab_id, info_guide, 380, alarm_y + 140))

        # 节点级文档（选中节点 → 右侧信息栏）
        pg_n = len(pg_targets or [])
        ids = {
            'inject': inject_id, 'delay': delay_id, 'join': join_id, 'final': final_id, 'rbe': rbe_id,
            'switch': switch_id, 'mqtt': mqtt_id, 'comm': comm_http_id, 'link': link_id,
            'alarm_rl': alarm_rl_id, 'alarm_change': alarm_change_id, 'alarm_tpl': alarm_tpl_id,
            'alarm_mqtt': alarm_mqtt_id, 'recon_rl': recon_rl_id, 'recon': recon_change_id, 'catch': catch_id,
            'reads': block_read_ids, 'bchg': block_change_ids, 'bbad': block_bad_ids,
            'pgc': [fb.nid(site_id, 'pgc', device.id, ti) for ti in range(pg_n)],
            'pg': [fb.nid(site_id, 'pg', device.id, ti) for ti in range(pg_n)],
            'pgcatch': [fb.nid(site_id, 'pgcatch', device.id, ti) for ti in range(pg_n)],
            'pgok': [fb.nid(site_id, 'pgok', device.id, ti) for ti in range(pg_n)],
            'pgfail': [fb.nid(site_id, 'pgfail', device.id, ti) for ti in range(pg_n)],
            'pgdbg': [fb.nid(site_id, 'pgdbg', device.id, ti) for ti in range(pg_n)],
            'pgedbg': [fb.nid(site_id, 'pgedbg', device.id, ti) for ti in range(pg_n)],
        }
        cls._annotate(nodes, cls._mc_tab_infos(model, device, dev, ids, blocks, sub_second, multi, pg_targets or [], api_key, trigger_change))
        # 标签页级文档：选中 tab → 右侧信息栏（Markdown 渲染）展示完整说明
        nodes[0]['info'] = (info_head + '\n\n' + info_guide).replace('\n', '  \n')
        return nodes

    # ==================== Modbus 支路 ====================

    @staticmethod
    def _merge_blocks_modbus(tags: list[dict], warnings: list, device_name: str, gap: int = 0) -> list[dict]:
        """Modbus 块读合并：按寄存器类型分组、地址排序、间隙≤gap 字合并（上限 120，含空洞）。

        多字类型（INT32/FLOAT 等）需 buffer-parser 解码，过渡版不支持：跳过并告警。
        """
        single_word = []
        for tag in tags:
            dt = (tag.get('data_type') or 'INT16').upper()
            if dt not in ('INT16', 'UINT16', 'BIT', 'BOOL'):
                warnings.append(
                    f'设备[{device_name}]点位[{tag["tag_name"]}]类型 {dt} 为跨寄存器类型，Modbus 支路暂不支持（需 buffer-parser），已跳过'
                )
                continue
            single_word.append(tag)

        groups: dict[str, list[dict]] = {}
        for tag in single_word:
            groups.setdefault(tag['register_type'], []).append(tag)

        blocks = []
        for group in groups.values():
            group.sort(key=lambda t: int(t['register_address']))
            cur = None
            for tag in group:
                addr = int(tag['register_address'])
                hole = addr - cur['end'] if cur else 0
                if cur and 0 <= hole <= gap and cur['regs'] + hole + 1 <= 120:
                    cur['tags'].append(tag)
                    cur['end'] = addr + 1
                    cur['regs'] += hole + 1
                else:
                    cur = {'start': addr, 'end': addr + 1, 'regs': 1, 'tags': [tag]}
                    blocks.append(cur)
        for b in blocks:
            b['fc'] = fb.MODBUS_FC_MAP.get(b['tags'][0]['register_type'], 'HoldingRegister')
        return blocks

    @classmethod
    def _build_device_tab_modbus(cls, model: FlowGenerateModel, node_id: int, device: PlcDevice, tags: list[dict],
                                 api_key: str = '', warnings: list | None = None, pg_targets: list | None = None) -> list:
        """Modbus TCP 支路：modbus-read 自带走时轮询（rate/rateUnit，原生支持毫秒），
        emptyMsgOnFail 开路失败 → 「读取失败?」switch 分流 BAD 支路。重连由 modbus-client
        内建（reconnectOnTimeout），无需 reinitialize 支路。"""
        warnings = warnings if warnings is not None else []
        dev = cls._resolve_dev(device)
        site_id = model.site_id
        tab_id = fb.nid(site_id, 'tab', device.id)
        client_id = fb.nid(site_id, 'mbc', device.id)
        final_id = fb.nid(site_id, 'final', device.id)
        rbe_id = fb.nid(site_id, 'rbe', device.id)
        switch_id = fb.nid(site_id, 'switch', device.id)
        mqtt_id = fb.nid(site_id, 'mqtt', device.id)
        alarm_rl_id = fb.nid(site_id, 'alarmrl', device.id)
        alarm_change_id = fb.nid(site_id, 'alarmc', device.id)
        alarm_tpl_id = fb.nid(site_id, 'alarmt', device.id)
        alarm_mqtt_id = fb.nid(site_id, 'alarmm', device.id)
        catch_id = fb.nid(site_id, 'catch', device.id)
        broker_id = fb.nid(site_id, 'broker')
        comm_http_id = fb.nid(site_id, 'comm', device.id)
        join_id = fb.nid(site_id, 'join', device.id)

        blocks = cls._merge_blocks_modbus(tags, warnings, device.device_name, model.block_gap)
        if not blocks:
            return []
        multi = len(blocks) > 1
        read_ids = [fb.nid(site_id, 'mbread', device.id, i) for i in range(len(blocks))]
        empty_ids = [fb.nid(site_id, 'mbempty', device.id, i) for i in range(len(blocks))]
        good_ids = [fb.nid(site_id, 'bchg', device.id, i) for i in range(len(blocks))]
        bad_ids = [fb.nid(site_id, 'bbad', device.id, i) for i in range(len(blocks))]

        trigger_change = (device.trigger_kind or 1) == 2

        nodes = [fb.make_tab(tab_id, f'{model.tab_prefix}采集_{device.device_name}')]
        nodes.append(fb.make_modbus_client(client_id, f'{device.device_name} 连接', dev))

        # 块读（自走时）→ 失败分流（null/empty/else 三路，评审 A1）→ 好路装配 / 坏路标BAD
        for i, block in enumerate(blocks):
            nodes.append(fb.make_modbus_read(
                read_ids[i], tab_id,
                f'[{device.device_name}] 读 {block["fc"]} {block["start"]}+{block["regs"]}',
                client_id, dev['unit_id'], block['fc'], block['start'], block['regs'],
                device.scan_interval_ms, [[empty_ids[i]]],
            ))
            # switch 三路：null→BAD、empty→BAD、else→装配
            nodes.append(fb.make_switch_empty(empty_ids[i], tab_id, [[bad_ids[i]], [bad_ids[i]], [good_ids[i]]]))

            good_rules = [fb.rule_set_jsonata('payload', fb.modbus_block_assemble_expr(block['tags'], block['start']))]
            if multi:
                good_rules.append(fb.rule_set_str('topic', f'block{i:02d}'))
            nodes.append(fb.make_change(good_ids[i], tab_id, '块内装配', good_rules, [[join_id if multi else final_id]]))

            bad_rules = [fb.rule_set_jsonata('payload', fb.bad_block_assemble_expr(block['tags']))]
            if multi:
                bad_rules.append(fb.rule_set_str('topic', f'block{i:02d}'))
            # 坏路 = 读取失败信号：入 join + 停采集闸 → 告警（通信状态统一在总开关后上报，评审 C3）
            nodes.append(fb.make_change(bad_ids[i], tab_id, f'块{i}失败标BAD', bad_rules,
                                        [[join_id if multi else final_id] + [alarm_rl_id]]))

        if multi:
            join_timeout_s = max(2, round((device.comm_timeout_ms or 3000) * 2 / 1000))
            nodes.append(fb.make_join(join_id, tab_id, len(blocks), [[final_id]], timeout_s=join_timeout_s))

        if api_key:
            nodes.append(fb.make_comm_stat_node(comm_http_id, tab_id, '通信状态上报',
                                                model.backend_host, model.backend_port, node_id, device.id, api_key))

        # 最终装配（与 MC 支路共用同一契约/指纹/PG 逻辑）
        final_rules = []
        if model.enable_pg:
            # 先暂存未剥离 transform_type 的 values，供 pg_sql 拼 INSERT 用（须在规则1 之前）
            final_rules.append(fb.rule_set_jsonata('pg_values', fb.pg_values_expr(multi)))
        final_rules.append(fb.rule_set_jsonata('payload', fb.final_assemble_expr(node_id, dev, multi)))
        if trigger_change:
            final_rules.append(fb.rule_set_jsonata('changeKey', fb.change_key_expr(multi)))
        if api_key:
            # 设备级通信状态：每轮一次，任一块 BAD 即离线（评审 C3）
            final_rules.append(fb.rule_set_jsonata('comm', fb.comm_expr(multi)))
        if model.enable_pg and pg_targets:
            # 多目标写库：每个目标一条 pg_sql_i（字段子集/模式/表各自独立）
            for ti, tgt in enumerate(pg_targets):
                final_rules.append(fb.rule_set_jsonata(f'pg_sql_{ti}', fb.pg_sql_expr(
                    node_id, dev, multi, fields=tgt.pg_fields, pg_schema=tgt.pg_schema, pg_table=tgt.pg_table)))
        downstream = rbe_id if trigger_change else switch_id
        final_wires = [downstream]
        nodes.append(fb.make_change(final_id, tab_id, '契约装配', final_rules, [final_wires]))

        if trigger_change:
            nodes.append(fb.make_rbe(rbe_id, tab_id, [[switch_id]]))

        # 通信状态上报接在总开关后（空轮不上报，评审 C3 每轮一次聚合）+ 数据出口
        link_id = fb.nid(site_id, 'link', device.id)
        fan_out = [mqtt_id] + ([fb.nid(site_id, 'pgc', device.id, ti) for ti in range(len(pg_targets or []))] if model.enable_pg and pg_targets else []) + ([comm_http_id] if api_key else []) + [link_id]
        nodes.append(fb.make_switch_nonempty(switch_id, tab_id, [fan_out]))
        # 数据出口（link out）：定制逻辑消费接口，用户在自己标签页 link in 连它（确定性 id，重部署连线存活）
        nodes.append(fb.make_link_out(link_id, tab_id, f'数据出口·{device.device_name}'))

        topic = f'{model.topic_prefix}/data/{node_id}/{device.id}'
        nodes.append(fb.make_mqtt_out(mqtt_id, tab_id, 'MQTT 上报', topic, broker_id))

        pg_branch_ids = []  # 供分组框收集
        if model.enable_pg and pg_targets:
            for ti, tgt in enumerate(pg_targets):
                pgc = fb.nid(site_id, 'pgc', device.id, ti)
                pgn = fb.nid(site_id, 'pg', device.id, ti)
                pgcatch = fb.nid(site_id, 'pgcatch', device.id, ti)
                pgok = fb.nid(site_id, 'pgok', device.id, ti)
                pgfail = fb.nid(site_id, 'pgfail', device.id, ti)
                pgdbg = fb.nid(site_id, 'pgdbg', device.id, ti)
                pgedbg = fb.nid(site_id, 'pgedbg', device.id, ti)
                pg_branch_ids += [pgc, pgn, pgcatch, pgdbg, pgedbg] + ([pgok, pgfail] if api_key else [])
                pg_rules = [fb.rule_set_jsonata('topic', f'pg_sql_{ti}'), fb.rule_set_jsonata('pg_rows', 'payload.value_count')]
                nodes.append(fb.make_change(pgc, tab_id, f'PG SQL·目标{ti + 1}', pg_rules, [[pgn, pgdbg]]))
                # SQL 调试：把实际 INSERT 语句打到调试侧栏（排错用，可在编辑器关停）
                nodes.append(fb.make_debug(pgdbg, tab_id, f'SQL调试·目标{ti + 1}', 'topic'))
                nodes.append(fb.make_pg_node(pgn, tab_id, f'写采集历史·目标{ti + 1}', fb.nid(site_id, 'pgcfg', ti)))
                if api_key:
                    nodes[-1]['wires'] = [[pgok]]
                    nodes.append(fb.make_pg_stat_node(pgok, tab_id, f'PG成功计数·目标{ti + 1}', model.backend_host, model.backend_port, node_id, device.id, 'ok', api_key))
                    nodes.append(fb.make_pg_stat_node(pgfail, tab_id, f'PG失败计数·目标{ti + 1}', model.backend_host, model.backend_port, node_id, device.id, 'fail', api_key))
                    nodes.append(fb.make_catch(pgcatch, tab_id, f'PG异常·目标{ti + 1}', [pgn], [[pgfail, pgedbg]]))
                else:
                    # 无 key 时 PG 失败走告警链（与 api_key 解耦，评审 C6）
                    nodes.append(fb.make_catch(pgcatch, tab_id, f'PG异常·目标{ti + 1}', [pgn], [[alarm_rl_id, pgedbg]]))
                # 错误调试：把 PG 报错原文打到调试侧栏（解决"只计数看不到原因"）
                nodes.append(fb.make_debug(pgedbg, tab_id, f'PG错误·目标{ti + 1}', 'error.message'))

        # 告警支路：坏块（读取失败）→ 限速 → ts → template → mqtt
        nodes.append(fb.make_rate_limit(alarm_rl_id, tab_id, '告警限速', 30, [[alarm_change_id]]))
        nodes.append(fb.make_change(alarm_change_id, tab_id, '告警时间戳', [fb.rule_set_jsonata('ts', fb.TS_EXPR)], [[alarm_tpl_id]]))
        nodes.append(fb.make_template(alarm_tpl_id, tab_id, '告警报文', fb.alarm_template_text(node_id, dev), [[alarm_mqtt_id]]))
        alarm_topic = f'{model.topic_prefix}/alarm/plc_offline/{device.id}'
        nodes.append(fb.make_mqtt_out(alarm_mqtt_id, tab_id, '告警上报', alarm_topic, broker_id))

        catch_scope = read_ids + empty_ids + good_ids + bad_ids + [final_id, switch_id, mqtt_id] + ([join_id] if multi else []) + ([rbe_id] if trigger_change else [])
        nodes.append(fb.make_catch(catch_id, tab_id, '支路异常', catch_scope, [[alarm_rl_id]]))

        # ==================== 画布布局（分组框 + 注释） ====================
        K = len(blocks)
        y0 = 140
        row_h = 110
        center_y = y0 + (K - 1) * row_h // 2
        up_y = y0 + K * row_h + 90
        n_pg = len(pg_targets) if (model.enable_pg and pg_targets) else 0
        alarm_y = up_y + max(100, n_pg * 80 + 20)

        coords = {}
        for i in range(K):
            coords[read_ids[i]] = (380, y0 + i * row_h)
            coords[empty_ids[i]] = (580, y0 + i * row_h)
            coords[good_ids[i]] = (800, y0 + i * row_h)
            coords[bad_ids[i]] = (800, y0 + i * row_h + 48)
        if multi:
            coords[join_id] = (1020, center_y)
        coords[final_id] = (1240, center_y)
        if trigger_change:
            coords[rbe_id] = (1460, center_y)
        coords[switch_id] = (1460 if not trigger_change else 1680, center_y)
        coords[mqtt_id] = (1900, up_y)
        coords[link_id] = (2130, up_y)
        if api_key:
            coords[comm_http_id] = (800, up_y)
        if model.enable_pg and pg_targets:
            for ti in range(len(pg_targets)):
                coords[fb.nid(site_id, 'pgc', device.id, ti)] = (1240, up_y + ti * 80)
                coords[fb.nid(site_id, 'pg', device.id, ti)] = (1460, up_y + ti * 80)
                coords[fb.nid(site_id, 'pgdbg', device.id, ti)] = (1460, up_y + ti * 80 + 40)
                if api_key:
                    coords[fb.nid(site_id, 'pgok', device.id, ti)] = (1680, up_y + ti * 80)
                    coords[fb.nid(site_id, 'pgfail', device.id, ti)] = (1460, alarm_y + ti * 80)
                coords[fb.nid(site_id, 'pgcatch', device.id, ti)] = (1240, alarm_y + ti * 80)
                coords[fb.nid(site_id, 'pgedbg', device.id, ti)] = (1460, alarm_y + ti * 80 + 40)
        coords[catch_id] = (140, alarm_y)
        coords[alarm_rl_id] = (460, alarm_y)
        coords[alarm_change_id] = (660, alarm_y)
        coords[alarm_tpl_id] = (860, alarm_y)
        coords[alarm_mqtt_id] = (1060, alarm_y)

        for n in nodes:
            if n['id'] in coords:
                n['x'], n['y'] = coords[n['id']]

        def _bbox(member_ids):
            pts = [coords[i] for i in member_ids if i in coords]
            minx = min(p[0] for p in pts)
            maxx = max(p[0] for p in pts)
            miny = min(p[1] for p in pts)
            maxy = max(p[1] for p in pts)
            return (minx - 50, miny - 45, maxx - minx + 250, maxy - miny + 130)

        g1 = read_ids + empty_ids + good_ids + bad_ids + ([join_id] if multi else []) + [final_id] + ([rbe_id] if trigger_change else []) + [switch_id]
        nodes.append(fb.make_group(fb.nid(site_id, 'grp1', device.id), tab_id, '采集与装配', g1, _bbox(g1), '#e8f4fd'))

        g2 = ([comm_http_id] if api_key else []) + (pg_branch_ids if (model.enable_pg and pg_targets) else []) + [mqtt_id, link_id]
        nodes.append(fb.make_group(fb.nid(site_id, 'grp2', device.id), tab_id, '上报与计数', g2, _bbox(g2), '#e9f7e8'))

        g3 = [catch_id, alarm_rl_id, alarm_change_id, alarm_tpl_id, alarm_mqtt_id]
        nodes.append(fb.make_group(fb.nid(site_id, 'grp3', device.id), tab_id, '告警与异常', g3, _bbox(g3), '#fdecea'))

        trigger_label = '变化触发' if trigger_change else '固定周期'
        gap_note = f' | 空洞容忍 {model.block_gap}字' if model.block_gap > 0 else ''
        info_head = (
            f'📦 {device.device_name} | Modbus {device.plc_ip}:{dev["plc_port"]} 从站{dev["unit_id"]} | 周期 {device.scan_interval_ms}ms'
            f' | 点位 {len(tags)} | 块读 {K}{gap_note} | {trigger_label}\n'
            '流程版本 __FLOWVER__ · EdgeLink 生成器产物 · 画布只读，配置变更请到后台重新生成部署'
        )
        info_guide = (
            '【支路说明】这个页面是怎么工作的\n'
            f'① 轮询：modbus-read 自走时，每 {device.scan_interval_ms}ms 读一块（rate/rateUnit 原生毫秒支持）\n'
            '② 失败分流：「读取失败?」三路判定——null/empty → 失败标BAD（造一块全 BAD 空值，保证 join 收得齐），else → 块内装配\n'
            '③ 块内装配：把原始值按点位拆成 values[]（HR 字区 BIT 点位做位提取；CR/COIL 位区直接取值）\n'
            '④ join 合并：各块按 topic=blockNN 拼回一个对象（超时兜底防卡死）\n'
            '⑤ 契约装配：拼成北向报文（node_id/device_id/values[]/quality），顺带生成 PG SQL 与通信状态\n'
            '⑥ 有值才报：空轮过滤后四路输出——MQTT 上报、PG 写库（SQL调试/PG错误 观察口）、通信状态上报、数据出口·' + device.device_name + '\n'
            '⑦ 告警与异常（下方红区）：读取失败 → 限速30s → MQTT 告警；重连由 modbus-client 内建（reconnectOnTimeout）\n'
            '【定制逻辑】新建自己的标签页，用 link in 连「数据出口·' + device.device_name + '」拿每轮数据，勿改本页——下次部署会被覆盖'
        )
        nodes.append(fb.make_comment(fb.nid(site_id, 'note', device.id), tab_id, info_head, 380, 50))
        nodes.append(fb.make_comment(fb.nid(site_id, 'note2', device.id), tab_id, info_guide, 380, alarm_y + 140))

        # 节点级文档（选中节点 → 右侧信息栏）
        pg_n = len(pg_targets or [])
        ids = {
            'final': final_id, 'rbe': rbe_id, 'switch': switch_id, 'mqtt': mqtt_id, 'comm': comm_http_id,
            'link': link_id, 'join': join_id,
            'alarm_rl': alarm_rl_id, 'alarm_change': alarm_change_id, 'alarm_tpl': alarm_tpl_id,
            'alarm_mqtt': alarm_mqtt_id, 'catch': catch_id,
            'reads': read_ids, 'empty': empty_ids, 'good': good_ids, 'bad': bad_ids,
            'pgc': [fb.nid(site_id, 'pgc', device.id, ti) for ti in range(pg_n)],
            'pg': [fb.nid(site_id, 'pg', device.id, ti) for ti in range(pg_n)],
            'pgcatch': [fb.nid(site_id, 'pgcatch', device.id, ti) for ti in range(pg_n)],
            'pgok': [fb.nid(site_id, 'pgok', device.id, ti) for ti in range(pg_n)],
            'pgfail': [fb.nid(site_id, 'pgfail', device.id, ti) for ti in range(pg_n)],
            'pgdbg': [fb.nid(site_id, 'pgdbg', device.id, ti) for ti in range(pg_n)],
            'pgedbg': [fb.nid(site_id, 'pgedbg', device.id, ti) for ti in range(pg_n)],
        }
        cls._annotate(nodes, cls._modbus_tab_infos(device, ids, blocks, multi, pg_targets or [], api_key, trigger_change))
        # 标签页级文档：选中 tab → 右侧信息栏（Markdown 渲染）展示完整说明
        nodes[0]['info'] = (info_head + '\n\n' + info_guide).replace('\n', '  \n')
        return nodes

    # ==================== 基础设施 tab ====================

    @classmethod
    def _build_infra_tab(cls, model: FlowGenerateModel, api_key: str, host_key: str, pg_targets: list) -> list:
        """基础设施 tab（排在最前，名称固定"基础设施"不带前缀）：
        site-health-server 共享配置（Key 只录一次）+ site-health + flows-upload + MQTT/PG config + 心跳支路。"""
        infra_tab_id = fb.nid(model.site_id, 'tab', 'infra')
        srv_id = fb.nid('shsrv', model.site_id)
        sh_id = fb.nid('sh', model.site_id)
        flows = [
            fb.make_tab(infra_tab_id, '基础设施'),
            fb.make_site_health_server(srv_id, model.backend_host, model.backend_port),
            fb.make_site_health(sh_id, infra_tab_id, model.backend_host, model.backend_port, server_ref=srv_id),
            fb.make_site_flows_upload(fb.nid('shup', model.site_id), infra_tab_id, srv_id),
            fb.make_mqtt_broker(fb.nid(model.site_id, 'broker'), 'MQTT broker', model.mqtt_host, model.mqtt_port),
        ]
        if model.enable_pg:
            for ti, tgt in enumerate(pg_targets):
                flows.append(fb.make_pg_config(fb.nid(model.site_id, 'pgcfg', ti), f'采集库·目标{ti + 1}',
                                               tgt.pg_host, tgt.pg_port, tgt.pg_db, user=tgt.pg_user, password=tgt.pg_password))

        # 心跳支路（带部署回执版本，OPT-08）
        if api_key:
            fb.make_heartbeat_branch(flows, model.site_id, infra_tab_id, model.backend_host, model.backend_port,
                                     host_key, api_key, '__FLOWVER__')

        # 美术层：分组框 + 使用说明注释
        infra_members = [sh_id, fb.nid('shup', model.site_id)]
        if api_key:
            infra_members += [fb.nid(model.site_id, 'hb', 'inject'), fb.nid(model.site_id, 'hb', 'http')]
        flows.append(fb.make_group(fb.nid(model.site_id, 'grp-infra'), infra_tab_id, '基础设施 · 监控与上传', infra_members, (80, 35, 1200, 250), '#f4f0fa'))
        flows.append(fb.make_comment(
            fb.nid(model.site_id, 'note-infra'), infra_tab_id,
            f'流程版本 __FLOWVER__ · 生成器 v{GENERATOR_VERSION} · EdgeLink 生成器产物\n'
            '════════════ 部署后必做（仅首次）════════════\n'
            '①「存量监控服务器」配置节点 → 录入监控 Key（site-health 与 flows 上传共用，只录一次）\n'
            '②「MQTT broker」配置节点 → 录入用户名/密码（生成时已填则跳过）\n'
            '③「采集库·目标N」配置节点 → 录入 PG 用户名/密码（生成时已填则跳过；该包密码为明文字段，注意 flows.json 保管）\n'
            '（credential 按节点 id 保留，之后重新生成部署不会丢失）\n'
            '════════════ 验证（2 分钟）════════════\n'
            '· 发布页横幅应显示「边缘在线 · 与最新版一致」\n'
            '· 节点监控页本节点 1-2 分钟内转在线（心跳 30s + 离线阈值 90s）\n'
            '· PG 支路：成功计数应持续增长；失败看「PG错误·目标N」调试侧栏的报错原文\n'
            '════════════ 定制逻辑（重要纪律）════════════\n'
            '· 不要修改任何生成页面！手改会在下次部署被覆盖（部署弹窗会红字警告；可先在发布页备份画布快照）\n'
            '· 阈值判断/转发等逻辑：新建自己的标签页（勿用 GEN_/EL_ 前缀），\n'
            '  用 link in 连各设备页的「数据出口」，或订阅 MQTT：' + model.topic_prefix + '/data/<节点ID>/<设备ID>\n'
            '· 数据出口每轮输出完整契约报文（payload.values[] 带 eng_value/quality）；\n'
            '  断线时 quality=BAD、值为 null，逻辑里务必先过滤 quality="GOOD"\n'
            '════════════ 排障入口 ════════════\n'
            '· SQL调试·目标N：每轮实际执行的 INSERT 语句\n'
            '· PG错误·目标N：PG 返回的报错原文（字段不存在/认证失败等）\n'
            '· 调试节点可点节点按钮临时关停，不影响采集',
            130, 330,
        ))
        # 节点级文档
        infos = {
            srv_id: '存量监控服务器（共享配置）：后端地址/端口 + 监控 Key（credential）。\nKey 只在这里录一次，site-health 与 flows 上传共用；重新部署不丢失。',
            sh_id: '采集点健康度：定期向后端上报本采集点运行指标（CPU/内存/流量等）。Key 在共享配置「存量监控服务器」上。',
            fb.nid('shup', model.site_id): 'flows.json 上传：点节点按钮把当前边缘画布快照传回后端留档（出问题时供监控页下载对照）。',
            fb.nid(model.site_id, 'broker'): 'MQTT broker 配置：数据/告警上报通道。账号密码由部署凭证下发或在编辑器录入（credential）。',
        }
        if api_key:
            infos[fb.nid(model.site_id, 'hb', 'inject')] = '心跳触发：启动 5s 后第一次，之后每 30s 一次。'
            infos[fb.nid(model.site_id, 'hb', 'http')] = '心跳上报：维持节点监控页在线状态（90s 无心跳判离线），URL 带 flow_version（部署回执，供"边缘在跑版本"比对）。'
        if model.enable_pg:
            for ti, tgt in enumerate(pg_targets):
                infos[fb.nid(model.site_id, 'pgcfg', ti)] = f'采集库·目标{ti + 1}（PG 连接配置）：{tgt.pg_db} 库。注意该包账号密码为明文字段。'
        cls._annotate(flows, infos)
        # 标签页级文档（Markdown 硬换行）
        flows[0]['info'] = (
            '**基础设施页**：监控 Key / MQTT / PG 凭证、心跳上报、flows.json 上传都在这里。\n'
            '- 首次部署后按画布下方注释完成凭证录入（生成时已填写的自动下发，跳过）\n'
            '- 详细使用说明见本页下方注释节点'
        ).replace('\n', '  \n')
        return flows

    # ==================== 节点级文档（info，选中节点右侧信息栏可见） ====================

    @staticmethod
    def _annotate(nodes: list, infos: dict) -> None:
        """给节点写 info 文档：选中节点 → 右侧信息栏可见，不占用画布空间。
        信息栏按 Markdown 渲染（单换行会被吞），行尾补两个空格=Markdown 硬换行。"""
        for n in nodes:
            text = infos.get(n['id'])
            if text:
                n['info'] = text.replace('\n', '  \n')

    @staticmethod
    def _mc_tab_infos(model: 'FlowGenerateModel', device, dev: dict, ids: dict, blocks: list,
                      sub_second: bool, multi: bool, pg_targets: list, api_key: str, trigger_change: bool) -> dict:
        """MC 支路每个关键节点的说明文本（按节点 id 索引）。"""
        infos = {
            ids['inject']: f'轮询触发器：每 {device.scan_interval_ms}ms 触发一轮采集。' +
                           ('\n亚秒模式：一次性触发，由下方"节奏" delay 自循环接力（周期=管道耗时+延迟，自带背压）。' if sub_second else ''),
            ids['final']: '契约装配：把各块拼成北向报文（node_id/device_id/values[]/quality/ts）。\n'
                          '同时生成：changeKey（变化触发指纹）、comm（通信状态）、pg_sql_i（各目标的 INSERT 语句）。',
            ids['switch']: '空轮过滤：value_count>0 才放行。四路输出：MQTT 上报 / PG 写库 / 通信状态上报 / 数据出口。',
            ids['mqtt']: '实时数据上报到 MQTT broker。断线时本节点缓冲有限，Broker 长期离线会丢实时数据（历史数据看 PG）。',
            ids['link']: '数据出口（link out）：定制逻辑的消费接口。\n新建自己的标签页，用 link in 连它，每轮拿到完整报文。勿改本页——重新部署会被覆盖。',
            ids['alarm_rl']: '告警限速：30 秒最多 1 条（防洪）。持续断线时告警间隔最长 30s。',
            ids['alarm_change']: '告警时间戳：给告警报文补上 ts。',
            ids['alarm_tpl']: '告警报文：PLC_OFFLINE 结构化告警（alert_type/node_id/device_id/ts）。',
            ids['alarm_mqtt']: '告警上报：MQTT topic = alarm/plc_offline/<设备ID>。',
            ids['recon_rl']: '重连限速：15 秒最多 1 次重连指令（防抖动反复重连）。',
            ids['recon']: '断线重连：收到错误脚后发送 topic=reinitialize 指令，回接首个 MC Read 重建 TCP 连接。',
            ids['catch']: '支路异常兜底：捕获本页所有未处理异常 → 告警链。PG 支路有专属 catch，不在此列。',
        }
        if sub_second:
            infos[ids['delay']] = f'节奏器（亚秒自循环）：每 {device.scan_interval_ms}ms 放行一轮，回接自契约装配。'
        if multi:
            infos[ids['join']] = f'多块合并：按 topic=blockNN 把 {len(blocks)} 个块拼回一个对象；超时兜底防卡死（正常时坏块由"失败标BAD"补齐）。'
        if trigger_change:
            infos[ids['rbe']] = '变化触发：监视 changeKey（不含 ts 的数值指纹），值没变整轮静默。\n注意：不能监视 payload——含 ts 每轮必变，会永远放行。'
        if api_key:
            infos[ids['comm']] = '通信状态上报：每轮一次上报本设备在线状态（任一块 BAD 即离线），供运行监控页展示。'
        for i, block in enumerate(blocks):
            infos[ids['reads'][i]] = (
                f'读取 PLC 寄存器块 {block["address"]}（{len(block["tags"])} 个点位）。\n'
                '输出1=成功（payload 为 {地址: 值}），输出2=失败（→ 失败标BAD + 告警 + 重连）。'
            )
            infos[ids['bchg'][i]] = '块内装配：原始值按点位拆成 values[]，做工程值换算（linear: raw*a+b），标 quality=GOOD/UNCERTAIN。'
            infos[ids['bbad'][i]] = '失败标BAD：该块读取失败时造一块全 BAD 空值（raw/eng=null），保证 join 收得齐块数，不静默丢轮。'
        if pg_targets:
            for ti in range(len(pg_targets)):
                infos[ids['pgc'][ti]] = f'PG SQL·目标{ti + 1}：从契约装配取 pg_sql_{ti} 作为执行 SQL（msg.topic），保留 pg_rows 供计数。'
                infos[ids['pg'][ti]] = f'写采集历史·目标{ti + 1}：执行 INSERT 写入 PG。凭证在配置节点「采集库·目标{ti + 1}」。'
                infos[ids['pgcatch'][ti]] = f'PG异常·目标{ti + 1}：捕获写库异常 → 失败计数；报错原文看「PG错误·目标{ti + 1}」调试侧栏。'
                infos[ids['pgdbg'][ti]] = f'SQL调试·目标{ti + 1}：调试侧栏显示每轮实际执行的 INSERT 语句。可点节点按钮关停，不影响采集。'
                infos[ids['pgedbg'][ti]] = f'PG错误·目标{ti + 1}：调试侧栏显示 PG 报错原文（字段不存在/认证失败等）。'
                if api_key:
                    infos[ids['pgok'][ti]] = f'PG成功计数·目标{ti + 1}：上报写库成功条数（监控页"PG 写入"列，每日 0:05 清零）。'
                    infos[ids['pgfail'][ti]] = f'PG失败计数·目标{ti + 1}：上报写库失败条数。'
        return infos

    @staticmethod
    def _modbus_tab_infos(device, ids: dict, blocks: list, multi: bool, pg_targets: list, api_key: str, trigger_change: bool) -> dict:
        """Modbus 支路每个关键节点的说明文本（按节点 id 索引）。"""
        infos = {
            ids['final']: '契约装配：把各块拼成北向报文（node_id/device_id/values[]/quality/ts），并生成 PG SQL 与通信状态。',
            ids['switch']: '空轮过滤：value_count>0 才放行。四路输出：MQTT 上报 / PG 写库 / 通信状态上报 / 数据出口。',
            ids['mqtt']: '实时数据上报到 MQTT broker。',
            ids['link']: '数据出口（link out）：定制逻辑的消费接口。新建自己的标签页用 link in 连接，勿改本页。',
            ids['alarm_rl']: '告警限速：30 秒最多 1 条（防洪）。',
            ids['alarm_change']: '告警时间戳：给告警报文补上 ts。',
            ids['alarm_tpl']: '告警报文：PLC_OFFLINE 结构化告警。',
            ids['alarm_mqtt']: '告警上报：MQTT topic = alarm/plc_offline/<设备ID>。',
            ids['catch']: '支路异常兜底：捕获本页所有未处理异常 → 告警链。',
        }
        if multi:
            infos[ids['join']] = f'多块合并：按 topic=blockNN 把 {len(blocks)} 个块拼回一个对象；超时兜底防卡死。'
        if trigger_change:
            infos[ids['rbe']] = '变化触发：监视 changeKey（不含 ts 的数值指纹），值没变整轮静默。'
        if api_key:
            infos[ids['comm']] = '通信状态上报：每轮一次上报本设备在线状态（任一块 BAD 即离线）。'
        for i, block in enumerate(blocks):
            infos[ids['reads'][i]] = (
                f'modbus-read 自走时轮询：读 {block["fc"]} 起始 {block["start"]} 共 {block["regs"]} 个（{len(block["tags"])} 个点位）。\n'
                'emptyMsgOnFail 已开启：失败时输出空消息 → 「读取失败?」分流。重连由 modbus-client 内建（reconnectOnTimeout）。'
            )
            infos[ids['empty'][i]] = '读取失败?三路分流：null → BAD，empty → BAD，else → 块内装配。'
            infos[ids['good'][i]] = '块内装配：原始值按点位拆成 values[]（HR 字区 BIT 点位做位提取；CR/COIL 位区直接取值）。'
            infos[ids['bad'][i]] = '失败标BAD：该块读取失败时造一块全 BAD 空值，保证 join 收得齐块数；同时触发告警链。'
        if pg_targets:
            for ti in range(len(pg_targets)):
                infos[ids['pgc'][ti]] = f'PG SQL·目标{ti + 1}：取 pg_sql_{ti} 作为执行 SQL（msg.topic），保留 pg_rows 供计数。'
                infos[ids['pg'][ti]] = f'写采集历史·目标{ti + 1}：执行 INSERT 写入 PG。凭证在配置节点「采集库·目标{ti + 1}」。'
                infos[ids['pgcatch'][ti]] = f'PG异常·目标{ti + 1}：捕获写库异常 → 失败计数；报错原文看「PG错误·目标{ti + 1}」。'
                infos[ids['pgdbg'][ti]] = f'SQL调试·目标{ti + 1}：调试侧栏显示每轮实际执行的 INSERT。'
                infos[ids['pgedbg'][ti]] = f'PG错误·目标{ti + 1}：调试侧栏显示 PG 报错原文。'
                if api_key:
                    infos[ids['pgok'][ti]] = f'PG成功计数·目标{ti + 1}：上报写库成功条数（每日 0:05 清零）。'
                    infos[ids['pgfail'][ti]] = f'PG失败计数·目标{ti + 1}：上报写库失败条数。'
        return infos

    # ==================== 主流程 ====================

    @classmethod
    async def generate(cls, db: AsyncSession, model: FlowGenerateModel, gen_by: str = '') -> dict:
        site = await cls._load_site(db, model.site_id)
        devices, host_keys = await cls._load_devices(db, site)
        if not devices:
            raise ServiceException(
                message=f'采集点「{site.site_name}」下没有匹配的设备（host_pc_ip 需为 {site.office_ip} 或 {site.office_ip}:{site.node_port}）'
            )
        drivers = await cls._load_drivers(db)
        tags = await cls._load_tags(db, [d.id for d in devices])
        config_version = await cls._load_config_version(db)

        # OPT-10：生成期输入校验（脏配置一次列清单，不产生 release）
        cls._validate_inputs(devices, tags)

        warnings: list[str] = []
        # node_id = nodered_node.id（V12/V13 契约），没有则预注册
        node_id, host_key = await cls._resolve_node_id(db, site, host_keys, warnings)

        # X-API-Key 前置解析（心跳支路与 PG 计数上报都要用）
        api_key = model.monitor_api_key or ''
        if not api_key:
            from config.env import AppConfig

            api_key = AppConfig.monitor_api_key or ''
            if api_key:
                warnings.append('X-API-Key 已内嵌生成文件（与 bootstrap.json 同等暴露面，注意 flows.json 的保管）')

        # 部署凭证（不进 payload）：MQTT credential 字段在 POST /flows 里走独立 credentials 对象
        deploy_creds = {}
        if model.mqtt_username:
            deploy_creds[fb.nid(model.site_id, 'broker')] = {'user': model.mqtt_username, 'password': model.mqtt_password}
        deploy_creds_json = json.dumps(deploy_creds, ensure_ascii=False) if deploy_creds else None
        if not api_key:
            warnings.append('monitor_api_key 未配置（后端 monitor_api_key 为空），心跳/PG计数支路不生成，节点监控中心将显示离线')
        tags_by_dev: dict[int, list[dict]] = {}
        for t in tags:
            tag_dict = {
                'id': t.id,
                'device_id': t.device_id,
                'tag_name': t.tag_name,
                'description': t.description,
                'register_type': t.register_type,
                'register_address': t.register_address,
                'data_type': t.data_type,
                'unit': t.unit,
                'eng_unit': t.eng_unit,
                'transform_type': t.transform_type,
                'transform_slope_a': t.transform_slope_a,
                'transform_offset_b': t.transform_offset_b,
                'bit_offset': t.bit_offset,
            }
            if t.calc_op:
                warnings.append(f'点位[{t.tag_name}](id={t.id})是计算点，过渡版不支持，已跳过')
                continue
            if t.transform_type == 'slope_offset':
                warnings.append(f'点位[{t.tag_name}](id={t.id})换算类型 slope_offset 暂按 linear 处理，待业务确认')
            if (t.report_deadband_ms or 0) > 0:
                warnings.append(f'点位[{t.tag_name}](id={t.id})配置了数值死区 {t.report_deadband_ms}，过渡版仅支持设备级变化过滤，死区未生效')
            tags_by_dev.setdefault(t.device_id, []).append(tag_dict)

        # PG 写入目标解析：pg_targets 多目标优先；否则单目标参数兜底为一个目标
        pg_targets = []
        if model.enable_pg:
            from module_flowgen.entity.vo.flowgen_vo import PG_FIELD_OPTIONS, PgTargetModel
            import re as _re
            pg_targets = model.pg_targets or [PgTargetModel(
                pg_host=model.pg_host, pg_port=model.pg_port, pg_db=model.pg_db,
                pg_schema=model.pg_schema, pg_table=model.pg_table, pg_fields=model.pg_fields,
            )]
            allowed = {f for f, _ in PG_FIELD_OPTIONS}
            for ti, t in enumerate(pg_targets):
                for label, val in (('模式名', t.pg_schema), ('表名', t.pg_table), ('库名', t.pg_db)):
                    if not _re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', val or ''):
                        raise ServiceException(message=f'PG 目标{ti + 1} 的{label}非法：「{val}」（仅允许字母/数字/下划线，字母开头）')
                if t.pg_fields:
                    bad_fields = [f for f in t.pg_fields if f not in allowed]
                    if bad_fields:
                        raise ServiceException(message=f'PG 目标{ti + 1} 插入列含非法字段：{bad_fields}（支持：{sorted(allowed)}）')

        if model.mqtt_username or any(t.pg_user for t in pg_targets):
            warnings.append('PG 凭证内嵌于生成文件（该包为明文字段）；MQTT 凭证走部署通道（不进 flows.json）；均请按敏感数据保管')

        # 基础设施 tab 排最前（tab 显示顺序 = flows 数组顺序）
        flows: list = cls._build_infra_tab(model, api_key, host_key, pg_targets)
        device_count = 0
        for device in devices:
            driver = drivers.get(device.driver_code or '')
            if not driver or not getattr(driver, 'gen_node_type', None):
                warnings.append(f'设备[{device.device_name}](id={device.id})驱动 {device.driver_code} 无生成版节点映射，已跳过')
                continue
            dev_tags = tags_by_dev.get(device.id, [])
            if not dev_tags:
                warnings.append(f'设备[{device.device_name}](id={device.id})无启用点位，已跳过')
                continue
            # 支路构造器分发：MC / Modbus；其余驱动安全跳过（防拼出类型错配的坏 flow）
            built = []
            if driver.gen_node_type == 'MC Read':
                built = cls._build_device_tab(model, node_id, device, dev_tags, api_key, warnings=warnings, pg_targets=pg_targets)
            elif driver.gen_node_type == 'modbus-read':
                built = cls._build_device_tab_modbus(model, node_id, device, dev_tags, api_key, warnings=warnings, pg_targets=pg_targets)
            else:
                warnings.append(f'设备[{device.device_name}](id={device.id})驱动 {device.driver_code} 的生成版支路尚未实现，已跳过')
                continue
            if not built:
                warnings.append(f'设备[{device.device_name}](id={device.id})无可用点位支路，已跳过')
                continue
            flows.extend(built)
            device_count += 1

        if device_count == 0:
            raise ServiceException(message='没有可生成的设备支路（检查驱动映射与点位配置）')

        node_count = len(flows)
        if node_count > _NODE_COUNT_WARN:
            warnings.append(f'节点总数 {node_count} 超过警戒值 {_NODE_COUNT_WARN}，部署将明显变慢，建议该现场走 V14 数据驱动方案')

        # 版本占位符参与哈希（幂等判定与版本号解耦），落库前替换为真版本
        # 部署凭证参与哈希：仅改密码也要出新版本，否则凭证改动会被幂等吞掉
        payload_draft = json.dumps(flows, ensure_ascii=False, indent=2)
        sha256 = hashlib.sha256((payload_draft + (deploy_creds_json or '')).encode('utf-8')).hexdigest()

        # 幂等：与最新版本内容一致则不新建
        latest = await FlowgenDao.get_latest_release(db, model.site_id)
        if latest and latest.sha256 == sha256:
            return {
                'releaseId': latest.id,
                'version': latest.version,
                'configVersion': latest.config_version,
                'deviceCount': latest.device_count,
                'nodeCount': latest.node_count,
                'sha256': sha256,
                'created': False,
                'warnings': warnings,
            }

        version = await FlowgenDao.get_max_version(db, model.site_id) + 1
        payload = payload_draft.replace('__FLOWVER__', str(version))
        release = PlcFlowRelease(
            site_id=model.site_id,
            config_version=config_version,
            version=version,
            payload=payload,
            sha256=sha256,
            device_count=device_count,
            node_count=node_count,
            status='0',
            deploy_credentials=deploy_creds_json,
            # 生成器版本留痕（OPT-13）：同一 config_version 可对应不同规则产物，靠它追溯
            remark=f'gen:v{GENERATOR_VERSION}' + ('; ' + '; '.join(warnings)[:480] if warnings else ''),
            create_by=gen_by,
        )
        db.add(release)
        try:
            await db.flush()
            # commit 会 expire 所有属性：id 必须在 commit 前取出（异步上下文禁止隐式 IO）
            release_id = release.id
            await db.commit()
        except IntegrityError:
            # uk_flow_release_site_version 兜底：两人同时点生成只会有一个成功
            await db.rollback()
            raise ServiceException(message='版本号冲突（存在并发生成），请重新点击生成')

        return {
            'releaseId': release_id,
            'version': version,
            'configVersion': config_version,
            'deviceCount': device_count,
            'nodeCount': node_count,
            'sha256': sha256,
            'created': True,
            'warnings': warnings,
        }

    # ==================== 回滚 ====================

    @classmethod
    async def rollback(cls, db: AsyncSession, release_id: int, gen_by: str = '') -> dict:
        """回滚：以指定历史版本的内容生成一个新版本（版本链只前进不后退，可追溯）。"""
        src = await FlowgenDao.get_release_by_id(db, release_id)
        if not src:
            raise ServiceException(message='流程版本不存在')

        # 版本占位符还原 → 重算内容哈希 → 替换为新版本号（与 generate 的哈希口径一致）
        draft = src.payload.replace(f'flow_version={src.version}', 'flow_version=__FLOWVER__').replace(
            f'流程版本 {src.version} ·', '流程版本 __FLOWVER__ ·'
        )
        sha256 = hashlib.sha256((draft + (src.deploy_credentials or '')).encode('utf-8')).hexdigest()

        latest = await FlowgenDao.get_latest_release(db, src.site_id)
        if latest and latest.sha256 == sha256:
            return {
                'releaseId': latest.id,
                'version': latest.version,
                'sha256': sha256,
                'created': False,
            }

        version = await FlowgenDao.get_max_version(db, src.site_id) + 1
        payload = draft.replace('__FLOWVER__', str(version))
        release = PlcFlowRelease(
            site_id=src.site_id,
            config_version=src.config_version,
            version=version,
            payload=payload,
            sha256=sha256,
            device_count=src.device_count,
            node_count=src.node_count,
            status='0',
            deploy_credentials=src.deploy_credentials,
            remark=f'rollback-from:v{src.version}; gen:v{GENERATOR_VERSION}',
            create_by=gen_by,
        )
        db.add(release)
        try:
            await db.flush()
            new_id = release.id
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise ServiceException(message='版本号冲突（存在并发操作），请重试')

        return {
            'releaseId': new_id,
            'version': version,
            'sha256': sha256,
            'created': True,
        }
