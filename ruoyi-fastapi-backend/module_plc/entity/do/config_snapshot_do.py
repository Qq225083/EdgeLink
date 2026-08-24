"""已发布配置快照 DO 模型"""
from datetime import datetime

from sqlalchemy import BigInteger, Column, DateTime, Integer, JSON, String

from config.database import Base


class PlcConfigSnapshot(Base):
    """已发布配置快照表（发布即版本模型：边缘节点的唯一配置拉取源）"""

    __tablename__ = 'plc_config_snapshot'
    __table_args__ = {'extend_existing': True, 'comment': '已发布配置快照（发布即版本模型）'}

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='主键')
    version = Column(Integer, nullable=False, default=1, comment='版本号（每次发布+1）')
    payload = Column(JSON, nullable=False, comment='快照内容（JSON数组，元素结构与全局点位查询响应行一致）')
    published_by = Column(String(64), nullable=True, default='', comment='发布人')
    published_at = Column(DateTime, default=datetime.now, comment='发布时间')
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, comment='更新时间')
