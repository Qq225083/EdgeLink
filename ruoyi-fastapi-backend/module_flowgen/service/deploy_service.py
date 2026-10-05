"""过渡版流程生成器 — 部署服务（Node-RED Admin API）

能力：
1. deploy_release —— 部署 release 到边缘 Node-RED。默认**合并部署**：只替换 GEN_ 开头的生成标签页
   （及其成员/配置节点），边缘上其他程序原样保留；full_replace=True 时退回全量清空替换；
2. drift_status   —— 漂移检测：只在生成范围内比对（用户自有节点不算漂移），并读出心跳回执的运行版本；
3. 版本留痕      —— 部署/巡检时读 GET /nodes，把关键节点包版本写进 deploy_msg（错配可见化）。

前提：边缘 Node-RED Admin API 可达（adminAuth 未启用；启用后需加 token，暂不支持）。
"""
import hashlib
import json
import time
from datetime import datetime

import httpx
from sqlalchemy import delete, desc, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from exceptions.exception import ServiceException
from module_flowgen.dao.flowgen_dao import FlowgenDao
from module_flowgen.entity.do.flowgen_do import PlcFlowCanvasSnapshot, PlcFlowDeployLog, PlcFlowRelease
from module_plc.entity.do.monitor_do import NoderedNode
from module_site_health.entity.do.site_health_do import SiteHealthSite

# 版本留痕关注的节点包
_WATCH_MODULES = (
    'node-red-contrib-mcprotocol',
    'node-red-contrib-postgresql',
    'node-red-contrib-modbus',
    'node-red-contrib-edgelink-site-health',
)

_TIMEOUT = httpx.Timeout(connect=5.0, read=90.0, write=90.0, pool=5.0)  # 大画布部署可达 20-30s

# 画布快照每现场保留份数
_KEEP_SNAPSHOTS = 20


def _edge_base(site: SiteHealthSite) -> str:
    port = site.node_port or 1880
    return f'http://{site.office_ip}:{port}'


def _canon_norm(v):
    """递归归一化（漂移比对用）：
    - 剔除编辑器部署时自动补充的元数据：g（分组归属）、*FieldType（类型标注）、x/y（画布坐标）；
    - 空串/None/缺省 视为相等；布尔与 'true'/'false' 字符串互认；数字与数字字符串互认；
    - postgreSQLConfig 的 user/password 不入比对（该包明文存储，属环境凭证而非生成内容）；
    - __PWRD__（credential 占位符）剔除。"""
    if isinstance(v, dict):
        ntype = v.get('type')
        out = {}
        for k, x in v.items():
            if k in ('g', 'x', 'y') or k.endswith('FieldType') or x == '__PWRD__':
                continue
            if ntype == 'group' and k in ('w', 'h'):
                continue  # 编辑器部署时自动重算分组尺寸
            if ntype == 'link out' and k == 'links':
                continue  # link out.links 是编辑器维护的"谁连了我"派生信息（用户侧接线，非生成内容）
            if ntype == 'debug' and k == 'active':
                continue  # debug 节点的启停按钮是用户侧观察口开关，不是逻辑变化
            if k in ('user', 'password') and ntype == 'postgreSQLConfig':
                continue
            nx = _canon_norm(x)
            if nx == '':
                continue
            out[k] = nx
        # 编辑器补的类型伴随字段（applicationNameType 等 XxxType）：基字段缺省（被剔除）则伴随字段视为噪音
        for k in list(out):
            if k.endswith('Type') and k[:-4] not in out:
                del out[k]
        return out
    if isinstance(v, list):
        return [_canon_norm(x) for x in v]
    if v is None:
        return ''
    if isinstance(v, bool):
        return '1' if v else '0'
    if isinstance(v, (int, float)):
        return repr(float(v))
    if isinstance(v, str):
        lv = v.lower()
        if lv == 'true':
            return '1'
        if lv == 'false':
            return '0'
        try:
            return repr(float(v))
        except ValueError:
            return v
    return str(v)


def _canon_hash(flows: list) -> str:
    """归一化哈希：按 id 排序（顺序无关）+ _canon_norm 归一化（编辑器格式噪音不算漂移）。"""
    stripped = sorted(
        (_canon_norm(node) for node in flows),
        key=lambda n: n.get('id', ''),
    )
    return hashlib.sha256(json.dumps(stripped, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()


def _gen_tab_matchers(payload_flows: list) -> tuple[set, set]:
    """从 payload 标签页名推断"生成页"识别规则：
    - prefixes：含"采集_"的标签切出的前缀（如 EL_采集_x → EL_），用于匹配采集页；
    - exact：不含"采集_"的标签整名（如"基础设施"），精确匹配（这类页不带前缀，不能用前缀规则）。"""
    prefixes, exact = set(), set()
    for n in payload_flows:
        if n.get('type') == 'tab':
            label = str(n.get('label', ''))
            if '采集_' in label:
                prefixes.add(label.split('采集_')[0])
            else:
                exact.add(label)
    return prefixes, exact


def _is_gen_tab(label: str, prefixes: set, exact: set) -> bool:
    if label in exact:
        return True
    if any(p and label.startswith(p + '采集_') for p in prefixes):
        return True
    return label.startswith('GEN_')  # 历史残留清理（早期无前缀识别版本）


def _scoped_match(live_flows: list, payload_flows: list) -> bool:
    """只在生成范围内比对：payload 内每个节点 id 在边缘侧逐节点一致 + 边缘无残留的生成标签页。
    用户自有标签页/节点不参与比对（合并部署语义下它们理应原样保留）。"""
    payload_by_id = {n['id']: n for n in payload_flows}
    live_by_id = {n['id']: n for n in live_flows}
    live_subset = [live_by_id[i] for i in payload_by_id if i in live_by_id]
    if _canon_hash(live_subset) != _canon_hash(list(payload_by_id.values())):
        return False
    prefixes, exact = _gen_tab_matchers(payload_flows)
    payload_tabs = {n.get('label', '') for n in payload_flows if n.get('type') == 'tab'}
    live_gen_tabs = {
        n.get('label', '') for n in live_flows
        if n.get('type') == 'tab' and _is_gen_tab(str(n.get('label', '')), prefixes, exact)
    }
    return not (live_gen_tabs - payload_tabs)


def _merge_flows(live_flows: list, payload_flows: list, known_gen_ids: set) -> tuple[list, int]:
    """合并部署：摘掉边缘上旧的生成范围（认门规则：确定性 id ∈ 已知生成集 ∪ 历史 GEN_ 前缀标签页），
    其余用户程序原样保留，再追加新 payload。返回 (合并结果, 移除节点数)。

    id 认门使标签页前缀可自定义；GEN_ 前缀规则仅用于清理早期版本的残留。"""
    live_gen_tab_ids = {
        n['id'] for n in live_flows
        if n.get('type') == 'tab' and (n.get('id') in known_gen_ids or str(n.get('label', '')).startswith('GEN_'))
    }
    payload_ids = {n['id'] for n in payload_flows}
    kept = []
    removed = 0
    for n in live_flows:
        node_id = n.get('id', '')
        if n.get('type') == 'tab' and node_id in live_gen_tab_ids:
            removed += 1
            continue
        if n.get('z') and n['z'] in live_gen_tab_ids:
            removed += 1
            continue
        if node_id in payload_ids:
            removed += 1
            continue
        # 全局 config 节点（无 z）：仅当 id 是已知生成产物才摘除（覆盖"设备被删"的残留场景）
        if not n.get('z') and node_id in known_gen_ids:
            removed += 1
            continue
        kept.append(n)
    return kept + payload_flows, removed


def _parse_flows_response(data) -> tuple[list, str]:
    """GET /flows 兼容两种返回形态：v1 纯数组 / v2 {flows, rev}。"""
    if isinstance(data, dict):
        return data.get('flows', []), data.get('rev') or ''
    return data, ''


async def _get_json(client: httpx.AsyncClient, url: str):
    resp = await client.get(url, headers={'Node-RED-API-Version': 'v2'})
    resp.raise_for_status()
    return resp.json()


async def _read_module_versions(client: httpx.AsyncClient, base: str) -> str:
    """读边缘实装节点包版本（留痕用；失败不阻塞主流程）。
    GET /nodes 返回数组，每项的 module/version 才是包名与版本（name 是节点名）。"""
    try:
        resp = await client.get(f'{base}/nodes', headers={'Accept': 'application/json'})
        resp.raise_for_status()
        nodes = resp.json()
    except Exception:
        return ''
    if not isinstance(nodes, list):
        return ''
    found = {}
    for item in nodes:
        mod = item.get('module', '')
        if mod in _WATCH_MODULES:
            found[mod] = item.get('version', '?')
    return ' '.join(f'{m.split("node-red-contrib-")[-1]}@{found[m]}' for m in _WATCH_MODULES if m in found)


class FlowDeployService:
    """部署与漂移检测服务"""

    @classmethod
    async def _load_site(cls, db: AsyncSession, site_id: int) -> SiteHealthSite:
        result = await db.execute(select(SiteHealthSite).where(SiteHealthSite.id == site_id))
        site = result.scalar_one_or_none()
        if not site:
            raise ServiceException(message=f'采集点不存在：site_id={site_id}')
        return site

    @classmethod
    async def drift_status(cls, db: AsyncSession, site_id: int) -> dict:
        """漂移检测（生成范围内比对）+ 心跳回执的运行版本。边缘离线时如实返回，不报错。"""
        site = await cls._load_site(db, site_id)
        latest = await FlowgenDao.get_latest_release(db, site_id)
        # 边缘"在跑版本"= 心跳回执写入的 nodered_node.config_version（OPT-08）
        host_keys = [site.office_ip] + ([f'{site.office_ip}:{site.node_port}'] if site.node_port else [])
        node_res = await db.execute(select(NoderedNode).where(NoderedNode.host_pc_ip.in_(host_keys)))
        nr_node = node_res.scalars().first()
        base = _edge_base(site)
        result = {
            'siteId': site_id,
            'edge': base,
            'online': False,
            'match': None,
            'latestVersion': latest.version if latest else None,
            'runningVersion': (nr_node.config_version if nr_node else None),
            'edgeNodeCount': None,
            'modules': '',
        }
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                data = await _get_json(client, f'{base}/flows')
                flows, _rev = _parse_flows_response(data)
                result['online'] = True
                result['edgeNodeCount'] = len(flows)
                result['modules'] = await _read_module_versions(client, base)
                if latest:
                    result['match'] = _scoped_match(flows, json.loads(latest.payload))
        except (httpx.HTTPError, ValueError):
            pass
        return result

    @classmethod
    async def deploy_preview(cls, db: AsyncSession, release_id: int) -> dict:
        """部署预览：列出本次合并部署将替换/摘除/新增/保留的标签页，让用户看得见再确认。"""
        release = await FlowgenDao.get_release_by_id(db, release_id)
        if not release:
            raise ServiceException(message='流程版本不存在')
        site = await cls._load_site(db, release.site_id)
        base = _edge_base(site)
        payload_flows = json.loads(release.payload)
        result = {'online': False, 'edge': base, 'replace': [], 'remove': [], 'add': [], 'keep': []}
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                live_flows, _rev = _parse_flows_response(await _get_json(client, f'{base}/flows'))
        except (httpx.HTTPError, ValueError):
            return result
        result['online'] = True

        latest = await FlowgenDao.get_latest_release(db, release.site_id)
        known_gen_ids = {n['id'] for n in payload_flows}
        if latest:
            known_gen_ids |= {n['id'] for n in json.loads(latest.payload)}
        payload_ids = {n['id'] for n in payload_flows}
        payload_tab_labels = {n['id']: n.get('label', '') for n in payload_flows if n.get('type') == 'tab'}
        live_ids = {n.get('id') for n in live_flows}

        prefixes, exact = _gen_tab_matchers(payload_flows)
        for n in live_flows:
            if n.get('type') != 'tab':
                continue
            label = str(n.get('label', ''))
            is_gen = n.get('id') in known_gen_ids or _is_gen_tab(label, prefixes, exact)
            if is_gen:
                (result['replace'] if n['id'] in payload_ids else result['remove']).append(label)
            else:
                result['keep'].append(label)
        result['add'] = [label for tid, label in payload_tab_labels.items() if tid not in live_ids]
        # 生成区漂移：边缘生成范围与该版本内容不一致（手改了生成页 / 边缘跑的是别的版本）→ 前端红字警告
        result['genDrift'] = not _scoped_match(live_flows, payload_flows)
        return result

    @classmethod
    async def snapshot_canvas(cls, db: AsyncSession, site_id: int, release_id: int | None = None,
                              source: str = 'deploy', create_by: str = '', flows: list | None = None, rev: str = '') -> int:
        """存一份边缘完整画布快照（含用户自定义标签页）；每现场只留最近 20 份。
        flows 为空时主动从边缘拉取（手动备份场景）。"""
        site = await cls._load_site(db, site_id)
        base = _edge_base(site)
        if flows is None:
            try:
                async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                    flows, rev = _parse_flows_response(await _get_json(client, f'{base}/flows'))
            except (httpx.HTTPError, ValueError):
                raise ServiceException(message=f'边缘不可达（{base}），无法备份画布')
        snap = PlcFlowCanvasSnapshot(
            site_id=site_id, release_id=release_id, rev=rev, node_count=len(flows),
            payload=json.dumps(flows, ensure_ascii=False), source=source, create_by=create_by,
        )
        db.add(snap)
        await db.flush()
        snap_id = snap.id
        old = await db.execute(
            select(PlcFlowCanvasSnapshot.id)
            .where(PlcFlowCanvasSnapshot.site_id == site_id)
            .order_by(desc(PlcFlowCanvasSnapshot.id))
            .offset(_KEEP_SNAPSHOTS)
        )
        old_ids = [r[0] for r in old.all()]
        if old_ids:
            await db.execute(delete(PlcFlowCanvasSnapshot).where(PlcFlowCanvasSnapshot.id.in_(old_ids)))
        await db.commit()
        return snap_id

    @classmethod
    async def deploy_release(cls, db: AsyncSession, release_id: int, deploy_by: str = '', full_replace: bool = False) -> dict:
        """部署 release 到边缘 Node-RED。默认合并部署（只替换 GEN_ 生成标签页）；
        full_replace=True 全量清空替换。任何一步失败都记录履历并抛 ServiceException。"""
        release = await FlowgenDao.get_release_by_id(db, release_id)
        if not release:
            raise ServiceException(message='流程版本不存在')
        site = await cls._load_site(db, release.site_id)
        base = _edge_base(site)
        flows = json.loads(release.payload)

        log = PlcFlowDeployLog(
            release_id=release.id, site_id=release.site_id, target=f'{site.office_ip}:{site.node_port or 1880}',
            deploy_type='full' if full_replace else 'merge', result='0', create_by=deploy_by,
        )
        t0 = time.monotonic()
        rev_before = rev_after = ''
        removed = 0
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                live_flows, rev_before = _parse_flows_response(await _get_json(client, f'{base}/flows'))
                if full_replace:
                    body_obj = {'flows': flows}
                else:
                    # 已知生成 id = 本次 payload + 最新版本 payload（覆盖"设备被删"的残留 config 节点）
                    latest = await FlowgenDao.get_latest_release(db, release.site_id)
                    known_gen_ids = {n['id'] for n in flows}
                    if latest:
                        known_gen_ids |= {n['id'] for n in json.loads(latest.payload)}
                    merged, removed = _merge_flows(live_flows, flows, known_gen_ids)
                    body_obj = {'flows': merged}
                # v2 安全部署：带 rev，部署期间画布被他人改动则 409 拒绝而不是互相覆盖
                if rev_before:
                    body_obj['rev'] = rev_before
                # 部署凭证（MQTT 等 credential 字段走独立 credentials 对象，不进 flows）
                if release.deploy_credentials:
                    body_obj['credentials'] = json.loads(release.deploy_credentials)
                resp = await client.post(
                    f'{base}/flows',
                    json=body_obj,
                    headers={
                        'Node-RED-Deployment-Type': 'full',
                        'Node-RED-API-Version': 'v2',
                    },
                )
                if resp.status_code == 409:
                    raise ServiceException(message='边缘画布部署期间被他人修改（409 rev 冲突），请重试')
                if resp.status_code >= 400:
                    raise ServiceException(message=f'边缘拒绝部署（HTTP {resp.status_code}）：{resp.text[:200]}')
                try:
                    flows_after, rev_after = _parse_flows_response(await _get_json(client, f'{base}/flows'))
                except Exception:
                    flows_after, rev_after = None, ''
                modules = await _read_module_versions(client, base)

            log.result = '1'
            # 同一现场同一时刻只有一个版本在边缘：复位其他版本的"已部署"标记
            await db.execute(
                update(PlcFlowRelease)
                .where(
                    PlcFlowRelease.site_id == release.site_id,
                    PlcFlowRelease.id != release.id,
                    PlcFlowRelease.status == '1',
                )
                .values(status='0')
            )
            release.status = '1'
            release.deploy_time = datetime.now()
            release.deploy_by = deploy_by
            deploy_note = '全量替换' if full_replace else f'合并部署（移除旧生成节点 {removed} 个，保留用户程序）'
            release.deploy_msg = (f'{deploy_note}; 边缘节点包版本: {modules}' if modules else deploy_note)[:480]
            # 部署后自动归档边缘完整画布快照（含用户自定义标签页；失败不影响部署结果）
            # commit 会 expire 所有 ORM 属性：id/version 必须在快照提交前取出（异步上下文禁止隐式 IO）
            rel_id = release.id
            rel_version = release.version
            deploy_type = log.deploy_type
            if flows_after is not None:
                try:
                    await cls.snapshot_canvas(db, release.site_id, release_id=rel_id,
                                              source='deploy', create_by=deploy_by, flows=flows_after, rev=rev_after)
                except Exception:
                    pass
            return {'releaseId': rel_id, 'version': rel_version, 'modules': modules,
                    'mode': deploy_type, 'removed': removed}
        except ServiceException as e:
            log.error_msg = (e.message or '')[:950]
            raise
        except httpx.ConnectError:
            log.error_msg = f'边缘不可达（{base}），请确认 Node-RED 已启动且网络可达'
            raise ServiceException(message=log.error_msg)
        except httpx.HTTPError as e:
            log.error_msg = f'HTTP 异常：{e}'[:950]
            raise ServiceException(message=f'部署失败：{e}')
        finally:
            log.rev_before = rev_before
            log.rev_after = rev_after
            log.duration_ms = int((time.monotonic() - t0) * 1000)
            db.add(log)
            await db.commit()
