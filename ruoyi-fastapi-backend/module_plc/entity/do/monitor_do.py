"""采集节点监控中心 — ORM 模型"""
from sqlalchemy import BigInteger, Column, DateTime, Integer, SmallInteger, String, Text, UniqueConstraint
from config.database import Base


class NoderedNode(Base):
    """采集节点注册表"""
    __tablename__ = 'nodered_node'
    __table_args__ = (
        UniqueConstraint('host_pc_ip', name='uq_nodered_node_host_pc_ip'),
        {'extend_existing': True, 'comment': '采集节点注册表'},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='节点ID')
    node_name = Column(String(50), nullable=False, comment='节点名称')
    office_net_ip = Column(String(20), comment='办公网IP（NIC1）')
    indust_net_ip = Column(String(20), comment='工业网IP（NIC2）')
    host_pc_ip = Column(String(50), comment='=office_net_ip[:port]，与plc_device.host_pc_ip对应')
    status = Column(SmallInteger, default=1, comment='0停用 1启用')
    heartbeat_interval = Column(Integer, default=30, comment='心跳间隔秒')
    last_heartbeat = Column(DateTime, comment='最后心跳时间')
    # ===== #88 节点健康指标（最近一次心跳上报）=====
    running_flows = Column(Integer, nullable=True, comment='运行流数量')
    memory_usage_mb = Column(Integer, nullable=True, comment='内存占用MB')
    pg_success_count = Column(BigInteger, nullable=True, comment='PG累计写入成功条数（边缘累计值）')
    pg_fail_count = Column(BigInteger, nullable=True, comment='PG累计写入失败条数（边缘累计值）')
    spool_bytes = Column(BigInteger, nullable=True, comment='磁盘spool积压字节数（0=无积压）')
    config_version = Column(Integer, nullable=True, comment='边缘已应用的配置快照版本（心跳上报；NULL=旧边缘未上报）')
    remark = Column(String(200), comment='备注')
    created_at = Column(DateTime, comment='创建时间')
    updated_at = Column(DateTime, comment='更新时间')


class HeartbeatLog(Base):
    """心跳日志表"""
    __tablename__ = 'nodered_heartbeat_log'
    __table_args__ = {'extend_existing': True, 'comment': '心跳日志'}

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='日志ID')
    node_id = Column(BigInteger, nullable=False, comment='节点ID')
    report_time = Column(DateTime, nullable=False, comment='上报时间')
    node_ip = Column(String(20), comment='上报IP')
    running_flows = Column(Integer, default=0, comment='运行流数量')
    memory_usage_mb = Column(Integer, default=0, comment='内存占用MB')


class DeviceCommStatus(Base):
    """PLC通信实时状态"""
    __tablename__ = 'device_comm_status'
    __table_args__ = (
        UniqueConstraint('node_id', 'device_id', name='uq_device_comm_node_device'),
        {'extend_existing': True, 'comment': 'PLC通信实时状态'},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    node_id = Column(BigInteger, nullable=False, comment='节点ID')
    device_id = Column(BigInteger, nullable=False, comment='PLC设备ID')
    online = Column(SmallInteger, default=0, comment='0离线 1在线')
    last_success_time = Column(DateTime, comment='最后成功采集时间')
    last_error_time = Column(DateTime, comment='最后错误时间')
    error_msg = Column(String(500), comment='错误信息')
    consecutive_fails = Column(Integer, default=0, comment='连续失败次数')
    updated_at = Column(DateTime, comment='更新时间')


class PgWriteStatus(Base):
    """PG写入实时状态"""
    __tablename__ = 'pg_write_status'
    __table_args__ = (
        UniqueConstraint('node_id', name='uq_pg_write_status_node_id'),
        {'extend_existing': True, 'comment': 'PG写入实时状态'},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    node_id = Column(BigInteger, nullable=False, comment='节点ID')
    last_write_time = Column(DateTime, comment='最后成功写入PG时间')
    write_latency_ms = Column(Integer, default=0, comment='写入延迟ms')
    today_write_count = Column(Integer, default=0, comment='今日写入条数')
    error_msg = Column(String(500), comment='错误信息')
    consecutive_fails = Column(Integer, default=0, comment='连续失败次数')
    updated_at = Column(DateTime, comment='更新时间')


class MonitorAlert(Base):
    """监控告警表"""
    __tablename__ = 'monitor_alert'
    __table_args__ = (
        UniqueConstraint('alert_type', 'node_id', 'device_id', name='uq_monitor_alert_dedup'),
        {'extend_existing': True, 'comment': '监控告警'},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    alert_type = Column(String(30), nullable=False, comment='NODE_OFFLINE/PLC_OFFLINE/PG_WRITE_LAG')
    severity = Column(SmallInteger, default=2, comment='1严重 2一般 3提示')
    node_id = Column(BigInteger, comment='关联节点')
    device_id = Column(BigInteger, default=0, nullable=False, comment='关联PLC设备（0=不关联设备）')
    alert_msg = Column(String(500), comment='告警内容')
    status = Column(SmallInteger, default=0, comment='0未处理 1已确认 2已恢复')
    created_at = Column(DateTime, comment='产生时间')
    confirmed_at = Column(DateTime, comment='确认时间')
    resolved_at = Column(DateTime, comment='恢复时间')
    last_notified_at = Column(DateTime, comment='最近一次通知时间（通知门控/防风暴）')
    notification_pending = Column(SmallInteger, default=0, nullable=False, comment='通知待补偿（1=上次发送失败待重试）')
