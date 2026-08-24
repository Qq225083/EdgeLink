from sqlalchemy import JSON, BigInteger, CHAR, Column, DateTime, Float, ForeignKey, Index, Integer, String, Text

from config.database import Base


class PlcTag(Base):
    """
    PLC采集点位从表
    """

    __tablename__ = 'plc_tag'
    __table_args__ = (
        Index('idx_plc_tag_device_id', 'device_id'),
        Index('idx_plc_tag_del_flag', 'del_flag'),
        Index('idx_plc_tag_status', 'status'),
        # 高频查询复合索引：设备下启用且未删除的点位
        Index('idx_plc_tag_device_status_del', 'device_id', 'status', 'del_flag'),
        {'extend_existing': True, 'comment': 'PLC采集点位表'},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False, comment='点位ID')
    device_id = Column(BigInteger, ForeignKey('plc_device.id'), nullable=False, comment='所属设备ID')
    tag_name = Column(String(100), nullable=False, comment='点位名称')
    register_type = Column(String(10), nullable=False, comment='寄存器类型（协议相关：MC=D/W/X/Y/M, Modbus=Coil/Discrete/Holding/Input, S7=DB/I/Q/M）')
    register_address = Column(String(50), nullable=False, comment='寄存器地址')
    data_type = Column(String(20), nullable=False, comment='数据类型（INT16/INT32/FLOAT/BIT/UINT16/UINT32/BOOL/DOUBLE）')
    unit = Column(String(20), nullable=True, comment='单位（寄存器原始单位）')
    description = Column(Text, nullable=True, comment='点位描述')
    status = Column(CHAR(1), default='0', nullable=False, comment='状态（0启用 1停用）')
    sort_order = Column(Integer, default=0, nullable=False, comment='排序号')
    # ======== 换算参数 ========
    transform_type = Column(String(20), default='none', nullable=False, comment='换算类型：none/linear/slope_offset')
    transform_slope_a = Column(Float, default=1.0, nullable=False, comment='斜率/乘数 a')
    transform_offset_b = Column(Float, default=0.0, nullable=False, comment='偏移量 b')
    raw_value_min = Column(Float, nullable=True, comment='原始值有效范围下限')
    raw_value_max = Column(Float, nullable=True, comment='原始值有效范围上限')
    eng_value_min = Column(Float, nullable=True, comment='工程值下限')
    eng_value_max = Column(Float, nullable=True, comment='工程值上限')
    eng_unit = Column(String(20), nullable=True, comment='工程单位（换算后的显示单位，如℃、MPa）')
    # ======== 上报策略 ========
    report_deadband_ms = Column(Float, default=0, nullable=False, comment='变化上报死区（数值，工程单位），0=每次上报')
    report_force_interval_ms = Column(Integer, default=5000, nullable=False, comment='强制上报间隔（ms），值未变也写一条防断连误判')
    quality_enabled = Column(CHAR(1), default='1', nullable=False, comment='是否启用数据质量码（0关闭 1启用）')
    # ======== 协议专用扩展（P1+P3：协议可插拔） ========
    protocol_params = Column(JSON, nullable=True, comment='协议专用点位参数（bit_offset/byte_order/word_order/function_code 等）')
    bit_offset = Column(Integer, nullable=True, comment='位偏移（BIT 类型时有效，0-15）')
    byte_order = Column(String(10), nullable=True, comment='字节序（LITTLE_ENDIAN/BIG_ENDIAN，INT32/FLOAT 时有效）')
    word_order = Column(String(10), nullable=True, comment='字序（LOW_FIRST/HIGH_FIRST，跨多寄存器时有效）')
    # ======== 计算点位（派生点位：值=同设备其他点位 和/平均/最大/最小） ========
    calc_op = Column(String(16), nullable=True, comment='计算算子：sum/avg/min/max；NULL=采集点位')
    calc_source_ids = Column(String(500), nullable=True, comment='计算来源点位ID列表（JSON数组，仅限同设备采集点位）')
    # ======== 审计字段 ========
    create_by = Column(String(64), nullable=True, comment='创建者')
    create_time = Column(DateTime, nullable=True, comment='创建时间')
    update_by = Column(String(64), nullable=True, comment='更新者')
    update_time = Column(DateTime, nullable=True, comment='更新时间')
    del_flag = Column(CHAR(1), default='0', nullable=False, comment='删除标志（0正常 2删除）')
