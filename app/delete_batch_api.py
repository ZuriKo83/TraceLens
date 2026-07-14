from __future__ import annotations

import json
import secrets
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.delete_credits import (
    DeleteCreditLedger,
    DeletionJob,
    DeletionJobItem,
    _build_extension_item,
    _validate_deletable,
    get_wallet,
)
from app.dependencies import collector_user
from app.models import Activity, User, utcnow

router = APIRouter()
MAX_BATCH_DELETE = 100


class BatchDeletionCreate(BaseModel):
    activity_ids: list[int] = Field(min_length=1, max_length=MAX_BATCH_DELETE)


class BatchDeletionResultItem(BaseModel):
    item_id: int
    status: Literal["success", "failed"]
    reason: str | None = None
    diagnostics: dict[str, Any] = Field(default_factory=dict)


class BatchDeletionResults(BaseModel):
    items: list[BatchDeletionResultItem] = Field(min_length=1, max_length=MAX_BATCH_DELETE)


class BatchDeletionCancel(BaseModel):
    reason: str = "확장 프로그램 배치 실행 취소"


def _job_items(db: Session, job: DeletionJob) -> list[DeletionJobItem]:
    return list(db.scalars(
        select(DeletionJobItem)
        .where(DeletionJobItem.job_id == job.id)
        .order_by(DeletionJobItem.id)
    ))


def _response(db: Session, user: User, job: DeletionJob, *, include_payload: bool = False) -> dict[str, Any]:
    items = _job_items(db, job)
    wallet = get_wallet(db, user.id)
    activity_map: dict[int, Activity] = {}
    if include_payload and items:
        activity_map = {
            activity.id: activity
            for activity in db.scalars(select(Activity).where(
                Activity.user_id == user.id,
                Activity.id.in_([item.activity_id for item in items]),
            ))
        }

    response_items = []
    for item in items:
        if include_payload and item.activity_id in activity_map:
            response_items.append(_build_extension_item(activity_map[item.activity_id], item))
        else:
            response_items.append({
                "item_id": item.id,
                "activity_id": item.activity_id,
                "status": item.status,
                "reason": item.error_message or None,
                "charged": item.charged,
            })

    return {
        "ok": True,
        "job_id": job.public_id,
        "status": job.status,
        "requested_count": job.requested_count,
        "successful_count": job.successful_count,
        "failed_count": job.failed_count,
        "balance": wallet.balance if wallet else 0,
        "items": response_items,
    }


def _refund_reserved(db: Session, user: User, job: DeletionJob, items: list[DeletionJobItem], reason: str) -> int:
    refundable = [item for item in items if item.credit_reserved and not item.charged]
    wallet = get_wallet(db, user.id, create=True)
    if not refundable:
        return wallet.balance

    count = len(refundable)
    wallet.balance += count
    wallet.updated_at = utcnow()
    for item in refundable:
        item.credit_reserved = False

    db.add(DeleteCreditLedger(
        user_id=user.id,
        amount=count,
        balance_after=wallet.balance,
        reason="삭제 배치 환불",
        note=f"job={job.public_id}; count={count}; {reason[:700]}",
        created_by=user.id,
    ))
    return wallet.balance


@router.post("/api/deletion-jobs/batch")
def create_batch_deletion_job(
    payload: BatchDeletionCreate,
    user: User = Depends(collector_user),
    db: Session = Depends(get_db),
):
    activity_ids = list(dict.fromkeys(int(value) for value in payload.activity_ids if int(value) > 0))
    if not activity_ids:
        raise HTTPException(400, "삭제할 기록을 하나 이상 선택하세요.")
    if len(activity_ids) > MAX_BATCH_DELETE:
        raise HTTPException(413, f"한 번에 최대 {MAX_BATCH_DELETE}개까지 삭제할 수 있습니다.")

    active = db.scalar(select(DeletionJob).where(
        DeletionJob.user_id == user.id,
        DeletionJob.status.in_(("queued", "running")),
    ).order_by(DeletionJob.created_at.desc()))
    if active is not None:
        raise HTTPException(409, "이미 진행 중인 삭제 작업이 있습니다. 잠시 후 다시 시도하세요.")

    activity_map = {
        activity.id: activity
        for activity in db.scalars(select(Activity).where(
            Activity.user_id == user.id,
            Activity.id.in_(activity_ids),
        ))
    }
    missing = [activity_id for activity_id in activity_ids if activity_id not in activity_map]
    if missing:
        raise HTTPException(404, f"선택한 기록 {len(missing)}개를 찾을 수 없습니다. 페이지를 새로고침하세요.")

    activities = [activity_map[activity_id] for activity_id in activity_ids]
    for activity in activities:
        _validate_deletable(activity)

    wallet = get_wallet(db, user.id, create=True)
    required = len(activities)
    if wallet.balance < required:
        raise HTTPException(409, f"삭제권이 {required - wallet.balance}개 부족합니다.")

    public_id = secrets.token_urlsafe(24)
    job = DeletionJob(
        public_id=public_id,
        user_id=user.id,
        status="queued",
        requested_count=required,
        successful_count=0,
        failed_count=0,
    )
    db.add(job)
    db.flush()

    for activity in activities:
        db.add(DeletionJobItem(
            job_id=job.id,
            activity_id=activity.id,
            status="queued",
            credit_reserved=True,
            original_activity_type=activity.activity_type,
        ))
    db.flush()

    wallet.balance -= required
    wallet.updated_at = utcnow()
    db.add(DeleteCreditLedger(
        user_id=user.id,
        amount=-required,
        balance_after=wallet.balance,
        reason="삭제 배치 예약",
        note=f"job={public_id}; count={required}; activities={','.join(map(str, activity_ids))[:1200]}",
        created_by=user.id,
    ))
    db.commit()
    return _response(db, user, job, include_payload=True)


@router.post("/api/deletion-jobs/batch/{public_id}/results")
def complete_batch_deletion_job(
    public_id: str,
    payload: BatchDeletionResults,
    user: User = Depends(collector_user),
    db: Session = Depends(get_db),
):
    job = db.scalar(select(DeletionJob).where(
        DeletionJob.public_id == public_id,
        DeletionJob.user_id == user.id,
    ))
    if job is None:
        raise HTTPException(404, "삭제 작업을 찾을 수 없습니다.")

    items = _job_items(db, job)
    if job.status in {"success", "partial", "failed"}:
        return _response(db, user, job)

    item_map = {item.id: item for item in items}
    result_map = {result.item_id: result for result in payload.items}
    if set(result_map) != set(item_map):
        raise HTTPException(409, "삭제 결과 항목이 배치 작업 정보와 일치하지 않습니다.")

    activity_map = {
        activity.id: activity
        for activity in db.scalars(select(Activity).where(
            Activity.user_id == user.id,
            Activity.id.in_([item.activity_id for item in items]),
        ))
    }

    now = utcnow()
    failed_items: list[DeletionJobItem] = []
    already_absent_items: list[DeletionJobItem] = []
    successful_count = 0
    for item in items:
        result = result_map[item.id]
        item.diagnostics_json = json.dumps(result.diagnostics, ensure_ascii=False, default=str)[:12000]
        reason = (result.reason or "").strip()[:2000]
        activity = activity_map.get(item.activity_id)
        verification_only = (
            result.status == "success"
            and result.diagnostics.get("click_evidence") == "verification_only_not_found"
        )

        if result.status == "success" and activity is not None:
            try:
                metadata = json.loads(activity.metadata_json or "{}")
                if not isinstance(metadata, dict):
                    metadata = {}
            except (TypeError, ValueError):
                metadata = {}
            metadata["deleted_at"] = now.isoformat()
            metadata["deleted_via"] = (
                "google_my_activity_already_absent"
                if verification_only
                else "google_my_activity_batch"
            )
            metadata["deleted_original_activity_type"] = item.original_activity_type
            activity.metadata_json = json.dumps(metadata, ensure_ascii=False, default=str)
            activity.delete_mode = "google_my_activity"
            activity.status = "deleted"
            activity.activity_type = "deleted"

            item.status = "success"
            item.charged = not verification_only
            item.error_message = ""
            item.completed_at = now
            successful_count += 1

            if verification_only:
                already_absent_items.append(item)
            else:
                item.credit_reserved = False
            continue

        if result.status == "success" and activity is None:
            reason = "외부 삭제는 확인됐지만 TraceLens 기록을 찾지 못했습니다."
        item.status = "failed"
        item.error_message = reason or "삭제 대상 확인 또는 삭제 검증에 실패했습니다."
        item.completed_at = now
        failed_items.append(item)

    failed_count = len(failed_items)
    if already_absent_items:
        _refund_reserved(
            db,
            user,
            job,
            already_absent_items,
            "이미 Google 내 활동에서 사라진 항목 예약 해제",
        )
    if failed_items:
        _refund_reserved(db, user, job, failed_items, "배치 삭제 실패 항목 환불")

    job.successful_count = successful_count
    job.failed_count = failed_count
    job.completed_at = now
    if successful_count == len(items):
        job.status = "success"
        job.error_message = ""
    elif successful_count:
        job.status = "partial"
        job.error_message = f"{failed_count}개 항목 삭제 실패"
    else:
        job.status = "failed"
        job.error_message = "선택한 항목을 삭제하지 못했습니다."

    db.commit()
    return _response(db, user, job)


@router.post("/api/deletion-jobs/batch/{public_id}/cancel")
def cancel_batch_deletion_job(
    public_id: str,
    payload: BatchDeletionCancel,
    user: User = Depends(collector_user),
    db: Session = Depends(get_db),
):
    job = db.scalar(select(DeletionJob).where(
        DeletionJob.public_id == public_id,
        DeletionJob.user_id == user.id,
    ))
    if job is None:
        raise HTTPException(404, "삭제 작업을 찾을 수 없습니다.")

    items = _job_items(db, job)
    if job.status in {"success", "partial", "failed"}:
        return _response(db, user, job)

    reason = payload.reason.strip()[:2000] or "확장 프로그램 배치 실행 취소"
    now = utcnow()
    _refund_reserved(db, user, job, items, reason)
    for item in items:
        if item.status not in {"success", "failed"}:
            item.status = "failed"
            item.error_message = reason
            item.completed_at = now
    job.status = "failed"
    job.successful_count = sum(1 for item in items if item.status == "success")
    job.failed_count = len(items) - job.successful_count
    job.error_message = reason
    job.completed_at = now
    db.commit()
    return _response(db, user, job)
