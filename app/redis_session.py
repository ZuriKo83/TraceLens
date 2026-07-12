from __future__ import annotations

import secrets
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, URLSafeSerializer
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.account_admin import AccountDeletionHistory, router as account_admin_router
from app.community import router as community_router
from app.community_admin import router as community_admin_router
from app.community_ops import router as community_ops_router
from app.community_models import CommunityUserRestriction
from app.community_schema import ensure_community_schema
from app.db import Base, engine
from app.models import User, utcnow


community_app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
community_app.mount("/static", StaticFiles(directory=Path(__file__).resolve().parent / "static"), name="static")
community_app.include_router(community_admin_router)
community_app.include_router(community_ops_router)
community_app.include_router(community_router)

account_tools_app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
account_tools_app.mount("/static", StaticFiles(directory=Path(__file__).resolve().parent / "static"), name="static")
account_tools_app.include_router(account_admin_router)

ACCOUNT_TOOL_PATHS = {
    "/auth/signup/request-code",
    "/auth/signup/verify",
    "/admin/users",
    "/admin/access-codes",
    "/admin-invite",
}


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
        ensure_community_schema()
        Base.metadata.create_all(engine)

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

        path = scope.get("path", "")
        user_id = session.get("user_id")

        if path == "/app/account/emails":
            response = PlainTextResponse("추가 이메일 연결 기능은 지원하지 않습니다.", status_code=404)
            await response(scope, receive, send)
            return

        deleted_account_snapshot: tuple[int, str] | None = None
        if path == "/app/account/delete" and scope_type == "http" and scope.get("method") == "POST" and user_id:
            with Session(engine) as db:
                user = db.get(User, int(user_id))
                if user and user.deleted_at is None:
                    deleted_account_snapshot = (user.id, user.email)

        if user_id and path.startswith("/community"):
            with Session(engine) as db:
                restriction = db.scalar(select(CommunityUserRestriction).where(CommunityUserRestriction.user_id == int(user_id)))
            if restriction is not None:
                now = utcnow()
                chat_blocked = restriction.chat_blocked_until is not None and restriction.chat_blocked_until > now
                community_blocked = restriction.community_blocked_until is not None and restriction.community_blocked_until > now
                is_chat_write = path.startswith("/community/chat") and (scope_type == "websocket" or scope.get("method") == "POST")
                is_community_write = scope_type == "http" and scope.get("method") == "POST" and not path.startswith("/community/admin")
                if (chat_blocked and is_chat_write) or (community_blocked and is_community_write):
                    if scope_type == "websocket":
                        await send({"type": "websocket.close", "code": 4403, "reason": "이용이 제한되었습니다."})
                    else:
                        response = PlainTextResponse("커뮤니티 이용이 일시적으로 제한되었습니다.", status_code=403)
                        await response(scope, receive, send)
                    return

        async def send_wrapper(message):
            if scope_type == "http" and message["type"] == "http.response.start":
                if deleted_account_snapshot and 300 <= int(message.get("status", 0)) < 400:
                    old_user_id, old_email = deleted_account_snapshot
                    try:
                        with Session(engine) as db:
                            user = db.get(User, old_user_id)
                            exists = db.scalar(select(AccountDeletionHistory).where(AccountDeletionHistory.user_id == old_user_id).order_by(AccountDeletionHistory.deleted_at.desc()))
                            if user and user.deleted_at is not None and (exists is None or exists.email != old_email):
                                db.add(AccountDeletionHistory(user_id=old_user_id, email=old_email, deleted_at=user.deleted_at))
                                db.commit()
                    except Exception:
                        pass
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

        if path.startswith("/community"):
            target_app = community_app
        elif path in ACCOUNT_TOOL_PATHS:
            target_app = account_tools_app
        else:
            target_app = self.app
        await target_app(scope, receive, send_wrapper)