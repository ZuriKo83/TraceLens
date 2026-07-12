from __future__ import annotations

import json
import time
import zipfile
from datetime import timedelta
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import Base, engine
from app.models import ScanArchiveBatch, ScanLog, utcnow

settings = get_settings()


def _serialize(row: ScanLog) -> dict:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "platform": row.platform,
        "source_url": row.source_url,
        "status": row.status,
        "found_count": row.found_count,
        "imported_count": row.imported_count,
        "message": row.message,
        "collector_email": row.collector_email,
        "account_label": row.account_label,
        "scan_scope": row.scan_scope,
        "scanned_at": row.scanned_at.isoformat() if row.scanned_at else None,
    }


def delete_confirmed_archives(db: Session) -> int:
    now = utcnow()
    batches = list(db.scalars(select(ScanArchiveBatch).where(
        ScanArchiveBatch.status == "ready",
        ScanArchiveBatch.delete_after <= now,
    ).order_by(ScanArchiveBatch.id)))
    deleted = 0
    for batch in batches:
        archive = Path(batch.archive_path)
        if not archive.is_file():
            continue
        with zipfile.ZipFile(archive, "r") as zf:
            manifest = json.loads(zf.read("manifest.json"))
            ids = [int(value) for value in manifest.get("scan_log_ids", [])]
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            result = db.execute(delete(ScanLog).where(
                ScanLog.id.in_(chunk),
                ScanLog.archived_batch_id == batch.id,
                ScanLog.scanned_at <= batch.cutoff_at,
            ))
            deleted += result.rowcount or 0
        batch.status = "deleted"
        batch.deleted_at = now
        db.commit()
    return deleted


def archive_expired_logs(db: Session) -> int:
    now = utcnow()
    cutoff = now - timedelta(days=settings.scan_log_retention_days)
    rows = list(db.scalars(select(ScanLog).where(
        ScanLog.scanned_at < cutoff,
        ScanLog.archived_batch_id.is_(None),
    ).order_by(ScanLog.id).limit(100000)))
    if not rows:
        return 0

    archive_dir = Path(settings.scan_archive_dir)
    archive_dir.mkdir(parents=True, exist_ok=True)
    batch = ScanArchiveBatch(
        archive_path="pending",
        cutoff_at=cutoff,
        row_count=len(rows),
        status="creating",
        created_at=now,
        delete_after=now + timedelta(hours=settings.scan_archive_delete_delay_hours),
    )
    db.add(batch)
    db.flush()

    filename = f"scan-logs-{now:%Y%m%dT%H%M%SZ}-batch-{batch.id}.zip"
    final_path = archive_dir / filename
    temp_path = archive_dir / f".{filename}.tmp"
    ids = [row.id for row in rows]
    manifest = {
        "batch_id": batch.id,
        "created_at": now.isoformat(),
        "cutoff_at": cutoff.isoformat(),
        "delete_after": batch.delete_after.isoformat(),
        "row_count": len(rows),
        "scan_log_ids": ids,
    }
    with zipfile.ZipFile(temp_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        content = "\n".join(json.dumps(_serialize(row), ensure_ascii=False) for row in rows) + "\n"
        zf.writestr("scan_logs.jsonl", content)
    with zipfile.ZipFile(temp_path, "r") as zf:
        if zf.testzip() is not None:
            raise RuntimeError("생성된 로그 보관 ZIP 검증에 실패했습니다.")
    temp_path.replace(final_path)

    batch.archive_path = str(final_path)
    batch.status = "ready"
    for row in rows:
        row.archived_batch_id = batch.id
    db.commit()
    return len(rows)


def run_once() -> None:
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        delete_confirmed_archives(db)
        archive_expired_logs(db)


if __name__ == "__main__":
    while True:
        try:
            run_once()
        except Exception as exc:
            print(f"[maintenance] {exc}", flush=True)
        time.sleep(60 * 60)
