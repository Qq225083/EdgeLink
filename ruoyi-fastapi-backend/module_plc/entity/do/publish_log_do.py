"""PLC 配置发布日志 DO 模型"""
from datetime import datetime

from sqlalchemy import BigInteger, Column, DateTime, Integer, JSON, String

from config.database import Base


class PlcPublishLog(Base):
    """PLC 配置发布日志表"""

    __tablename__ = 'plc_publish_log'
    __table_args__ = {'extend_existing': True, 'comment': 'PLC配置发布日志表'}

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='日志ID')
    publish_by = Column(String(64), nullable=True, comment='发布人')
    publish_time = Column(DateTime, default=datetime.now, comment='发布时间')
    device_count = Column(Integer, default=0, comment='涉及设备数')
    node_count = Column(Integer, default=0, comment='涉及采集节点数')
    ip_count = Column(Integer, default=0, comment='涉及IP数')
    device_ids = Column(JSON, nullable=True, comment='发布的设备ID列表')
    remark = Column(String(500), nullable=True, comment='备注')
    status = Column(String(20), nullable=False, default='success', comment='发布结果：success/partial/failed')
    fail_detail = Column(JSON, nullable=True, comment='失败明细（未送达的设备/节点）')
    config_snapshot = Column(JSON, nullable=True, comment='发布时配置快照（用于审计与回滚依据）')
