"""Authorize PC deletion targets and reconcile only verified selected rows."""
import hashlib
import json
import re

from fastapi import APIRouter, Depends, HTTPException
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel, Field, PositiveInt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.dependencies import collector_user
from app.models import Activity, User

router = APIRouter(prefix="/api/collector/youtube")


class DeleteSelection(BaseModel):
    activity_ids: list[PositiveInt] = Field(min_length=1, max_length=100)


class DeleteConfirmation(DeleteSelection):
    receipt: str = Field(min_length=1, max_length=30000)
    verification_complete: bool = False


def signer():
    return URLSafeTimedSerializer(get_settings().session_secret, salt="pc-youtube-delete-v1")


def fingerprint(row: Activity) -> str:
    return hashlib.sha256(json.dumps([
        row.user_id, row.external_id, row.content, row.source_url,
        row.metadata_json, str(row.imported_at),
    ], ensure_ascii=False).encode()).hexdigest()


def youtube_target(row: Activity) -> dict | None:
    if row.platform != "youtube" or row.activity_type != "comment":
        return None
    try:
        meta = json.loads(row.metadata_json)
    except (TypeError, ValueError):
        return None
    if not isinstance(meta, dict) or meta.get("ownership_verified") is not True:
        return None
    if meta.get("youtube_activity_kind", "comment") != "comment":
        return None
    comment_id = meta.get("comment_id")
    if not isinstance(comment_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,500}", comment_id):
        return None
    title, _, content = row.content.partition("\n")
    return {"id": str(row.id), "commentId": comment_id, "activityKind": "comment",
            "title": title, "content": content, "strictMatch": True}


@router.post("/delete-targets")
def delete_targets(payload: DeleteSelection, db: Session = Depends(get_db), user: User = Depends(collector_user)):
    ids = list(dict.fromkeys(payload.activity_ids))
    rows = list(db.scalars(select(Activity).where(Activity.user_id == user.id, Activity.id.in_(ids))))
    if len(rows) != len(ids):
        raise HTTPException(404, "선택한 기록이 변경되었습니다. 대시보드를 새로고침하세요.")
    targets = [youtube_target(row) for row in rows]
    if any(target is None for target in targets):
        raise HTTPException(400, "본인 유튜브 댓글 ID를 확인할 수 있는 항목만 삭제할 수 있습니다. 먼저 다시 조회하세요.")
    receipt = signer().dumps({"user": user.id, "rows": {str(row.id): fingerprint(row) for row in rows}})
    db.commit()
    return {"ok": True, "targets": targets, "receipt": receipt}


@router.post("/delete-confirm")
def delete_confirm(payload: DeleteConfirmation, db: Session = Depends(get_db), user: User = Depends(collector_user)):
    try:
        approved = signer().loads(payload.receipt, max_age=3600)
    except BadSignature as error:
        raise HTTPException(400, "삭제 확인 요청이 만료되었거나 유효하지 않습니다.") from error
    ids = list(dict.fromkeys(payload.activity_ids))
    if (approved.get("user") != user.id or not payload.verification_complete
            or any(str(id_) not in approved.get("rows", {}) for id_ in ids)):
        raise HTTPException(400, "선택한 댓글의 삭제 확인이 필요합니다.")
    # Serialize with collection replacement for the same user.
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    removed = []
    for row in db.scalars(select(Activity).where(Activity.user_id == user.id, Activity.id.in_(ids))):
        if fingerprint(row) == approved["rows"][str(row.id)]:
            removed.append(row.id)
            db.delete(row)
    db.commit()
    return {"ok": True, "removed_ids": removed}
