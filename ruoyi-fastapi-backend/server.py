from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI, applications
from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
from fastapi.responses import HTMLResponse

from common.router import auto_register_routers
from config.env import AppConfig
from config.get_db import init_create_table
from config.get_redis import RedisUtil
from config.get_scheduler import SchedulerUtil
from exceptions.handle import handle_exception
from middlewares.handle import handle_middleware
from module_plc.mqtt.mqtt_consumer import MqttNotifier
from sub_applications.handle import handle_sub_applications
from utils.common_util import worship
from utils.log_util import logger


# 生命周期事件
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    logger.info(f'⏰️ {AppConfig.app_name}开始启动')
    worship()
    await init_create_table()
    app.state.redis = await RedisUtil.create_redis_pool()
    await RedisUtil.init_sys_dict(app.state.redis)
    await RedisUtil.init_sys_config(app.state.redis)
    await SchedulerUtil.init_system_scheduler()

    # 启动 MQTT 通知发布器（前端离线弹窗通道）
    mqtt_notifier = MqttNotifier()
    await mqtt_notifier.start()
    app.state.mqtt_notifier = mqtt_notifier

    logger.info(f'🚀 {AppConfig.app_name}启动成功')
    yield

    # 关闭 MQTT 通知发布器
    await mqtt_notifier.stop()

    await RedisUtil.close_redis_pool(app)
    await SchedulerUtil.close_system_scheduler()


def setup_docs_static_resources(
    redoc_js_url: str = 'https://registry.npmmirror.com/redoc/2/files/bundles/redoc.standalone.js',
    redoc_favicon_url: str = 'https://fastapi.tiangolo.com/img/favicon.png',
    swagger_js_url: str = 'https://registry.npmmirror.com/swagger-ui-dist/5/files/swagger-ui-bundle.js',
    swagger_css_url: str = 'https://registry.npmmirror.com/swagger-ui-dist/5/files/swagger-ui.css',
    swagger_favicon_url: str = 'https://fastapi.tiangolo.com/img/favicon.png',
) -> None:
    def redoc_monkey_patch(*args, **kwargs) -> HTMLResponse:
        return get_redoc_html(
            *args,
            **kwargs,
            redoc_js_url=redoc_js_url,
            redoc_favicon_url=redoc_favicon_url,
        )

    def swagger_ui_monkey_patch(*args, **kwargs) -> HTMLResponse:
        return get_swagger_ui_html(
            *args,
            **kwargs,
            swagger_js_url=swagger_js_url,
            swagger_css_url=swagger_css_url,
            swagger_favicon_url=swagger_favicon_url,
        )

    applications.get_redoc_html = redoc_monkey_patch
    applications.get_swagger_ui_html = swagger_ui_monkey_patch


def create_app() -> FastAPI:
    # 配置文档静态资源
    setup_docs_static_resources()

    # 初始化 FastAPI 对象
    app = FastAPI(
        title=AppConfig.app_name,
        description=f'{AppConfig.app_name}接口文档',
        version=AppConfig.app_version,
        lifespan=lifespan,
    )

    # 挂载子应用
    handle_sub_applications(app)
    # 加载中间件
    handle_middleware(app)
    # 加载全局异常处理
    handle_exception(app)
    # 自动注册框架自带路由
    auto_register_routers(app)

    return app