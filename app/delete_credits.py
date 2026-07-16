from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, delete, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.config import get_settings
from app.db import Base, get_db
from app.dependencies import collector_user
from app.models import Activity, CollectorToken, User, utcnow
from app.supported_sites import ACTIVITY_TYPE_LABELS, PLATFORM_LABELS, VISIBLE_ACTIVITY_TYPES

settings = get_settings()
templates = Jinja2Templates(directory="app/templates")
router = APIRouter()


class DeleteCreditWallet(Base):
    __tablename__ = "delete_credit_wallets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True)
    balance: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class DeleteCreditLedger(Base):
    __tablename__ = "delete_credit_ledger"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    amount: Mapped[int] = mapped_column(Integer)
    balance_after: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(200), default="관리자 발급")
    note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class ConfirmDeletedActivities(BaseModel):
    activity_ids: list[int] = Field(min_length=1, max_length=100)
    activity_kind: str = "comment"


def csrf_token(request: Request) -> str:
    token = request.session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(24)
        request.session["csrf_token"] = token
    return token


def require_csrf(request: Request, supplied: str) -> None:
    expected = request.session.get("csrf_token")
    if not expected or not secrets.compare_digest(expected, supplied or ""):
        raise HTTPException(400, "요청 검증에 실패했습니다. 페이지를 새로고침하세요.")


def current_user(request: Request, db: Session) -> User | None:
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    user = db.get(User, int(user_id))
    if user is None or user.deleted_at is not None or not user.is_verified:
        return None
    return user


def require_user(request: Request, db: Session, next_path: str) -> User | RedirectResponse:
    user = current_user(request, db)
    return user if user else RedirectResponse(f"/login?next={next_path}", status_code=303)


def require_admin(request: Request, db: Session) -> User | RedirectResponse:
    user = current_user(request, db)
    if user is None or not user.is_admin:
        return RedirectResponse("/login?next=/admin/delete-credits", status_code=303)
    return user


def get_wallet(db: Session, user_id: int, *, create: bool = False) -> DeleteCreditWallet | None:
    wallet = db.scalar(select(DeleteCreditWallet).where(DeleteCreditWallet.user_id == user_id))
    if wallet is None and create:
        wallet = DeleteCreditWallet(user_id=user_id, balance=0)
        db.add(wallet)
        db.flush()
    return wallet


def issue_collector_token(db: Session, user: User) -> str:
    now = utcnow()
    db.execute(delete(CollectorToken).where(
        CollectorToken.user_id == user.id,
        CollectorToken.expires_at < now,
    ))
    active = list(db.scalars(
        select(CollectorToken)
        .where(CollectorToken.user_id == user.id, CollectorToken.revoked_at.is_(None))
        .order_by(CollectorToken.created_at.desc())
    ))
    for stale in active[4:]:
        stale.revoked_at = now

    raw = secrets.token_urlsafe(40)
    db.add(CollectorToken(
        user_id=user.id,
        token_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        label="Chrome extension delete page",
        expires_at=now + timedelta(days=settings.collector_token_days),
    ))
    db.flush()
    return raw


def youtube_activity_kind(activity: Activity) -> str:
    try:
        metadata = json.loads(activity.metadata_json or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        metadata = {}
    explicit = str(metadata.get("youtube_activity_kind") or "").strip().lower()
    if explicit == "live_chat" or str(activity.content or "").lstrip().startswith("[실시간 채팅]"):
        return "live_chat"
    return "comment"


@router.get("/delete-credits/purchase", response_class=HTMLResponse)
def purchase_page(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db, "/delete-credits/purchase")
    if isinstance(user, RedirectResponse):
        return user

    extension_token = issue_collector_token(db, user)
    db.commit()

    wallet = get_wallet(db, user.id)
    activities = list(db.scalars(
        select(Activity)
        .where(
            Activity.user_id == user.id,
            Activity.status == "visible",
            Activity.activity_type.in_(VISIBLE_ACTIVITY_TYPES),
        )
        .order_by(Activity.imported_at.desc(), Activity.id.desc())
    ))
    return templates.TemplateResponse(
        request=request,
        name="delete_credit_purchase.html",
        context={
            "request": request,
            "app_name": settings.app_name,
            "session_user": user,
            "csrf_token": csrf_token(request),
            "balance": wallet.balance if wallet else 0,
            "packages": [
                {"price": 1000, "credits": 10},
                {"price": 3000, "credits": 50},
                {"price": 5000, "credits": 100},
            ],
            "activities": activities,
            "platform_labels": PLATFORM_LABELS,
            "activity_type_labels": ACTIVITY_TYPE_LABELS,
            "extension_token": extension_token,
            "extension_server": settings.public_base_url.rstrip("/"),
            "extension_user_email": user.email,
        },
    )


@router.post("/api/delete-credits/confirm-deleted")
def confirm_deleted_activities(
    payload: ConfirmDeletedActivities,
    user: User = Depends(collector_user),
    db: Session = Depends(get_db),
):
    activity_kind = payload.activity_kind.strip().lower()
    if activity_kind not in {"comment", "live_chat"}:
        raise HTTPException(400, "지원하지 않는 YouTube 활동 유형입니다.")

    activity_ids = sorted({int(value) for value in payload.activity_ids if int(value) > 0})
    if not activity_ids or len(activity_ids) > 100:
        raise HTTPException(400, "삭제 확인 행은 1개 이상 100개 이하이어야 합니다.")

    rows = list(db.scalars(
        select(Activity).where(
            Activity.id.in_(activity_ids),
            Activity.user_id == user.id,
            Activity.platform == "youtube",
            Activity.activity_type == "comment",
        )
    ))
    existing_ids = {row.id for row in rows}
    physically_deleted_ids = sorted(existing_ids)
    already_absent_ids = sorted(set(activity_ids) - existing_ids)
    kind_mismatch_ids = sorted(row.id for row in rows if youtube_activity_kind(row) != activity_kind)

    for row in rows:
        db.delete(row)
    db.commit()

    # deleted_ids는 호출자가 최종 정리 성공 여부를 판단하는 필드이므로
    # 이미 DB에서 사라진 ID까지 포함한 전체 resolved ID를 반환한다.
    return {
        "ok": True,
        "requested": len(activity_ids),
        "deleted": len(activity_ids),
        "deleted_ids": activity_ids,
        "resolved_ids": activity_ids,
        "physically_deleted": len(physically_deleted_ids),
        "physically_deleted_ids": physically_deleted_ids,
        "already_absent_ids": already_absent_ids,
        "not_deleted_ids": [],
        "kind_mismatch_ids": kind_mismatch_ids,
    }


@router.get("/admin/delete-credits", response_class=HTMLResponse)
def admin_credit_page(request: Request, q: str = "", db: Session = Depends(get_db)):
    admin = require_admin(request, db)
    if isinstance(admin, RedirectResponse):
        return admin
    users = []
    term = q.strip()
    if term:
        users = list(db.scalars(
            select(User)
            .where(User.deleted_at.is_(None), User.email.ilike(f"%{term}%"))
            .order_by(User.id.desc())
            .limit(50)
        ))
    recent = list(db.scalars(select(DeleteCreditLedger).order_by(DeleteCreditLedger.created_at.desc()).limit(100)))
    user_map = {row.id: row for row in db.scalars(select(User).where(User.id.in_({entry.user_id for entry in recent})))} if recent else {}
    balances = {row.user_id: row.balance for row in db.scalars(select(DeleteCreditWallet))}
    return templates.TemplateResponse(
        request=request,
        name="admin_delete_credits.html",
        context={
            "request": request,
            "app_name": settings.app_name,
            "session_user": admin,
            "csrf_token": csrf_token(request),
            "users": users,
            "recent": recent,
            "user_map": user_map,
            "balances": balances,
            "q": q,
        },
    )


@router.post("/admin/delete-credits/grant")
def admin_grant_credits(
    request: Request,
    email: str = Form(...),
    amount: int = Form(...),
    note: str = Form(""),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
    admin = require_admin(request, db)
    if isinstance(admin, RedirectResponse):
        return admin
    require_csrf(request, csrf)
    normalized = email.strip().lower()
    user = db.scalar(select(User).where(User.email == normalized, User.deleted_at.is_(None)))
    if user is None:
        return RedirectResponse(f"/admin/delete-credits?error=user-not-found&q={normalized}", status_code=303)
    if amount <= 0 or amount > 100000:
        return RedirectResponse(f"/admin/delete-credits?error=invalid-amount&q={normalized}", status_code=303)
    wallet = get_wallet(db, user.id, create=True)
    wallet.balance += amount
    wallet.updated_at = utcnow()
    db.add(DeleteCreditLedger(
        user_id=user.id,
        amount=amount,
        balance_after=wallet.balance,
        reason="관리자 발급",
        note=note.strip()[:1000],
        created_by=admin.id,
    ))
    db.commit()
    return RedirectResponse(f"/admin/delete-credits?granted={amount}&q={normalized}", status_code=303)