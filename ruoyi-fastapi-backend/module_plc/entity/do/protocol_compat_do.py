"""PLC协议兼容表 ORM"""

from sqlalchemy import BigInteger, Boolean, Column, Integer, String

from config.database import Base


class PlcProtocolCompat(Base):
    __tablename__ = 'plc_protocol_compat'

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment='ID')
    plc_brand = Column(String(50), nullable=False, comment='PLC品牌')
    plc_series = Column(String(50), nullable=False, comment='PLC系列')
    com_type = Column(String(50), nullable=False, comment='通信方式')
    driver_code = Column(String(50), nullable=False, comment='驱动编码（对应 plc_driver.driver_code）')
    is_default_com_type = Column(Boolean, default=False, comment='是否默认通信方式')
    register_type = Column(String(20), nullable=False, comment='寄存器类型')
    register_type_label = Column(String(50), comment='寄存器类型标签')
    sort_order = Column(Integer, default=0, comment='排序')
