from datetime import datetime
from typing import Optional, Any

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from module_plc.entity.vo.tag_vo import TagModel


class PlcDeviceModel(BaseModel):
    """
    PLC设备表对应Pydantic模型
    """
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)

    id: Optional[int] = Field(default=None, description='设备ID')
    device_name: Optional[str] = Field(default=None, description='设备名称')
    device_code: Optional[str] = Field(default=None, description='设备编号（如PLC-Q-01）')
    plc_brand: Optional[str] = Field(default=None, description='PLC品牌')
    plc_series: Optional[str] = Field(default=None, description='PLC系列')
    com_type: Optional[str] = Field(default=None, description='通信方式')
    plc_ip: Optional[str] = Field(default=None, description='PLC IP地址')
    host_pc_ip: Optional[str] = Field(default=None, description='主采集PC的办公网IP（标记设备归属哪台PC采集）')
    backup_pc_ip: Optional[str] = Field(default=None, description='备采集PC的办公网IP（主PC宕机时自动切换，可选）')
    mes_ip: Optional[str] = Field(default=None, description='MES/MDPS对接IP')
    mes_port: Optional[int] = Field(default=0, description='MES/MDPS对接端口')
    plc_port: Optional[int] = Field(default=5007, description='PLC端口号')
    mc_frame: Optional[str] = Field(default=None, description='MC协议帧格式')
    station_no: Optional[int] = Field(default=0, description='站号')
    network_no: Optional[int] = Field(default=0, description='网络号')
    scan_interval_ms: Optional[int] = Field(default=1000, description='采集周期（毫秒）')
    comm_timeout_ms: Optional[int] = Field(default=3000, description='通信超时（毫秒）')
    retry_count: Optional[int] = Field(default=2, description='失败重试次数')
    retry_interval_ms: Optional[int] = Field(default=500, description='重试间隔（毫秒）')
    trigger_kind: Optional[int] = Field(default=0, description='触发方式（0=握手 1=固定周期 2=变化触发）')
    protocol_params: Optional[Any] = Field(default=None, description='协议专用参数（JSON，如Modbus的unit_id/function_code，OPC UA的node_id）')
    driver_code: Optional[str] = Field(default=None, description='驱动编码（如 mitsubishi_mc / modbus_tcp）')
    status: Optional[str] = Field(default='0', description='状态（0启用 1停用）')
    create_by: Optional[str] = Field(default=None, description='创建者')
    create_time: Optional[datetime] = Field(default=None, description='创建时间')
    update_by: Optional[str] = Field(default=None, description='更新者')
    update_time: Optional[datetime] = Field(default=None, description='更新时间')
    remark: Optional[str] = Field(default=None, description='备注')
    del_flag: Optional[str] = Field(default='0', description='删除标志（0正常 2删除）')
    # 点位列表（查询详情时填充）
    tags: Optional[list[TagModel]] = Field(default=None, description='点位列表')
    # 点位数量（列表查询时填充）
    tag_count: Optional[int] = Field(default=None, description='点位数量')


class PlcDeviceQueryModel(PlcDeviceModel):
    """
    PLC设备不分页查询模型
    """
    # 🔧 Day9/P1-14：查询场景默认不按状态过滤（基类 default='0' 会让停用设备从列表/详情/克隆静默消失）
    status: Optional[str] = Field(default=None, description='状态（0启用 1停用，查询默认全部）')


class PlcDevicePageQueryModel(PlcDeviceQueryModel):
    """
    PLC设备分页查询模型
    """
    page_num: int = Field(default=1, ge=1, description='当前页码')  # 🔧 Day9/P2-1
    page_size: int = Field(default=10, ge=1, le=500, description='每页记录数')  # 🔧 Day9/P2-1：防 pageSize=0 除零/超大全表


class DeletePlcDeviceModel(BaseModel):
    """
    删除/停用PLC设备模型
    """
    ids: str = Field(description='需要操作的数据ID，多个用逗号分隔')
