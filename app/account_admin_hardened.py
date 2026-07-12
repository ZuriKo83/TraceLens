from __future__ import annotations

import secrets
from datetime import timedelta, timezone

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from redis import Redis
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.account_admin import (
    ADMIN_CODE_MINUTES,
    AccountDeletionHistory,
    AdminAccessCode,
    cooldown_until,
    csrf_token,
    create_signup_code,
    hash_password,
    hash_token,
    normalize_email,
    require_admin,
    require_csrf,
    send_code,
    validate_password,
)
from app.config import get_settings
from app.db import get_db
from app.models import User, UserEmail, VerificationCode, utcnow

settings = get_settings()
templates = Jinja2Templates(directory="app/templates")
router = APIRouter()
redis_client = Redis.from_url(settings.redis_url, decode_responses=True)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    return forwarded or (request.client.host if request.client else "unknown")


def _allow_signup_code_request(request: Request, email: str) -> bool:
    """Limit one request per email/minute and five requests per IP/10 minutes."""
    try:
        email_key = f"rate:signup-code:email:{hash_token(email)}"
        ip_key = f"rate:signup-code:ip:{_client_ip(request)}"
        email_count = int(redis_client.incr(email_key))
        if email_count == 1:
            redis_client.expire(email_key, 60)
        ip_count = int(redis_client.incr(ip_key))
        if ip_count == 1:
            redis_client.expire(ip_key, 600)
        return email_count <= 1 and ip_count <= 5
    except Exception:
        return True


def _render_signup(request: Request, *, email: str = "", error: str | None = None, rejoin_blocked: bool = False):
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
            "rejoin_blocked": rejoin_blocked,
        },
    )


@router.post("/auth/signup/request-code", response_class=HTMLResponse)
def signup_request_code(
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

    until = cooldown_until(db, normalized)
    if until:
        remaining = max(1, (until - utcnow()).days + 1)
        return _render_signup(
            request,
            email=normalized,
            error=f"회원탈퇴 후 7일 동안 재가입할 수 없습니다. 약 {remaining}일 후 다시 시도하거나 관리자 승인 코드를 이용하세요.",
            rejoin_blocked=True,
        )

    if not _allow_signup_code_request(request, normalized):
        return _render_signup(request, email=normalized, error="인증번호 요청이 너무 많습니다. 잠시 후 다시 시도하세요.")

    existing = db.scalar(select(User).where(User.email == normalized, User.deleted_at.is_(None)))
    if existing and existing.is_verified and existing.password_hash:
        return _render_signup(request, email=normalized, error="이미 가입된 이메일입니다. 로그인하세요.")

    user = existing
    if user is None:
        user = User(email=normalized, is_verified=False, is_admin=False)
        db.add(user)
        db.flush()
        db.add(UserEmail(user_id=user.id, email=normalized, is_verified=False, is_primary=True))
    user.password_hash = hash_password(password)
    code = create_signup_code(db, user, normalized)
    try:
        delivered = send_code(normalized, code)
    except Exception:
        delivered = False
    db.commit()
    request.session["pending_signup_email"] = normalized
    return templates.TemplateResponse(
        request=request,
        name="verify_code.html",
        context={
            "request": request,
            "app_name": settings.app_name,
            "session_user": None,
            "csrf_token": csrf_token(request),
            "email": normalized,
            "purpose": "signup",
            "delivered": delivered,
            "dev_code": code if settings.debug_magic_links and not delivered else None,
        },
    )


@router.post("/auth/signup/verify", response_class=HTMLResponse)
def signup_verify(request: Request, email: str = Form(...), code: str = Form(...), csrf: str = Form(...), db: Session = Depends(get_db)):
    require_csrf(request, csrf)
    try:
        normalized = normalize_email(email)
    except ValueError as exc:
        return _render_signup(request, email=email, error=str(exc))
    if cooldown_until(db, normalized):
        return _render_signup(request, email=normalized, error="회원탈퇴 후 7일 동안 재가입할 수 없습니다. 관리자 승인 코드를 이용하세요.", rejoin_blocked=True)
    user = db.scalar(select(User).where(User.email == normalized, User.deleted_at.is_(None)))
    record = db.scalar(select(VerificationCode).where(VerificationCode.user_id == user.id, VerificationCode.purpose == "signup", VerificationCode.used_at.is_(None)).order_by(VerificationCode.created_at.desc())) if user else None
    error = None
    if not user or not record:
        error = "인증번호를 다시 요청하세요."
    else:
        expires = record.expires_at if record.expires_at.tzinfo else record.expires_at.replace(tzinfo=timezone.utc)
        if expires <= utcnow():
            error = "인증번호가 만료되었습니다."
        elif not secrets.compare_digest(record.code_hash, hash_token(code.strip())):
            error = "인증번호가 올바르지 않습니다."
    if error:
        return templates.TemplateResponse(request=request, name="verify_code.html", context={"request": request, "app_name": settings.app_name, "session_user": None, "csrf_token": csrf_token(request), "email": normalized, "purpose": "signup", "error": error})
    record.used_at = utcnow()
    user.is_verified = True
    user.is_admin = normalized in settings.admin_email_set
    user.last_login_at = utcnow()
    email_row = db.scalar(select(UserEmail).where(UserEmail.email == normalized))
    if email_row:
        email_row.is_verified = True
        email_row.verified_at = utcnow()
    db.commit()
    request.session.clear()
    request.session["user_id"] = user.id
    request.session["csrf_token"] = secrets.token_urlsafe(24)
    return RedirectResponse("/app", status_code=303)


@router.get("/admin/users", response_class=HTMLResponse)
def admin_users(request: Request, q: str = "", page: int = 1, db: Session = Depends(get_db)):
    admin = require_admin(request, db)
    if isinstance(admin, RedirectResponse):
        return admin
    page = max(1, page)
    per_page = 50
    history_email = select(AccountDeletionHistory.email).where(AccountDeletionHistory.user_id == User.id).order_by(AccountDeletionHistory.deleted_at.desc()).limit(1).scalar_subquery()
    filters = []
    if q.strip():
        term = q.strip()
        conditions = [User.email.ilike(f"%{term}%"), history_email.ilike(f"%{term}%")]
        if term.isdigit():
            conditions.append(User.id == int(term))
        filters.append(or_(*conditions))
    total = db.scalar(select(func.count(User.id)).where(*filters)) or 0
    total_pages = max(1, (total + per_page - 1) // per_page)
    page = min(page, total_pages)
    users = list(db.scalars(select(User).where(*filters).order_by(User.id.desc()).limit(per_page).offset((page - 1) * per_page)))
    deleted_emails: dict[int, str] = {}
    for row in db.scalars(select(AccountDeletionHistory).order_by(AccountDeletionHistory.deleted_at.desc())):
        deleted_emails.setdefault(row.user_id, row.email)
    return templates.TemplateResponse(request=request, name="admin_users.html", context={"request": request, "app_name": settings.app_name, "session_user": admin, "csrf_token": csrf_token(request), "users": users, "deleted_emails": deleted_emails, "q": q, "page": page, "total_pages": total_pages, "total": total})


@router.get("/admin/access-codes", response_class=HTMLResponse)
def access_code_page(request: Request, db: Session = Depends(get_db)):
    admin = require_admin(request, db)
    if isinstance(admin, RedirectResponse):
        return admin
    recent = list(db.scalars(select(AdminAccessCode).order_by(AdminAccessCode.created_at.desc()).limit(50)))
    return templates.TemplateResponse(request=request, name="admin_access_codes.html", context={"request": request, "app_name": settings.app_name, "session_user": admin, "csrf_token": csrf_token(request), "recent": recent})


@router.post("/admin/access-codes", response_class=HTMLResponse)
def create_access_code(request: Request, email: str = Form(...), csrf: str = Form(...), db: Session = Depends(get_db)):
    admin = require_admin(request, db)
    if isinstance(admin, RedirectResponse):
        return admin
    require_csrf(request, csrf)
    try:
        normalized = normalize_email(email)
    except ValueError as exc:
        recent = list(db.scalars(select(AdminAccessCode).order_by(AdminAccessCode.created_at.desc()).limit(50)))
        return templates.TemplateResponse(request=request, name="admin_access_codes.html", context={"request": request, "app_name": settings.app_name, "session_user": admin, "csrf_token": csrf_token(request), "recent": recent, "error": str(exc)})
    if db.scalar(select(User).where(User.email == normalized, User.deleted_at.is_(None))):
        error = "현재 사용 중인 계정에는 승인 코드를 발급할 수 없습니다."
    elif cooldown_until(db, normalized) is None:
        error = "최근 7일 이내 탈퇴한 이메일에만 승인 코드를 발급할 수 있습니다."
    else:
        error = None
    if error:
        recent = list(db.scalars(select(AdminAccessCode).order_by(AdminAccessCode.created_at.desc()).limit(50)))
        return templates.TemplateResponse(request=request, name="admin_access_codes.html", context={"request": request, "app_name": settings.app_name, "session_user": admin, "csrf_token": csrf_token(request), "recent": recent, "error": error})
    db.execute(delete(AdminAccessCode).where(AdminAccessCode.email == normalized, AdminAccessCode.used_at.is_(None)))
    code = f"{secrets.randbelow(1_000_000):06d}"
    db.add(AdminAccessCode(email=normalized, code_hash=hash_token(code), created_by=admin.id, expires_at=utcnow() + timedelta(minutes=ADMIN_CODE_MINUTES)))
    db.commit()
    recent = list(db.scalars(select(AdminAccessCode).order_by(AdminAccessCode.created_at.desc()).limit(50)))
    return templates.TemplateResponse(request=request, name="admin_access_codes.html", context={"request": request, "app_name": settings.app_name, "session_user": admin, "csrf_token": csrf_token(request), "recent": recent, "generated_email": normalized, "generated_code": code})


@router.get("/admin-invite", response_class=HTMLResponse)
def approved_signup_page(request: Request, db: Session = Depends(get_db)):
    return templates.TemplateResponse(request=request, name="admin_invite.html", context={"request": request, "app_name": settings.app_name, "session_user": None, "csrf_token": csrf_token(request)})


@router.post("/admin-invite", response_class=HTMLResponse)
def approved_signup_verify(request: Request, email: str = Form(...), code: str = Form(...), password: str = Form(...), password_confirm: str = Form(...), csrf: str = Form(...), db: Session = Depends(get_db)):
    require_csrf(request, csrf)
    try:
        normalized = normalize_email(email)
        validate_password(password)
        if password != password_confirm:
            raise ValueError("비밀번호 확인이 일치하지 않습니다.")
    except ValueError as exc:
        return templates.TemplateResponse(request=request, name="admin_invite.html", context={"request": request, "app_name": settings.app_name, "session_user": None, "csrf_token": csrf_token(request), "email": email, "error": str(exc)})
    if db.scalar(select(User).where(User.email == normalized, User.deleted_at.is_(None))):
        error = "이미 사용 중인 계정입니다. 로그인하거나 비밀번호 재설정을 이용하세요."
        return templates.TemplateResponse(request=request, name="admin_invite.html", context={"request": request, "app_name": settings.app_name, "session_user": None, "csrf_token": csrf_token(request), "email": normalized, "error": error})
    if cooldown_until(db, normalized) is None:
        error = "관리자 승인 재가입 대상이 아닙니다."
        return templates.TemplateResponse(request=request, name="admin_invite.html", context={"request": request, "app_name": settings.app_name, "session_user": None, "csrf_token": csrf_token(request), "email": normalized, "error": error})
    record = db.scalar(select(AdminAccessCode).where(AdminAccessCode.email == normalized, AdminAccessCode.used_at.is_(None)).order_by(AdminAccessCode.created_at.desc()))
    error = None
    if not record:
        error = "유효한 관리자 승인 코드가 없습니다."
    else:
        expires = record.expires_at if record.expires_at.tzinfo else record.expires_at.replace(tzinfo=timezone.utc)
        if expires <= utcnow():
            error = "인증번호가 만료되었습니다."
        elif not secrets.compare_digest(record.code_hash, hash_token(code.strip())):
            error = "인증번호가 올바르지 않습니다."
    if error:
        return templates.TemplateResponse(request=request, name="admin_invite.html", context={"request": request, "app_name": settings.app_name, "session_user": None, "csrf_token": csrf_token(request), "email": normalized, "error": error})
    user = User(email=normalized, is_verified=True, is_admin=normalized in settings.admin_email_set, password_hash=hash_password(password), last_login_at=utcnow())
    db.add(user)
    db.flush()
    db.add(UserEmail(user_id=user.id, email=normalized, is_verified=True, is_primary=True, verified_at=utcnow()))
    record.used_at = utcnow()
    db.commit()
    request.session.clear()
    request.session["user_id"] = user.id
    request.session["csrf_token"] = secrets.token_urlsafe(24)
    return RedirectResponse("/app", status_code=303)
