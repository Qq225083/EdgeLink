"""存量采集点健康监控 — 内置后台任务

与 V12 的 monitor_task.py 并列，负责存量采集点心跳履历的定期清理，
防止 site_health_heartbeat_log 表无限膨胀。
"""
from sqlalchemy.exc import SQLAlchemyError

from config.database import AsyncSessionLocal
from module_site_health.dao.site_health_dao import SiteHealthDao
from utils.log_util import logger


async def clean_site_health_heartbeat_logs_task() -> None:
    """每天凌晨清理超过 7 天的存量采集点心跳履历。"""
    async with AsyncSessionLocal() as db:
        try:
            count = await SiteHealthDao.clean_old_heartbeat_logs(db, retention_days=7)
            if count:
                logger.info(f'存量采集点履历清理完成：删除 {count} 条过期记录')
            await db.commit()
        except SQLAlchemyError as exc:
            await db.rollback()
            logger.error(f'存量采集点履历清理任务 DB 异常（下周期重试）：{exc}')
        except Exception:
            await db.rollback()
            logger.exception('存量采集点履历清理任务出现未预期异常')
