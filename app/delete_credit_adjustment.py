from __future__ import annotations

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.delete_credits import (
    DeleteCreditLedger,
    DeleteCreditWallet,
    ensure_delete_credit_schema,
    get_wallet,
    require_admin,
    require_csrf,
)
from app.models import User, utcnow

router = APIRouter()
MAX_ADMIN_CREDIT_ADJUSTMENT = 100_000


def adjusted_delete_credit_balance(current_balance: int, amount: int) -> int:
    if amount == 0 or abs(amount) > MAX_ADMIN_CREDIT_ADJUSTMENT:
        raise ValueError("invalid-amount")

    adjusted = current_balance + amount
    if adjusted < 0:
        raise ValueError("insufficient-balance")
    return adjusted


@router.post("/admin/delete-credits/grant")
def admin_adjust_delete_credits(
    request: Request,
    email: str = Form(...),
    amount: int = Form(...),
    note: str = Form(""),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
    ensure_delete_credit_schema(db)
    admin = require_admin(request, db)
    if isinstance(admin, RedirectResponse):
        return admin
    require_csrf(request, csrf)

    normalized = email.strip().lower()
    user = db.scalar(select(User).where(User.email == normalized, User.deleted_at.is_(None)))
    if user is None:
        return RedirectResponse(
            f"/admin/delete-credits?error=user-not-found&q={normalized}",
            status_code=303,
        )

    wallet = db.scalar(
        select(DeleteCreditWallet)
        .where(DeleteCreditWallet.user_id == user.id)
        .with_for_update()
    )
    current_balance = int(wallet.balance if wallet else 0)
    try:
        adjusted_balance = adjusted_delete_credit_balance(current_balance, amount)
    except ValueError as error:
        return RedirectResponse(
            f"/admin/delete-credits?error={error.args[0]}&q={normalized}",
            status_code=303,
        )

    if wallet is None:
        wallet = get_wallet(db, user.id, create=True)

    wallet.balance = adjusted_balance
    wallet.updated_at = utcnow()
    is_grant = amount > 0
    db.add(DeleteCreditLedger(
        user_id=user.id,
        amount=amount,
        balance_after=adjusted_balance,
        reason="관리자 발급" if is_grant else "관리자 회수",
        note=note.strip()[:1000],
        created_by=admin.id,
    ))
    db.commit()

    result_key = "granted" if is_grant else "recovered"
    result_amount = amount if is_grant else abs(amount)
    return RedirectResponse(
        f"/admin/delete-credits?{result_key}={result_amount}&q={normalized}",
        status_code=303,
    )
