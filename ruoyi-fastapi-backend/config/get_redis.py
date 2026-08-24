from fastapi import FastAPI
from redis import asyncio as aioredis

from config.database import AsyncSessionLocal
from config.env import RedisConfig
from module_admin.service.config_service import ConfigService
from module_admin.service.dict_service import DictDataService
from utils.log_util import logger


class RedisUtil:
    """
    Redis相关方法
    """

    @classmethod
    async def create_redis_pool(cls) -> aioredis.Redis:
        """
        应用启动时初始化redis连接

        :return: Redis连接对象
        :raises AuthenticationError: Redis 认证失败
        :raises RedisTimeoutError: Redis 连接超时
        :raises RedisError: Redis 其他错误
        """
        logger.info('🔎 开始连接redis...')
        redis = await aioredis.from_url(
            url=f'redis://{RedisConfig.redis_host}',
            port=RedisConfig.redis_port,
            username=RedisConfig.redis_username,
            password=RedisConfig.redis_password,
            db=RedisConfig.redis_database,
            encoding='utf-8',
            decode_responses=True,
        )
        connection = await redis.ping()
        if connection:
            logger.info('✅️ redis连接成功')
        else:
            logger.error('❌️ redis连接失败')
        return redis

    @classmethod
    async def close_redis_pool(cls, app: FastAPI) -> None:
        """
        应用关闭时关闭redis连接

        :param app: fastapi对象
        :return:
        """
        await app.state.redis.close()
        logger.info('✅️ 关闭redis连接成功')

    @classmethod
    async def init_sys_dict(cls, redis: FastAPI) -> None:
        """
        应用启动时缓存字典表

        :param redis: redis对象
        :return:
        """
        async with AsyncSessionLocal() as session:
            await DictDataService.init_cache_sys_dict_services(session, redis)

    @classmethod
    async def init_sys_config(cls, redis: aioredis.Redis) -> None:
        """
        应用启动时缓存参数配置表

        :param redis: redis对象
        :return:
        """
        async with AsyncSessionLocal() as session:
            await ConfigService.init_cache_sys_config_services(session, redis)
