from sqlalchemy import JSON, BigInteger, CHAR, Column, DateTime, Index, Integer, String, UniqueConstraint

from config.database import Base


class PlcDevice(Base):
    """
    PLC设备主表
    """

    __tablename__ = 'plc_device'
    __table_args__ = (
        # 注意：不在数据库层设唯一约束，因为软删除场景下
        # (name, del_flag='2') 会与另一条同名删除记录冲突。
        # 唯一性校验已在 Service 层通过查询 del_flag='0' 实现。
        Index('idx_plc_device_del_flag', 'del_flag'),
        Index('idx_plc_device_status', 'status'),
        Index('idx_plc_device_host_pc_ip', 'host_pc_ip'),
        # 高频查询复合索引：启用且未删除的设备按节点查询
        Index('idx_plc_device_del_status_host', 'del_flag', 'status', 'host_pc_ip'),
        {'extend_existing': True, 'comment': 'PLC设备表'},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False, comment='设备ID')
    device_name = Column(String(100), nullable=False, comment='设备名称')
    device_code = Column(String(50), nullable=True, comment='设备编号（如PLC-Q-01）')
    plc_brand = Column(String(50), default='Mitsubishi', nullable=False, comment='PLC品牌')
    plc_series = Column(String(50), nullable=True, comment='PLC系列（Q/L/FX/iQ-R）')
    com_type = Column(String(50), nullable=True, comment='通信方式（MC_Protocol/Modbus_TCP）')
    plc_ip = Column(String(50), nullable=True, default=None, comment='PLC IP地址（RS-232C串口通信时可为空）')
    host_pc_ip = Column(String(50), nullable=True, comment='主采集节点标识（IP 或 IP:端口，多实例部署时用端口区分）')
    backup_pc_ip = Column(String(50), nullable=True, comment='备采集PC的办公网IP（主PC宕机时自动切换，可选）')
    mes_ip = Column(String(50), nullable=True, comment='MES/MDPS对接IP')
    mes_port = Column(Integer, default=0, nullable=False, comment='MES/MDPS对接端口')
    plc_port = Column(Integer, default=5007, nullable=False, comment='PLC端口号')
    mc_frame = Column(String(10), nullable=True, comment='MC协议帧格式（3E/4E）')
    station_no = Column(Integer, default=0, nullable=False, comment='站号')
    network_no = Column(Integer, default=0, nullable=False, comment='网络号')
    scan_interval_ms = Column(Integer, default=1000, nullable=False, comment='采集周期（毫秒）')
    comm_timeout_ms = Column(Integer, default=3000, nullable=False, comment='通信超时（毫秒）')
    retry_count = Column(Integer, default=2, nullable=False, comment='失败重试次数')
    retry_interval_ms = Column(Integer, default=500, nullable=False, comment='重试间隔（毫秒）')
    trigger_kind = Column(Integer, default=0, nullable=False, comment='触发方式（0=握手 1=固定周期 2=变化触发）')
    protocol_params = Column(JSON, nullable=True, comment='协议专用参数（Modbus: unit_id/function_code; OPC UA: node_id/namespace_index; S7: rack/slot; MC: mc_frame/station_no/network_no 的JSON形式）')
    driver_code = Column(String(50), nullable=False, default='UNKNOWN', comment='驱动编码（如 mitsubishi_mc / modbus_tcp，由品牌/系列/通信方式映射得到）')
    status = Column(CHAR(1), default='0', nullable=False, comment='状态（0启用 1停用）')
    create_by = Column(String(64), nullable=True, comment='创建者')
    create_time = Column(DateTime, nullable=True, comment='创建时间')
    update_by = Column(String(64), nullable=True, comment='更新者')
    update_time = Column(DateTime, nullable=True, comment='更新时间')
    remark = Column(String(500), nullable=True, comment='备注')
    del_flag = Column(CHAR(1), default='0', nullable=False, comment='删除标志（0正常 2删除）')
