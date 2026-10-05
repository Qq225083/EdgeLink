"""一次性 SQL 迁移执行器（凭证由后端自身配置加载，不经手明文）。

用法：APP_ENV=dev .venv/Scripts/python.exe scripts/run_sql_file.py <sql文件路径>
行为：按分号切分语句逐条执行；ALTER 重复列错误降级为警告（防误重跑炸断）；
     其余错误立即中止并报告。
"""
import asyncio
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import text

from config.database import async_engine


def split_statements(sql_text: str) -> list[str]:
    """按分号切分（本项目的迁移 SQL 无存储过程/触发器，简单切分即可），剔除纯注释块。"""
    # 去掉 -- 行注释，避免注释里的分号干扰
    lines = [ln for ln in sql_text.split('\n') if not ln.strip().startswith('--')]
    cleaned = '\n'.join(lines)
    return [s.strip() for s in cleaned.split(';') if s.strip()]


async def main(sql_path: str) -> None:
    sql_text = Path(sql_path).read_text(encoding='utf-8')
    statements = split_statements(sql_text)
    print(f'共 {len(statements)} 条语句待执行')

    cfg_note = 'engine: config.database.async_engine（凭证由后端 .env 自行加载）'
    print(cfg_note)
    try:
        async with async_engine.begin() as conn:
            for i, stmt in enumerate(statements, 1):
                head = re.sub(r'\s+', ' ', stmt)[:70]
                try:
                    await conn.execute(text(stmt))
                    print(f'[{i}/{len(statements)}] OK  {head}...')
                except Exception as e:
                    msg = str(e)
                    if 'Duplicate column' in msg or 'Duplicate key name' in msg:
                        print(f'[{i}/{len(statements)}] SKIP(已存在)  {head}...')
                    else:
                        print(f'[{i}/{len(statements)}] FAIL  {head}...\n  错误: {msg[:300]}')
                        raise
    finally:
        await async_engine.dispose()
    print('迁移执行完毕。')


if __name__ == '__main__':
    # 用环境变量传参：config.env 的 parse_cli_args 会劫持 sys.argv
    sql_file = os.environ.get('SQL_FILE')
    if not sql_file:
        print('用法: SQL_FILE=<sql路径> python scripts/run_sql_file.py')
        sys.exit(1)
    asyncio.run(main(sql_file))
