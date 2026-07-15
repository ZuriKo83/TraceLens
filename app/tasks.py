from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import parse_qs, urlparse

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db import engine
from app.models import Activity, ScanLog, User, utcnow
from app.schemas import CollectorImport
from app.supported_sites import EXCLUDED_PLATFORMS, VISIBLE_ACTIVITY_TYPES


def _normalized_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip().lower()


def _youtube_source_identity(source_url: str | None, metadata: dict | None = None) -> tuple[str, str]:
    metadata = metadata or {}
    post_id = str(metadata.get("post_id") or metadata.get("youtube_post_id") or "").strip()
    if post_id:
        return "post", post_id
    video_id = str(metadata.get("video_id") or metadata.get("youtube_video_id") or "").strip()
    if video_id:
        return "video", video_id
    try:
        source = urlparse(source_url or "")
    except ValueError:
        return "", ""
    post_match = re.match(r"^/post/([^/?#]+)", source.path or "", re.I)
    if post_match:
        return "post", post_match.group(1)
    query_id = parse_qs(source.query).get("v", [""])[0]
    if query_id:
        return "video", query_id
    video_match = re.match(r"^/(?:shorts|live|embed|v)/([^/?#]+)", source.path or "", re.I)
    return ("video", video_match.group(1)) if video_match else ("", "")


def _youtube_source_key(source_url: str | None, metadata: dict | None = None) -> str:
    kind, source_id = _youtube_source_identity(source_url, metadata)
    if not source_id:
        return ""
    return f"post:{source_id}" if kind == "post" else source_id


def _fingerprint(platform: str, item, *, omit_youtube_source: bool = False) -> str:
    platform = platform.strip().lower()
    activity_type = item.activity_type.strip().lower()
    title = _normalized_text(item.title)
    content = _normalized_text(item.content)
    if platform == "youtube":
        metadata = item.metadata or {}
        comment_id = str(metadata.get("comment_id") or metadata.get("youtube_comment_id") or "").strip()
        if comment_id:
            normalized = f"youtube|{activity_type}|{comment_id}"
        else:
            source_key = "" if omit_youtube_source else _youtube_source_key(item.source_url, metadata)
            normalized = f"youtube|{activity_type}|{source_key}|{title}|{content}"
    else:
        normalized = "|".join([
            platform,
            activity_type,
            (item.source_url or "").strip(),
            title,
            content,
            item.external_id.strip(),
        ])
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _fingerprint_candidates(platform: str, item) -> list[str]:
    primary = _fingerprint(platform, item)
    candidates = [primary]
    if platform.strip().lower() == "youtube":
        fallback = _fingerprint(platform, item, omit_youtube_source=True)
        if fallback != primary:
            candidates.append(fallback)
    return candidates


def _load_metadata(raw: str | None) -> dict:
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def _activity_youtube_source_key(activity: Activity) -> str:
    return _youtube_source_key(activity.source_url, _load_metadata(activity.metadata_json))


def _merged_metadata(existing: Activity, item) -> dict:
    previous = _load_metadata(existing.metadata_json)
    incoming = dict(item.metadata or {})
    merged = {**previous, **incoming}
    if item.source_url:
        return merged
    if existing.source_url:
        source_kind, source_id = _youtube_source_identity(existing.source_url, previous)
        merged["original_url"] = existing.source_url
        merged["original_link_resolved"] = True
        merged["original_link_status"] = "preserved"
        merged["source_type"] = source_kind or merged.get("source_type")
        merged["source_id"] = source_id or merged.get("source_id")
        if source_kind == "video" and source_id:
            merged["video_id"] = source_id
        if source_kind == "post" and source_id:
            merged["post_id"] = source_id
            merged["youtube_post_id"] = source_id
        locator = merged.get("deletion_locator")
        if isinstance(locator, dict):
            locator = dict(locator)
            locator["source_type"] = source_kind or locator.get("source_type")
            locator["source_id"] = source_id or locator.get("source_id")
            locator["source_url"] = existing.source_url
            if source_kind == "video" and source_id:
                locator["video_id"] = source_id
                locator["video_url"] = existing.source_url
            if source_kind == "post" and source_id:
                locator["post_id"] = source_id
                locator["post_url"] = existing.source_url
            merged["deletion_locator"] = locator
    return merged


def _verified_self_activity(platform: str, item) -> bool:
    metadata = item.metadata or {}
    if platform in {"instagram", "facebook", "threads"}:
        return bool(metadata.get("ownership_verified"))
    return True


def _youtube_activity_kind(activity: Activity) -> str:
    metadata = _load_metadata(activity.metadata_json)
    kind = str(metadata.get("youtube_activity_kind") or "").strip().lower()
    if kind:
        return kind
    title = (activity.content or "").lstrip()
    return "live_chat" if title.startswith("[실시간 채팅]") else "comment"


def _prune_complete_youtube_snapshot(
    db: Session,
    *,
    user_id: int,
    payload: CollectorImport,
    account: str | None,
    snapshot_fingerprints: set[str],
) -> int:
    if payload.platform != "youtube" or payload.status != "success" or not payload.snapshot_complete:
        return 0
    if payload.scan_scope not in {"comment", "live_chat"}:
        return 0

    stmt = select(Activity).where(
        Activity.user_id == user_id,
        Activity.platform == "youtube",
        Activity.status == "visible",
    )
    if account is None:
        stmt = stmt.where(Activity.account_label.is_(None))
    else:
        stmt = stmt.where(Activity.account_label == account)

    removed = 0
    for activity in db.scalars(stmt):
        if _youtube_activity_kind(activity) != payload.scan_scope:
            continue
        fingerprint = (activity.content_fingerprint or "").strip()
        if not fingerprint or fingerprint in snapshot_fingerprints:
            continue
        db.delete(activity)
        removed += 1
    return removed


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
            fp = _fingerprint(payload.platform, item)
            ext = item.external_id[:500]
            if fp in seen_fp or ext in seen_ext:
                continue
            seen_fp.add(fp)
            seen_ext.add(ext)
            accepted.append(item)

        prepared = [(item, _fingerprint_candidates(payload.platform, item), item.external_id[:500]) for item in accepted]
        snapshot_fingerprints = {fingerprint for _, candidates, _ in prepared for fingerprint in candidates}
        by_ext, by_fp = {}, {}
        if prepared:
            fps = list(snapshot_fingerprints)
            exts = list({ext for _, _, ext in prepared})
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
        for item, fp_candidates, ext in prepared:
            item_account = str((item.metadata or {}).get("account_label") or account or "").strip()[:160] or None
            primary_fp = fp_candidates[0]
            existing = by_ext.get(ext) or by_fp.get(primary_fp)
            if existing is None and len(fp_candidates) > 1:
                fallback = by_fp.get(fp_candidates[1])
                if fallback is not None and not _activity_youtube_source_key(fallback):
                    existing = fallback
            content = "\n".join(part for part in [item.title.strip(), item.content.strip()] if part).strip()
            if existing:
                source_url = item.source_url
                if payload.platform == "youtube" and not source_url:
                    source_url = existing.source_url
                metadata = _merged_metadata(existing, item) if payload.platform == "youtube" else dict(item.metadata or {})
                existing.activity_type = item.activity_type
                existing.content = content
                existing.source_url = source_url
                existing.occurred_at = item.occurred_at
                existing.metadata_json = json.dumps(metadata, ensure_ascii=False, default=str)
                existing.status = "visible"
                existing.delete_mode = "none"
                existing.collector_email = user.email
                existing.account_label = item_account
                existing.content_fingerprint = primary_fp
                updated += 1
            else:
                db.add(Activity(
                    user_id=user.id,
                    platform=payload.platform,
                    activity_type=item.activity_type,
                    external_id=ext,
                    content=content,
                    source_url=item.source_url,
                    occurred_at=item.occurred_at,
                    delete_mode="none",
                    status="visible",
                    metadata_json=json.dumps(item.metadata, ensure_ascii=False, default=str),
                    collector_email=user.email,
                    account_label=item_account,
                    content_fingerprint=primary_fp,
                    imported_at=now,
                ))
                imported += 1

        pruned = _prune_complete_youtube_snapshot(
            db,
            user_id=user.id,
            payload=payload,
            account=account,
            snapshot_fingerprints=snapshot_fingerprints,
        )

        message = payload.message
        if payload.items and not accepted:
            message = "본인이 작성한 게시글·댓글·질문·답변으로 확인되지 않은 기록은 제외했습니다."
        if pruned:
            message = f"{message} 삭제가 확인된 기존 기록 {pruned}개를 보관함에서 제거했습니다.".strip()
        db.add(ScanLog(
            user_id=user.id,
            platform=payload.platform,
            source_url=payload.source_url,
            status=payload.status,
            found_count=len(accepted),
            imported_count=imported,
            message=message,
            collector_email=user.email,
            account_label=account,
            scan_scope=payload.scan_scope,
            scanned_at=now,
        ))
        db.commit()
        return {
            "ok": True,
            "platform": payload.platform,
            "found": len(accepted),
            "imported": imported,
            "updated": updated,
            "pruned": pruned,
            "ignored": len(payload.items) - len(accepted),
            "account_label": account,
            "user": user.email,
        }
