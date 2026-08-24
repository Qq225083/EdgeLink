"""PLC 修改履历 DO 模型"""
from datetime import datetime

from sqlalchemy import BigInteger, Column, DateTime, Integer, JSON, String

from config.database import Base


class PlcChangeLog(Base):
    """PLC 设备/点位修改履历表"""

    __tablename__ = 'plc_change_log'
    __table_args__ = {'extend_existing': True, 'comment': 'PLC设备/点位修改履历表'}

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='ID')
    change_type = Column(String(20), nullable=False, comment='操作类型：add/update/disable/delete/enable')
    target_type = Column(String(20), nullable=False, comment='对象类型：device/tag')
    target_id = Column(BigInteger, nullable=False, comment='对象ID')
    target_name = Column(String(100), nullable=True, comment='对象名称（冗余，便于查询）')
    change_by = Column(String(64), nullable=True, comment='操作人')
    change_time = Column(DateTime, default=datetime.now, comment='操作时间')
    before_value = Column(JSON, nullable=True, comment='变更前值')
    after_value = Column(JSON, nullable=True, comment='变更后值')
    remark = Column(String(500), nullable=True, comment='备注')
