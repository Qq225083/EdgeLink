import importlib
import json
from asyncio import iscoroutinefunction
from datetime import datetime, timedelta
from typing import Any, Callable, Optional, Union

from apscheduler.events import EVENT_ALL, SchedulerEvent
from apscheduler.executors.asyncio import AsyncIOExecutor
from apscheduler.executors.pool import ProcessPoolExecutor
from apscheduler.job import Job
from apscheduler.jobstores.memory import MemoryJobStore
from apscheduler.jobstores.redis import RedisJobStore
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.combining import OrTrigger
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from sqlalchemy.engine import create_engine
from sqlalchemy.orm import sessionmaker

import module_task  # noqa: F401
from config.database import AsyncSessionLocal, quote_plus
from config.env import DataBaseConfig, RedisConfig
from module_admin.dao.job_dao import JobDao
from module_admin.entity.vo.job_vo import JobLogModel, JobModel
from module_admin.service.job_log_service import JobLogService
from utils.log_util import logger


# 重写Cron定时
class MyCronTrigger(CronTrigger):
    CRON_EXPRESSION_LENGTH_MIN = 6
    CRON_EXPRESSION_LENGTH_MAX = 7
    WEEKDAY_COUNT = 5

    @classmethod
    def from_crontab(cls, expr: str, timezone: Optional[str] = None) -> 'MyCronTrigger':
        values = expr.split()
        if len(values) != cls.CRON_EXPRESSION_LENGTH_MIN and len(values) != cls.CRON_EXPRESSION_LENGTH_MAX:
            raise ValueError(f'Wrong number of fields; got {len(values)}, expected 6 or 7')

        second = values[0]
        minute = values[1]
        hour = values[2]
        if '?' in values[3]:
            day = None
        elif 'L' in values[5]:
            day = f'last {values[5].replace("L", "")}'
        elif 'W' in values[3]:
            day = cls.__find_recent_workday(int(values[3].split('W')[0]))
        else:
            day = values[3].replace('L', 'last')
        month = values[4]
        if '?' in values[5] or 'L' in values[5]:
            week = None
        elif '#' in values[5]:
            week = int(values[5].split('#')[1])
        else:
            week = values[5]
        day_of_week = int(values[5].split('#')[0]) - 1 if '#' in values[5] else None
        year = values[6] if len(values) == cls.CRON_EXPRESSION_LENGTH_MAX else None
        return cls(
            second=second,
            minute=minute,
            hour=hour,
            day=day,
            month=month,
            week=week,
            day_of_week=day_of_week,
            year=year,
            timezone=timezone,
        )

    @classmethod
    def __find_recent_workday(cls, day: int) -> int:
        now = datetime.now()
        date = datetime(now.year, now.month, day)
        if date.weekday() < cls.WEEKDAY_COUNT:
            return date.day
        diff = 1
        while True:
            previous_day = date - timedelta(days=diff)
            if previous_day.weekday() < cls.WEEKDAY_COUNT:
                return previous_day.day
            diff += 1


SQLALCHEMY_DATABASE_URL = (
    f'mysql+pymysql://{DataBaseConfig.db_username}:{quote_plus(DataBaseConfig.db_password)}@'
    f'{DataBaseConfig.db_host}:{DataBaseConfig.db_port}/{DataBaseConfig.db_database}'
)
if DataBaseConfig.db_type == 'postgresql':
    SQLALCHEMY_DATABASE_URL = (
        f'postgresql+psycopg2://{DataBaseConfig.db_username}:{quote_plus(DataBaseConfig.db_password)}@'
        f'{DataBaseConfig.db_host}:{DataBaseConfig.db_port}/{DataBaseConfig.db_database}'
    )
# 同步引擎仅用于 APScheduler 元数据 + 任务日志写入，负载极低，
# 使用独立的小连接池避免与主 async 连接池争抢 Windows 临时端口。
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    echo=DataBaseConfig.db_echo,
    max_overflow=5,
    pool_size=3,
    pool_recycle=DataBaseConfig.db_pool_recycle,
    pool_timeout=DataBaseConfig.db_pool_timeout,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
redis_config = {
    'host': RedisConfig.redis_host,
    'port': RedisConfig.redis_port,
    'username': RedisConfig.redis_username,
    'password': RedisConfig.redis_password,
    'db': RedisConfig.redis_database,
}
job_stores = {
    'default': MemoryJobStore(),
    'sqlalchemy': SQLAlchemyJobStore(url=SQLALCHEMY_DATABASE_URL, engine=engine),
    'redis': RedisJobStore(**redis_config),
}
executors = {'default': AsyncIOExecutor(), 'processpool': ProcessPoolExecutor(5)}
job_defaults = {'coalesce': False, 'max_instances': 1}
scheduler = AsyncIOScheduler()
scheduler.configure(jobstores=job_stores, executors=executors, job_defaults=job_defaults)


class SchedulerUtil:
    """
    定时任务相关方法
    """

    @classmethod
    async def init_system_scheduler(cls) -> None:
        """
        应用启动时初始化定时任务

        :return:
        """
        logger.info('🔎 开始启动定时任务...')
        scheduler.start()
        async with AsyncSessionLocal() as session:
            job_list = await JobDao.get_job_list_for_scheduler(session)
            for item in job_list:
                cls.remove_scheduler_job(job_id=str(item.job_id))
                cls.add_scheduler_job(item)
        # 注册内置监控任务（不依赖数据库中的定时任务配置）
        cls._register_builtin_monitor_tasks()
        scheduler.add_listener(cls.scheduler_event_listener, EVENT_ALL)
        logger.info('✅️ 系统初始定时任务加载成功')

    @classmethod
    def _register_builtin_monitor_tasks(cls) -> None:
        """注册 EdgeLink 监控中心内置后台任务"""
        from module_task.monitor_task import check_offline_nodes_task, check_offline_devices_task, clean_heartbeat_logs_task
        from module_task.site_health_task import clean_site_health_heartbeat_logs_task

        # 离线节点检测：每30秒执行一次
        scheduler.add_job(
            func=check_offline_nodes_task,
            trigger=CronTrigger(second='*/30'),
            id='builtin_check_offline_nodes',
            name='离线节点检测',
            replace_existing=True,
            jobstore='redis',
            executor='default',
            coalesce=True,
            max_instances=1,
        )

        # 设备通信离线检测：每30秒执行一次
        scheduler.add_job(
            func=check_offline_devices_task,
            trigger=CronTrigger(second='*/30'),
            id='builtin_check_offline_devices',
            name='设备通信离线检测',
            replace_existing=True,
            jobstore='redis',
            executor='default',
            coalesce=True,
            max_instances=1,
        )

        # 心跳日志清理：每天凌晨3点执行
        scheduler.add_job(
            func=clean_heartbeat_logs_task,
            trigger=CronTrigger(hour=3, minute=0),
            id='builtin_clean_heartbeat_logs',
            name='心跳日志清理',
            replace_existing=True,
            jobstore='redis',
            executor='default',
            coalesce=True,
            max_instances=1,
        )
        # 存量采集点心跳履历清理：每天凌晨3点30执行（与 V12 心跳日志清理错开）
        scheduler.add_job(
            func=clean_site_health_heartbeat_logs_task,
            trigger=CronTrigger(hour=3, minute=30),
            id='builtin_clean_site_health_heartbeat_logs',
            name='存量采集点履历清理',
            replace_existing=True,
            jobstore='redis',
            executor='default',
            coalesce=True,
            max_instances=1,
        )
        logger.info('📎 内置监控任务已注册：离线检测（每30s）、心跳日志清理（每天3:00）、存量采集点履历清理（每天3:30）')

    @classmethod
    async def close_system_scheduler(cls) -> None:
        """
        应用关闭时关闭定时任务

        :return:
        """
        scheduler.shutdown()
        logger.info('✅️ 关闭定时任务成功')

    @classmethod
    def _import_function(cls, func_path: str) -> Callable[..., Any]:
        """
        动态导入函数

        :param func_path: 函数字符串，如module_task.scheduler_test.job
        :return: 导入的函数对象
        """
        module_path, func_name = func_path.rsplit('.', 1)
        module = importlib.import_module(module_path)
        return getattr(module, func_name)

    @classmethod
    def get_scheduler_job(cls, job_id: Union[str, int]) -> Job:
        """
        根据任务id获取任务对象

        :param job_id: 任务id
        :return: 任务对象
        """
        query_job = scheduler.get_job(job_id=str(job_id))

        return query_job

    @classmethod
    def add_scheduler_job(cls, job_info: JobModel) -> None:
        """
        根据输入的任务对象信息添加任务

        :param job_info: 任务对象信息
        :return:
        """
        job_func = cls._import_function(job_info.invoke_target)
        job_executor = job_info.job_executor
        if iscoroutinefunction(job_func):
            job_executor = 'default'
        scheduler.add_job(
            func=job_func,
            trigger=MyCronTrigger.from_crontab(job_info.cron_expression),
            args=job_info.job_args.split(',') if job_info.job_args else None,
            kwargs=json.loads(job_info.job_kwargs) if job_info.job_kwargs else None,
            id=str(job_info.job_id),
            name=job_info.job_name,
            misfire_grace_time=1000000000000 if job_info.misfire_policy == '3' else None,
            coalesce=job_info.misfire_policy == '2',
            max_instances=3 if job_info.concurrent == '0' else 1,
            jobstore=job_info.job_group,
            executor=job_executor,
        )

    @classmethod
    def execute_scheduler_job_once(cls, job_info: JobModel) -> None:
        """
        根据输入的任务对象执行一次任务

        :param job_info: 任务对象信息
        :return:
        """
        job_func = cls._import_function(job_info.invoke_target)
        job_executor = job_info.job_executor
        if iscoroutinefunction(job_func):
            job_executor = 'default'
        job_trigger = DateTrigger()
        if job_info.status == '0':
            job_trigger = OrTrigger(triggers=[DateTrigger(), MyCronTrigger.from_crontab(job_info.cron_expression)])
        scheduler.add_job(
            func=job_func,
            trigger=job_trigger,
            args=job_info.job_args.split(',') if job_info.job_args else None,
            kwargs=json.loads(job_info.job_kwargs) if job_info.job_kwargs else None,
            id=str(job_info.job_id),
            name=job_info.job_name,
            misfire_grace_time=1000000000000 if job_info.misfire_policy == '3' else None,
            coalesce=job_info.misfire_policy == '2',
            max_instances=3 if job_info.concurrent == '0' else 1,
            jobstore=job_info.job_group,
            executor=job_executor,
        )

    @classmethod
    def remove_scheduler_job(cls, job_id: Union[str, int]) -> None:
        """
        根据任务id移除任务

        :param job_id: 任务id
        :return:
        """
        query_job = cls.get_scheduler_job(job_id=job_id)
        if query_job:
            scheduler.remove_job(job_id=str(job_id))

    @classmethod
    def scheduler_event_listener(cls, event: SchedulerEvent) -> None:
        """调度器事件监听（不阻塞 event loop）

        同步 DB 写入通过 asyncio.get_event_loop().run_in_executor 扔到线程池，
        避免 SessionLocal 的同步 I/O 阻塞 MQTT PINGREQ 等异步任务。
        """
        import asyncio

        # 获取事件类型和任务ID
        event_type = event.__class__.__name__
        # 获取任务执行异常信息
        status = '0'
        exception_info = ''
        if event_type == 'JobExecutionEvent' and event.exception:
            exception_info = str(event.exception)
            status = '1'
        if hasattr(event, 'job_id'):
            job_id = event.job_id
            query_job = cls.get_scheduler_job(job_id=job_id)
            if query_job:
                query_job_info = query_job.__getstate__()
                # 获取任务名称
                job_name = query_job_info.get('name')
                # 获取任务组名
                job_group = query_job._jobstore_alias
                # 获取任务执行器
                job_executor = query_job_info.get('executor')
                # 获取调用目标字符串
                invoke_target = query_job_info.get('func')
                # 获取调用函数位置参数
                job_args = ','.join(query_job_info.get('args'))
                # 获取调用函数关键字参数
                job_kwargs = json.dumps(query_job_info.get('kwargs'))
                # 获取任务触发器
                job_trigger = str(query_job_info.get('trigger'))
                # 构造日志消息
                job_message = f'事件类型: {event_type}, 任务ID: {job_id}, 任务名称: {job_name}, 执行于{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}'
                job_log = JobLogModel(
                    jobName=job_name,
                    jobGroup=job_group,
                    jobExecutor=job_executor,
                    invokeTarget=invoke_target,
                    jobArgs=job_args,
                    jobKwargs=job_kwargs,
                    jobTrigger=job_trigger,
                    jobMessage=job_message,
                    status=status,
                    exceptionInfo=exception_info,
                    createTime=datetime.now(),
                )

                # 同步 DB 写入扔到线程池，不阻塞 event loop
                try:
                    loop = asyncio.get_running_loop()
                    loop.run_in_executor(None, cls._write_job_log_sync, job_log)
                except RuntimeError:
                    # fallback：无运行中的 event loop 时直接同步写入
                    cls._write_job_log_sync(job_log)

    @staticmethod
    def _write_job_log_sync(job_log: 'JobLogModel') -> None:
        """同步写入任务日志（在线程池中执行）"""
        session = SessionLocal()
        try:
            JobLogService.add_job_log_services(session, job_log)
        except Exception:
            logger.exception('任务日志写入失败')  # 不向上抛出，避免影响调度器，但必须留痕
        finally:
            session.close()
