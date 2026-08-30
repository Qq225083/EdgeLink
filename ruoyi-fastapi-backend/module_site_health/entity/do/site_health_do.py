"""存量采集点健康监控 — ORM 模型"""
import hashlib
from datetime import datetime

from sqlalchemy import BigInteger, Column, DateTime, Integer, SmallInteger, String

from config.database import Base


def hash_site_key(secret: str) -> str:
    """采集点密钥存储哈希（高熵随机 token，SHA-256 即可，无需加盐）。

    登记/重置时存储哈希，节点上报按哈希比对校验。明文仅创建/重置时返回一次。
    """
    return hashlib.sha256(secret.encode('utf-8')).hexdigest()


class SiteHealthSite(Base):
    """存量采集点登记表"""
    __tablename__ = 'site_health_site'
    __table_args__ = {'extend_existing': True, 'comment': '存量采集点登记表'}

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='采集点ID')
    site_key_hash = Column(String(64), nullable=False, unique=True, comment='密钥哈希（明文仅创建/重置时返回一次）')
    office_ip = Column(String(20), nullable=False, comment='办公网IP')
    indust_ip = Column(String(20), comment='工业网IP')
    site_name = Column(String(100), nullable=False, comment='采集场所')
    contact = Column(String(50), comment='联系人')
    remark = Column(String(200), comment='采集备注')
    heartbeat_interval = Column(Integer, default=30, comment='心跳间隔秒（节点上报，10-180）')
    status = Column(SmallInteger, default=1, comment='0停用 1启用')
    # ===== 节点健康指标（最近一次心跳上报）=====
    last_heartbeat = Column(DateTime, comment='最后心跳时间')
    report_ip = Column(String(50), comment='最近上报来源IP')
    node_port = Column(Integer, nullable=True, comment='Node-RED 监听端口（登记时手动填写，心跳上报自动回填）')
    memory_rss_mb = Column(Integer, nullable=True, comment='Node进程内存占用MB')
    memory_total_mb = Column(Integer, nullable=True, comment='整机总内存MB')
    memory_free_mb = Column(Integer, nullable=True, comment='整机空闲内存MB')
    running_flows = Column(Integer, nullable=True, comment='运行流数量')
    node_red_version = Column(String(20), nullable=True, comment='Node-RED版本')
    uptime_sec = Column(BigInteger, nullable=True, comment='Node-RED运行时长秒')
    created_at = Column(DateTime, default=datetime.now, comment='创建时间')
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, comment='更新时间')


class SiteHealthHeartbeatLog(Base):
    """存量采集点心跳履历表"""
    __tablename__ = 'site_health_heartbeat_log'
    __table_args__ = {'extend_existing': True, 'comment': '存量采集点心跳履历'}

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='日志ID')
    site_id = Column(BigInteger, nullable=False, index=True, comment='采集点ID')
    report_time = Column(DateTime, nullable=False, index=True, comment='上报时间')
    report_ip = Column(String(50), comment='上报来源IP')
    memory_rss_mb = Column(Integer, default=0, comment='Node进程内存占用MB')
    memory_total_mb = Column(Integer, default=0, comment='整机总内存MB')
    memory_free_mb = Column(Integer, default=0, comment='整机空闲内存MB')
    running_flows = Column(Integer, default=0, comment='运行流数量')
    node_red_version = Column(String(20), comment='Node-RED版本')
    uptime_sec = Column(BigInteger, default=0, comment='Node-RED运行时长秒')
