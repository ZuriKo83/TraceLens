from __future__ import annotations

from fastapi import HTTPException, Request
from redis import Redis

from app.config import get_settings

settings = get_settings()
redis_client = Redis.from_url(settings.redis_url, decode_responses=True)


def client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    return forwarded or (request.client.host if request.client else "unknown")


def enforce_rate_limit(scope: str, identity: str, limit: int, window_seconds: int) -> None:
    if limit <= 0:
        return
    key = f"ratelimit:{scope}:{identity}"
    try:
        current = redis_client.incr(key)
        if current == 1:
            redis_client.expire(key, window_seconds)
        if current > limit:
            ttl = max(redis_client.ttl(key), 1)
            raise HTTPException(429, f"요청이 너무 많습니다. {ttl}초 후 다시 시도하세요.", headers={"Retry-After": str(ttl)})
    except HTTPException:
        raise
    except Exception:
        # Redis 장애가 인증·수집 전체 장애로 번지지 않도록 제한 기능만 우회합니다.
        return
