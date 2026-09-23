from __future__ import annotations

import json
import os
from pathlib import Path

import psutil
from redis import Redis
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import engine

settings = get_settings()
redis_client = Redis.from_url(settings.redis_url, decode_responses=True)

status = {
    'cpu_percent': psutil.cpu_percent(interval=1),
    'memory_percent': psutil.virtual_memory().percent,
    'disk_percent': psutil.disk_usage(str(Path.cwd())).percent,
    'queue_length': None,
    'redis_ok': False,
    'database_ok': False,
    'database_size_bytes': None,
    'recent_error_count': int(redis_client.get('metrics:errors:5m') or 0) if redis_client.ping() else None,
}
try:
    status['redis_ok'] = bool(redis_client.ping())
    status['queue_length'] = redis_client.llen(f'rq:queue:{settings.queue_name}')
except Exception:
    pass
try:
    with Session(engine) as db:
        db.execute(text('SELECT 1'))
        status['database_ok'] = True
        if settings.database_url.startswith('postgresql'):
            status['database_size_bytes'] = db.execute(text('SELECT pg_database_size(current_database())')).scalar_one()
        elif settings.database_url.startswith('sqlite'):
            path = Path(settings.database_url.removeprefix('sqlite:///'))
            status['database_size_bytes'] = path.stat().st_size if path.exists() else 0
except Exception:
    pass
print(json.dumps(status, ensure_ascii=False, indent=2))
