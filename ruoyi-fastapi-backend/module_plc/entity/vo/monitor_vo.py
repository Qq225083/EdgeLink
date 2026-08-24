"""采集节点监控中心 — Pydantic VO 模型"""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class NoderedNodeModel(BaseModel):
    """采集节点"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None)
    node_name: Optional[str] = Field(default=None, description='节点名称')
    office_net_ip: Optional[str] = Field(default=None, description='办公网IP')
    indust_net_ip: Optional[str] = Field(default=None, description='工业网IP')
    host_pc_ip: Optional[str] = Field(default=None, description='host_pc_ip')
    status: Optional[int] = Field(default=1)
    heartbeat_interval: Optional[int] = Field(default=30)
    last_heartbeat: Optional[datetime] = Field(default=None, description='最后心跳时间')
    remark: Optional[str] = Field(default=None)
    created_at: Optional[datetime] = Field(default=None)
    updated_at: Optional[datetime] = Field(default=None)
    # 运行时计算字段
    is_online: Optional[bool] = Field(default=False, description='是否在线')
    running_flows: Optional[int] = Field(default=0, description='运行流数')
    memory_usage_mb: Optional[int] = Field(default=0, description='内存占用MB')
    pg_success_count: Optional[int] = Field(default=0, description='PG累计写入成功条数')
    pg_fail_count: Optional[int] = Field(default=0, description='PG累计写入失败条数')
    spool_bytes: Optional[int] = Field(default=0, description='磁盘spool积压字节数')
    device_count: Optional[int] = Field(default=0, description='负责设备数')
    online_device_count: Optional[int] = Field(default=0, description='在线设备数')
    today_count: Optional[int] = Field(default=0, description='今日采集条数')
    plc_list: Optional[list] = Field(default=None, description='下级PLC状态列表')


class DeviceCommStatusModel(BaseModel):
    """PLC通信状态"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None)
    node_id: Optional[int] = Field(default=None)
    device_id: Optional[int] = Field(default=None)
    online: Optional[int] = Field(default=0)
    last_success_time: Optional[datetime] = Field(default=None)
    last_error_time: Optional[datetime] = Field(default=None)
    error_msg: Optional[str] = Field(default=None)
    consecutive_fails: Optional[int] = Field(default=0)
    updated_at: Optional[datetime] = Field(default=None)
    # JOIN 字段
    device_name: Optional[str] = Field(default=None)
    plc_ip: Optional[str] = Field(default=None)
    plc_port: Optional[int] = Field(default=None)
    scan_interval_ms: Optional[int] = Field(default=None)
    is_online: Optional[bool] = Field(default=False)


class PgWriteStatusModel(BaseModel):
    """PG写入状态"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None)
    node_id: Optional[int] = Field(default=None)
    last_write_time: Optional[datetime] = Field(default=None)
    write_latency_ms: Optional[int] = Field(default=0)
    today_write_count: Optional[int] = Field(default=0)
    error_msg: Optional[str] = Field(default=None)
    consecutive_fails: Optional[int] = Field(default=0)
    updated_at: Optional[datetime] = Field(default=None)
    is_healthy: Optional[bool] = Field(default=True)


class MonitorAlertModel(BaseModel):
    """告警"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None)
    alert_type: Optional[str] = Field(default=None)
    severity: Optional[int] = Field(default=2)
    node_id: Optional[int] = Field(default=None)
    device_id: Optional[int] = Field(default=None)
    alert_msg: Optional[str] = Field(default=None)
    status: Optional[int] = Field(default=0)
    created_at: Optional[datetime] = Field(default=None)
    confirmed_at: Optional[datetime] = Field(default=None)
    resolved_at: Optional[datetime] = Field(default=None)
    # Day3 通知门控字段
    last_notified_at: Optional[datetime] = Field(default=None)
    notification_pending: Optional[int] = Field(default=0)
    # JOIN 字段
    node_name: Optional[str] = Field(default=None)
    device_name: Optional[str] = Field(default=None)


class KpiDashboardModel(BaseModel):
    """KPI 仪表盘"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    total_nodes: int = Field(default=0, description='采集节点总数')
    online_nodes: int = Field(default=0, description='在线节点数')
    total_devices: int = Field(default=0, description='PLC设备总数')
    online_devices: int = Field(default=0, description='在线PLC数')
    today_collect_count: int = Field(default=0, description='今日总采集条数')
    active_alerts: int = Field(default=0, description='未处理告警数')
