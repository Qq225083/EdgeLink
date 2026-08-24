from typing import Any, Union

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from common.vo import PageModel
from module_plc.entity.do.device_do import PlcDevice
from module_plc.entity.do.tag_do import PlcTag
from module_plc.entity.vo.tag_vo import TagModel, TagPageQueryModel
from utils.page_util import PageUtil


class TagDao:
    """
    PLC采集点位模块数据库操作层
    """

    @classmethod
    async def get_tag_detail_by_id(cls, db: AsyncSession, tag_id: int) -> Union[PlcTag, None]:
        """
        根据点位ID获取未删除的点位详细信息

        :param db: orm对象
        :param tag_id: 点位ID
        :return: PLC点位信息对象
        """
        tag_info = (
            (
                await db.execute(
                    select(PlcTag).where(
                        PlcTag.id == tag_id,
                        PlcTag.del_flag == '0',
                    )
                )
            )
            .scalars()
            .first()
        )

        return tag_info

    @classmethod
    async def get_tag_list_by_device_id(
        cls, db: AsyncSession, device_id: int, query_object: TagPageQueryModel, is_page: bool = False
    ) -> Union[PageModel, list[dict[str, Any]]]:
        """
        根据设备ID查询该设备下未删除的点位列表

        :param db: orm对象
        :param device_id: 设备ID
        :param query_object: 查询参数对象
        :param is_page: 是否开启分页
        :return: 点位列表信息对象
        """
        query = (
            select(PlcTag)
            .where(
                PlcTag.device_id == device_id,
                PlcTag.del_flag == '0',
                PlcTag.tag_name.contains(query_object.tag_name) if query_object.tag_name else True,
                PlcTag.status == query_object.status if query_object.status else True,
            )
            .order_by(PlcTag.sort_order, PlcTag.id)
        )
        tag_list: Union[PageModel, list[dict[str, Any]]] = await PageUtil.paginate(
            db, query, query_object.page_num, query_object.page_size, is_page
        )

        return tag_list

    @classmethod
    async def add_tag_dao(cls, db: AsyncSession, tag: TagModel, flush: bool = True) -> PlcTag:
        """
        新增PLC点位数据库操作

        :param db: orm对象
        :param tag: PLC点位对象
        :param flush: 是否立即flush（批量导入时可设为False，循环外统一flush）
        :return: 新增后的PLC点位ORM对象
        """
        db_tag = PlcTag(**tag.model_dump(exclude={'device_name', 'id'}))  # 🔧 Day9/P1-17：主键不接受客户端传值
        db.add(db_tag)
        if flush:
            await db.flush()

        return db_tag

    @classmethod
    async def batch_add_tags(cls, db: AsyncSession, tag_list: list[TagModel]) -> int:
        """批量新增PLC点位（使用多值 INSERT，避免逐条 round-trip）

        :param db: orm对象
        :param tag_list: PLC点位对象列表
        :return: 新增数量
        """
        if not tag_list:
            return 0
        values = [
            tag.model_dump(exclude={'id', 'device_name'}, exclude_none=True)
            for tag in tag_list
        ]
        await db.execute(insert(PlcTag).values(values))
        await db.flush()
        return len(values)

    @classmethod
    async def edit_tag_dao(cls, db: AsyncSession, tag: dict) -> None:
        """
        编辑PLC点位数据库操作（ORM模式：先取ORM对象 → 改属性 → flush）

        :param db: orm对象
        :param tag: 需要更新的PLC点位字典（必须包含 id）
        :return:
        """
        tag_id = tag.get('id')
        if not tag_id:
            return
        tag_info = await cls.get_tag_detail_by_id(db, tag_id)
        if tag_info:
            for key, value in tag.items():
                if key != 'id' and hasattr(tag_info, key):
                    setattr(tag_info, key, value)
            await db.flush()

    @classmethod
    async def soft_delete_tag_dao(cls, db: AsyncSession, tag_id: int) -> None:
        """
        软删除PLC点位（设置del_flag='2'）

        :param db: orm对象
        :param tag_id: 点位ID
        :return:
        """
        await db.execute(
            update(PlcTag)
            .where(PlcTag.id == tag_id)
            .values(del_flag='2')
        )

    @classmethod
    async def soft_delete_tags_by_device_id(cls, db: AsyncSession, device_id: int) -> None:
        """
        根据设备ID软删除该设备下所有未删除的点位

        :param db: orm对象
        :param device_id: 设备ID
        :return:
        """
        await db.execute(
            update(PlcTag)
            .where(
                PlcTag.device_id == device_id,
                PlcTag.del_flag == '0',
            )
            .values(del_flag='2')
        )

    # 全局查询需要的列 — 加设备字段以支撑 Node-RED fn-config 自动发现设备
    # ⚠️ 字段语义约定（撞名警告）：
    #   结果行的 `status` = 设备状态（PlcDevice.status，末尾未加 label 的那列）——边缘 cm 依赖它过滤停用设备；
    #   结果行的 `tag_status` = 点位自身状态（PlcTag.status）——前端点位页开关必须绑 tagStatus。
    #   改动这两个键名必须同步检查：Node-RED 主流 cm 设备过滤逻辑 + 前端 tag/index.vue。
    _GLOBAL_TAG_COLUMNS = (
        PlcTag.id,
        PlcTag.device_id,
        PlcTag.tag_name,
        PlcTag.register_type,
        PlcTag.register_address,
        PlcTag.data_type,
        PlcTag.unit,
        PlcTag.description,
        PlcTag.status.label('tag_status'),
        PlcTag.sort_order,
        PlcTag.transform_type,
        PlcTag.transform_slope_a,
        PlcTag.transform_offset_b,
        PlcTag.raw_value_min,
        PlcTag.raw_value_max,
        PlcTag.eng_value_min,
        PlcTag.eng_value_max,
        PlcTag.eng_unit,
        PlcTag.report_deadband_ms,
        PlcTag.report_force_interval_ms,
        PlcTag.quality_enabled,
        # === P1+P3: 协议扩展字段 ===
        PlcTag.protocol_params,
        PlcTag.bit_offset,
        PlcTag.byte_order,
        PlcTag.word_order,
        PlcTag.calc_op,
        PlcTag.calc_source_ids,
        PlcTag.create_by,
        PlcTag.create_time,
        PlcTag.update_by,
        PlcTag.update_time,
        # === 设备级字段（fn-config 自动发现设备所需） ===
        PlcDevice.device_name,
        PlcDevice.host_pc_ip,
        PlcDevice.backup_pc_ip,
        PlcDevice.plc_ip,
        PlcDevice.plc_port,
        PlcDevice.com_type,
        PlcDevice.driver_code,
        PlcDevice.mc_frame,
        PlcDevice.plc_series,
        PlcDevice.station_no,
        PlcDevice.network_no,
        PlcDevice.scan_interval_ms,
        PlcDevice.comm_timeout_ms,
        PlcDevice.retry_count,
        PlcDevice.retry_interval_ms,
        PlcDevice.trigger_kind,
        PlcDevice.status,
        # === P1: 设备协议扩展 ===
        PlcDevice.protocol_params,
    )

    @classmethod
    async def get_tag_global_list(
        cls, db: AsyncSession, query_object: TagPageQueryModel, is_page: bool = False
    ) -> Union[PageModel, list[dict[str, Any]]]:
        """
        跨设备全局查询未删除的点位列表（JOIN 设备表，带设备名称）

        :param db: orm对象
        :param query_object: 查询参数对象
        :param is_page: 是否开启分页
        :return: 点位列表信息对象
        """
        query = (
            select(*cls._GLOBAL_TAG_COLUMNS)
            .join(PlcDevice, PlcTag.device_id == PlcDevice.id, isouter=True)
            .where(
                PlcTag.del_flag == '0',
                PlcDevice.del_flag == '0',
                PlcTag.device_id == query_object.device_id if query_object.device_id is not None else True,
                PlcTag.register_type == query_object.register_type if query_object.register_type else True,
                PlcTag.register_address == query_object.register_address if query_object.register_address else True,
                PlcTag.tag_name.contains(query_object.tag_name) if query_object.tag_name else True,
                PlcTag.status == query_object.status if query_object.status else True,
                PlcDevice.device_name.contains(query_object.device_name) if query_object.device_name else True,
            )
            .order_by(PlcDevice.device_name, PlcTag.sort_order, PlcTag.id)
        )
        return await PageUtil.paginate(db, query, query_object.page_num, query_object.page_size, is_page)

    @classmethod
    async def batch_update_tags(cls, db: AsyncSession, tag_ids: list[int], update_dict: dict) -> None:
        """
        批量更新点位字段

        :param db: orm对象
        :param tag_ids: 点位ID列表
        :param update_dict: 需要更新的字段字典（调用方负责确保只包含有效字段）
        """
        if update_dict:
            await db.execute(
                update(PlcTag)
                .where(PlcTag.id.in_(tag_ids))
                .values(**update_dict)
            )
