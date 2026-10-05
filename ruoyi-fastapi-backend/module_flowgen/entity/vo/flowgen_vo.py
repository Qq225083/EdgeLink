"""过渡版流程生成器 — Pydantic VO 模型"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class PgTargetModel(BaseModel):
    """PG 写入目标（多目标写库：每条目标独立 库/模式/表/字段子集）"""

    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    pg_host: str = Field(default='127.0.0.1', description='PG 地址', max_length=100)
    pg_port: int = Field(default=5432, description='PG 端口', ge=1, le=65535)
    pg_db: str = Field(default='ruoyi_pg', description='库名', max_length=64)
    pg_schema: str = Field(default='public', description='模式名', max_length=64)
    pg_table: str = Field(default='plc_data_log', description='表名', max_length=64)
    pg_fields: Optional[list[str]] = Field(default=None, description='插入列子集（None=全部）')
    pg_user: str = Field(default='', description='PG 账号（内嵌生成文件，明文；留空=现场编辑器录入）', max_length=64)
    pg_password: str = Field(default='', description='PG 密码（内嵌生成文件，明文；留空=现场编辑器录入）', max_length=128)


class FlowGenerateModel(BaseModel):
    """生成请求参数"""

    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    site_id: int = Field(description='目标采集点ID（site_health_site.id）')
    topic_prefix: str = Field(default='edgelink/gen', description='MQTT topic 前缀（对拍期 edgelink/gen，切换期改 edgelink）', max_length=100)
    tab_prefix: str = Field(default='GEN_', description='生成标签页名称前缀（合并部署/漂移检测靠它+确定性id认门，勿与他人程序撞名）', max_length=16)
    block_gap: int = Field(default=8, ge=0, le=32, description='块读空洞容忍（字）：地址间隙≤该值时合并成一块多读回来再丢弃，防跳址点位炸出几百个读节点')
    enable_pg: bool = Field(default=False, description='是否生成 PG 写库支路（postgres 节点格式待真机验证）')
    backend_host: str = Field(default='127.0.0.1', description='后端地址（site-health 上报指向）', max_length=100)
    backend_port: int = Field(default=9099, description='后端端口', ge=1, le=65535)
    mqtt_host: str = Field(default='127.0.0.1', description='MQTT broker 地址', max_length=100)
    mqtt_port: int = Field(default=1883, description='MQTT broker 端口', ge=1, le=65535)
    mqtt_username: str = Field(default='', description='MQTT 账号（内嵌生成文件，运行时抽进 credential；留空=现场录入）', max_length=64)
    mqtt_password: str = Field(default='', description='MQTT 密码（内嵌生成文件；留空=现场录入）', max_length=128)
    pg_host: str = Field(default='127.0.0.1', description='PostgreSQL 地址（enable_pg 时生效）', max_length=100)
    pg_port: int = Field(default=5432, description='PostgreSQL 端口', ge=1, le=65535)
    pg_db: str = Field(default='ruoyi_pg', description='PostgreSQL 库名', max_length=64)
    pg_schema: str = Field(default='public', description='PostgreSQL 模式名（如 public/edgelink）', max_length=64)
    pg_table: str = Field(default='plc_data_log', description='目标表名', max_length=64)
    pg_fields: Optional[list[str]] = Field(default=None, description='PG 插入列子集（None=全部 8 列；合法值见 PG_FIELD_OPTIONS）')
    pg_targets: Optional[list[PgTargetModel]] = Field(default=None, description='多目标写库（同时写多张表）；为空则用上方单目标参数')
    monitor_api_key: Optional[str] = Field(default=None, description='X-API-Key（心跳支路用；留空则取后端 monitor_api_key 配置）', max_length=128)


# PG 可插入列白名单（供前端生成弹窗选项 + 后端校验）
PG_FIELD_OPTIONS = [
    ('device_id', '设备ID'), ('tag_id', '点位ID'), ('node_id', '节点ID'),
    ('tag_name', '点位名称'), ('tag_address', '寄存器地址'), ('register_type', '寄存器类型'),
    ('raw_value', '原始值'), ('eng_value', '工程值'), ('unit', '单位'),
    ('quality', '质量码'), ('transform_type', '换算类型'), ('ts', '采集时间'),
]


class FlowReleaseModel(BaseModel):
    """流程版本（详情，含 payload 全文）"""

    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None)
    site_id: Optional[int] = Field(default=None)
    config_version: Optional[int] = Field(default=None)
    version: Optional[int] = Field(default=None)
    payload: Optional[str] = Field(default=None)
    sha256: Optional[str] = Field(default=None)
    device_count: Optional[int] = Field(default=None)
    node_count: Optional[int] = Field(default=None)
    status: Optional[str] = Field(default=None)
    remark: Optional[str] = Field(default=None)
    create_by: Optional[str] = Field(default=None)
    create_time: Optional[datetime] = Field(default=None)
    update_time: Optional[datetime] = Field(default=None)


class FlowReleasePageQueryModel(BaseModel):
    """流程版本分页查询"""

    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    page_num: int = Field(default=1, description='当前页码')
    page_size: int = Field(default=10, description='每页记录数')
    site_id: Optional[int] = Field(default=None, description='按采集点过滤')
