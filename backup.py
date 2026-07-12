from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from app.config import get_settings

settings = get_settings()
backup_dir = Path(settings.backup_dir)
backup_dir.mkdir(parents=True, exist_ok=True)
stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')


def backup_sqlite(url: str) -> Path:
    source = Path(url.removeprefix('sqlite:///'))
    target = backup_dir / f'tracelens-{stamp}.db'
    with sqlite3.connect(source) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
    return target


def backup_postgres(url: str) -> Path:
    target = backup_dir / f'tracelens-{stamp}.dump'
    env = os.environ.copy()
    parsed = urlparse(url.replace('postgresql+psycopg://', 'postgresql://'))
    if parsed.password:
        env['PGPASSWORD'] = parsed.password
    command = [
        'pg_dump', '--format=custom', '--no-owner', '--no-privileges',
        '--host', parsed.hostname or '127.0.0.1', '--port', str(parsed.port or 5432),
        '--username', parsed.username or 'postgres', '--file', str(target),
        parsed.path.lstrip('/'),
    ]
    subprocess.run(command, check=True, env=env)
    return target


def cleanup_old_backups() -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.backup_retention_days)
    for item in backup_dir.glob('tracelens-*'):
        modified = datetime.fromtimestamp(item.stat().st_mtime, timezone.utc)
        if modified < cutoff:
            item.unlink(missing_ok=True)


if __name__ == '__main__':
    if settings.database_url.startswith('sqlite'):
        result = backup_sqlite(settings.database_url)
    elif settings.database_url.startswith('postgresql'):
        result = backup_postgres(settings.database_url)
    else:
        raise SystemExit('지원하지 않는 DATABASE_URL입니다.')
    cleanup_old_backups()
    print(f'Backup created: {result}')
