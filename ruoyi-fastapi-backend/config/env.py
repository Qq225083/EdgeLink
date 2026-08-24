import argparse
import configparser
import os
import sys
from typing import Literal

from dotenv import load_dotenv
from pydantic import Field, computed_field
from pydantic_settings import BaseSettings


class AppSettings(BaseSettings):
    """
    应用配置
    """

    app_env: str = 'dev'
    app_name: str = 'RuoYi-FastAPI'
    app_root_path: str = '/dev-api'
    app_host: str = '0.0.0.0'
    app_port: int = 9099
    app_version: str = '1.0.0'
    app_reload: bool = True
    app_ip_location_query: bool = True
    app_same_time_login: bool = True
    # Node-RED 监控上报 API Key（用于心跳/通信状态/PG写入上报的内网鉴权）
    # 生产环境必须配置，空值将在启动时触发校验失败
    monitor_api_key: str = Field(..., min_length=1, description='Node-RED 监控上报 API Key')
    # MQTT Broker 配置（EMQX）——后端通知发布器专用账号（仅 publish edgelink/notify/#）
    mqtt_host: str = '127.0.0.1'
    mqtt_port: int = 1883
    mqtt_ws_port: int = 8083
    mqtt_username: str = ''
    mqtt_password: str = ''
    # 边缘节点 MQTT 账号（bootstrap 下发给 Node-RED；与后端账号分离，避免边缘凭据泄露后被伪造 kill switch）
    edge_mqtt_username: str = ''
    edge_mqtt_password: str = ''
    # 采集节点专用账号 edge_collector 的登录密码（bootstrap 下发给 Node-RED，未配置时 bootstrap 直接报错，
    # Node-RED 会回退到 settings.js 本地凭据，避免下发错误账号导致认证死循环）
    edge_collector_password: str = Field(default='', description='edge_collector 账号密码（bootstrap 下发）')


class JwtSettings(BaseSettings):
    """
    Jwt配置
    """

    jwt_secret_key: str = Field(..., min_length=32, description='JWT 密钥，生产环境必须配置且长度不少于 32 位')
    jwt_algorithm: str = 'HS256'
    jwt_expire_minutes: int = 1440
    jwt_redis_expire_minutes: int = 30


class DataBaseSettings(BaseSettings):
    """
    数据库配置
    """

    db_type: Literal['mysql', 'postgresql'] = 'mysql'
    db_host: str = '127.0.0.1'
    db_port: int = 3307
    db_username: str = 'root'
    db_password: str = Field(..., min_length=1, description='数据库密码，生产环境必须配置')
    db_database: str = 'ruoyi-fastapi'
    db_echo: bool = False
    db_max_overflow: int = 40
    db_pool_size: int = 20
    db_pool_recycle: int = 1800
    db_pool_timeout: int = 10
    db_pool_pre_ping: bool = True

    @computed_field
    @property
    def sqlglot_parse_dialect(self) -> str:
        if self.db_type == 'postgresql':
            return 'postgres'
        return self.db_type


class RedisSettings(BaseSettings):
    """
    Redis配置
    """

    redis_host: str = '127.0.0.1'
    redis_port: int = 6379
    redis_username: str = ''
    redis_password: str = ''
    redis_database: int = 2


class GenSettings:
    """
    代码生成配置
    """

    author = 'insistence'
    package_name = 'module_admin.system'
    auto_remove_pre = False
    table_prefix = 'sys_'
    allow_overwrite = False

    GEN_PATH = 'vf_admin/gen_path'

    def __init__(self) -> None:
        if not os.path.exists(self.GEN_PATH):
            os.makedirs(self.GEN_PATH)


class UploadSettings:
    """
    上传配置
    """

    UPLOAD_PREFIX = '/profile'
    UPLOAD_PATH = 'vf_admin/upload_path'
    UPLOAD_MACHINE = 'A'
    DEFAULT_ALLOWED_EXTENSION = [
        # 图片
        'bmp',
        'gif',
        'jpg',
        'jpeg',
        'png',
        # word excel powerpoint
        'doc',
        'docx',
        'xls',
        'xlsx',
        'ppt',
        'pptx',
        'html',
        'htm',
        'txt',
        # 压缩文件
        'rar',
        'zip',
        'gz',
        'bz2',
        # 视频格式
        'mp4',
        'avi',
        'rmvb',
        # pdf
        'pdf',
    ]
    DOWNLOAD_PATH = 'vf_admin/download_path'

    def __init__(self) -> None:
        if not os.path.exists(self.UPLOAD_PATH):
            os.makedirs(self.UPLOAD_PATH)
        if not os.path.exists(self.DOWNLOAD_PATH):
            os.makedirs(self.DOWNLOAD_PATH)


class CachePathConfig:
    """
    缓存目录配置
    """

    PATH = os.path.join(os.path.abspath(os.getcwd()), 'caches')
    PATHSTR = 'caches'


class GetConfig:
    """
    获取配置
    """

    def __init__(self) -> None:
        self.parse_cli_args()

    def get_app_config(self) -> AppSettings:
        """
        获取应用配置
        """
        # 实例化应用配置模型
        return AppSettings()

    def get_jwt_config(self) -> JwtSettings:
        """
        获取Jwt配置
        """
        # 实例化Jwt配置模型
        return JwtSettings()

    def get_database_config(self) -> DataBaseSettings:
        """
        获取数据库配置
        """
        # 实例化数据库配置模型
        return DataBaseSettings()

    def get_redis_config(self) -> RedisSettings:
        """
        获取Redis配置
        """
        # 实例化Redis配置模型
        return RedisSettings()

    def get_gen_config(self) -> GenSettings:
        """
        获取代码生成配置
        """
        # 实例化代码生成配置
        return GenSettings()

    def get_upload_config(self) -> UploadSettings:
        """
        获取上传配置
        """
        # 实例上传配置
        return UploadSettings()

    @staticmethod
    def parse_cli_args() -> None:
        """
        解析命令行参数
        """
        # 检查是否在alembic环境中运行，如果是则跳过参数解析
        if 'alembic' in sys.argv[0] or any('alembic' in arg for arg in sys.argv):
            ini_config = configparser.ConfigParser()
            ini_config.read('alembic.ini', encoding='utf-8')
            if 'settings' in ini_config:
                # 获取env选项
                env_value = ini_config['settings'].get('env')
                os.environ['APP_ENV'] = env_value if env_value else 'dev'
        elif 'uvicorn' in sys.argv[0]:
            # 使用uvicorn启动时，命令行参数需要按照uvicorn的文档进行配置，无法自定义参数
            pass
        else:
            # 使用argparse定义命令行参数
            parser = argparse.ArgumentParser(description='命令行参数')
            parser.add_argument('--env', type=str, default='', help='运行环境')
            # 解析命令行参数
            args = parser.parse_args()
            # 设置环境变量
            if args.env:
                os.environ['APP_ENV'] = args.env
        # 读取运行环境
        run_env = os.environ.get('APP_ENV', '')
        # P1#26: 未指定 APP_ENV 时抛出异常，不再默认加载 .env.dev
        if not run_env:
            raise ValueError(
                'APP_ENV 未设置，无法确定加载哪个环境配置文件。'
                '请通过以下方式之一设置：\n'
                '1. 环境变量：export APP_ENV=dev 或 APP_ENV=prod\n'
                '2. 命令行参数：python app.py --env=dev 或 --env=prod\n'
                '3. uvicorn 启动：APP_ENV=prod uvicorn app:app --host 0.0.0.0 --port 9099'
            )
        env_file = f'.env.{run_env}'
        # 加载配置
        load_dotenv(env_file)


# 实例化获取配置类
get_config = GetConfig()
# 应用配置
AppConfig = get_config.get_app_config()
# Jwt配置
JwtConfig = get_config.get_jwt_config()
# 数据库配置
DataBaseConfig = get_config.get_database_config()
# Redis配置
RedisConfig = get_config.get_redis_config()
# 代码生成配置
GenConfig = get_config.get_gen_config()
# 上传配置
UploadConfig = get_config.get_upload_config()
