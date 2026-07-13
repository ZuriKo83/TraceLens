from __future__ import annotations

import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.config import get_settings
from app.db import Base, get_db
from app.models import User, utcnow

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


@router.get("/delete-credits/purchase", response_class=HTMLResponse)
def purchase_page(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db, "/delete-credits/purchase")
    if isinstance(user, RedirectResponse):
        return user
    wallet = get_wallet(db, user.id)
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
        },
    )


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
    user_map = {row.id: row for row in db.scalars(select(User).where(User.id.in_({entry.user_id for entry in recent}))) } if recent else {}
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
