#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import engine
from app.delete_credits import DeleteCreditLedger, DeletionJob, DeletionJobItem, get_wallet
from app.models import Activity, utcnow


def load_metadata(raw: str | None) -> dict:
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def parse_datetime(value: object) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def recalculate_job(db: Session, job_id: int, now) -> None:
    job = db.get(DeletionJob, job_id)
    if job is None:
        return
    items = list(db.scalars(select(DeletionJobItem).where(DeletionJobItem.job_id == job_id)))
    success = sum(1 for item in items if item.status == "success")
    failed = len(items) - success
    job.successful_count = success
    job.failed_count = failed
    job.completed_at = job.completed_at or now
    if success == len(items):
        job.status = "success"
        job.error_message = ""
    elif success:
        job.status = "partial"
        job.error_message = f"{failed}개 항목 삭제 성공 오판 복구"
    else:
        job.status = "failed"
        job.error_message = "삭제 성공 오판 복구"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Google 내 활동에서 다시 확인된 TraceLens 삭제 성공 오판 기록을 복구하고 삭제권을 환불합니다."
    )
    parser.add_argument("--apply", action="store_true", help="실제로 DB를 변경합니다. 생략하면 확인만 합니다.")
    parser.add_argument("--user-id", type=int, default=None, help="특정 사용자 ID만 처리합니다.")
    args = parser.parse_args()

    now = utcnow()
    with Session(engine) as db:
        query = select(Activity).where(
            Activity.platform == "youtube",
            Activity.status == "deleted",
        ).order_by(Activity.id)
        if args.user_id:
            query = query.where(Activity.user_id == args.user_id)

        candidates: list[tuple[Activity, dict]] = []
        for activity in db.scalars(query):
            metadata = load_metadata(activity.metadata_json)
            if metadata.get("deleted_via") != "google_my_activity_batch":
                continue
            seen_at = parse_datetime(metadata.get("last_seen_after_delete_at"))
            deleted_at = parse_datetime(metadata.get("deleted_at"))
            if seen_at is None:
                continue
            if deleted_at is not None and seen_at <= deleted_at:
                continue
            candidates.append((activity, metadata))

        print(f"복구 후보: {len(candidates)}개")
        for activity, metadata in candidates[:30]:
            print(
                f"- activity={activity.id} user={activity.user_id} "
                f"seen={metadata.get('last_seen_after_delete_at')} "
                f"content={(activity.content or '')[:100]!r}"
            )
        if len(candidates) > 30:
            print(f"- 외 {len(candidates) - 30}개")

        if not args.apply:
            print("확인만 했습니다. 실제 복구는 --apply를 붙여 다시 실행하세요.")
            return 0

        refunds_by_user: dict[int, int] = {}
        affected_jobs: set[int] = set()
        restored = 0

        for activity, metadata in candidates:
            original_type = str(metadata.get("deleted_original_activity_type") or "comment")
            activity.activity_type = original_type if original_type in {"comment", "post", "question", "answer"} else "comment"
            activity.status = "visible"
            metadata["delete_false_positive_restored_at"] = now.isoformat()
            metadata["delete_false_positive_reason"] = "record_reappeared_in_complete_collection"
            metadata["delete_false_positive_previous_deleted_via"] = metadata.get("deleted_via")
            activity.metadata_json = json.dumps(metadata, ensure_ascii=False, default=str)
            restored += 1

            charged_items = list(db.scalars(
                select(DeletionJobItem).where(
                    DeletionJobItem.activity_id == activity.id,
                    DeletionJobItem.status == "success",
                    DeletionJobItem.charged.is_(True),
                )
            ))
            for item in charged_items:
                item.status = "failed"
                item.charged = False
                item.credit_reserved = False
                item.error_message = "Google 내 활동 재조회에서 기록이 다시 확인되어 삭제 성공 오판으로 복구됨"
                item.completed_at = now
                refunds_by_user[activity.user_id] = refunds_by_user.get(activity.user_id, 0) + 1
                affected_jobs.add(item.job_id)

        for user_id, count in refunds_by_user.items():
            wallet = get_wallet(db, user_id, create=True)
            wallet.balance += count
            wallet.updated_at = now
            db.add(DeleteCreditLedger(
                user_id=user_id,
                amount=count,
                balance_after=wallet.balance,
                reason="삭제 성공 오판 환불",
                note=f"Google 내 활동 재조회로 복구된 기록 {count}개",
                created_by=user_id,
            ))

        for job_id in affected_jobs:
            recalculate_job(db, job_id, now)

        db.commit()
        print(f"복구 완료: 기록 {restored}개, 삭제권 환불 {sum(refunds_by_user.values())}개")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
