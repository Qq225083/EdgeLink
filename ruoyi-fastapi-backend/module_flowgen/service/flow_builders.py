"""过渡版流程生成器 — Node-RED 节点构建器（纯函数，零依赖，可单测）

每个 make_xxx() 返回一个 flows.json 节点 dict。所有 id 由调用方通过 nid() 确定性生成：
同一现场重复生成 id 不变（credential 与编辑器内手工改动靠节点 id 存活）。

节点字段取值依据：9-28/社区MC节点核实记录.md（社区 MC 节点源码）+
packages/node-red-contrib-edgelink-site-health（自研基础设施节点，登记类型 site-health）。
"""
import hashlib
import json


def nid(*parts) -> str:
    """确定性节点 id（16 位十六进制）。同一组 parts 永远得到同一个 id。"""
    return hashlib.sha1(':'.join(str(p) for p in parts).encode('utf-8')).hexdigest()[:16]


def make_group(node_id: str, z: str, name: str, member_ids: list, bounds: tuple, fill: str) -> dict:
    """分组框（Node-RED 原生 group）。bounds=(x, y, w, h) 由生成器按成员坐标计算。"""
    x, y, w, h = bounds
    return {
        'id': node_id,
        'type': 'group',
        'z': z,
        'name': name,
        'style': {'label': True, 'fill': fill, 'color': '#303133'},
        'nodes': member_ids,
        'x': x, 'y': y, 'w': w, 'h': h,
    }


def make_comment(node_id: str, z: str, text: str, x: int, y: int) -> dict:
    """注释节点（画布说明文字）。"""
    return {'id': node_id, 'type': 'comment', 'z': z, 'name': text, 'info': '', 'x': x, 'y': y, 'wires': []}


def _jstr(value) -> str:
    """生成 JSONata 字符串字面量（JSON 转义与 JSONata 兼容）。"""
    return json.dumps('' if value is None else str(value), ensure_ascii=False)


# ISO 时间戳（对齐 V13 的 new Date().toISOString()：UTC + Z 后缀）
TS_EXPR = "$fromMillis($millis(),'[Y0001]-[M01]-[D01]T[H01]:[m01]:[s01].[f001]Z','+0000')"


def make_tab(tab_id: str, label: str, info: str = '') -> dict:
    return {'id': tab_id, 'type': 'tab', 'label': label, 'disabled': False, 'info': info}


def make_mc_connection(node_id: str, z: str, name: str, device: dict) -> dict:
    """MC Protocol Connection 配置节点（每 PLC 独立一个，绝不共享）。

    device 需要的键：plc_ip/plc_port/plc_type/octal_input_output/mc_frame/station_no/network_no/comm_timeout_ms。
    plc_type 与 octal_input_output 由调用方解析好（plcType 显式值或按系列推导）。
    """
    plc_type = device.get('plc_type') or 'Q'
    return {
        'id': node_id,
        'type': 'MC Protocol Connection',
        'z': z,
        'name': name,
        'host': str(device.get('plc_ip') or ''),
        'port': str(device.get('plc_port') or 5007),
        'protocol': device.get('protocol') or 'TCP',
        'plcType': plc_type,
        'frame': str(device.get('mc_frame') or '3E'),
        'ascii': bool(device.get('ascii')),
        'PLCStation': str(device.get('station_no') or 0),
        'PCStation': '255',
        'PLCModuleNo': '1023',
        'network': str(device.get('network_no') or 0),
        'timeout': str(device.get('comm_timeout_ms') or 3000),
        # FX 系列 X/Y 是八进制编址，连接级正确处理（V12 怪癖④在生成版不存在）
        'octalInputOutput': bool(device.get('octal_input_output')),
    }


def make_inject(node_id: str, z: str, name: str, interval_ms: int, wires: list, once: bool = False) -> dict:
    """轮询注入。once=True：仅启动时触发一次（亚秒轮询的循环起点，周期由 delay 节点承担）。"""
    return {
        'id': node_id,
        'type': 'inject',
        'z': z,
        'name': name,
        'props': [{'p': 'payload'}],
        'repeat': '' if once else str((interval_ms or 1000) / 1000),  # inject 支持小数秒（20-inject.js 乘 1000）；不取整（评审 C4）
        'crontab': '',
        'once': once,
        'onceDelay': 0.1,
        'topic': '',
        'payload': '',
        'payloadType': 'date',
        'x': 130,
        'y': 0,
        'wires': wires,
    }


def make_delay(node_id: str, z: str, name: str, ms: int, wires: list) -> dict:
    """固定延迟节点（亚秒轮询的自循环节奏器）。"""
    return {
        'id': node_id,
        'type': 'delay',
        'z': z,
        'name': name,
        'pauseType': 'delay',
        'timeout': str(ms),
        'timeoutUnits': 'milliseconds',
        'rate': '1',
        'nbRateUnits': '1',
        'rateUnits': 'second',
        'randomFirst': '1',
        'randomLast': '5',
        'randomUnits': 'seconds',
        'drop': False,
        'allowrate': False,
        'outputs': 1,
        'x': 130,
        'y': 0,
        'wires': wires,
    }


def make_rate_limit(node_id: str, z: str, name: str, per_seconds: int, wires: list) -> dict:
    """限速节点（1 条/N 秒，中间丢弃）：告警防洪——PLC 掉线时每轮都失败，不能每轮都发告警。"""
    return {
        'id': node_id,
        'type': 'delay',
        'z': z,
        'name': name,
        'pauseType': 'rate',
        'timeout': '5',
        'timeoutUnits': 'seconds',
        'rate': '1',
        'nbRateUnits': str(per_seconds),
        'rateUnits': 'second',
        'randomFirst': '1',
        'randomLast': '5',
        'randomUnits': 'seconds',
        'drop': True,
        'allowrate': False,
        'outputs': 1,
        'x': 130,
        'y': 0,
        'wires': wires,
    }


def make_mc_read(node_id: str, z: str, name: str, conn_id: str, address: str, wires: list) -> dict:
    """MC Read 读取节点。errorHandling=output2：错误走第二输出脚（告警支路），不依赖 catch。"""
    return {
        'id': node_id,
        'type': 'MC Read',
        'z': z,
        'name': name,
        'topic': '',
        'connection': conn_id,
        'address': address,  # TODO(真机验证 M2)：块读地址串语法，见 9-28/社区MC节点核实记录.md §5
        'addressType': 'str',
        'outputFormat': '0',
        'errorHandling': 'output2',
        'outputs': 2,
        'x': 350,
        'y': 0,
        'wires': wires,
    }


def make_change(node_id: str, z: str, name: str, rules: list, wires: list, x: int = 570, y: int = 0) -> dict:
    return {
        'id': node_id,
        'type': 'change',
        'z': z,
        'name': name,
        'rules': rules,
        'action': '',
        'property': '',
        'from': '',
        'to': '',
        'reg': False,
        'x': x,
        'y': y,
        'wires': wires,
    }


def rule_set_jsonata(prop: str, expr: str) -> dict:
    return {'t': 'set', 'p': prop, 'pt': 'msg', 'to': expr, 'tot': 'jsonata'}


def rule_set_str(prop: str, value: str) -> dict:
    return {'t': 'set', 'p': prop, 'pt': 'msg', 'to': value, 'tot': 'str'}


def make_join(node_id: str, z: str, count: int, wires: list, timeout_s: int = 30) -> dict:
    """多块合并：按 topic（blockNN）聚合成对象，保证与块序一致。

    timeout 是兜底：正常时每块的好/坏两路必有一路到达（坏路由 BAD 装配节点保证），
    join 收齐即触发；超时仅在节点静默死亡的异常路径生效。
    """
    return {
        'id': node_id,
        'type': 'join',
        'z': z,
        'name': '合并块读',
        'mode': 'custom',
        'build': 'object',
        'property': 'payload',
        'propertyType': 'msg',
        'key': 'topic',
        'joiner': '\\n',
        'joinerType': 'str',
        'accumulate': False,
        'timeout': str(timeout_s),
        'count': str(count),
        'reduceRight': False,
        'reduceExp': '',
        'reduceInit': '',
        'reduceInitType': '',
        'reduceFixup': '',
        'x': 790,
        'y': 0,
        'wires': wires,
    }


def make_link_out(node_id: str, z: str, name: str) -> dict:
    """数据出口（link out）：定制逻辑的消费者接口——用户在自己标签页用 link in 连它。

    确定性 id：重新部署后出口重建但 id 不变，用户 link in 连线自动存活。
    links 留空即可（运行时由 link-in 侧的 links 解析，编辑器里的连线信息不影响运行）。
    """
    return {
        'id': node_id,
        'type': 'link out',
        'z': z,
        'name': name,
        'mode': 'link',
        'links': [],
        'x': 1780,
        'y': 0,
        'wires': [],
    }


def make_rbe(node_id: str, z: str, wires: list, x: int = 1010, y: int = 0) -> dict:
    """设备级变化过滤（trigger_kind=2 才插入）：监视 msg.changeKey（不含 ts 的数值指纹）。

    注意：不能监视 payload——契约对象含 ts，每轮必变，rbe 会永远放行。
    """
    return {
        'id': node_id,
        'type': 'rbe',
        'z': z,
        'name': '有变化才报',
        'func': 'rbe',
        'gap': '',
        'start': '',
        'inout': 'out',
        'property': 'changeKey',
        'x': x,
        'y': y,
        'wires': wires,
    }


def make_switch_nonempty(node_id: str, z: str, wires: list, x: int = 1010, y: int = 0) -> dict:
    """value_count>0 才放行（空轮不上报，对齐 V13 的 tagValues.length>0 判断）。"""
    return {
        'id': node_id,
        'type': 'switch',
        'z': z,
        'name': '有值才报',
        'property': 'payload.value_count',
        'propertyType': 'msg',
        'rules': [{'t': 'gt', 'v': '0', 'vt': 'num'}],
        'checkall': 'true',
        'repair': False,
        'outputs': 1,
        'x': x,
        'y': y,
        'wires': wires,
    }


def make_mqtt_broker(node_id: str, name: str, host: str, port: int) -> dict:
    """MQTT broker 配置节点。user/password 属 credential 字段，payload 里永不出现：
    生成期写入 release.deploy_credentials，部署时经 POST /flows 的 credentials 对象下发。"""
    return {
        'id': node_id,
        'type': 'mqtt-broker',
        'name': name,
        'broker': host,
        'port': str(port),
        'clientid': '',
        'autoConnect': True,
        'usetls': False,
        'protocolVersion': '4',
        'keepalive': '60',
        'cleansession': True,
        'birthTopic': '',
        'birthQos': '0',
        'birthPayload': '',
        'closeTopic': '',
        'closeQos': '0',
        'closePayload': '',
        'willTopic': '',
        'willQos': '0',
        'willPayload': '',
    }


def make_mqtt_out(node_id: str, z: str, name: str, topic: str, broker_id: str, x: int = 1250, y: int = 0) -> dict:
    return {
        'id': node_id,
        'type': 'mqtt out',
        'z': z,
        'name': name,
        'topic': topic,
        'qos': '1',
        'retain': 'false',
        'respTopic': '',
        'contentType': '',
        'userProps': '',
        'correl': '',
        'expiry': '',
        'broker': broker_id,
        'x': x,
        'y': y,
        'wires': [],
    }


def make_template(node_id: str, z: str, name: str, template: str, wires: list, x: int = 790, y: int = 0) -> dict:
    return {
        'id': node_id,
        'type': 'template',
        'z': z,
        'name': name,
        'field': 'payload',
        'fieldType': 'msg',
        'format': 'handlebars',
        'syntax': 'mustache',
        'template': template,
        'output': 'str',
        'x': x,
        'y': y,
        'wires': wires,
    }


def make_catch(node_id: str, z: str, name: str, scope: list, wires: list) -> dict:
    """支路级异常兜底：scope 限定本支路节点（告警链路自身除外，防循环）。"""
    return {
        'id': node_id,
        'type': 'catch',
        'z': z,
        'name': name,
        'scope': scope,
        'uncaught': False,
        'x': 130,
        'y': 0,
        'wires': wires,
    }


def make_debug(node_id: str, z: str, name: str, prop: str) -> dict:
    """调试节点：把 msg 的某个属性打到编辑器调试侧栏（排错用，可点节点按钮关停）。"""
    return {
        'id': node_id,
        'type': 'debug',
        'z': z,
        'name': name,
        'active': True,
        'tosidebar': True,
        'console': False,
        'tostatus': False,
        'complete': prop,
        'targetType': 'msg',
        'statusVal': '',
        'statusType': 'auto',
        'x': 0,
        'y': 0,
        'wires': [],
    }


def make_site_health_server(node_id: str, backend_host: str, backend_port: int) -> dict:
    """site-health-server 共享配置节点（全局 config，无 z）。
    铁律：key 字段（credential）整个省略——运行时按节点 id 保留已录入凭证。"""
    return {
        'id': node_id,
        'type': 'site-health-server',
        'name': '存量监控服务器',
        'server': backend_host,
        'port': backend_port,
        'basePath': '',
        'https': False,
    }


def make_site_health(node_id: str, z: str, backend_host: str, backend_port: int, interval: int = 30,
                     server_ref: str = '') -> dict:
    """site-health 上报节点。铁律：key 字段（credential）整个省略——运行时按节点 id 保留已录入凭证。
    server_ref 非空时走共享配置（key 在共享配置节点上录入一次，site-health/flows-upload 共用）。"""
    return {
        'id': node_id,
        'type': 'site-health',
        'z': z,
        'name': '采集点健康度',
        'serverRef': server_ref,
        'interval': interval,
        'server': backend_host,
        'port': backend_port,
        'basePath': '',
        'https': False,
        'x': 200,
        'y': 80,
        'wires': [],
    }


def make_site_flows_upload(node_id: str, z: str, server_ref: str) -> dict:
    """flows.json 手动上传节点（编辑器按钮触发，把现场画布快照传回后端留档）。
    serverRef 必填（共享配置节点）；本身无 credential，key 在共享配置上。"""
    return {
        'id': node_id,
        'type': 'site-flows-upload',
        'z': z,
        'name': 'flows.json 上传',
        'serverRef': server_ref,
        'flowsPath': '',
        'x': 200,
        'y': 130,
        'wires': [],
    }

def make_pg_config(node_id: str, name: str, host: str, port: int, db: str,
                   user: str = '', password: str = '') -> dict:
    """PostgreSQL 配置节点（node-red-contrib-postgresql，字段名 database 非 db，评审 A2）。
    注意：该包的 user/password 是明文普通字段（非 credential）——内嵌会留在 flows.json 里。
    留空则不写，现场编辑器录入一次（按节点 id 存活）。"""
    node = {
        'id': node_id,
        'type': 'postgreSQLConfig',
        'name': name,
        'host': host,
        'port': port,
        'database': db,
        'ssl': False,
    }
    if user:
        node['user'] = user
        node['password'] = password
    return node


def make_pg_node(node_id: str, z: str, name: str, config_id: str, x: int = 1470, y: int = 0) -> dict:
    """PostgreSQL 执行节点：query 用 mustache 渲染 msg.topic（上游 change 已拼好多行 INSERT）。

    该包取 SQL 的顺序是 msg.query → mustache(node.query)（postgresql.js:174），不读 msg.topic——
    评审 A2：query 留空会得到空 SQL，故显式渲染 msg.topic。
    """
    return {
        'id': node_id,
        'type': 'postgresql',
        'z': z,
        'name': name,
        'query': '{{{msg.topic}}}',
        'postgreSQLConfig': config_id,
        'split': False,
        'rowsPerMsg': 1,
        'outputs': 1,
        'x': x,
        'y': y,
        'wires': [],
    }


# ==================== JSONata 装配表达式 ====================


def tag_ref_expr(tag: dict, octal_xy: bool) -> str:
    """点位在块输出 JSON 对象中的取值表达式 $lookup(payload, "<key>")。

    key 规则（读 read.js 确认）：非 BIT = 寄存器类型+地址（如 D100）；
    BIT = 类型+地址+'.'+十六进制位号（如 D100.A）；
    FX 的 X/Y 八进制模式下地址按十六进制大写表示。
    """
    reg_type = tag['register_type']
    addr = tag['register_address']
    data_type = (tag.get('data_type') or '').upper()
    if data_type in ('BIT', 'BOOL'):
        bit = int(tag.get('bit_offset') or 0)
        key = f'{reg_type}{addr}.{bit:X}'
    elif octal_xy and reg_type in ('X', 'Y'):
        key = f'{reg_type}{int(str(addr), 8):X}'
    else:
        key = f'{reg_type}{addr}'
    return f'$lookup(payload, {_jstr(key)})'


def comm_expr(multi_block: bool) -> str:
    """设备级通信状态（每轮一次，评审 C3）：任一块 BAD 即离线。

    注意取 payload.values：本规则在契约装配（规则1）之后执行，payload 已是契约对象。
    """
    return '($count(payload.values[quality="BAD"]) = 0) ? "true" : "false"'


def block_assemble_expr(tags: list, octal_xy: bool) -> str:
    """块内契约装配：把块输出对象转为该块点位的 values 数组（含 transform_type 供 PG 用）。

    点位级缺失语义（OPT-04）：$lookup 查不到 key 时 raw/eng 置 null、quality=UNCERTAIN
    （对齐 V13 三态语义；UNCERTAIN 不计入设备级 comm 离线的 BAD 统计，个别点缺失不放大为设备离线）。
    """
    items = []
    for tag in tags:
        raw = tag_ref_expr(tag, octal_xy)
        tt = tag.get('transform_type') or 'none'
        if tt in ('linear', 'slope_offset'):
            a = tag.get('transform_slope_a') or 1
            b = tag.get('transform_offset_b') or 0
            eng = f'($w := {raw}; $exists($w) ? ($w * {a} + {b}) : null)'
        else:
            eng = f'($w := {raw}; $exists($w) ? $w : null)'
        items.append(
            '{'
            f'"tag_id": {tag["id"]}, '
            f'"tag_address": {_jstr(tag["register_address"])}, '
            f'"tag_name": {_jstr(tag.get("description") or "")}, '
            f'"raw_value": ($v := {raw}; $exists($v) ? $v : null), '
            f'"register_type": {_jstr(tag["register_type"])}, '
            f'"eng_value": {eng}, '
            f'"unit": {_jstr(tag.get("eng_unit") or tag.get("unit") or "")}, '
            # 好路恒 GOOD；点位缺失降级 UNCERTAIN（评审 A3 + OPT-04）
            f'"quality": ($exists({raw}) ? "GOOD" : "UNCERTAIN"), '
            f'"transform_type": {_jstr(tt)}, '
            f'"ts": {TS_EXPR}'
            '}'
        )
    return '[' + ', '.join(items) + ']'


def bad_block_assemble_expr(tags: list) -> str:
    """块读取失败时的 BAD 装配：该块全部点位 raw/eng 置空、quality=BAD（块级失败语义）。

    与正常装配同构（含 transform_type 供 PG 用），保证 join 永远收齐块数。
    """
    items = []
    for tag in tags:
        items.append(
            '{'
            f'"tag_id": {tag["id"]}, '
            f'"tag_address": {_jstr(tag["register_address"])}, '
            f'"tag_name": {_jstr(tag.get("description") or "")}, '
            f'"raw_value": null, '
            f'"register_type": {_jstr(tag["register_type"])}, '
            f'"eng_value": null, '
            f'"unit": {_jstr(tag.get("eng_unit") or tag.get("unit") or "")}, '
            f'"quality": "BAD", '
            f'"transform_type": {_jstr(tag.get("transform_type") or "none")}, '
            f'"ts": {TS_EXPR}'
            '}'
        )
    return '[' + ', '.join(items) + ']'


def _reduce_vals_expr(multi_block: bool) -> str:
    """把（join 后的块对象 / 单块的数组）归并为一个 values 数组，绑定为 $vals。"""
    if multi_block:
        return (
            '$reduce($sort($keys(payload)), '
            'function($acc, $k){$append($acc, $lookup(payload, $k))}, [])'
        )
    return 'payload'


def change_key_expr(multi_block: bool) -> str:
    """变化指纹：values 的 [tag_id, eng_value, quality] 投影（不含 ts），供 rbe 节点监视。

    注意取 payload.values：本规则在契约装配（规则1）之后执行，payload 已是契约对象。
    """
    return (
        '$map(payload.values, function($v){{'
        '"i": $v.tag_id, "v": $v.eng_value, "q": $v.quality'
        '}})'
    )


def pg_values_expr(multi_block: bool) -> str:
    """暂存原始 values（含 transform_type）：契约装配（规则1）会把 transform_type 从 MQTT
    契约 values 里剥离，而 pg_sql_expr 拼 INSERT 时又需要它。本规则在契约装配之前执行，
    把未剥离的 values 归并数组暂存到 msg.pg_values，供 pg_sql_expr 读取。
    """
    return _reduce_vals_expr(multi_block)


def final_assemble_expr(node_id: int, device: dict, multi_block: bool) -> str:
    """最终装配：产出 V13 MQTT 契约对象（values 剥离 transform_type，保持契约字段一致）。

    node_id = nodered_node.id（与 V12/V13 契约一致），不是 site_health_site.id。
    """
    vals = _reduce_vals_expr(multi_block)
    strip = (
        '$map($vals, function($v){{'
        '"tag_id": $v.tag_id, "tag_address": $v.tag_address, "tag_name": $v.tag_name, '
        '"raw_value": $v.raw_value, "register_type": $v.register_type, '
        '"eng_value": $v.eng_value, "unit": $v.unit, "quality": $v.quality, "ts": $v.ts'
        '}})'
    )
    return (
        f'($vals := {vals}; {{'
        f'"node_id": {node_id}, '
        f'"device_id": {device["id"]}, '
        f'"device_name": {_jstr(device["device_name"])}, '
        f'"host_pc_ip": {_jstr(device.get("host_pc_ip") or "")}, '
        f'"ts": {TS_EXPR}, '
        f'"value_count": $count($vals), '
        f'"values": {strip}, '
        f'"quality": ($count($vals[quality="BAD"]) > 0 ? "BAD" : "GOOD")'
        '})'
    )


def pg_sql_expr(node_id: int, device: dict, multi_block: bool, fields: list = None,
                pg_schema: str = 'public', pg_table: str = 'plc_data_log') -> str:
    """多行 INSERT 拼进 msg.pg_sql（目标 schema.table 与列子集均可按现场配置）。

    注意取 pg_values：契约装配（规则1）把 transform_type 从 payload.values 里剥离了，
    所以本规则读规则1之前暂存的 msg.pg_values（含 transform_type）——直接取 payload.values
    会产出 transform_type 为空串的坏 SQL。

    fields：插入列子集（None=全部 8 列）。列名走白名单映射（防注入）。
    pg_schema/pg_table：由调用方做标识符校验（^[A-Za-z_][A-Za-z0-9_]*$）。
    必填列（NOT NULL 约束）：device_id/tag_id/quality 强制包含，勾掉也会被带上。
    """
    comma = '","'  # JSONata 文本 ","
    quote = '"\'"'  # JSONata 文本 "'"
    qcq = '"\',\'"'  # JSONata 文本 "','"

    # 列名 → JSONata 取值表达式（数字裸值、字符串加引号、可空走 NULL）
    field_expr = {
        'device_id': f'{device["id"]}',
        'tag_id': '$string(tag_id)',
        'node_id': f'{node_id}',
        'tag_name': f'{quote} & tag_name & {quote}',
        'tag_address': f'{quote} & tag_address & {quote}',
        'register_type': f'{quote} & register_type & {quote}',
        'raw_value': '(raw_value != null ? $string(raw_value) : "NULL")',
        'eng_value': '(eng_value != null ? $string(eng_value) : "NULL")',
        'unit': f'{quote} & unit & {quote}',
        'quality': f'{quote} & quality & {quote}',
        'transform_type': f'{quote} & transform_type & {quote}',
        'ts': f'{quote} & ts & {quote}',
    }
    # NOT NULL 约束列（plc_data_log: device_id/tag_id/quality 非空）——强制带上，防呆
    mandatory = ['device_id', 'tag_id', 'quality']
    default_fields = ['device_id', 'tag_id', 'node_id', 'raw_value', 'eng_value', 'quality', 'transform_type', 'ts']
    chosen = [f for f in (fields or default_fields) if f in field_expr]
    use_fields = mandatory + [f for f in chosen if f not in mandatory] if chosen else default_fields

    row = '"(" & ' + f' & {comma} & '.join(field_expr[f] for f in use_fields) + ' & ")"'
    cols = ','.join(use_fields)
    return (
        '($vals := pg_values; '
        f'"INSERT INTO {pg_schema}.{pg_table} ({cols}) VALUES " '
        f'& $join($vals.({row}), ","))'
    )


def alarm_template_text(node_id: int, device: dict) -> str:
    """告警 mustache 模板（ts 由上游 change 节点写入 msg.ts）。node_id = nodered_node.id。"""
    return (
        '{"alert_type":"PLC_OFFLINE",'
        f'"node_id":{node_id},'
        f'"device_id":{device["id"]},'
        f'"device_name":{_jstr(device["device_name"])},'
        f'"host_pc_ip":{_jstr(device.get("host_pc_ip") or "")},'
        '"msg":"采集失败或支路异常",'
        '"ts":"{{ts}}"}'
    )


def make_pg_stat_node(node_id: str, z: str, name: str, backend_host: str, backend_port: int,
                      node_id_ref: int, device_id: int, field: str, api_key: str) -> dict:
    """PG 写入计数上报（http request）。field='ok'（成功支路）或 'fail'（失败支路）。

    条数取 msg.pg_rows（PG 支路上游 change 已把 value_count 存入），URL 用 mustache 取值。
    """
    url = (
        f'http://{backend_host}:{backend_port}/monitor/pg-stat-edge'
        f'?node_id={node_id_ref}&{field}=' + '{{pg_rows}}'
    )
    return {
        'id': node_id, 'type': 'http request', 'z': z, 'name': name,
        'method': 'POST', 'ret': 'obj', 'paytoqs': 'ignore', 'url': url, 'tls': '',
        'persist': False, 'proxy': '', 'insecureHTTPParser': False, 'authType': '',
        'senderr': False,
        'headers': [{'keyType': 'other', 'keyValue': 'X-API-Key', 'valueType': 'other', 'valueValue': api_key}],
        'x': 1690, 'y': 80, 'wires': [[]],
    }


def make_comm_stat_node(node_id: str, z: str, name: str, backend_host: str, backend_port: int,
                        node_id_ref: int, device_id: int, api_key: str) -> dict:
    """逐台通信状态上报（http request）。读取成功/失败两条支路汇入同一节点，
    msg.comm（'true'/'false'，由块装配/BAD装配节点写入）经 mustache 进 URL。

    语义：在线状态只反映 MC 读取结果，与 PG 写入解耦。
    """
    url = (
        f'http://{backend_host}:{backend_port}/monitor/device-comm-edge'
        f'?node_id={node_id_ref}&device_id={device_id}&success=' + '{{comm}}'
    )
    return {
        'id': node_id, 'type': 'http request', 'z': z, 'name': name,
        'method': 'POST', 'ret': 'obj', 'paytoqs': 'ignore', 'url': url, 'tls': '',
        'persist': False, 'proxy': '', 'insecureHTTPParser': False, 'authType': '',
        'senderr': False,
        'headers': [{'keyType': 'other', 'keyValue': 'X-API-Key', 'valueType': 'other', 'valueValue': api_key}],
        'x': 1010, 'y': 240, 'wires': [[]],
    }


def make_reconnect_change(node_id: str, z: str, wires: list) -> dict:
    """断线重连指令：把消息改写为 topic=reinitialize，回接 MC Read 输入触发连接池重建。

    依据（connection_pool.js 作者注释）：物理断连后旧连接对象 connect() 无法恢复，
    必须 reinitialize（销毁重建）。自动重连对物理断连无效，由此支路兜底。
    """
    return {
        'id': node_id,
        'type': 'change',
        'z': z,
        'name': '重连指令',
        'rules': [
            {'t': 'set', 'p': 'topic', 'pt': 'msg', 'to': 'reinitialize', 'tot': 'str'},
            {'t': 'set', 'p': 'payload', 'pt': 'msg', 'to': '', 'tot': 'str'},
        ],
        'action': '', 'property': '', 'from': '', 'to': '', 'reg': False,
        'x': 500, 'y': 0,
        'wires': wires,
    }


# ==================== Modbus（node-red-contrib-modbus） ====================

# 寄存器类型 → 功能码
MODBUS_FC_MAP = {
    'HR': 'HoldingRegister',
    'IR': 'InputRegister',
    'CR': 'Coil',
    'COIL': 'Coil',
    'DISCRETE': 'Input',
}


def make_modbus_client(node_id: str, name: str, device: dict) -> dict:
    """modbus-client 配置节点（TCP）。unit_id 取 protocol_params.unitId，默认 1。"""
    return {
        'id': node_id,
        'type': 'modbus-client',
        'name': name,
        'clienttype': 'tcp',
        'bufferCommands': True,
        'stateLogEnabled': False,
        'queueLogEnabled': False,
        'failMsgEnabled': True,
        'tcpHost': str(device.get('plc_ip') or ''),
        'tcpPort': str(device.get('plc_port') or 502),
        'tcpType': 'DEFAULT',
        'serialPort': '/dev/ttyUSB',
        'serialType': 'RTU-BUFFERD',
        'serialBaudrate': '9600',
        'serialDatabits': '8',
        'serialStopbits': '1',
        'serialParity': 'none',
        'serialConnectionDelay': '100',
        'serialAsciiResponseStartDelimiter': '',
        'unit_id': int(device.get('unit_id') or 1),
        'commandDelay': 100,
        'clientTimeout': int(device.get('comm_timeout_ms') or 3000),
        'reconnectOnTimeout': True,       # Modbus 侧超时自动重连（节点内建）
        'reconnectTimeout': 2000,
    }


def make_modbus_read(node_id: str, z: str, name: str, client_id: str, unit_id, fc: str,
                     address: int, quantity: int, interval_ms: int, wires: list) -> dict:
    """modbus-read：自带走时轮询（rate/rateUnit），emptyMsgOnFail 开路失败分流。

    TODO(真机验证 M2)：rateUnit 'ms' 亚秒档位以实际安装版本为准。
    """
    sub = (interval_ms or 1000) < 1000
    return {
        'id': node_id,
        'type': 'modbus-read',
        'z': z,
        'name': name,
        'topic': '',
        'unitid': str(unit_id or 1),
        'dataType': fc,
        'adr': str(address),
        'quantity': str(quantity),
        'rate': str(interval_ms if sub else max(1, round((interval_ms or 1000) / 1000))),
        'rateUnit': 'ms' if sub else 's',
        'delayOnStart': False,
        'startDelayTime': '',
        'server': client_id,
        'useIOFile': False,
        'ioFile': '',
        'useIOForPayload': False,
        'emptyMsgOnFail': True,
        'x': 380,
        'y': 0,
        'wires': wires,
    }


def make_switch_empty(node_id: str, z: str, wires: list) -> dict:
    """空载荷分流：out1=null(BAD) out2=empty(BAD) out3=else(正常装配)。

    合法规则名只有 empty/nempty/null（isempty 不存在——评审 A1）。
    empty 对 null 返回 false（switch.js:34-41），故 null 需单独一条。
    wires 顺序对应 [null路, empty路, else路]。
    """
    return {
        'id': node_id,
        'type': 'switch',
        'z': z,
        'name': '读取失败?',
        'property': 'payload',
        'propertyType': 'msg',
        'rules': [{'t': 'null'}, {'t': 'empty'}, {'t': 'else'}],
        'checkall': 'true',
        'repair': False,
        'outputs': 3,
        'x': 560,
        'y': 0,
        'wires': wires,
    }


def modbus_block_assemble_expr(tags: list, block_start: int) -> str:
    """Modbus 块内装配：payload 是寄存器值数组，按下标取值（数组下标 = 地址 - 块起始）。

    读取成功路径 quality=GOOD；下标越界（点位缺失）降级 UNCERTAIN（OPT-04，与 MC 支路同语义）。
    位语义（OPT-02）：CR/COIL/DISCRETE 位区直接取值；HR/IR 字区上的 BIT 点用
    bit_offset 算术位提取（JSONata 无位运算，$floor(w/2^n)%2）。
    多字类型（INT32/FLOAT 等）在服务层已拦截告警。
    """
    items = []
    for tag in tags:
        idx = int(tag['register_address']) - block_start
        dt = (tag.get('data_type') or '').upper()
        reg = tag['register_type']
        bit_on_word = dt in ('BIT', 'BOOL') and reg in ('HR', 'IR')
        if bit_on_word:
            bit = int(tag.get('bit_offset') or 0)
            raw = f'($word := payload[{idx}]; $exists($word) ? ($floor($word / $power(2, {bit})) % 2) : null)'
        else:
            raw = f'payload[{idx}]'
        tt = tag.get('transform_type') or 'none'
        if tt in ('linear', 'slope_offset') and not bit_on_word:
            a = tag.get('transform_slope_a') or 1
            b = tag.get('transform_offset_b') or 0
            eng = f'($w := {raw}; $exists($w) ? ($w * {a} + {b}) : null)'
        else:
            eng = f'($w := {raw}; $exists($w) ? $w : null)'
        items.append(
            '{'
            f'"tag_id": {tag["id"]}, '
            f'"tag_address": {_jstr(tag["register_address"])}, '
            f'"tag_name": {_jstr(tag.get("description") or "")}, '
            f'"raw_value": ($v := {raw}; $exists($v) ? $v : null), '
            f'"register_type": {_jstr(tag["register_type"])}, '
            f'"eng_value": {eng}, '
            f'"unit": {_jstr(tag.get("eng_unit") or tag.get("unit") or "")}, '
            f'"quality": ($exists(payload[{idx}]) ? "GOOD" : "UNCERTAIN"), '
            f'"transform_type": {_jstr(tt)}, '
            f'"ts": {TS_EXPR}'
            '}'
        )
    return '[' + ', '.join(items) + ']'


def make_heartbeat_branch(nodes: list, site_id: int, infra_tab_id: str, backend_host: str, backend_port: int,
                          host_pc_ip: str, api_key: str, flow_version: str) -> None:
    """基础设施 tab 心跳支路：inject(30s) → http request POST /monitor/heartbeat-edge。

    维持节点监控中心（nodered_node）在线状态；URL 带 flow_version（部署回执，OPT-08）。
    X-API-Key 内嵌 flow（与 bootstrap.json 同等暴露面）。
    """
    from urllib.parse import quote

    inject_id = nid(site_id, 'hb', 'inject')
    http_id = nid(site_id, 'hb', 'http')
    url = (
        f'http://{backend_host}:{backend_port}/monitor/heartbeat-edge'
        f'?host_pc_ip={quote(host_pc_ip, safe="")}&flow_version={flow_version}'
    )
    nodes.append({
        'id': inject_id, 'type': 'inject', 'z': infra_tab_id, 'name': '心跳',
        'props': [{'p': 'payload'}], 'repeat': '30', 'crontab': '', 'once': True, 'onceDelay': 5,
        'topic': '', 'payload': '', 'payloadType': 'date', 'x': 130, 'y': 160, 'wires': [[http_id]],
    })
    nodes.append({
        'id': http_id, 'type': 'http request', 'z': infra_tab_id, 'name': '心跳上报',
        'method': 'POST', 'ret': 'obj', 'paytoqs': 'ignore', 'url': url, 'tls': '',
        'persist': False, 'proxy': '', 'insecureHTTPParser': False, 'authType': '',
        'senderr': False,
        'headers': [{'keyType': 'other', 'keyValue': 'X-API-Key', 'valueType': 'other', 'valueValue': api_key}],
        'x': 350, 'y': 160, 'wires': [[]],
    })
