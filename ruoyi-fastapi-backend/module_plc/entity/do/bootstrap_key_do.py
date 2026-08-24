"""边缘节点初始接入密钥 DO 模型"""
import hashlib
from datetime import datetime

from sqlalchemy import BigInteger, Column, DateTime, SmallInteger, String

from config.database import Base


class EdgeBootstrapKey(Base):
    """边缘节点初始接入密钥表"""

    __tablename__ = 'edge_bootstrap_key'
    __table_args__ = {'extend_existing': True, 'comment': '边缘节点初始接入密钥表'}

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='ID')
    node_key = Column(String(64), nullable=False, unique=True, comment='节点标识（如 pc-001）')
    node_name = Column(String(100), nullable=True, comment='节点名称')
    host_pc_ip = Column(String(50), nullable=True, unique=True, comment='预设的节点标识（IP:端口，必须唯一）')
    machine_fingerprint = Column(String(64), nullable=True, comment='机器指纹 SHA256(hostname+MACs)')
    secret_key = Column(String(64), nullable=False, comment='初始接入密钥（存 SHA-256 哈希，明文仅创建/重置时返回一次）')
    enabled = Column(SmallInteger, default=1, comment='是否启用（0停用 1启用）')
    created_at = Column(DateTime, default=datetime.now, comment='创建时间')
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, comment='更新时间')


def hash_bootstrap_secret(secret: str) -> str:
    """bootstrap 密钥存储哈希（高熵随机 token，SHA-256 即可，无需加盐）。

    管理端新增/重置与 /auto 首次注册时存储哈希；/bootstrap 按哈希比对校验。
    """
    return hashlib.sha256(secret.encode('utf-8')).hexdigest()
