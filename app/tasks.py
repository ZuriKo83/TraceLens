from __future__ import annotations

import hashlib
import json
from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db import engine
from app.models import Activity, ScanLog, User, utcnow
from app.schemas import CollectorImport
from app.supported_sites import EXCLUDED_PLATFORMS, VISIBLE_ACTIVITY_TYPES


def _fingerprint(platform: str, item) -> str:
    normalized = "|".join([
        platform.strip().lower(),
        item.activity_type.strip().lower(),
        (item.source_url or "").strip(),
        item.title.strip(),
        item.content.strip(),
        item.external_id.strip(),
    ])
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _verified_self_activity(platform: str, item) -> bool:
    metadata = item.metadata or {}
    if platform in {"instagram", "facebook", "threads"}:
        return bool(metadata.get("ownership_verified"))
    return True


def process_collector_import(payload_data: dict, user_id: int) -> dict:
    payload = CollectorImport.model_validate(payload_data)
    with Session(engine) as db:
        user = db.get(User, user_id)
        if not user or user.deleted_at is not None:
            raise RuntimeError("사용자 계정을 찾을 수 없습니다.")

        raw = [] if payload.platform in EXCLUDED_PLATFORMS else [
            item for item in payload.items
            if item.activity_type in VISIBLE_ACTIVITY_TYPES and _verified_self_activity(payload.platform, item)
        ]
        accepted = []
        seen_fp, seen_ext = set(), set()
        for item in raw:
            fp, ext = _fingerprint(payload.platform, item), item.external_id[:500]
            if fp in seen_fp or ext in seen_ext:
                continue
            seen_fp.add(fp); seen_ext.add(ext); accepted.append(item)

        by_ext, by_fp = {}, {}
        if accepted:
            fps = [_fingerprint(payload.platform, item) for item in accepted]
            exts = [item.external_id[:500] for item in accepted]
            rows = list(db.scalars(select(Activity).where(
                Activity.user_id == user.id,
                Activity.platform == payload.platform,
                or_(Activity.external_id.in_(exts), Activity.content_fingerprint.in_(fps)),
            ).order_by(Activity.id.desc())))
            for row in rows:
                by_ext.setdefault(row.external_id, row)
                if row.content_fingerprint:
                    by_fp.setdefault(row.content_fingerprint, row)

        imported = updated = 0
        now = utcnow()
        account = (payload.account_label or "").strip()[:160] or None
        for item in accepted:
            item_account = str((item.metadata or {}).get("account_label") or account or "").strip()[:160] or None
            fp, ext = _fingerprint(payload.platform, item), item.external_id[:500]
            existing = by_ext.get(ext) or by_fp.get(fp)
            content = "\n".join(part for part in [item.title.strip(), item.content.strip()] if part).strip()
            metadata_json = json.dumps(item.metadata, ensure_ascii=False, default=str)
            if existing:
                existing.activity_type = item.activity_type
                existing.content = content
                existing.source_url = item.source_url
                existing.occurred_at = item.occurred_at
                existing.metadata_json = metadata_json
                existing.status = "visible"
                existing.collector_email = user.email
                existing.account_label = item_account
                existing.content_fingerprint = fp
                updated += 1
            else:
                db.add(Activity(user_id=user.id, platform=payload.platform, activity_type=item.activity_type,
                    external_id=ext, content=content, source_url=item.source_url, occurred_at=item.occurred_at,
                    delete_mode="none", status="visible", metadata_json=metadata_json, collector_email=user.email,
                    account_label=item_account, content_fingerprint=fp, imported_at=now))
                imported += 1

        message = payload.message
        if payload.items and not accepted:
            message = "본인이 작성한 게시글·댓글·질문·답변으로 확인되지 않은 기록은 제외했습니다."
        db.add(ScanLog(user_id=user.id, platform=payload.platform, source_url=payload.source_url,
            status=payload.status, found_count=len(accepted), imported_count=imported, message=message,
            collector_email=user.email, account_label=account, scan_scope=payload.scan_scope, scanned_at=now))
        db.commit()
        return {"ok": True, "platform": payload.platform, "found": len(accepted), "imported": imported,
                "updated": updated, "ignored": len(payload.items)-len(accepted), "account_label": account,
                "user": user.email}
