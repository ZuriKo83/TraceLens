from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, delete, select
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


class DeletionJob(Base):
    __tablename__ = "deletion_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    public_id: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(30), default="queued", index=True)
    requested_count: Mapped[int] = mapped_column(Integer, default=1)
    successful_count: Mapped[int] = mapped_column(Integer, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DeletionJobItem(Base):
    __tablename__ = "deletion_job_items"
    __table_args__ = (UniqueConstraint("job_id", "activity_id", name="uq_deletion_job_activity"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("deletion_jobs.id", ondelete="CASCADE"), index=True)
    activity_id: Mapped[int] = mapped_column(ForeignKey("activities.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(30), default="queued", index=True)
    error_message: Mapped[str] = mapped_column(Text, default="")
    diagnostics_json: Mapped[str] = mapped_column(Text, default="{}")
    credit_reserved: Mapped[bool] = mapped_column(Boolean, default=False)
    charged: Mapped[bool] = mapped_column(Boolean, default=False)
    original_activity_type: Mapped[str] = mapped_column(String(80), default="comment")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DeletionJobCreate(BaseModel):
    activity_ids: list[int] = Field(min_length=1, max_length=1)
    csrf: str


class DeletionJobCancel(BaseModel):
    csrf: str
    reason: str = "확장 프로그램 실행 취소"


class DeletionResultItem(BaseModel):
    item_id: int
    status: Literal["success", "failed"]
    reason: str | None = None
    diagnostics: dict[str, Any] = Field(default_factory=dict)


class DeletionResults(BaseModel):
    items: list[DeletionResultItem] = Field(min_length=1, max_length=1)


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


def require_api_user(request: Request, db: Session) -> User:
    user = current_user(request, db)
    if user is None:
        raise HTTPException(401, "로그인이 필요합니다.")
    return user


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


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def issue_collector_token(db: Session, user: User) -> str:
    now = utcnow()
    db.execute(delete(CollectorToken).where(CollectorToken.user_id == user.id, CollectorToken.expires_at < now))
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
        token_hash=_hash_token(raw),
        label="Chrome extension delete connection",
        expires_at=now + timedelta(days=settings.collector_token_days),
    ))
    db.flush()
    return raw


def _metadata(activity: Activity) -> dict[str, Any]:
    try:
        value = json.loads(activity.metadata_json or "{}")
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _split_activity_content(activity: Activity, locator: dict[str, Any]) -> tuple[str, str]:
    title = str(locator.get("title") or "").strip()
    content = str(locator.get("content") or "").strip()
    if title and content:
        return title, content
    parts = (activity.content or "").split("\n", 1)
    if not title:
        title = parts[0].strip() if parts else ""
    if not content:
        content = parts[1].strip() if len(parts) > 1 else (parts[0].strip() if parts else "")
    return title, content


def _source_identity(activity: Activity, metadata: dict[str, Any], locator: dict[str, Any]) -> tuple[str | None, str | None]:
    source_type = str(locator.get("source_type") or metadata.get("source_type") or "").strip() or None
    source_id = str(locator.get("source_id") or metadata.get("source_id") or "").strip() or None
    if source_type and source_id:
        return source_type, source_id

    post_id = str(locator.get("post_id") or metadata.get("post_id") or metadata.get("youtube_post_id") or "").strip()
    if post_id:
        return "post", post_id
    video_id = str(locator.get("video_id") or metadata.get("video_id") or "").strip()
    if video_id:
        return "video", video_id

    source = activity.source_url or ""
    if "/post/" in source:
        return "post", source.split("/post/", 1)[1].split("?", 1)[0].split("#", 1)[0]
    if "v=" in source:
        return "video", source.split("v=", 1)[1].split("&", 1)[0].split("#", 1)[0]
    for marker in ("/shorts/", "/live/", "/embed/"):
        if marker in source:
            return "video", source.split(marker, 1)[1].split("?", 1)[0].split("#", 1)[0]
    return None, None


def _build_extension_item(activity: Activity, job_item: DeletionJobItem) -> dict[str, Any]:
    metadata = _metadata(activity)
    locator = metadata.get("deletion_locator")
    if not isinstance(locator, dict):
        locator = {}
    title, content = _split_activity_content(activity, locator)
    source_type, source_id = _source_identity(activity, metadata, locator)
    locator = dict(locator)
    locator.update({
        "title": title,
        "content": content,
        "source_type": source_type,
        "source_id": source_id,
        "source_url": activity.source_url,
    })
    return {
        "item_id": job_item.id,
        "activity_id": activity.id,
        "platform": activity.platform,
        "activity_type": job_item.original_activity_type,
        "title": title,
        "content": content,
        "source_url": activity.source_url,
        "locator": locator,
    }


def _validate_deletable(activity: Activity) -> None:
    if activity.platform != "youtube" or activity.activity_type != "comment":
        raise HTTPException(409, "현재는 YouTube 댓글 한 건 삭제만 지원합니다.")
    if activity.status != "visible":
        raise HTTPException(409, "이미 처리됐거나 삭제할 수 없는 기록입니다.")

    metadata = _metadata(activity)
    if not metadata.get("ownership_verified") or metadata.get("ownership_scope") != "self_activity":
        raise HTTPException(409, "본인 활동으로 확인된 YouTube 기록만 삭제할 수 있습니다. 다시 조회하세요.")
    locator = metadata.get("deletion_locator")
    if not isinstance(locator, dict):
        raise HTTPException(409, "삭제 위치 정보가 없습니다. 확장 프로그램을 새로고침하고 YouTube를 다시 조회하세요.")

    _, content = _split_activity_content(activity, locator)
    source_type, source_id = _source_identity(activity, metadata, locator)
    stable_locator = locator.get("row_data_id") or locator.get("row_jsdata") or locator.get("row_text_hash")
    if not content:
        raise HTTPException(409, "댓글 내용이 없어 안전하게 삭제 대상을 확인할 수 없습니다.")
    if not (source_type and source_id) and not stable_locator:
        raise HTTPException(409, "원문 식별자와 안정적인 삭제 위치 정보가 없습니다. YouTube를 다시 조회하세요.")


def _refund_reserved_credit(db: Session, user: User, job: DeletionJob, item: DeletionJobItem, reason: str) -> int:
    wallet = get_wallet(db, user.id, create=True)
    if item.credit_reserved:
        wallet.balance += 1
        wallet.updated_at = utcnow()
        db.add(DeleteCreditLedger(
            user_id=user.id,
            amount=1,
            balance_after=wallet.balance,
            reason="삭제 작업 환불",
            note=f"job={job.public_id}; activity={item.activity_id}; {reason[:500]}",
            created_by=user.id,
        ))
        item.credit_reserved = False
    return wallet.balance


def _expire_stale_jobs(db: Session, user: User) -> None:
    cutoff = utcnow() - timedelta(minutes=15)
    jobs = list(db.scalars(select(DeletionJob).where(
        DeletionJob.user_id == user.id,
        DeletionJob.status.in_(("queued", "running")),
    )))
    for job in jobs:
        created = _as_utc(job.created_at)
        if created is not None and created >= cutoff:
            continue
        item = db.scalar(select(DeletionJobItem).where(DeletionJobItem.job_id == job.id))
        if item is not None:
            _refund_reserved_credit(db, user, job, item, "작업 제한 시간 초과")
            item.status = "failed"
            item.error_message = "작업 제한 시간이 초과되었습니다."
            item.completed_at = utcnow()
        job.status = "failed"
        job.failed_count = 1
        job.error_message = "작업 제한 시간이 초과되었습니다."
        job.completed_at = utcnow()


def _job_response(db: Session, user: User, job: DeletionJob, item: DeletionJobItem, activity: Activity | None = None) -> dict[str, Any]:
    wallet = get_wallet(db, user.id)
    response: dict[str, Any] = {
        "ok": True,
        "job_id": job.public_id,
        "status": job.status,
        "item_status": item.status,
        "reason": item.error_message or job.error_message or None,
        "balance": wallet.balance if wallet else 0,
        "charged": item.charged,
    }
    if activity is not None:
        response["items"] = [_build_extension_item(activity, item)]
    return response


@router.get("/delete-credits/purchase", response_class=HTMLResponse)
def purchase_page(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db, "/delete-credits/purchase")
    if isinstance(user, RedirectResponse):
        return user
    _expire_stale_jobs(db, user)
    wallet = get_wallet(db, user.id)
    extension_token = issue_collector_token(db, user)
    activities = list(db.scalars(
        select(Activity)
        .where(
            Activity.user_id == user.id,
            Activity.status == "visible",
            Activity.activity_type.in_(VISIBLE_ACTIVITY_TYPES),
        )
        .order_by(Activity.imported_at.desc(), Activity.id.desc())
    ))
    db.commit()
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
        },
    )


@router.post("/api/deletion-jobs")
def create_deletion_job(payload: DeletionJobCreate, request: Request, db: Session = Depends(get_db)):
    user = require_api_user(request, db)
    require_csrf(request, payload.csrf)
    _expire_stale_jobs(db, user)

    active = db.scalar(select(DeletionJob).where(
        DeletionJob.user_id == user.id,
        DeletionJob.status.in_(("queued", "running")),
    ).order_by(DeletionJob.created_at.desc()))
    if active is not None:
        db.commit()
        raise HTTPException(409, "이미 진행 중인 삭제 작업이 있습니다. 잠시 후 다시 시도하세요.")

    activity_id = payload.activity_ids[0]
    activity = db.scalar(select(Activity).where(Activity.id == activity_id, Activity.user_id == user.id))
    if activity is None:
        raise HTTPException(404, "선택한 기록을 찾을 수 없습니다.")
    _validate_deletable(activity)

    wallet = get_wallet(db, user.id, create=True)
    if wallet.balance < 1:
        raise HTTPException(409, "삭제권이 부족합니다.")

    public_id = secrets.token_urlsafe(24)
    job = DeletionJob(public_id=public_id, user_id=user.id, status="queued", requested_count=1)
    db.add(job)
    db.flush()
    item = DeletionJobItem(
        job_id=job.id,
        activity_id=activity.id,
        status="queued",
        credit_reserved=True,
        original_activity_type=activity.activity_type,
    )
    db.add(item)
    db.flush()

    wallet.balance -= 1
    wallet.updated_at = utcnow()
    db.add(DeleteCreditLedger(
        user_id=user.id,
        amount=-1,
        balance_after=wallet.balance,
        reason="삭제 작업 예약",
        note=f"job={public_id}; activity={activity.id}",
        created_by=user.id,
    ))
    db.commit()
    return _job_response(db, user, job, item, activity)


@router.get("/api/deletion-jobs/{public_id}")
def deletion_job_status(public_id: str, request: Request, db: Session = Depends(get_db)):
    user = require_api_user(request, db)
    job = db.scalar(select(DeletionJob).where(DeletionJob.public_id == public_id, DeletionJob.user_id == user.id))
    if job is None:
        raise HTTPException(404, "삭제 작업을 찾을 수 없습니다.")
    item = db.scalar(select(DeletionJobItem).where(DeletionJobItem.job_id == job.id))
    if item is None:
        raise HTTPException(404, "삭제 작업 항목을 찾을 수 없습니다.")
    return _job_response(db, user, job, item)


@router.post("/api/deletion-jobs/{public_id}/cancel")
def cancel_deletion_job(public_id: str, payload: DeletionJobCancel, request: Request, db: Session = Depends(get_db)):
    user = require_api_user(request, db)
    require_csrf(request, payload.csrf)
    job = db.scalar(select(DeletionJob).where(DeletionJob.public_id == public_id, DeletionJob.user_id == user.id))
    if job is None:
        raise HTTPException(404, "삭제 작업을 찾을 수 없습니다.")
    item = db.scalar(select(DeletionJobItem).where(DeletionJobItem.job_id == job.id))
    if item is None:
        raise HTTPException(404, "삭제 작업 항목을 찾을 수 없습니다.")
    if job.status in {"success", "failed"}:
        return _job_response(db, user, job, item)

    reason = payload.reason.strip()[:2000] or "확장 프로그램 실행 취소"
    balance = _refund_reserved_credit(db, user, job, item, reason)
    now = utcnow()
    item.status = "failed"
    item.error_message = reason
    item.completed_at = now
    job.status = "failed"
    job.failed_count = 1
    job.error_message = reason
    job.completed_at = now
    db.commit()
    response = _job_response(db, user, job, item)
    response["balance"] = balance
    return response


@router.post("/api/deletion-jobs/{public_id}/results")
def complete_deletion_job(
    public_id: str,
    payload: DeletionResults,
    extension_user: User = Depends(collector_user),
    db: Session = Depends(get_db),
):
    job = db.scalar(select(DeletionJob).where(DeletionJob.public_id == public_id, DeletionJob.user_id == extension_user.id))
    if job is None:
        raise HTTPException(404, "삭제 작업을 찾을 수 없습니다.")
    item = db.scalar(select(DeletionJobItem).where(DeletionJobItem.job_id == job.id))
    if item is None:
        raise HTTPException(404, "삭제 작업 항목을 찾을 수 없습니다.")
    result = payload.items[0]
    if result.item_id != item.id:
        raise HTTPException(409, "삭제 결과 항목이 작업 정보와 일치하지 않습니다.")
    if job.status in {"success", "failed"}:
        return _job_response(db, extension_user, job, item)

    job.status = "running"
    item.status = "running"
    diagnostics = json.dumps(result.diagnostics, ensure_ascii=False, default=str)
    item.diagnostics_json = diagnostics[:12000]
    reason = (result.reason or "").strip()[:2000]
    now = utcnow()

    if result.status == "success":
        activity = db.scalar(select(Activity).where(Activity.id == item.activity_id, Activity.user_id == extension_user.id))
        if activity is None:
            reason = "외부 삭제는 확인됐지만 TraceLens 기록을 찾지 못했습니다."
            result_status = "failed"
        else:
            metadata = _metadata(activity)
            metadata["deleted_at"] = now.isoformat()
            metadata["deleted_via"] = "google_my_activity"
            metadata["deleted_original_activity_type"] = item.original_activity_type
            activity.metadata_json = json.dumps(metadata, ensure_ascii=False, default=str)
            activity.delete_mode = "google_my_activity"
            activity.status = "deleted"
            activity.activity_type = "deleted"
            item.status = "success"
            item.credit_reserved = False
            item.charged = True
            item.error_message = ""
            item.completed_at = now
            job.status = "success"
            job.successful_count = 1
            job.failed_count = 0
            job.error_message = ""
            job.completed_at = now
            result_status = "success"
    else:
        result_status = "failed"

    if result_status == "failed":
        _refund_reserved_credit(db, extension_user, job, item, reason or "삭제 대상 확인 또는 삭제 검증에 실패했습니다.")
        item.status = "failed"
        item.error_message = reason or "삭제 대상 확인 또는 삭제 검증에 실패했습니다."
        item.completed_at = now
        job.status = "failed"
        job.successful_count = 0
        job.failed_count = 1
        job.error_message = item.error_message
        job.completed_at = now

    db.commit()
    return _job_response(db, extension_user, job, item)


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
