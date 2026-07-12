from __future__ import annotations

import logging
import secrets
from datetime import timedelta, timezone

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from redis import Redis
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import account_admin_hardened
from app.account_admin import (
    cooldown_until,
    csrf_token,
    create_signup_code,
    hash_password,
    hash_token,
    normalize_email,
    require_csrf,
    send_code,
    validate_password,
)
from app.config import get_settings
from app.db import get_db
from app.models import User, UserEmail, VerificationCode, utcnow

logger = logging.getLogger(__name__)
settings = get_settings()
templates = Jinja2Templates(directory="app/templates")
router = APIRouter()
redis_client = Redis.from_url(settings.redis_url, decode_responses=True)

GENERIC_REQUEST_MESSAGE = "입력한 이메일로 처리 가능한 경우 인증번호를 보냈습니다."


def _client_ip(request: Request) -> str:
    cf_ip = request.headers.get("cf-connecting-ip", "").strip()
    if cf_ip:
        return cf_ip
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    return forwarded or (request.client.host if request.client else "unknown")


def _incr_limit(key: str, ttl: int, limit: int) -> bool:
    count = int(redis_client.incr(key))
    if count == 1:
        redis_client.expire(key, ttl)
    return count <= limit


def _request_allowed(request: Request, email: str) -> tuple[bool, str | None]:
    email_hash = hash_token(email)
    ip = _client_ip(request)
    try:
        checks = (
            _incr_limit(f"rate:signup:email:60:{email_hash}", 60, 1),
            _incr_limit(f"rate:signup:email:3600:{email_hash}", 3600, 5),
            _incr_limit(f"rate:signup:email:86400:{email_hash}", 86400, 10),
            _incr_limit(f"rate:signup:ip:600:{ip}", 600, 5),
            _incr_limit(f"rate:signup:ip:3600:{ip}", 3600, 15),
            _incr_limit(f"rate:signup:ip:86400:{ip}", 86400, 50),
        )
        if not all(checks):
            logger.warning("Signup code request blocked ip=%s email_hash=%s", ip, email_hash[:12])
            return False, "인증번호 요청이 너무 많습니다. 잠시 후 다시 시도하세요."
        return True, None
    except Exception:
        logger.exception("Redis unavailable during signup request rate check")
        return False, "현재 인증 요청을 처리할 수 없습니다. 잠시 후 다시 시도하세요."


def _verify_allowed(request: Request, email: str) -> tuple[bool, str | None]:
    ip = _client_ip(request)
    email_hash = hash_token(email)
    try:
        if redis_client.exists(f"block:signup-verify:ip:{ip}"):
            return False, "인증 시도가 너무 많습니다. 30분 후 다시 시도하세요."
        if not _incr_limit(f"rate:signup-verify:ip:600:{ip}", 600, 20):
            redis_client.setex(f"block:signup-verify:ip:{ip}", 1800, "1")
            logger.warning("Signup verification IP blocked ip=%s email_hash=%s", ip, email_hash[:12])
            return False, "인증 시도가 너무 많습니다. 30분 후 다시 시도하세요."
        return True, None
    except Exception:
        logger.exception("Redis unavailable during signup verification rate check")
        return False, "현재 인증 요청을 처리할 수 없습니다. 잠시 후 다시 시도하세요."


def _record_verify_failure(request: Request, email: str) -> None:
    ip = _client_ip(request)
    try:
        failures = int(redis_client.incr(f"fail:signup-verify:ip:{ip}"))
        if failures == 1:
            redis_client.expire(f"fail:signup-verify:ip:{ip}", 1800)
        if failures >= 10:
            redis_client.setex(f"block:signup-verify:ip:{ip}", 1800, "1")
        logger.warning("Signup verification failed ip=%s email_hash=%s failures=%s", ip, hash_token(email)[:12], failures)
    except Exception:
        logger.exception("Failed to record signup verification failure")


def _clear_verify_failures(request: Request) -> None:
    try:
        redis_client.delete(f"fail:signup-verify:ip:{_client_ip(request)}")
    except Exception:
        logger.exception("Failed to clear signup verification failures")


def _cleanup_stale_signup_rows(db: Session) -> None:
    cutoff = utcnow() - timedelta(hours=24)
    db.execute(delete(VerificationCode).where(VerificationCode.created_at < cutoff))
    stale_users = list(db.scalars(select(User).where(
        User.is_verified.is_(False),
        User.deleted_at.is_(None),
        User.created_at < cutoff,
    )))
    for user in stale_users:
        db.delete(user)


def _render_signup(request: Request, *, email: str = "", error: str | None = None, message: str | None = None, rejoin_blocked: bool = False):
    return templates.TemplateResponse(
        request=request,
        name="signup.html",
        context={
            "request": request,
            "app_name": settings.app_name,
            "session_user": None,
            "csrf_token": csrf_token(request),
            "email": email,
            "error": error,
            "message": message,
            "rejoin_blocked": rejoin_blocked,
        },
    )


def _render_verify(request: Request, email: str, *, error: str | None = None, delivered: bool | None = None, dev_code: str | None = None):
    return templates.TemplateResponse(
        request=request,
        name="verify_code.html",
        context={
            "request": request,
            "app_name": settings.app_name,
            "session_user": None,
            "csrf_token": csrf_token(request),
            "email": email,
            "purpose": "signup",
            "error": error,
            "delivered": delivered,
            "dev_code": dev_code,
            "generic_message": GENERIC_REQUEST_MESSAGE,
        },
    )


@router.post("/auth/signup/request-code", response_class=HTMLResponse)
def secure_signup_request_code(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    password_confirm: str = Form(...),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
    require_csrf(request, csrf)
    try:
        normalized = normalize_email(email)
        validate_password(password)
        if password != password_confirm:
            raise ValueError("비밀번호 확인이 일치하지 않습니다.")
    except ValueError as exc:
        return _render_signup(request, email=email, error=str(exc))

    _cleanup_stale_signup_rows(db)
    db.commit()

    until = cooldown_until(db, normalized)
    if until:
        remaining = max(1, (until - utcnow()).days + 1)
        return _render_signup(
            request,
            email=normalized,
            error=f"회원탈퇴 후 7일 동안 재가입할 수 없습니다. 약 {remaining}일 후 다시 시도하거나 관리자 승인 코드를 이용하세요.",
            rejoin_blocked=True,
        )

    allowed, error = _request_allowed(request, normalized)
    if not allowed:
        return _render_signup(request, email=normalized, error=error)

    existing = db.scalar(select(User).where(User.email == normalized, User.deleted_at.is_(None)))
    if existing and existing.is_verified and existing.password_hash:
        logger.info("Generic signup response for existing account email_hash=%s", hash_token(normalized)[:12])
        return _render_verify(request, normalized, delivered=True)

    user = existing
    if user is None:
        user = User(email=normalized, is_verified=False, is_admin=False)
        db.add(user)
        db.flush()
        db.add(UserEmail(user_id=user.id, email=normalized, is_verified=False, is_primary=True))
    user.password_hash = hash_password(password)
    code = create_signup_code(db, user, normalized)
    db.commit()

    try:
        delivered = send_code(normalized, code)
    except Exception:
        logger.exception("Failed to send signup verification email email_hash=%s", hash_token(normalized)[:12])
        delivered = False

    request.session["pending_signup_email"] = normalized
    return _render_verify(
        request,
        normalized,
        delivered=delivered,
        dev_code=code if settings.debug_magic_links and not delivered else None,
    )


@router.post("/auth/signup/verify", response_class=HTMLResponse)
def secure_signup_verify(
    request: Request,
    email: str = Form(...),
    code: str = Form(...),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
    require_csrf(request, csrf)
    try:
        normalized = normalize_email(email)
    except ValueError as exc:
        return _render_signup(request, email=email, error=str(exc))

    allowed, error = _verify_allowed(request, normalized)
    if not allowed:
        return _render_verify(request, normalized, error=error)

    if cooldown_until(db, normalized):
        return _render_signup(request, email=normalized, error="회원탈퇴 후 7일 동안 재가입할 수 없습니다. 관리자 승인 코드를 이용하세요.", rejoin_blocked=True)

    user = db.scalar(select(User).where(User.email == normalized, User.deleted_at.is_(None)))
    record = db.scalar(select(VerificationCode).where(
        VerificationCode.user_id == user.id,
        VerificationCode.purpose == "signup",
        VerificationCode.used_at.is_(None),
    ).order_by(VerificationCode.created_at.desc())) if user else None

    verify_error = None
    if not user or not record:
        verify_error = "인증번호를 다시 요청하세요."
    else:
        expires = record.expires_at if record.expires_at.tzinfo else record.expires_at.replace(tzinfo=timezone.utc)
        if expires <= utcnow():
            verify_error = "인증번호가 만료되었습니다."
        elif record.attempts >= 5:
            record.used_at = utcnow()
            db.commit()
            verify_error = "인증 시도 횟수를 초과했습니다. 새 인증번호를 요청하세요."
        elif not secrets.compare_digest(record.code_hash, hash_token(code.strip())):
            record.attempts += 1
            if record.attempts >= 5:
                record.used_at = utcnow()
            db.commit()
            verify_error = "인증번호가 올바르지 않습니다."

    if verify_error:
        _record_verify_failure(request, normalized)
        return _render_verify(request, normalized, error=verify_error)

    record.used_at = utcnow()
    user.is_verified = True
    user.is_admin = normalized in settings.admin_email_set
    user.last_login_at = utcnow()
    email_row = db.scalar(select(UserEmail).where(UserEmail.email == normalized))
    if email_row:
        email_row.is_verified = True
        email_row.verified_at = utcnow()
    db.commit()

    _clear_verify_failures(request)
    request.session.clear()
    request.session["user_id"] = user.id
    request.session["csrf_token"] = secrets.token_urlsafe(24)
    return RedirectResponse("/app", status_code=303)


# Secure routes are registered first. Remaining admin and approved-signup routes
# are inherited from the hardened router.
router.include_router(account_admin_hardened.router)
