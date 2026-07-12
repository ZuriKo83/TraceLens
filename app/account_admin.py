from __future__ import annotations

import hashlib
import re
import secrets
import smtplib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, func, or_, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.config import get_settings
from app.db import Base, get_db
from app.models import User, UserEmail, VerificationCode, utcnow

settings = get_settings()
templates = Jinja2Templates(directory="app/templates")
router = APIRouter()
REJOIN_COOLDOWN_DAYS = 7
ADMIN_CODE_MINUTES = 5


class AccountDeletionHistory(Base):
    __tablename__ = "account_deletion_history"
    __table_args__ = (Index("ix_account_deletion_email_deleted", "email", "deleted_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    deleted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class AdminAccessCode(Base):
    __tablename__ = "admin_access_codes"
    __table_args__ = (Index("ix_admin_access_email_created", "email", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 320:
        raise ValueError("올바른 이메일 주소를 입력하세요.")
    return email


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${derived.hex()}"


def validate_password(password: str) -> None:
    if len(password) < 10 or len(password) > 128:
        raise ValueError("비밀번호는 10자 이상 128자 이하로 입력하세요.")
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        raise ValueError("비밀번호에는 영문과 숫자를 모두 포함하세요.")


def current_admin(request: Request, db: Session) -> User | None:
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    user = db.get(User, int(user_id))
    return user if user and user.deleted_at is None and user.is_verified and user.is_admin else None


def require_admin(request: Request, db: Session) -> User | RedirectResponse:
    admin = current_admin(request, db)
    return admin if admin else RedirectResponse("/login?next=/admin/users", status_code=303)


def csrf_token(request: Request) -> str:
    token = request.session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(24)
        request.session["csrf_token"] = token
    return token


def require_csrf(request: Request, supplied: str) -> None:
    expected = request.session.get("csrf_token")
    if not expected or not secrets.compare_digest(expected, supplied or ""):
        raise HTTPException(400, "요청 검증에 실패했습니다.")


def last_deletion(db: Session, email: str) -> AccountDeletionHistory | None:
    return db.scalar(select(AccountDeletionHistory).where(AccountDeletionHistory.email == email).order_by(AccountDeletionHistory.deleted_at.desc()))


def cooldown_until(db: Session, email: str) -> datetime | None:
    record = last_deletion(db, email)
    if not record:
        return None
    deleted_at = record.deleted_at if record.deleted_at.tzinfo else record.deleted_at.replace(tzinfo=timezone.utc)
    until = deleted_at + timedelta(days=REJOIN_COOLDOWN_DAYS)
    return until if until > utcnow() else None


def send_code(recipient: str, code: str) -> bool:
    if not settings.smtp_host or not settings.smtp_from:
        return False
    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = recipient
    message["Subject"] = "TraceLens 관리자 승인 인증번호"
    message.set_content(f"관리자가 발급한 인증번호는 {code}입니다.\n\n인증번호는 5분 동안 유효합니다.")
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as smtp:
        if settings.smtp_starttls:
            smtp.starttls()
        if settings.smtp_username:
            smtp.login(settings.smtp_username, settings.smtp_password)
        smtp.send_message(message)
    return True


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
    deleted_emails = {row.user_id: row.email for row in db.scalars(select(AccountDeletionHistory).order_by(AccountDeletionHistory.deleted_at.desc())) if row.user_id not in locals().get('deleted_emails', {})}
    return templates.TemplateResponse(request=request, name="admin_users.html", context={
        "request": request, "app_name": settings.app_name, "session_user": admin, "csrf_token": csrf_token(request),
        "users": users, "deleted_emails": deleted_emails, "q": q, "page": page, "total_pages": total_pages, "total": total,
    })


@router.get("/admin/access-codes", response_class=HTMLResponse)
def access_code_page(request: Request, db: Session = Depends(get_db)):
    admin = require_admin(request, db)
    if isinstance(admin, RedirectResponse):
        return admin
    recent = list(db.scalars(select(AdminAccessCode).order_by(AdminAccessCode.created_at.desc()).limit(50)))
    return templates.TemplateResponse(request=request, name="admin_access_codes.html", context={"request": request, "app_name": settings.app_name, "session_user": admin, "csrf_token": csrf_token(request), "recent": recent})


@router.post("/admin/access-codes", response_class=HTMLResponse)
def create_access_code(request: Request, email: str = Form(...), send_email: bool = Form(False), csrf: str = Form(...), db: Session = Depends(get_db)):
    admin = require_admin(request, db)
    if isinstance(admin, RedirectResponse):
        return admin
    require_csrf(request, csrf)
    try:
        normalized = normalize_email(email)
    except ValueError as exc:
        recent = list(db.scalars(select(AdminAccessCode).order_by(AdminAccessCode.created_at.desc()).limit(50)))
        return templates.TemplateResponse(request=request, name="admin_access_codes.html", context={"request": request, "app_name": settings.app_name, "session_user": admin, "csrf_token": csrf_token(request), "recent": recent, "error": str(exc)})
    code = f"{secrets.randbelow(1_000_000):06d}"
    db.add(AdminAccessCode(email=normalized, code_hash=hash_token(code), created_by=admin.id, expires_at=utcnow() + timedelta(minutes=ADMIN_CODE_MINUTES)))
    db.commit()
    delivered = False
    if send_email:
        try:
            delivered = send_code(normalized, code)
        except Exception:
            delivered = False
    recent = list(db.scalars(select(AdminAccessCode).order_by(AdminAccessCode.created_at.desc()).limit(50)))
    return templates.TemplateResponse(request=request, name="admin_access_codes.html", context={"request": request, "app_name": settings.app_name, "session_user": admin, "csrf_token": csrf_token(request), "recent": recent, "generated_email": normalized, "generated_code": code, "delivered": delivered})


@router.get("/admin-invite", response_class=HTMLResponse)
def admin_invite_page(request: Request, db: Session = Depends(get_db)):
    return templates.TemplateResponse(request=request, name="admin_invite.html", context={"request": request, "app_name": settings.app_name, "session_user": None, "csrf_token": csrf_token(request)})


@router.post("/admin-invite", response_class=HTMLResponse)
def admin_invite_verify(request: Request, email: str = Form(...), code: str = Form(...), password: str = Form(...), password_confirm: str = Form(...), csrf: str = Form(...), db: Session = Depends(get_db)):
    require_csrf(request, csrf)
    try:
        normalized = normalize_email(email)
        validate_password(password)
        if password != password_confirm:
            raise ValueError("비밀번호 확인이 일치하지 않습니다.")
    except ValueError as exc:
        return templates.TemplateResponse(request=request, name="admin_invite.html", context={"request": request, "app_name": settings.app_name, "session_user": None, "csrf_token": csrf_token(request), "email": email, "error": str(exc)})
    record = db.scalar(select(AdminAccessCode).where(AdminAccessCode.email == normalized, AdminAccessCode.used_at.is_(None)).order_by(AdminAccessCode.created_at.desc()))
    if not record:
        error = "유효한 관리자 승인 코드가 없습니다."
    else:
        expires = record.expires_at if record.expires_at.tzinfo else record.expires_at.replace(tzinfo=timezone.utc)
        error = "인증번호가 만료되었습니다." if expires <= utcnow() else ("인증번호가 올바르지 않습니다." if not secrets.compare_digest(record.code_hash, hash_token(code.strip())) else None)
    if error:
        return templates.TemplateResponse(request=request, name="admin_invite.html", context={"request": request, "app_name": settings.app_name, "session_user": None, "csrf_token": csrf_token(request), "email": normalized, "error": error})
    existing = db.scalar(select(User).where(User.email == normalized, User.deleted_at.is_(None)))
    if existing:
        user = existing
    else:
        user = User(email=normalized, is_verified=True, is_admin=normalized in settings.admin_email_set, password_hash=hash_password(password), last_login_at=utcnow())
        db.add(user)
        db.flush()
        db.add(UserEmail(user_id=user.id, email=normalized, is_verified=True, is_primary=True, verified_at=utcnow()))
    user.password_hash = hash_password(password)
    user.is_verified = True
    user.last_login_at = utcnow()
    record.used_at = utcnow()
    db.commit()
    request.session.clear()
    request.session["user_id"] = user.id
    request.session["csrf_token"] = secrets.token_urlsafe(24)
    return RedirectResponse("/app", status_code=303)
