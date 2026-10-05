"""PLC驱动元数据表 ORM

供前端动态渲染驱动表单与 Node-RED 动态分发驱动节点使用。
"""

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Integer, JSON, String

from config.database import Base


class PlcDriver(Base):
    __tablename__ = 'plc_driver'
    __table_args__ = {'comment': 'PLC 驱动元数据表'}

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='ID')
    driver_code = Column(String(50), nullable=False, unique=True, comment='驱动编码（如 mitsubishi_mc / modbus_tcp）')
    driver_name = Column(String(100), nullable=False, comment='驱动显示名称')
    node_red_node_type = Column(String(100), nullable=False, comment='Node-RED 节点类型名')
    # 过渡版流程生成器映射（9-28 迁移）：V12/V13 自研节点用 node_red_node_type，生成器用 gen_* 两列
    gen_node_type = Column(String(100), nullable=True, comment='生成版读取节点类型名（社区/核心节点注册名）')
    gen_conn_type = Column(String(100), nullable=True, comment='生成版连接配置节点类型名')
    config_schema = Column(JSON, nullable=False, comment='设备级协议参数 schema')
    register_types = Column(JSON, nullable=False, comment='支持的寄存器类型')
    data_types = Column(JSON, nullable=False, comment='支持的数据类型')
    address_pattern = Column(String(255), nullable=True, comment='寄存器地址校验正则')
    bit_offset_supported = Column(Boolean, default=False, comment='是否支持位偏移')
    byte_order_supported = Column(Boolean, default=False, comment='是否支持字节序')
    word_order_supported = Column(Boolean, default=False, comment='是否支持字序')
    enabled = Column(Boolean, default=True, comment='是否启用')
    schema_version = Column(Integer, default=1, comment='schema 版本，便于后续演进')
    sort_order = Column(Integer, default=0, comment='排序')
    create_time = Column(DateTime, nullable=True, comment='创建时间')
    update_time = Column(DateTime, nullable=True, comment='更新时间')
    remark = Column(String(500), nullable=True, comment='备注')
