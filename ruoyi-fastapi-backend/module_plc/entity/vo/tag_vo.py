from datetime import datetime
from typing import Optional, Any

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class TagModel(BaseModel):
    """
    PLC采集点位表对应Pydantic模型
    """
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None, description='点位ID')
    device_id: Optional[int] = Field(default=None, description='所属设备ID')
    tag_name: Optional[str] = Field(default=None, description='点位名称')
    register_type: Optional[str] = Field(default=None, description='寄存器类型（D/W/X/Y/M）')
    register_address: Optional[str] = Field(default=None, description='寄存器地址')
    data_type: Optional[str] = Field(default=None, description='数据类型（INT16/INT32/FLOAT/BIT/UINT16/UINT32/BOOL/DOUBLE）')
    unit: Optional[str] = Field(default=None, description='单位（寄存器原始单位）')
    description: Optional[str] = Field(default=None, description='点位描述')
    status: Optional[str] = Field(default='0', description='状态（0启用 1停用）')
    sort_order: Optional[int] = Field(default=0, description='排序号')
    # ======== 换算参数 ========
    transform_type: Optional[str] = Field(default='none', description='换算类型：none/linear/slope_offset')
    transform_slope_a: Optional[float] = Field(default=1.0, description='斜率/乘数 a')
    transform_offset_b: Optional[float] = Field(default=0.0, description='偏移量 b')
    raw_value_min: Optional[float] = Field(default=None, description='原始值有效范围下限')
    raw_value_max: Optional[float] = Field(default=None, description='原始值有效范围上限')
    eng_value_min: Optional[float] = Field(default=None, description='工程值下限')
    eng_value_max: Optional[float] = Field(default=None, description='工程值上限')
    eng_unit: Optional[str] = Field(default=None, description='工程单位（换算后的显示单位，如℃、MPa）')
    # ======== 上报策略 ========
    report_deadband_ms: Optional[float] = Field(default=0, description='变化上报死区（数值，工程单位，变化量小于此值不上报），0=每次上报')
    report_force_interval_ms: Optional[int] = Field(default=5000, description='强制上报间隔（ms），值未变也写一条防断连误判')
    quality_enabled: Optional[str] = Field(default='1', description='是否启用数据质量码（0关闭 1启用）')
    # ======== P1+P3: 协议扩展字段 ========
    protocol_params: Optional[Any] = Field(default=None, description='协议专用点位参数（JSON，如bit_offset/byte_order/word_order/function_code）')
    bit_offset: Optional[int] = Field(default=None, description='位偏移（BIT类型时有效，0-15）')
    byte_order: Optional[str] = Field(default=None, description='字节序（LITTLE_ENDIAN/BIG_ENDIAN）')
    word_order: Optional[str] = Field(default=None, description='字序（LOW_FIRST/HIGH_FIRST）')
    # ======== 计算点位（派生点位） ========
    calc_op: Optional[str] = Field(default=None, description='计算算子：sum/avg/min/max；NULL=采集点位')
    calc_source_ids: Optional[Any] = Field(default=None, description='计算来源点位ID列表（JSON数组，仅限同设备采集点位）')
    # ======== 审计字段 ========
    create_by: Optional[str] = Field(default=None, description='创建者')
    create_time: Optional[datetime] = Field(default=None, description='创建时间')
    update_by: Optional[str] = Field(default=None, description='更新者')
    update_time: Optional[datetime] = Field(default=None, description='更新时间')
    del_flag: Optional[str] = Field(default='0', description='删除标志（0正常 2删除）')
    # 关联的设备名称（跨设备查询时填充）
    device_name: Optional[str] = Field(default=None, description='所属设备名称')


class TagQueryModel(TagModel):
    """
    PLC采集点位不分页查询模型
    """
    # 🔧 Day9/P1-14：查询场景默认不按状态过滤（基类 default='0' 会让克隆/详情静默丢停用点位）
    status: Optional[str] = Field(default=None, description='状态（0启用 1停用，查询默认全部）')


class TagPageQueryModel(TagQueryModel):
    """
    PLC采集点位分页查询模型
    """
    page_num: int = Field(default=1, ge=1, description='当前页码')
    page_size: int = Field(default=10, ge=1, le=5000, description='每页记录数（最大5000，防止边缘侧一次性拉取全量点位导致后端内存/CPU飙升）')


class DeleteTagModel(BaseModel):
    """
    删除/停用PLC采集点位模型
    """
    ids: str = Field(description='需要操作的数据ID，多个用逗号分隔')


class TagImportError(BaseModel):
    """单条导入错误"""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    row: int = Field(description='行号')
    reason: str = Field(description='失败原因')


class TagImportResult(BaseModel):
    """导入结果"""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    success_count: int = Field(default=0, description='成功条数')
    fail_count: int = Field(default=0, description='失败条数')
    errors: list[TagImportError] = Field(default_factory=list, description='失败明细')


class TagBatchUpdateModel(BaseModel):
    """批量更新点位模型"""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    ids: str = Field(description='点位ID列表，逗号分隔')
    register_type: Optional[str] = Field(default=None, description='寄存器类型')
    data_type: Optional[str] = Field(default=None, description='数据类型')
    status: Optional[str] = Field(default=None, description='状态（0启用 1停用）')
    unit: Optional[str] = Field(default=None, description='单位')
    # 批量设置换算参数
    transform_type: Optional[str] = Field(default=None, description='换算类型')
    transform_slope_a: Optional[float] = Field(default=None, description='斜率/乘数')
    transform_offset_b: Optional[float] = Field(default=None, description='偏移量')
    eng_unit: Optional[str] = Field(default=None, description='工程单位')
    report_deadband_ms: Optional[float] = Field(default=None, description='死区（数值，工程单位）')
    report_force_interval_ms: Optional[int] = Field(default=None, description='强制间隔ms')
    # ======== 批量设置协议参数 ========
    protocol_params: Optional[Any] = Field(default=None, description='协议专用点位参数（JSON）')
    bit_offset: Optional[int] = Field(default=None, description='位偏移（BIT/BOOL类型时有效，0-15）')
    byte_order: Optional[str] = Field(default=None, description='字节序（LITTLE_ENDIAN/BIG_ENDIAN，多字节类型时有效）')
    word_order: Optional[str] = Field(default=None, description='字序（LOW_FIRST/HIGH_FIRST，跨多寄存器时有效）')
