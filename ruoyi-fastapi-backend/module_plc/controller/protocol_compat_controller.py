"""
PLC协议兼容配置接口 — 返回 品牌→系列→通信方式→寄存器类型 级联数据
"""
from typing import Annotated

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from common.aspect.db_seesion import DBSessionDependency
from common.aspect.pre_auth import PreAuthDependency
from common.router import APIRouterPro
from module_plc.entity.do.protocol_compat_do import PlcProtocolCompat
from utils.response_util import ResponseUtil

protocol_compat_controller = APIRouterPro(
    prefix='/plc/protocol-compat', order_num=410, tags=['协议兼容'],
    dependencies=[PreAuthDependency()],
)


@protocol_compat_controller.get('/all')
async def get_protocol_compat(db: Annotated[AsyncSession, DBSessionDependency()]):
    """
    返回嵌套结构的协议兼容配置，前端直接用于下拉框级联。

    返回格式:
    {
      "Mitsubishi": {
        "series": [
          {
            "value": "Q",
            "label": "Q系列",
            "comTypes": [
              {
                "value": "MC_Protocol",
                "label": "MC Protocol",
                "isDefault": true,
                "registerTypes": [
                  {"value": "D", "label": "D（数据寄存器）"},
                  ...
                ]
              }
            ]
          }
        ]
      }
    }
    """
    result = await db.execute(
        select(PlcProtocolCompat).order_by(
            PlcProtocolCompat.plc_brand,
            PlcProtocolCompat.plc_series,
            PlcProtocolCompat.sort_order,
        )
    )
    rows = result.scalars().all()

    # 组装嵌套结构
    COM_TYPE_LABELS = {
        'MC_Protocol': 'MC Protocol',
        'Modbus_TCP': 'Modbus TCP',
        'S7': 'S7 协议',
        'GOT': 'GOT（触摸屏透传）',
        'PLC_RS232C': 'RS-232C（串口）',
    }

    data: dict[str, dict] = {}
    for r in rows:
        brand = data.setdefault(r.plc_brand, {'series': []})
        # 找或建 series
        series_list = brand['series']
        series = next((s for s in series_list if s['value'] == r.plc_series), None)
        if not series:
            series = {'value': r.plc_series, 'label': r.plc_series, 'comTypes': []}
            series_list.append(series)
        # 找或建 comType
        ct = next((c for c in series['comTypes'] if c['value'] == r.com_type), None)
        if not ct:
            ct = {
                'value': r.com_type,
                'label': COM_TYPE_LABELS.get(r.com_type, r.com_type),
                'driverCode': r.driver_code,
                'isDefault': r.is_default_com_type,
                'registerTypes': [],
            }
            series['comTypes'].append(ct)
        # 防重复：唯一键 uq_protocol_compat 已保证数据不重复，此处再做一层展示侧防护
        if any(rt['value'] == r.register_type for rt in ct['registerTypes']):
            continue
        ct['registerTypes'].append({
            'value': r.register_type,
            'label': r.register_type_label or r.register_type,
        })

    return ResponseUtil.success(data=data)
