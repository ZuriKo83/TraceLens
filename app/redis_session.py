from __future__ import annotations

import secrets
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, URLSafeSerializer
from redis.asyncio import Redis

from app.community import router as community_router


community_app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
community_app.mount("/static", StaticFiles(directory=Path(__file__).resolve().parent / "static"), name="static")
community_app.include_router(community_router)


class RedisSessionMiddleware:
    def __init__(self, app, redis_url: str, secret_key: str, *, cookie_name: str = "tracelens_session", max_age: int = 2592000, https_only: bool = False, same_site: str = "lax", prefix: str = "session:"):
        self.app = app
        self.redis = Redis.from_url(redis_url, decode_responses=True)
        self.serializer = URLSafeSerializer(secret_key, salt="tracelens-session")
        self.cookie_name = cookie_name
        self.max_age = max_age
        self.https_only = https_only
        self.same_site = same_site
        self.prefix = prefix

    async def __call__(self, scope: dict[str, Any], receive, send) -> None:
        scope_type = scope.get("type")
        if scope_type not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        cookie = SimpleCookie()
        cookie.load(headers.get("cookie", ""))
        sid = None
        if self.cookie_name in cookie:
            try:
                sid = self.serializer.loads(cookie[self.cookie_name].value)
            except BadSignature:
                sid = None
        if not isinstance(sid, str) or len(sid) < 20:
            sid = secrets.token_urlsafe(32)

        key = f"{self.prefix}{sid}"
        session: dict[str, Any] = {}
        try:
            raw = await self.redis.hgetall(key)
            session = dict(raw or {})
            if "user_id" in session:
                try:
                    session["user_id"] = int(session["user_id"])
                except (TypeError, ValueError):
                    session.pop("user_id", None)
        except Exception:
            session = {}
        scope["session"] = session

        async def send_wrapper(message):
            if scope_type == "http" and message["type"] == "http.response.start":
                try:
                    if session:
                        await self.redis.delete(key)
                        await self.redis.hset(key, mapping={k: str(v) for k, v in session.items()})
                        await self.redis.expire(key, self.max_age)
                    else:
                        await self.redis.delete(key)
                except Exception:
                    pass
                signed = self.serializer.dumps(sid)
                parts = [f"{self.cookie_name}={signed}", "Path=/", "HttpOnly", f"Max-Age={self.max_age}", f"SameSite={self.same_site.capitalize()}"]
                if self.https_only:
                    parts.append("Secure")
                message.setdefault("headers", []).append((b"set-cookie", "; ".join(parts).encode("latin-1")))
            await send(message)

        target_app = community_app if scope.get("path", "").startswith("/community") else self.app
        await target_app(scope, receive, send_wrapper)
