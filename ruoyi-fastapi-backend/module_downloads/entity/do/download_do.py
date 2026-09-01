"""部署中心（节点与文档下载）— ORM 模型"""
from datetime import datetime

from sqlalchemy import BigInteger, Column, DateTime, Integer, SmallInteger, String

from config.database import Base


class DownloadItem(Base):
    """部署中心交付物表"""
    __tablename__ = 'edgelink_download_item'
    __table_args__ = {'extend_existing': True, 'comment': 'EdgeLink 部署中心交付物表'}

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='交付物ID')
    group_key = Column(String(30), nullable=False, index=True, comment='类别：packages/nodered-full/nodered-inc/docs')
    name = Column(String(100), nullable=False, comment='交付物名称')
    version = Column(String(20), comment='版本号')
    file_name = Column(String(255), nullable=False, comment='磁盘文件名（相对 downloads 目录的路径，含子目录+时间戳前缀）')
    origin_name = Column(String(255), comment='原始文件名（上传时的文件名，用于下载展示）')
    size_bytes = Column(BigInteger, default=0, comment='文件大小（字节）')
    description = Column(String(500), comment='描述')
    tags = Column(String(200), comment='标签（逗号分隔）')
    status = Column(SmallInteger, default=1, index=True, comment='0下架 1上架')
    create_by = Column(String(64), comment='创建者')
    create_time = Column(DateTime, default=datetime.now, comment='创建时间')
    update_by = Column(String(64), comment='更新者')
    update_time = Column(DateTime, default=datetime.now, onupdate=datetime.now, comment='更新时间')
    remark = Column(String(200), comment='备注')
