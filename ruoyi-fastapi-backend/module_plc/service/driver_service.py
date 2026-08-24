"""PLC 驱动元数据服务层

为前端动态表单与 Node-RED 动态分发提供驱动能力描述。
"""

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from exceptions.exception import ServiceException
from module_plc.entity.do.device_do import PlcDevice
from module_plc.entity.do.driver_do import PlcDriver
from module_plc.entity.do.protocol_compat_do import PlcProtocolCompat
from module_plc.entity.vo.device_vo import PlcDeviceModel


class DriverService:
    """PLC 驱动元数据服务层"""

    @classmethod
    async def list_drivers(cls, query_db: AsyncSession, include_disabled: bool = False) -> list[dict[str, Any]]:
        """获取所有驱动元数据列表（默认只返回启用）。"""
        stmt = select(PlcDriver)
        if not include_disabled:
            stmt = stmt.where(PlcDriver.enabled == True)
        stmt = stmt.order_by(PlcDriver.sort_order, PlcDriver.driver_code)
        result = await query_db.execute(stmt)
        rows = result.scalars().all()
        return [
            {
                'driverCode': d.driver_code,
                'driverName': d.driver_name,
                'nodeRedNodeType': d.node_red_node_type,
                'schemaVersion': d.schema_version,
                'bitOffsetSupported': d.bit_offset_supported,
                'byteOrderSupported': d.byte_order_supported,
                'wordOrderSupported': d.word_order_supported,
                'enabled': d.enabled,
                'sortOrder': d.sort_order,
            }
            for d in rows
        ]

    @classmethod
    async def get_driver_schema(cls, query_db: AsyncSession, driver_code: str) -> dict[str, Any]:
        """获取指定驱动的完整 schema（含配置项、寄存器类型、数据类型、地址校验）。"""
        result = await query_db.execute(
            select(PlcDriver).where(
                PlcDriver.driver_code == driver_code,
                PlcDriver.enabled == True,
            )
        )
        driver = result.scalar_one_or_none()
        if not driver:
            raise ServiceException(message=f'驱动不存在或已禁用：{driver_code}')

        return {
            'driverCode': driver.driver_code,
            'driverName': driver.driver_name,
            'nodeRedNodeType': driver.node_red_node_type,
            'schemaVersion': driver.schema_version,
            'configSchema': driver.config_schema,
            'registerTypes': driver.register_types,
            'dataTypes': driver.data_types,
            'addressPattern': driver.address_pattern,
            'bitOffsetSupported': driver.bit_offset_supported,
            'byteOrderSupported': driver.byte_order_supported,
            'wordOrderSupported': driver.word_order_supported,
        }

    @classmethod
    async def resolve_driver_code(
        cls, query_db: AsyncSession, plc_brand: str, plc_series: str, com_type: str
    ) -> str:
        """根据品牌/系列/通信方式解析驱动编码。

        当存在多条记录时，取 sort_order 最小的一条作为首选（允许设备层覆盖）。
        未找到映射时返回 'UNKNOWN'，由调用方决定是否拒绝保存。
        """
        if not plc_brand or not plc_series or not com_type:
            return 'UNKNOWN'

        result = await query_db.execute(
            select(PlcProtocolCompat.driver_code)
            .where(
                PlcProtocolCompat.plc_brand == plc_brand,
                PlcProtocolCompat.plc_series == plc_series,
                PlcProtocolCompat.com_type == com_type,
            )
            .order_by(PlcProtocolCompat.sort_order)
            .limit(1)
        )
        row = result.scalar_one_or_none()
        return row or 'UNKNOWN'

    @classmethod
    async def validate_driver_code(cls, query_db: AsyncSession, driver_code: str) -> None:
        """校验 driver_code 是否有效且已启用。'UNKNOWN' 视为无效。"""
        if not driver_code or driver_code == 'UNKNOWN':
            raise ServiceException(message='设备驱动编码无效或未映射到可用驱动')

        result = await query_db.execute(
            select(PlcDriver).where(
                PlcDriver.driver_code == driver_code,
                PlcDriver.enabled == True,
            )
        )
        if not result.scalar_one_or_none():
            raise ServiceException(message=f'驱动不存在或已禁用：{driver_code}')

    @classmethod
    async def fill_driver_code_for_device(cls, query_db: AsyncSession, device: PlcDevice) -> None:
        """为设备对象填充 driver_code（若尚未设置）。"""
        if device.driver_code and device.driver_code != 'UNKNOWN':
            return
        device.driver_code = await cls.resolve_driver_code(
            query_db, device.plc_brand, device.plc_series, device.com_type
        )

    @classmethod
    async def fill_driver_code_for_device_vo(
        cls, query_db: AsyncSession, page_object: PlcDeviceModel
    ) -> None:
        """为 VO/新增设备对象填充 driver_code（若前端未传）。"""
        if page_object.driver_code and page_object.driver_code != 'UNKNOWN':
            return
        page_object.driver_code = await cls.resolve_driver_code(
            query_db, page_object.plc_brand, page_object.plc_series, page_object.com_type
        )

    @classmethod
    def build_driver_config(cls, device: PlcDevice | Any) -> dict[str, Any]:
        """根据设备字段构建驱动专用配置对象 driverConfig。

        配置来源约定（避免双源歧义）：
        1. 公共采集参数（plc_port、scan_interval_ms、comm_timeout_ms、retry_count、
           retry_interval_ms、trigger_kind）使用设备表平铺字段。
        2. 已落地的内置驱动：
           - mitsubishi_mc / mitsubishi_mc_serial：mc_frame、station_no、network_no 使用
             设备表平铺字段；平铺字段为空时才从 protocol_params 回退（兼容旧数据）。
           - modbus_tcp：unit_id、function_code 仅来自 protocol_params（无平铺字段）。
        3. 新扩展驱动：全部参数来自 protocol_params，build_driver_config 按 driver_code
           分支读取即可。
        4. 同一参数若同时存在于平铺字段和 protocol_params，以平铺字段为准。

        注：未来动态表单成熟后，可逐步把三菱特有参数也迁移到 protocol_params，届时
        删除平铺字段回退逻辑即可。
        """
        # 兼容 ORM 对象与字典（发布中心列表使用字典）
        def _get(name: str, default: Any = None) -> Any:
            if isinstance(device, dict):
                return device.get(name, default)
            return getattr(device, name, default)

        # protocol_params 兜底（仅用于 Modbus/S7 等无平铺字段的协议，以及旧数据回退）
        protocol_params = _get('protocol_params') or {}
        if not isinstance(protocol_params, dict):
            protocol_params = {}

        driver_code = _get('driver_code', 'UNKNOWN') or 'UNKNOWN'
        driver_config: dict[str, Any] = {}

        # 公共字段
        plc_port = _get('plc_port')
        if plc_port is not None:
            driver_config['plcPort'] = plc_port
        scan_interval_ms = _get('scan_interval_ms')
        if scan_interval_ms is not None:
            driver_config['scanIntervalMs'] = scan_interval_ms
        comm_timeout_ms = _get('comm_timeout_ms')
        if comm_timeout_ms is not None:
            driver_config['commTimeoutMs'] = comm_timeout_ms
        retry_count = _get('retry_count')
        if retry_count is not None:
            driver_config['retryCount'] = retry_count
        retry_interval_ms = _get('retry_interval_ms')
        if retry_interval_ms is not None:
            driver_config['retryIntervalMs'] = retry_interval_ms
        trigger_kind = _get('trigger_kind')
        if trigger_kind is not None:
            driver_config['triggerKind'] = trigger_kind

        if driver_code in {'mitsubishi_mc', 'mitsubishi_mc_serial'}:
            # 平铺字段为主，protocol_params 仅作旧数据回退
            driver_config['mcFrame'] = _get('mc_frame') or protocol_params.get('mcFrame') or '3E'
            station_no = _get('station_no')
            driver_config['stationNo'] = station_no if station_no is not None else protocol_params.get('stationNo', 0)
            network_no = _get('network_no')
            driver_config['networkNo'] = network_no if network_no is not None else protocol_params.get('networkNo', 0)
            # MC 以太网传输协议与数据代码（无平铺字段，仅 protocol_params；边缘读取节点按协议白名单校验）
            if driver_code == 'mitsubishi_mc':
                driver_config['protocol'] = protocol_params.get('protocol') or 'tcp'
                driver_config['commCode'] = protocol_params.get('commCode') or 'binary'
            if driver_code == 'mitsubishi_mc_serial':
                driver_config['serialPort'] = protocol_params.get('serialPort', 'COM1')

        elif driver_code == 'modbus_tcp':
            # Modbus 参数全部来自 protocol_params
            driver_config['unitId'] = protocol_params.get('unitId') or protocol_params.get('unit_id') or 1
            driver_config['functionCode'] = protocol_params.get('functionCode') or protocol_params.get('function_code')

        elif driver_code == 'siemens_s7':
            # S7 参数全部来自 protocol_params
            driver_config['rack'] = protocol_params.get('rack', 0)
            driver_config['slot'] = protocol_params.get('slot', 1)

        return driver_config
