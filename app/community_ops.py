from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from redis import Redis
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.community_models import CommunityAuditLog, CommunityChatMessage, CommunityUserRestriction
from app.config import get_settings
from app.db import engine, get_db
from app.models import User

router = APIRouter(prefix="/community", tags=["community-ops"])
templates = Jinja2Templates(directory="app/templates")
settings = get_settings()


def _user(request: Request, db: Session) -> User | None:
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    user = db.get(User, int(user_id))
    if user is None or user.deleted_at is not None or not user.is_verified:
        return None
    return user


@router.get("/health")
def community_health(request: Request, db: Session = Depends(get_db)):
    user = _user(request, db)
    if user is None:
        return JSONResponse({"ok": False, "detail": "로그인이 필요합니다."}, status_code=401)

    checks: dict[str, object] = {"database": False, "redis": False, "session": True}
    errors: dict[str, str] = {}
    try:
        db.execute(text("SELECT 1"))
        checks["database"] = True
        checks["chat_messages"] = db.scalar(select(func.count(CommunityChatMessage.id))) or 0
    except Exception as exc:
        errors["database"] = type(exc).__name__

    try:
        redis = Redis.from_url(settings.redis_url, socket_connect_timeout=2, socket_timeout=2)
        checks["redis"] = bool(redis.ping())
        redis.close()
    except Exception as exc:
        errors["redis"] = type(exc).__name__

    ok = bool(checks["database"] and checks["redis"])
    return JSONResponse({"ok": ok, "checks": checks, "errors": errors}, status_code=200 if ok else 503)


@router.get("/admin/audit", response_class=HTMLResponse)
def community_audit_page(request: Request, db: Session = Depends(get_db)):
    user = _user(request, db)
    if user is None:
        return RedirectResponse("/login?next=/community/admin/audit", status_code=303)
    if not user.is_admin:
        raise HTTPException(403)

    logs = list(db.scalars(select(CommunityAuditLog).order_by(CommunityAuditLog.created_at.desc()).limit(300)))
    restrictions = list(db.scalars(select(CommunityUserRestriction).order_by(CommunityUserRestriction.updated_at.desc()).limit(200)))
    return templates.TemplateResponse(
        request=request,
        name="community/audit.html",
        context={
            "request": request,
            "app_name": settings.app_name,
            "session_user": user,
            "csrf_token": request.session.get("csrf_token", ""),
            "logs": logs,
            "restrictions": restrictions,
        },
    )
