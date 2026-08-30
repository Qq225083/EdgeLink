"""存量采集点健康监控 — Pydantic VO 模型"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class SiteRegisterModel(BaseModel):
    """采集点登记表单"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    office_ip: str = Field(description='办公网IP', max_length=20)
    indust_ip: Optional[str] = Field(default=None, description='工业网IP', max_length=20)
    site_name: str = Field(description='采集场所', max_length=100)
    contact: Optional[str] = Field(default=None, description='联系人', max_length=50)
    remark: Optional[str] = Field(default=None, description='采集备注', max_length=200)
    node_port: int = Field(description='Node-RED 监听端口（办公网IP+端口唯一标识一个采集点）', ge=1, le=65535)


class SiteUpdateModel(BaseModel):
    """采集点编辑表单（仅情报字段，不含密钥；密钥只能走重置）"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    office_ip: str = Field(description='办公网IP', max_length=20)
    indust_ip: Optional[str] = Field(default=None, description='工业网IP', max_length=20)
    site_name: str = Field(description='采集场所', max_length=100)
    contact: Optional[str] = Field(default=None, description='联系人', max_length=50)
    remark: Optional[str] = Field(default=None, description='采集备注', max_length=200)
    node_port: int = Field(description='Node-RED 监听端口', ge=1, le=65535)


class SiteHealthSiteModel(BaseModel):
    """采集点（列表/详情）"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None)
    office_ip: Optional[str] = Field(default=None)
    indust_ip: Optional[str] = Field(default=None)
    site_name: Optional[str] = Field(default=None)
    contact: Optional[str] = Field(default=None)
    remark: Optional[str] = Field(default=None)
    heartbeat_interval: Optional[int] = Field(default=30)
    status: Optional[int] = Field(default=1)
    last_heartbeat: Optional[datetime] = Field(default=None)
    report_ip: Optional[str] = Field(default=None)
    node_port: Optional[int] = Field(default=None)
    memory_rss_mb: Optional[int] = Field(default=None)
    memory_total_mb: Optional[int] = Field(default=None)
    memory_free_mb: Optional[int] = Field(default=None)
    running_flows: Optional[int] = Field(default=None)
    node_red_version: Optional[str] = Field(default=None)
    uptime_sec: Optional[int] = Field(default=None)
    created_at: Optional[datetime] = Field(default=None)
    updated_at: Optional[datetime] = Field(default=None)
    # 运行时计算字段
    is_online: Optional[bool] = Field(default=False)
    has_reported: Optional[bool] = Field(default=False, description='是否已上报过（区分未接入与离线）')
    memory_used_mb: Optional[int] = Field(default=None, description='整机已用内存MB')


class SiteHealthPageQueryModel(BaseModel):
    """分页查询模型"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    page_num: int = Field(default=1, description='当前页码')
    page_size: int = Field(default=10, description='每页记录数')
    keyword: Optional[str] = Field(default=None, description='关键字（采集场所/办公IP/工业IP/联系人，模糊）')
    state: Optional[str] = Field(
        default=None,
        description='状态过滤：online/offline/notConnected/disabled，不传为全部',
    )


class SiteHeartbeatLogModel(BaseModel):
    """心跳履历"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None)
    site_id: Optional[int] = Field(default=None)
    report_time: Optional[datetime] = Field(default=None)
    report_ip: Optional[str] = Field(default=None)
    memory_rss_mb: Optional[int] = Field(default=None)
    memory_total_mb: Optional[int] = Field(default=None)
    memory_free_mb: Optional[int] = Field(default=None)
    running_flows: Optional[int] = Field(default=None)
    node_red_version: Optional[str] = Field(default=None)
    uptime_sec: Optional[int] = Field(default=None)
