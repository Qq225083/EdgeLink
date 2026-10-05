"""过渡版流程生成器 — ORM 模型

对应 docs 迁移：9-28/migration_20260928_flowgen.sql
"""
from datetime import datetime

from sqlalchemy import BigInteger, CHAR, Column, DateTime, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.mysql import MEDIUMTEXT

from config.database import Base


class PlcFlowRelease(Base):
    """流程版本表（生成器产物：一现场一版本链，绑定配置快照版本）"""

    __tablename__ = 'plc_flow_release'
    __table_args__ = (
        UniqueConstraint('site_id', 'version', name='uk_flow_release_site_version'),
        Index('ix_flow_release_site_id', 'site_id'),
        Index('ix_flow_release_config_version', 'config_version'),
        {'extend_existing': True, 'comment': '流程版本表（生成器产物，部署即全量替换目标画布）', 'mysql_charset': 'utf8mb4'},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='主键')
    site_id = Column(BigInteger, nullable=False, comment='目标采集点ID（site_health_site.id）')
    config_version = Column(Integer, nullable=False, comment='生成依据的配置快照版本（plc_config_snapshot.version）')
    version = Column(Integer, nullable=False, comment='流程版本号（每现场自增，从1开始）')
    payload = Column(MEDIUMTEXT, nullable=False, comment='生成的 flows.json 全文（完整目标状态，全量替换语义）')
    sha256 = Column(CHAR(64), nullable=False, comment='payload 内容哈希（幂等：内容不变不重复建版本）')
    device_count = Column(Integer, default=0, comment='包含设备数（PLC 支路数）')
    node_count = Column(Integer, default=0, comment='节点总数（部署性能评估用，警戒值 500）')
    status = Column(CHAR(1), default='0', comment='状态（0草稿 1已发布 2归档）')
    deploy_time = Column(DateTime, comment='最近一次部署到边缘的时间')
    deploy_by = Column(String(64), comment='部署操作人')
    deploy_msg = Column(String(500), comment='部署结果摘要（边缘节点包版本留痕等）')
    deploy_credentials = Column(Text, comment='部署凭证（JSON，按节点id；仅部署时使用，不进 flows.json）')
    remark = Column(String(500), comment='备注（生成告警列表）')
    create_by = Column(String(64), comment='创建者')
    create_time = Column(DateTime, default=datetime.now, comment='创建时间')
    update_by = Column(String(64), comment='更新者')
    update_time = Column(DateTime, default=datetime.now, onupdate=datetime.now, comment='更新时间')


class PlcFlowDeployLog(Base):
    """流程部署履历表（M3 部署服务使用，M1 仅建模）"""

    __tablename__ = 'plc_flow_deploy_log'
    __table_args__ = (
        Index('ix_flow_deploy_log_release_id', 'release_id'),
        Index('ix_flow_deploy_log_site_id', 'site_id'),
        Index('ix_flow_deploy_log_create_time', 'create_time'),
        {'extend_existing': True, 'comment': '流程部署履历表', 'mysql_charset': 'utf8mb4'},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='主键')
    release_id = Column(BigInteger, nullable=False, comment='流程版本ID（plc_flow_release.id）')
    site_id = Column(BigInteger, nullable=False, comment='目标采集点ID（site_health_site.id）')
    target = Column(String(64), nullable=False, comment='部署目标（office_ip:node_port）')
    deploy_type = Column(String(10), default='nodes', comment='部署类型（nodes增量/full全量）')
    rev_before = Column(String(64), comment='部署前目标端 flow rev')
    rev_after = Column(String(64), comment='部署后目标端 flow rev')
    result = Column(CHAR(1), nullable=False, comment='结果（0失败 1成功）')
    error_msg = Column(String(1000), comment='失败原因（含 409 rev 冲突等）')
    duration_ms = Column(Integer, comment='部署耗时毫秒')
    create_by = Column(String(64), comment='操作人')
    create_time = Column(DateTime, default=datetime.now, comment='部署时间')


class PlcFlowCanvasSnapshot(Base):
    """边缘画布快照表（部署后自动归档 + 手动备份；含用户自定义标签页，按敏感数据对待）"""

    __tablename__ = 'plc_flow_canvas_snapshot'
    __table_args__ = (
        Index('ix_canvas_snap_site', 'site_id'),
        Index('ix_canvas_snap_time', 'create_time'),
        {'extend_existing': True, 'comment': '边缘画布快照表（部署归档+手动备份，每现场保留最近20份）', 'mysql_charset': 'utf8mb4'},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='主键')
    site_id = Column(BigInteger, nullable=False, comment='采集点ID（site_health_site.id）')
    release_id = Column(BigInteger, comment='关联流程版本ID（部署归档时填；手动备份为空）')
    rev = Column(String(64), comment='边缘 flow rev（Admin API v2）')
    node_count = Column(Integer, default=0, comment='节点总数')
    payload = Column(MEDIUMTEXT, nullable=False, comment='边缘完整 flows.json（含用户自定义标签页）')
    source = Column(CHAR(10), default='deploy', comment='来源（deploy部署后自动/manual手动备份）')
    create_by = Column(String(64), comment='操作人')
    create_time = Column(DateTime, default=datetime.now, comment='归档时间')
