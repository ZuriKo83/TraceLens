from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.community_models import (
    CommunityAuditLog,
    CommunityChatMessage,
    CommunityComment,
    CommunityNotification,
    CommunityPost,
    CommunityReaction,
    CommunityReport,
    CommunityUserRestriction,
)
from app.db import engine
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]
BACKUP_DIR = ROOT / "backups" / "community"
MODELS = [
    CommunityPost,
    CommunityComment,
    CommunityReaction,
    CommunityChatMessage,
    CommunityReport,
    CommunityNotification,
    CommunityAuditLog,
    CommunityUserRestriction,
]


def serialize(row):
    result = {}
    for column in row.__table__.columns:
        value = getattr(row, column.name)
        if hasattr(value, "isoformat"):
            value = value.isoformat()
        result[column.name] = value
    return result


def main() -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = BACKUP_DIR / f"community-{stamp}.json"
    payload = {"created_at": datetime.now(timezone.utc).isoformat(), "tables": {}}
    with Session(engine) as db:
        for model in MODELS:
            payload["tables"][model.__tablename__] = [serialize(row) for row in db.scalars(select(model))]
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
