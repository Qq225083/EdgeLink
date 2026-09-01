"""部署中心（节点与文档下载）— Pydantic VO 模型"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class DownloadItemModel(BaseModel):
    """交付物（列表/详情）"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None)
    group_key: Optional[str] = Field(default=None)
    name: Optional[str] = Field(default=None)
    version: Optional[str] = Field(default=None)
    file_name: Optional[str] = Field(default=None)
    origin_name: Optional[str] = Field(default=None)
    size_bytes: Optional[int] = Field(default=None)
    description: Optional[str] = Field(default=None)
    tags: Optional[str] = Field(default=None)
    status: Optional[int] = Field(default=None)
    create_by: Optional[str] = Field(default=None)
    create_time: Optional[datetime] = Field(default=None)
    update_time: Optional[datetime] = Field(default=None)
    remark: Optional[str] = Field(default=None)


class DownloadQueryModel(BaseModel):
    """列表查询（按类别/关键字过滤）"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    group: Optional[str] = Field(default=None, description='类别过滤')
    keyword: Optional[str] = Field(default=None, description='名称/描述模糊')
    status: Optional[int] = Field(default=None, description='状态过滤（下载中心传1）')


class DownloadUpdateModel(BaseModel):
    """交付物元信息编辑"""
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    name: str = Field(max_length=100)
    group_key: str = Field(max_length=30)
    version: Optional[str] = Field(default=None, max_length=20)
    description: Optional[str] = Field(default=None, max_length=500)
    tags: Optional[str] = Field(default=None, max_length=200)
    status: Optional[int] = Field(default=1, ge=0, le=1)
    remark: Optional[str] = Field(default=None, max_length=200)
