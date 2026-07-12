import hashlib
from datetime import timezone

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import CollectorToken, User, utcnow


def optional_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    return db.get(User, int(user_id))


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user = optional_user(request, db)
    if user is None or not user.is_verified:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


def current_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다.")
    return user


def collector_user(request: Request, db: Session = Depends(get_db)) -> User:
    authorization = request.headers.get("authorization", "")
    scheme, _, raw_token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not raw_token:
        raise HTTPException(status_code=401, detail="확장 프로그램 연결이 필요합니다.")
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    token = db.scalar(select(CollectorToken).where(CollectorToken.token_hash == token_hash))
    now = utcnow()
    if token is None or token.revoked_at is not None:
        raise HTTPException(status_code=401, detail="확장 프로그램 연결 토큰이 유효하지 않습니다.")
    expires_at = token.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= now:
        raise HTTPException(status_code=401, detail="확장 프로그램 연결이 만료되었습니다. 웹 앱에 다시 로그인하세요.")
    user = db.get(User, token.user_id)
    if user is None or not user.is_verified:
        raise HTTPException(status_code=401, detail="사용자 계정을 확인할 수 없습니다.")
    token.last_used_at = now
    db.flush()
    return user
