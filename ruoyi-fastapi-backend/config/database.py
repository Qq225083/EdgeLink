from urllib.parse import quote_plus

from sqlalchemy.ext.asyncio import AsyncAttrs, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from config.env import DataBaseConfig

ASYNC_SQLALCHEMY_DATABASE_URL = (
    f'mysql+asyncmy://{DataBaseConfig.db_username}:{quote_plus(DataBaseConfig.db_password)}@'
    f'{DataBaseConfig.db_host}:{DataBaseConfig.db_port}/{DataBaseConfig.db_database}'
    f'?connect_timeout=10&read_timeout=30&charset=utf8mb4'
)
if DataBaseConfig.db_type == 'postgresql':
    ASYNC_SQLALCHEMY_DATABASE_URL = (
        f'postgresql+asyncpg://{DataBaseConfig.db_username}:{quote_plus(DataBaseConfig.db_password)}@'
        f'{DataBaseConfig.db_host}:{DataBaseConfig.db_port}/{DataBaseConfig.db_database}'
    )

async_engine = create_async_engine(
    ASYNC_SQLALCHEMY_DATABASE_URL,
    echo=DataBaseConfig.db_echo,
    max_overflow=DataBaseConfig.db_max_overflow,
    pool_size=DataBaseConfig.db_pool_size,
    pool_recycle=DataBaseConfig.db_pool_recycle,
    pool_timeout=DataBaseConfig.db_pool_timeout,
    pool_pre_ping=DataBaseConfig.db_pool_pre_ping,
)
AsyncSessionLocal = async_sessionmaker(autocommit=False, autoflush=False, bind=async_engine)


class Base(AsyncAttrs, DeclarativeBase):
    pass
