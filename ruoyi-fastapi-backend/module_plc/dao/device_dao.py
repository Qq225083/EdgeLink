from typing import Any, Union

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from common.vo import PageModel
from module_plc.entity.do.device_do import PlcDevice
from module_plc.entity.vo.device_vo import PlcDeviceModel, PlcDevicePageQueryModel
from utils.page_util import PageUtil


class DeviceDao:
    """
    PLC设备模块数据库操作层
    """

    @classmethod
    async def get_device_detail_by_id(cls, db: AsyncSession, device_id: int) -> Union[PlcDevice, None]:
        """
        根据设备ID获取未删除的设备详细信息

        :param db: orm对象
        :param device_id: 设备ID
        :return: PLC设备信息对象
        """
        device_info = (
            (
                await db.execute(
                    select(PlcDevice)
                    .where(
                        PlcDevice.id == device_id,
                        PlcDevice.del_flag == '0',
                    )
                )
            )
            .scalars()
            .first()
        )

        return device_info

    @classmethod
    async def get_device_by_name(cls, db: AsyncSession, device_name: str) -> Union[PlcDevice, None]:
        """
        根据设备名称获取未删除的设备信息（用于唯一性校验）

        :param db: orm对象
        :param device_name: 设备名称
        :return: PLC设备信息对象
        """
        device_info = (
            (
                await db.execute(
                    select(PlcDevice).where(
                        PlcDevice.device_name == device_name,
                        PlcDevice.del_flag == '0',
                    )
                )
            )
            .scalars()
            .first()
        )

        return device_info

    @classmethod
    async def get_device_by_code(cls, db: AsyncSession, device_code: str) -> Union[PlcDevice, None]:
        """
        根据设备编号获取未删除的设备信息（用于唯一性校验）

        :param db: orm对象
        :param device_code: 设备编号
        :return: PLC设备信息对象
        """
        if not device_code:
            return None
        device_info = (
            (
                await db.execute(
                    select(PlcDevice).where(
                        PlcDevice.device_code == device_code,
                        PlcDevice.del_flag == '0',
                    )
                )
            )
            .scalars()
            .first()
        )
        return device_info

    @classmethod
    async def get_device_list(
        cls, db: AsyncSession, query_object: PlcDevicePageQueryModel, is_page: bool = False
    ) -> Union[PageModel, list[dict[str, Any]]]:
        """
        根据查询参数获取未删除的PLC设备列表信息

        :param db: orm对象
        :param query_object: 查询参数对象
        :param is_page: 是否开启分页
        :return: PLC设备列表信息对象
        """
        query = (
            select(PlcDevice)
            .where(
                PlcDevice.del_flag == '0',
                PlcDevice.device_name.contains(query_object.device_name) if query_object.device_name else True,
                PlcDevice.device_code == query_object.device_code if query_object.device_code else True,
                PlcDevice.plc_ip == query_object.plc_ip if query_object.plc_ip else True,
                PlcDevice.status == query_object.status if query_object.status else True,
                PlcDevice.plc_brand == query_object.plc_brand if query_object.plc_brand else True,
            )
            .order_by(PlcDevice.id)
        )
        device_list: Union[PageModel, list[dict[str, Any]]] = await PageUtil.paginate(
            db, query, query_object.page_num, query_object.page_size, is_page
        )

        return device_list

    @classmethod
    async def add_device_dao(cls, db: AsyncSession, device: PlcDeviceModel) -> PlcDevice:
        """
        新增PLC设备数据库操作

        :param db: orm对象
        :param device: PLC设备对象
        :return: 新增后的PLC设备ORM对象
        """
        db_device = PlcDevice(**device.model_dump(exclude={'tags', 'tag_count', 'id'}))  # 🔧 Day9/P1-17：主键不接受客户端传值
        db.add(db_device)
        await db.flush()

        return db_device

    @classmethod
    async def edit_device_dao(cls, db: AsyncSession, device: dict) -> None:
        """
        编辑PLC设备数据库操作（ORM模式：先取ORM对象 → 改属性 → flush）

        :param db: orm对象
        :param device: 需要更新的PLC设备字典（必须包含 id）
        :return:
        """
        device_id = device.get('id')
        if not device_id:
            return
        device_info = await cls.get_device_detail_by_id(db, device_id)
        if device_info:
            for key, value in device.items():
                if key != 'id' and hasattr(device_info, key):
                    setattr(device_info, key, value)
            await db.flush()
