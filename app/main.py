import hashlib
import json
import re
import secrets
import shutil
import httpx
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urlparse

from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import delete, func, inspect, or_, select, text
from sqlalchemy.orm import Session
from redis import Redis
from rq import Queue, Retry
from rq.job import Job

from app.config import get_settings
from app.db import Base, engine, get_db
from app.dependencies import collector_user, current_user
from app.models import Activity, AuthToken, CollectorToken, ScanArchiveBatch, ScanLog, User, UserEmail, VerificationCode, utcnow
from app.schemas import CollectorImport
from app.rate_limit import client_key, enforce_rate_limit
from app.redis_session import RedisSessionMiddleware
from app.supported_sites import (
    ACTIVITY_TYPE_LABELS,
    EXCLUDED_PLATFORMS,
    PLATFORM_LABELS,
    STATUS_LABELS,
    SUPPORTED_SITES,
    VISIBLE_ACTIVITY_TYPES,
)

settings = get_settings()
redis_connection = Redis.from_url(settings.redis_url)
collector_queue = Queue(settings.queue_name, connection=redis_connection, default_timeout=900)


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 320:
        raise ValueError("올바른 이메일 주소를 입력하세요.")
    return email


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${derived.hex()}"


def verify_password(password: str, encoded: str | None) -> bool:
    if not encoded:
        return False
    try:
        algorithm, n, r, p, salt_hex, digest_hex = encoded.split("$", 5)
        if algorithm != "scrypt":
            return False
        actual = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p), dklen=32)
        return secrets.compare_digest(actual.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def validate_password(password: str) -> None:
    if len(password) < 10 or len(password) > 128:
        raise ValueError("비밀번호는 10자 이상 128자 이하로 입력하세요.")
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        raise ValueError("비밀번호에는 영문과 숫자를 모두 포함하세요.")


def ensure_schema_columns() -> None:
    with engine.begin() as connection:
        inspector = inspect(connection)
        tables = set(inspector.get_table_names())
        if "users" in tables:
            columns = {column["name"] for column in inspector.get_columns("users")}
            if "is_admin" not in columns:
                connection.execute(text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0"))
            if "password_hash" not in columns:
                connection.execute(text("ALTER TABLE users ADD COLUMN password_hash VARCHAR(512)"))
            if "last_login_at" not in columns:
                connection.execute(text("ALTER TABLE users ADD COLUMN last_login_at DATETIME"))
            if "deleted_at" not in columns:
                connection.execute(text("ALTER TABLE users ADD COLUMN deleted_at DATETIME"))
        for table in ("activities", "scan_logs"):
            if table not in tables:
                continue
            columns = {column["name"] for column in inspector.get_columns(table)}
            if "collector_email" not in columns:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN collector_email VARCHAR(320)"))
            if "account_label" not in columns:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN account_label VARCHAR(160)"))
            if table == "activities" and "content_fingerprint" not in columns:
                connection.execute(text("ALTER TABLE activities ADD COLUMN content_fingerprint VARCHAR(64)"))
            if table == "scan_logs" and "scan_scope" not in columns:
                connection.execute(text("ALTER TABLE scan_logs ADD COLUMN scan_scope VARCHAR(80) NOT NULL DEFAULT 'default'"))
            if table == "scan_logs" and "archived_batch_id" not in columns:
                connection.execute(text("ALTER TABLE scan_logs ADD COLUMN archived_batch_id INTEGER"))

        # create_all() does not add new indexes to existing databases.
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_activities_user_imported ON activities (user_id, imported_at)"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_activities_platform_imported ON activities (platform, imported_at)"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_scan_logs_user_scanned ON scan_logs (user_id, scanned_at)"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_scan_logs_platform_scanned ON scan_logs (platform, scanned_at)"))


def bootstrap_users(db: Session) -> None:
    configured_admin_list = settings.admin_email_list
    configured_admins = set(configured_admin_list)
    first_admin = configured_admin_list[0] if configured_admin_list else None
    legacy = db.scalar(select(User).where(User.email == "local@digital-footprint.local"))
    if legacy and first_admin:
        target = db.scalar(select(User).where(User.email == first_admin))
        if target and target.id != legacy.id:
            db.execute(text("UPDATE activities SET user_id=:target WHERE user_id=:legacy"), {"target": target.id, "legacy": legacy.id})
            db.execute(text("UPDATE scan_logs SET user_id=:target WHERE user_id=:legacy"), {"target": target.id, "legacy": legacy.id})
            db.delete(legacy)
        else:
            legacy.email = first_admin
            legacy.is_verified = True
            legacy.is_admin = True

    for admin_email in configured_admin_list:
        user = db.scalar(select(User).where(User.email == admin_email))
        if user is None:
            user = User(email=admin_email, is_verified=True, is_admin=True)
            db.add(user)
            db.flush()
        else:
            user.is_admin = True
        email_row = db.scalar(select(UserEmail).where(UserEmail.email == admin_email))
        if email_row is None:
            db.add(UserEmail(user_id=user.id, email=admin_email, is_verified=True, is_primary=True, verified_at=utcnow()))

    users = list(db.scalars(select(User)))
    for user in users:
        if user.deleted_at is not None:
            continue
        primary = db.scalar(select(UserEmail).where(UserEmail.email == user.email))
        if primary is None:
            db.add(UserEmail(
                user_id=user.id,
                email=user.email,
                is_verified=user.is_verified,
                is_primary=True,
                verified_at=utcnow() if user.is_verified else None,
            ))

    # 관리자 권한은 ADMIN_EMAILS에 명시된 인증 이메일만 기준으로 동기화합니다.
    # 기존 DB에서 첫 가입자에게 부여됐던 관리자 권한도 여기서 자동 해제됩니다.
    for user in users:
        if user.deleted_at is not None:
            user.is_admin = False
            continue
        linked_emails = set(db.scalars(
            select(UserEmail.email).where(UserEmail.user_id == user.id)
        ))
        linked_emails.add(user.email)
        user.is_admin = bool(linked_emails & configured_admins)


def infer_scan_scope(scan: ScanLog) -> str:
    explicit = str(getattr(scan, "scan_scope", "") or "").strip().lower()
    if explicit and explicit != "default":
        return explicit
    message = (scan.message or "").lower()
    source = (scan.source_url or "").lower()
    if scan.platform == "naver_kin":
        if "답변" in message or "answer" in source:
            return "answer"
        if "질문" in message or "question" in source:
            return "question"
    if scan.platform == "facebook":
        if "댓글" in message or "commentscluster" in source:
            return "comment"
        if "게시글" in message or "내 게시물" in message or "yourposts" in source:
            return "post"
    if scan.platform == "threads":
        if "답글" in message or source.rstrip("/").endswith("/replies"):
            return "comment"
        if "게시글" in message:
            return "post"
    if scan.platform in {"instagram", "youtube"}:
        return "comment"
    if scan.platform in {"x", "naver_blog"}:
        return "post"
    return "default"


def backfill_and_dedupe_records(db: Session) -> None:
    # Backfill stable fingerprints so the same item is updated instead of inserted
    # again when a platform changes its temporary DOM identifier.
    for activity in db.scalars(select(Activity).order_by(Activity.id)):
        if not activity.content_fingerprint:
            class ItemView:
                activity_type = activity.activity_type
                title = ""
                content = activity.content
                source_url = activity.source_url
            activity.content_fingerprint = collector_item_fingerprint(activity.platform, ItemView())

    seen_activities: dict[tuple[int, str, str, str, str], int] = {}
    duplicate_activity_ids: list[int] = []
    for activity in db.scalars(select(Activity).order_by(Activity.id.desc())):
        key = (
            activity.user_id,
            activity.platform,
            activity.account_label or "",
            activity.activity_type,
            activity.content_fingerprint or "",
        )
        if key[-1] and key in seen_activities:
            duplicate_activity_ids.append(activity.id)
        else:
            seen_activities[key] = activity.id
    if duplicate_activity_ids:
        db.execute(delete(Activity).where(Activity.id.in_(duplicate_activity_ids)))

    for scan in db.scalars(select(ScanLog)):
        scan.scan_scope = infer_scan_scope(scan)


def cleanup_legacy_records(db: Session) -> None:
    db.execute(delete(Activity).where(Activity.platform.in_(EXCLUDED_PLATFORMS)))
    db.execute(delete(ScanLog).where(ScanLog.platform.in_(EXCLUDED_PLATFORMS)))
    db.execute(delete(Activity).where(
        Activity.platform == "instagram",
        ~Activity.metadata_json.contains('"comment_text_verified": true'),
    ))
    # Instagram changed the comments-management DOM. Remove records created by
    # older extractors so stale captions or incomplete rows are not shown as
    # the user's comments after upgrading to TraceLens v1.0.0.
    db.execute(delete(Activity).where(
        Activity.platform == "instagram",
        ~Activity.metadata_json.contains('"extractor_version": "1.0.0"'),
    ))
    db.execute(delete(Activity).where(
        Activity.platform == "facebook",
        ~Activity.metadata_json.contains('"ownership_verified": true'),
    ))
    db.execute(delete(Activity).where(
        Activity.platform == "x",
        Activity.metadata_json.contains('"extractor_version": "0.6.0"'),
    ))


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    ensure_schema_columns()
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        bootstrap_users(db)
        cleanup_legacy_records(db)
        backfill_and_dedupe_records(db)
        db.commit()
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.add_middleware(
    RedisSessionMiddleware,
    redis_url=settings.redis_url,
    secret_key=settings.session_secret,
    cookie_name=settings.session_cookie_name,
    same_site="lax",
    https_only=settings.secure_cookies,
    max_age=settings.session_max_age_seconds,
    prefix=settings.session_redis_prefix,
)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"chrome-extension://.*",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.middleware("http")
async def metrics_and_errors(request: Request, call_next):
    try:
        response = await call_next(request)
        if response.status_code >= 500:
            try:
                redis_connection.incr("metrics:errors:5m")
                redis_connection.expire("metrics:errors:5m", 300)
            except Exception:
                pass
        return response
    except Exception:
        try:
            redis_connection.incr("metrics:errors:5m")
            redis_connection.expire("metrics:errors:5m", 300)
        except Exception:
            pass
        raise


@app.middleware("http")
async def rate_limit_requests(request: Request, call_next):
    if request.method == "POST":
        path = request.url.path
        identity = client_key(request)
        if path in {"/auth/login", "/auth/signup/verify", "/auth/reset/verify"}:
            enforce_rate_limit("login", identity, settings.rate_limit_login_per_minute, 60)
        elif path in {"/auth/signup/request-code", "/auth/reset/request-code"}:
            enforce_rate_limit("verification", identity, settings.rate_limit_verification_per_hour, 3600)
        elif path == "/api/collector/import":
            token = request.headers.get("authorization", "")[-24:]
            enforce_rate_limit("collector", f"{identity}:{token}", settings.rate_limit_collector_per_minute, 60)
    return await call_next(request)

BASE_DIR = Path(__file__).resolve().parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def render(request: Request, name: str, **context):
    context.update({
        "request": request,
        "app_name": settings.app_name,
        "session_user": context.get("session_user") or get_session_user(request, context.get("db")),
        "csrf_token": csrf_token(request),
    })
    return templates.TemplateResponse(request=request, name=name, context=context)


def csrf_token(request: Request) -> str:
    token = request.session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(24)
        request.session["csrf_token"] = token
    return token


def require_csrf(request: Request, supplied: str) -> None:
    expected = request.session.get("csrf_token")
    if not expected or not secrets.compare_digest(expected, supplied or ""):
        raise HTTPException(status_code=400, detail="요청 검증에 실패했습니다. 페이지를 새로고침하세요.")


def get_session_user(request: Request, db: Session | None) -> User | None:
    if db is None:
        return None
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    user = db.get(User, int(user_id))
    if user is None or user.deleted_at is not None:
        request.session.clear()
        return None
    return user


def require_web_user(request: Request, db: Session) -> User | RedirectResponse:
    user = get_session_user(request, db)
    if user is None or not user.is_verified:
        return RedirectResponse(f"/login?next={quote(request.url.path)}", status_code=303)
    return user


def require_web_admin(request: Request, db: Session) -> User | RedirectResponse:
    user = require_web_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    if not user.is_admin:
        return RedirectResponse("/app", status_code=303)
    return user


def create_or_find_user(db: Session, email: str) -> User:
    linked = db.scalar(select(UserEmail).where(UserEmail.email == email))
    if linked:
        user = db.get(User, linked.user_id)
        if user is None:
            raise HTTPException(409, "연결된 사용자 계정을 찾을 수 없습니다.")
        return user
    user = db.scalar(select(User).where(User.email == email, User.deleted_at.is_(None)))
    if user:
        return user
    legacy = db.scalar(select(User).where(User.email == "local@digital-footprint.local"))
    real_user_count = db.scalar(select(func.count(User.id)).where(User.email != "local@digital-footprint.local")) or 0
    user = User(
        email=email,
        is_verified=False,
        is_admin=email in settings.admin_email_set,
    )
    db.add(user)
    db.flush()
    db.add(UserEmail(user_id=user.id, email=email, is_verified=False, is_primary=True))
    if legacy is not None and real_user_count == 0:
        db.execute(text("UPDATE activities SET user_id=:target WHERE user_id=:legacy"), {"target": user.id, "legacy": legacy.id})
        db.execute(text("UPDATE scan_logs SET user_id=:target WHERE user_id=:legacy"), {"target": user.id, "legacy": legacy.id})
        db.delete(legacy)
    return user


def make_magic_link(db: Session, user: User, email: str, purpose: str) -> str:
    raw = secrets.token_urlsafe(36)
    db.add(AuthToken(
        user_id=user.id,
        email=email,
        purpose=purpose,
        token_hash=hash_token(raw),
        expires_at=utcnow() + timedelta(minutes=settings.login_token_minutes),
    ))
    return f"{settings.public_base_url.rstrip('/')}/auth/verify?token={quote(raw)}"


def send_magic_email(recipient: str, link: str, purpose: str) -> bool:
    # Local development: the link is shown in the response, never emailed.
    return False


def create_verification_code(db: Session, user: User, email: str, purpose: str) -> str:
    now = utcnow()
    db.execute(delete(VerificationCode).where(
        VerificationCode.user_id == user.id,
        VerificationCode.purpose == purpose,
        VerificationCode.used_at.is_(None),
    ))
    code = f"{secrets.randbelow(1_000_000):06d}"
    db.add(VerificationCode(
        user_id=user.id,
        email=email,
        purpose=purpose,
        code_hash=hash_token(code),
        expires_at=now + timedelta(minutes=settings.verification_code_minutes),
    ))
    return code


def send_verification_code(recipient: str, code: str, purpose: str) -> bool:
    # Local development: the code is shown in the response, never emailed.
    return False


def consume_verification_code(db: Session, email: str, purpose: str, code: str) -> tuple[User | None, str | None]:
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        return None, "인증번호가 올바르지 않습니다."
    record = db.scalar(
        select(VerificationCode)
        .where(VerificationCode.user_id == user.id, VerificationCode.purpose == purpose, VerificationCode.used_at.is_(None))
        .order_by(VerificationCode.created_at.desc())
    )
    if record is None:
        return None, "인증번호를 다시 요청하세요."
    expires_at = record.expires_at if record.expires_at.tzinfo else record.expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= utcnow():
        return None, "인증번호가 만료되었습니다. 다시 요청하세요."
    if record.attempts >= settings.verification_max_attempts:
        return None, "인증 시도 횟수를 초과했습니다. 새 인증번호를 요청하세요."
    if not secrets.compare_digest(record.code_hash, hash_token(code.strip())):
        record.attempts += 1
        db.commit()
        return None, "인증번호가 올바르지 않습니다."
    record.used_at = utcnow()
    return user, None

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
        token_hash=hash_token(raw),
        label="Local browser collector",
        expires_at=now + timedelta(days=settings.collector_token_days),
    ))
    db.flush()
    return raw


def dashboard_data(db: Session, user_id: int, q: str, platform: str, activity_type: str, account_label: str):
    visible_filters = [
        Activity.user_id == user_id,
        Activity.activity_type.in_(VISIBLE_ACTIVITY_TYPES),
        Activity.platform.not_in(EXCLUDED_PLATFORMS),
    ]
    stmt = select(Activity).where(*visible_filters)
    if q:
        stmt = stmt.where(or_(Activity.content.ilike(f"%{q}%"), Activity.source_url.ilike(f"%{q}%")))
    if platform:
        stmt = stmt.where(Activity.platform == platform)
    if activity_type in VISIBLE_ACTIVITY_TYPES:
        stmt = stmt.where(Activity.activity_type == activity_type)
    if account_label:
        stmt = stmt.where(Activity.account_label == account_label)
    activities = list(db.scalars(stmt.order_by(Activity.occurred_at.desc().nullslast(), Activity.id.desc()).limit(500)))
    platforms = list(db.scalars(select(Activity.platform).where(*visible_filters).distinct().order_by(Activity.platform)))
    activity_types = list(db.scalars(select(Activity.activity_type).where(*visible_filters).distinct().order_by(Activity.activity_type)))
    accounts = list(db.scalars(
        select(Activity.account_label)
        .where(*visible_filters, Activity.account_label.is_not(None), Activity.account_label != "")
        .distinct().order_by(Activity.account_label)
    ))

    # Keep the activity archive compact by grouping records by platform/account.
    # Native <details> elements in the template let users expand only the group
    # they need without losing access to individual source links.
    activity_group_map: dict[tuple[str, str], dict] = {}
    activity_type_order = {"post": 0, "comment": 1, "question": 2, "answer": 3, "question_or_answer": 4}
    for activity in activities:
        key = (activity.platform, activity.account_label or "")
        group = activity_group_map.get(key)
        if group is None:
            group = {
                "platform": activity.platform,
                "account_label": activity.account_label or "",
                "activities": [],
                "type_count_map": {},
                "latest_at": activity.occurred_at or activity.imported_at,
            }
            activity_group_map[key] = group
        group["activities"].append(activity)
        group["type_count_map"][activity.activity_type] = group["type_count_map"].get(activity.activity_type, 0) + 1
        candidate_at = activity.occurred_at or activity.imported_at
        if candidate_at and (group["latest_at"] is None or candidate_at > group["latest_at"]):
            group["latest_at"] = candidate_at
    activity_groups = []
    for group in activity_group_map.values():
        group["total"] = len(group["activities"])
        group["type_counts"] = [
            {"type": value, "label": ACTIVITY_TYPE_LABELS.get(value, value), "count": count}
            for value, count in sorted(
                group["type_count_map"].items(),
                key=lambda pair: (activity_type_order.get(pair[0], 99), pair[0]),
            )
        ]
        activity_groups.append(group)
    activity_groups.sort(key=lambda group: group["latest_at"] or utcnow(), reverse=True)

    raw_scans = list(db.scalars(
        select(ScanLog).where(ScanLog.user_id == user_id, ScanLog.platform.not_in(EXCLUDED_PLATFORMS))
        .order_by(ScanLog.scanned_at.desc(), ScanLog.id.desc()).limit(160)
    ))
    scope_labels = {
        "post": "게시글",
        "comment": "댓글",
        "question": "질문",
        "answer": "답변",
        "default": "전체",
    }
    scope_order = {"post": 0, "comment": 1, "question": 2, "answer": 3, "default": 9}
    scan_group_map: dict[tuple[str, str], dict] = {}
    seen_scan_scopes: set[tuple[str, str, str]] = set()
    for scan in raw_scans:
        scope = infer_scan_scope(scan)
        scope_key = (scan.platform, scan.account_label or "", scope)
        if scope_key in seen_scan_scopes:
            continue
        seen_scan_scopes.add(scope_key)
        group_key = (scan.platform, scan.account_label or "")
        group = scan_group_map.get(group_key)
        if group is None:
            group = {
                "platform": scan.platform,
                "account_label": scan.account_label or "",
                "entries": [],
                "latest_at": scan.scanned_at,
            }
            scan_group_map[group_key] = group
        group["entries"].append({
            "scope": scope,
            "scope_label": scope_labels.get(scope, scope),
            "status": scan.status,
            "status_label": STATUS_LABELS.get(scan.status, scan.status),
            "found_count": scan.found_count,
            "imported_count": scan.imported_count,
            "message": scan.message,
            "scanned_at": scan.scanned_at,
        })
        if scan.scanned_at and scan.scanned_at > group["latest_at"]:
            group["latest_at"] = scan.scanned_at

    scan_groups = []
    for group in scan_group_map.values():
        group["entries"].sort(key=lambda entry: scope_order.get(entry["scope"], 99))
        statuses = {entry["status"] for entry in group["entries"]}
        if statuses == {"success"}:
            group_status = "success"
        elif "success" in statuses or "partial" in statuses:
            group_status = "partial"
        elif "error" in statuses:
            group_status = "error"
        elif "login_required" in statuses:
            group_status = "login_required"
        else:
            group_status = next(iter(statuses), "partial")
        group["status"] = group_status
        group["status_label"] = STATUS_LABELS.get(group_status, group_status)
        group["found_total"] = sum(entry["found_count"] for entry in group["entries"])
        group["imported_total"] = sum(entry["imported_count"] for entry in group["entries"])
        scan_groups.append(group)
    scan_groups.sort(key=lambda group: group["latest_at"], reverse=True)
    scan_groups = scan_groups[:12]

    return {
        "activities": activities,
        "activity_groups": activity_groups,
        "activity_group_count": len(activity_groups),
        "platforms": platforms,
        "activity_types": activity_types,
        "accounts": accounts,
        "scan_groups": scan_groups,
        "total": db.scalar(select(func.count(Activity.id)).where(*visible_filters)) or 0,
        "comment_count": db.scalar(select(func.count(Activity.id)).where(*visible_filters, Activity.activity_type == "comment")) or 0,
        "post_count": db.scalar(select(func.count(Activity.id)).where(*visible_filters, Activity.activity_type == "post")) or 0,
        "answer_count": db.scalar(select(func.count(Activity.id)).where(*visible_filters, Activity.activity_type.in_(["question", "answer", "question_or_answer"]))) or 0,
        "platform_count": db.scalar(select(func.count(func.distinct(Activity.platform))).where(*visible_filters)) or 0,
        "latest_scan": db.scalar(select(ScanLog.scanned_at).where(ScanLog.user_id == user_id, ScanLog.platform.not_in(EXCLUDED_PLATFORMS)).order_by(ScanLog.scanned_at.desc()).limit(1)),
    }


def is_verified_self_activity(platform: str, item) -> bool:
    if platform not in {"instagram", "facebook", "threads"}:
        return True
    metadata = item.metadata or {}
    captured_from = str(metadata.get("captured_from") or "")
    source_url = str(item.source_url or "")
    try:
        captured = urlparse(captured_from)
        source = urlparse(source_url)
    except ValueError:
        return False

    if platform == "instagram":
        return (
            item.activity_type == "comment"
            and metadata.get("ownership_scope") == "self_activity"
            and metadata.get("instagram_scope") == "self_comments"
            and metadata.get("comment_text_verified") is True
            and captured.hostname == "www.instagram.com"
            and captured.path.rstrip("/") == "/your_activity/interactions/comments"
            and source.hostname in {"www.instagram.com", "instagram.com"}
            and (source.path.startswith("/p/") or source.path.startswith("/reel/") or source.path.rstrip("/") == "/your_activity/interactions/comments")
        )

    if platform == "threads":
        owner = str(metadata.get("threads_owner") or "").lower().lstrip("@")
        actor = str(metadata.get("threads_actor") or "").lower().lstrip("@")
        return (
            item.activity_type in {"post", "comment"}
            and metadata.get("ownership_scope") == "self_activity"
            and metadata.get("ownership_verified") is True
            and bool(owner)
            and owner == actor
            and captured.hostname in {"www.threads.com", "threads.com"}
            and source.hostname in {"www.threads.com", "threads.com"}
            and bool(re.search(r"/@[^/]+/post/", source.path, re.I))
        )

    owner_kind = str(metadata.get("facebook_owner_kind") or "")
    owner_identity = str(metadata.get("facebook_owner_identity") or "").lower()
    actor_identity = str(metadata.get("facebook_actor_identity") or "").lower()
    common_checks = (
        metadata.get("ownership_scope") == "self_activity"
        and metadata.get("ownership_verified") is True
        and owner_kind in {"id", "slug"}
        and bool(owner_identity)
        and actor_identity == owner_identity
        and captured.hostname == "www.facebook.com"
        and bool(re.search(r"/(allactivity|activitylog|your_activity)", captured.path, re.I))
        and source.hostname in {"www.facebook.com", "facebook.com"}
    )
    if item.activity_type == "post":
        return common_checks and metadata.get("facebook_scope") == "authored_posts"
    if item.activity_type == "comment":
        return common_checks and metadata.get("facebook_scope") == "authored_comments"
    return False


def collector_item_fingerprint(platform: str, item) -> str:
    normalized_title = re.sub(r"\s+", " ", str(item.title or "")).strip().lower()
    normalized_content = re.sub(r"\s+", " ", str(item.content or "")).strip().lower()
    source = urlparse(str(item.source_url or ""))
    normalized_source = f"{source.hostname or ''}{source.path.rstrip('/')}"
    raw = f"{platform}|{item.activity_type}|{normalized_source}|{normalized_title}|{normalized_content}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@app.get("/", response_class=HTMLResponse)
def landing(request: Request, db: Session = Depends(get_db)):
    user = get_session_user(request, db)
    return render(request, "index.html", db=db, session_user=user, supported_sites=SUPPORTED_SITES)


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request, next: str = "/app", db: Session = Depends(get_db)):
    if get_session_user(request, db):
        return RedirectResponse(next if next.startswith("/") else "/app", status_code=303)
    return render(request, "login.html", db=db, next_path=next)


@app.post("/auth/login", response_class=HTMLResponse)
def password_login(
    request: Request, email: str = Form(...), password: str = Form(...),
    next_path: str = Form("/app"), csrf: str = Form(...), db: Session = Depends(get_db),
):
    require_csrf(request, csrf)
    try:
        normalized = normalize_email(email)
    except ValueError:
        normalized = ""
    user = db.scalar(select(User).where(User.email == normalized, User.deleted_at.is_(None))) if normalized else None
    if user is None or not user.is_verified or not verify_password(password, user.password_hash):
        return render(request, "login.html", db=db, next_path=next_path, email=email, error="이메일 또는 비밀번호가 올바르지 않습니다.")
    user.last_login_at = utcnow()
    request.session.clear()
    request.session["user_id"] = user.id
    request.session["csrf_token"] = secrets.token_urlsafe(24)
    db.commit()
    return RedirectResponse(next_path if next_path.startswith("/") else "/app", status_code=303)


@app.get("/signup", response_class=HTMLResponse)
def signup_page(request: Request, db: Session = Depends(get_db)):
    if get_session_user(request, db):
        return RedirectResponse("/app", status_code=303)
    return render(request, "signup.html", db=db)


@app.post("/auth/signup/request-code", response_class=HTMLResponse)
def signup_request_code(
    request: Request, email: str = Form(...), password: str = Form(...), password_confirm: str = Form(...),
    csrf: str = Form(...), db: Session = Depends(get_db),
):
    require_csrf(request, csrf)
    try:
        normalized = normalize_email(email)
        validate_password(password)
        if password != password_confirm:
            raise ValueError("비밀번호 확인이 일치하지 않습니다.")
    except ValueError as error:
        return render(request, "signup.html", db=db, email=email, error=str(error))
    user = db.scalar(select(User).where(User.email == normalized, User.deleted_at.is_(None)))
    if user and user.is_verified and user.password_hash:
        return render(request, "signup.html", db=db, email=normalized, error="이미 가입된 이메일입니다. 로그인하세요.")
    user = user or create_or_find_user(db, normalized)
    user.password_hash = hash_password(password)
    code = create_verification_code(db, user, normalized, "signup")
    try:
        delivered = send_verification_code(normalized, code, "signup")
    except Exception as error:
        print(f"[EMAIL ERROR] {error}")
        delivered = False
    db.commit()
    request.session["pending_signup_email"] = normalized
    return render(request, "verify_code.html", db=db, email=normalized, purpose="signup", delivered=delivered, dev_code=code if settings.debug_magic_links and not delivered else None)


@app.post("/auth/signup/verify", response_class=HTMLResponse)
def signup_verify(request: Request, email: str = Form(...), code: str = Form(...), csrf: str = Form(...), db: Session = Depends(get_db)):
    require_csrf(request, csrf)
    normalized = normalize_email(email)
    user, error = consume_verification_code(db, normalized, "signup", code)
    if error or user is None:
        return render(request, "verify_code.html", db=db, email=normalized, purpose="signup", error=error)
    user.is_verified = True
    user.is_admin = normalized in settings.admin_email_set
    email_row = db.scalar(select(UserEmail).where(UserEmail.email == normalized))
    if email_row:
        email_row.is_verified = True
        email_row.verified_at = utcnow()
    user.last_login_at = utcnow()
    request.session.clear()
    request.session["user_id"] = user.id
    request.session["csrf_token"] = secrets.token_urlsafe(24)
    db.commit()
    return RedirectResponse("/app", status_code=303)


@app.get("/forgot-password", response_class=HTMLResponse)
def forgot_password_page(request: Request, db: Session = Depends(get_db)):
    return render(request, "forgot_password.html", db=db)


@app.post("/auth/password/request-code", response_class=HTMLResponse)
def password_request_code(request: Request, email: str = Form(...), csrf: str = Form(...), db: Session = Depends(get_db)):
    require_csrf(request, csrf)
    try:
        normalized = normalize_email(email)
    except ValueError as error:
        return render(request, "forgot_password.html", db=db, email=email, error=str(error))
    user = db.scalar(select(User).where(User.email == normalized, User.is_verified.is_(True), User.deleted_at.is_(None)))
    code = None
    delivered = False
    if user:
        code = create_verification_code(db, user, normalized, "reset_password")
        try:
            delivered = send_verification_code(normalized, code, "reset_password")
        except Exception as error:
            print(f"[EMAIL ERROR] {error}")
        db.commit()
    request.session["pending_reset_email"] = normalized
    return render(request, "reset_password.html", db=db, email=normalized, delivered=delivered, dev_code=code if code and settings.debug_magic_links and not delivered else None)


@app.post("/auth/password/reset", response_class=HTMLResponse)
def password_reset(
    request: Request, email: str = Form(...), code: str = Form(...), password: str = Form(...),
    password_confirm: str = Form(...), csrf: str = Form(...), db: Session = Depends(get_db),
):
    require_csrf(request, csrf)
    normalized = normalize_email(email)
    try:
        validate_password(password)
        if password != password_confirm:
            raise ValueError("비밀번호 확인이 일치하지 않습니다.")
    except ValueError as error:
        return render(request, "reset_password.html", db=db, email=normalized, error=str(error))
    user, error = consume_verification_code(db, normalized, "reset_password", code)
    if error or user is None:
        return render(request, "reset_password.html", db=db, email=normalized, error=error)
    user.password_hash = hash_password(password)
    db.execute(delete(CollectorToken).where(CollectorToken.user_id == user.id))
    db.commit()
    request.session.clear()
    return RedirectResponse("/login?reset=1", status_code=303)


@app.get("/auth/verify")
def verify_magic_link(token: str, request: Request, db: Session = Depends(get_db)):
    record = db.scalar(select(AuthToken).where(AuthToken.token_hash == hash_token(token)))
    if record is None or record.used_at is not None:
        raise HTTPException(400, "유효하지 않거나 이미 사용한 인증 링크입니다.")
    expires_at = record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= utcnow():
        raise HTTPException(400, "인증 링크가 만료되었습니다. 다시 요청하세요.")
    user = db.get(User, record.user_id)
    if user is None:
        raise HTTPException(400, "사용자 계정을 찾을 수 없습니다.")
    email_row = db.scalar(select(UserEmail).where(UserEmail.email == record.email))
    if email_row is None:
        email_row = UserEmail(user_id=user.id, email=record.email, is_primary=record.email == user.email)
        db.add(email_row)
    email_row.is_verified = True
    email_row.verified_at = utcnow()
    if record.email == user.email:
        user.is_verified = True
    if record.email in settings.admin_email_set:
        user.is_admin = True
    record.used_at = utcnow()
    next_path = request.session.get("login_next") or "/app"
    request.session.clear()
    request.session["user_id"] = user.id
    request.session["csrf_token"] = secrets.token_urlsafe(24)
    db.commit()
    return RedirectResponse(next_path if str(next_path).startswith("/") else "/app", status_code=303)


@app.post("/logout")
def logout(request: Request, csrf: str = Form(...)):
    require_csrf(request, csrf)
    request.session.clear()
    return RedirectResponse("/", status_code=303)


@app.get("/dashboard")
def legacy_dashboard(request: Request, db: Session = Depends(get_db)):
    user = get_session_user(request, db)
    if user is None:
        return RedirectResponse("/login", status_code=303)
    return RedirectResponse("/admin" if user.is_admin else "/app", status_code=303)


@app.get("/app", response_class=HTMLResponse)
def user_dashboard(
    request: Request,
    q: str = "",
    platform: str = "",
    activity_type: str = "",
    account_label: str = "",
    db: Session = Depends(get_db),
):
    user = require_web_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    extension_token = issue_collector_token(db, user)
    request.session["browser_collector_token"] = extension_token
    data = dashboard_data(db, user.id, q, platform, activity_type, account_label)
    db.commit()
    site_summary = {
        "automatic": sum(1 for site in SUPPORTED_SITES if site.get("tier") == "automatic"),
        "manual": sum(1 for site in SUPPORTED_SITES if site.get("tier") == "manual"),
    }
    return render(
        request,
        "user_dashboard.html",
        db=db,
        session_user=user,
        user=user,
        extension_token=extension_token,
        extension_server=settings.public_base_url.rstrip("/"),
        extension_store_url=settings.extension_store_url.strip(),
        supported_sites=SUPPORTED_SITES,
        site_summary=site_summary,
        platform_labels=PLATFORM_LABELS,
        activity_type_labels=ACTIVITY_TYPE_LABELS,
        status_labels=STATUS_LABELS,
        q=q,
        selected_platform=platform,
        selected_activity_type=activity_type,
        selected_account_label=account_label,
        **data,
    )


SITE_BROWSER_LABELS = {
    "youtube": "YouTube", "instagram": "Instagram", "threads": "Threads",
    "facebook": "Facebook", "x": "X", "naver_blog": "네이버 블로그", "naver_kin": "네이버 지식iN",
}


@app.get("/app/site", response_class=HTMLResponse)
def browser_site(request: Request, site: str, db: Session = Depends(get_db)):
    user = require_web_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    if site not in SITE_BROWSER_LABELS:
        raise HTTPException(404, "지원하지 않는 사이트입니다.")
    if not request.session.get("browser_collector_token"):
        request.session["browser_collector_token"] = issue_collector_token(db, user)
        db.commit()
    return render(request, "browser_site.html", db=db, session_user=user, site=site, site_label=SITE_BROWSER_LABELS[site])


@app.get("/api/browser/health")
async def browser_health(user: User = Depends(current_user)):
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{settings.browser_collector_url.rstrip('/')}/health")
            response.raise_for_status()
        return {"ok": True}
    except httpx.HTTPError as exc:
        raise HTTPException(503, "서버의 수집기를 시작하지 못했습니다.") from exc


@app.post("/api/browser/{action}")
async def browser_command(action: str, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if action not in {"open", "frame", "input", "scan"}:
        raise HTTPException(404, "지원하지 않는 요청입니다.")
    require_csrf(request, request.headers.get("x-tracelens-csrf", ""))
    data = await request.body()
    if len(data) > 8192:
        raise HTTPException(413, "요청 크기가 너무 큽니다.")
    token = request.session.get("browser_collector_token")
    if not token:
        token = issue_collector_token(db, user)
        db.commit()
        request.session["browser_collector_token"] = token
    try:
        timeout = 900 if action == "scan" else 50
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{settings.browser_collector_url.rstrip('/')}/{action}",
                content=data,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            )
        response_headers = {"Cache-Control": "no-store"}
        if action == "frame" and response.headers.get("x-frame-revision"):
            response_headers["X-Frame-Revision"] = response.headers["x-frame-revision"]
        return Response(content=response.content, status_code=response.status_code,
                        media_type=response.headers.get("content-type", "application/json"),
                        headers=response_headers)
    except httpx.HTTPError as exc:
        raise HTTPException(503, "서버의 수집기에 연결할 수 없습니다.") from exc


@app.get("/app/account", response_class=HTMLResponse)
def account_page(request: Request, db: Session = Depends(get_db)):
    user = require_web_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    emails = list(db.scalars(select(UserEmail).where(UserEmail.user_id == user.id).order_by(UserEmail.is_primary.desc(), UserEmail.created_at)))
    return render(request, "account.html", db=db, session_user=user, user=user, emails=emails)


@app.post("/app/account/emails", response_class=HTMLResponse)
def add_connected_email(
    request: Request,
    email: str = Form(...),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
    require_csrf(request, csrf)
    user = require_web_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    try:
        normalized = normalize_email(email)
    except ValueError as error:
        emails = list(db.scalars(select(UserEmail).where(UserEmail.user_id == user.id)))
        return render(request, "account.html", db=db, session_user=user, user=user, emails=emails, error=str(error))
    existing = db.scalar(select(UserEmail).where(UserEmail.email == normalized))
    if existing and existing.user_id != user.id:
        raise HTTPException(409, "다른 계정에서 이미 사용 중인 이메일입니다.")
    if existing and existing.is_verified:
        return RedirectResponse("/app/account", status_code=303)
    if existing is None:
        db.add(UserEmail(user_id=user.id, email=normalized, is_verified=False, is_primary=False))
    link = make_magic_link(db, user, normalized, "connect_email")
    try:
        sent = send_magic_email(normalized, link, "connect_email")
    except Exception as error:
        print(f"[EMAIL ERROR] {error}")
        sent = False
    db.commit()
    emails = list(db.scalars(select(UserEmail).where(UserEmail.user_id == user.id).order_by(UserEmail.is_primary.desc(), UserEmail.created_at)))
    return render(
        request,
        "account.html",
        db=db,
        session_user=user,
        user=user,
        emails=emails,
        sent_email=normalized,
        delivered=sent,
        dev_link=link if settings.debug_magic_links and not sent else None,
    )


@app.post("/app/account/delete")
def delete_account(
    request: Request,
    password: str = Form(...),
    confirmation: str = Form(...),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
    require_csrf(request, csrf)
    user = require_web_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    if confirmation.strip() != "회원탈퇴":
        emails = list(db.scalars(select(UserEmail).where(UserEmail.user_id == user.id)))
        return render(request, "account.html", db=db, session_user=user, user=user, emails=emails, delete_error="확인란에 회원탈퇴를 정확히 입력하세요.")
    if not verify_password(password, user.password_hash):
        emails = list(db.scalars(select(UserEmail).where(UserEmail.user_id == user.id)))
        return render(request, "account.html", db=db, session_user=user, user=user, emails=emails, delete_error="비밀번호가 올바르지 않습니다.")
    if user.email in settings.admin_email_set:
        emails = list(db.scalars(select(UserEmail).where(UserEmail.user_id == user.id)))
        return render(request, "account.html", db=db, session_user=user, user=user, emails=emails, delete_error="환경 변수 ADMIN_EMAILS에 등록된 관리자 계정은 먼저 관리자 설정에서 제거해야 탈퇴할 수 있습니다.")

    browser_token = request.session.get("browser_collector_token")
    if browser_token:
        try:
            with httpx.Client(timeout=15) as client:
                response = client.post(f"{settings.browser_collector_url.rstrip('/')}/purge", json={}, headers={"Authorization": f"Bearer {browser_token}"})
                if response.status_code == 409:
                    raise HTTPException(409, "조회가 끝난 뒤 탈퇴를 다시 시도하세요.")
        except httpx.HTTPError:
            pass
    shutil.rmtree(Path(settings.browser_profile_dir) / str(user.id), ignore_errors=True)

    now = utcnow()
    db.execute(delete(AuthToken).where(AuthToken.user_id == user.id))
    db.execute(delete(VerificationCode).where(VerificationCode.user_id == user.id))
    db.execute(delete(CollectorToken).where(CollectorToken.user_id == user.id))
    db.execute(delete(UserEmail).where(UserEmail.user_id == user.id))
    user.email = f"deleted-{user.id}-{secrets.token_hex(8)}@deleted.invalid"
    user.password_hash = None
    user.is_verified = False
    user.is_admin = False
    user.last_login_at = None
    user.deleted_at = now
    db.commit()
    request.session.clear()
    return RedirectResponse("/?account_deleted=1", status_code=303)


@app.get("/admin", response_class=HTMLResponse)
def admin_dashboard(
    request: Request,
    user_id: str = "",
    platform: str = "",
    q: str = "",
    user_q: str = "",
    scan_q: str = "",
    date_from: str = "",
    date_to: str = "",
    user_page: int = 1,
    scan_page: int = 1,
    activity_page: int = 1,
    db: Session = Depends(get_db),
):
    admin = require_web_admin(request, db)
    if isinstance(admin, RedirectResponse):
        return admin

    per_page = 50
    user_page = max(1, user_page)
    scan_page = max(1, scan_page)
    activity_page = max(1, activity_page)

    selected_user_id: int | None = None
    normalized_user_id = user_id.strip()
    if normalized_user_id:
        try:
            parsed_user_id = int(normalized_user_id)
            if parsed_user_id > 0:
                selected_user_id = parsed_user_id
        except ValueError:
            selected_user_id = None

    def parse_date(value: str, end_of_day: bool = False):
        if not value:
            return None
        try:
            parsed = datetime.strptime(value, "%Y-%m-%d")
            return parsed + timedelta(days=1) if end_of_day else parsed
        except ValueError:
            return None

    start_dt = parse_date(date_from)
    end_dt = parse_date(date_to, end_of_day=True)

    activity_filters = [Activity.platform.not_in(EXCLUDED_PLATFORMS)]
    if selected_user_id is not None:
        activity_filters.append(Activity.user_id == selected_user_id)
    if platform:
        activity_filters.append(Activity.platform == platform)
    if q:
        activity_filters.append(Activity.content.ilike(f"%{q}%"))
    if start_dt:
        activity_filters.append(Activity.imported_at >= start_dt)
    if end_dt:
        activity_filters.append(Activity.imported_at < end_dt)

    user_filters = [User.deleted_at.is_(None)]
    if user_q:
        user_filters.append(User.email.ilike(f"%{user_q.strip()}%"))
    scan_filters = [ScanLog.platform.not_in(EXCLUDED_PLATFORMS)]
    if selected_user_id is not None:
        scan_filters.append(ScanLog.user_id == selected_user_id)
    if platform:
        scan_filters.append(ScanLog.platform == platform)
    if scan_q:
        scan_filters.append(or_(ScanLog.message.ilike(f"%{scan_q}%"), ScanLog.collector_email.ilike(f"%{scan_q}%")))
    if start_dt:
        scan_filters.append(ScanLog.scanned_at >= start_dt)
    if end_dt:
        scan_filters.append(ScanLog.scanned_at < end_dt)
    filtered_activity_count = db.scalar(select(func.count(Activity.id)).where(*activity_filters)) or 0
    user_count = db.scalar(select(func.count(User.id)).where(*user_filters)) or 0
    scan_count = db.scalar(select(func.count(ScanLog.id)).where(*scan_filters)) or 0

    user_total_pages = max(1, (user_count + per_page - 1) // per_page)
    scan_total_pages = max(1, (scan_count + per_page - 1) // per_page)
    activity_total_pages = max(1, (filtered_activity_count + per_page - 1) // per_page)
    user_page = min(user_page, user_total_pages)
    scan_page = min(scan_page, scan_total_pages)
    activity_page = min(activity_page, activity_total_pages)

    users = list(db.scalars(
        select(User).where(*user_filters).order_by(User.created_at.desc())
        .limit(per_page).offset((user_page - 1) * per_page)
    ))
    scans = list(db.scalars(
        select(ScanLog).where(*scan_filters).order_by(ScanLog.scanned_at.desc())
        .limit(per_page).offset((scan_page - 1) * per_page)
    ))
    activities = list(db.scalars(
        select(Activity).where(*activity_filters).order_by(Activity.imported_at.desc())
        .limit(per_page).offset((activity_page - 1) * per_page)
    ))

    selected_user = db.get(User, selected_user_id) if selected_user_id is not None else None
    return render(
        request,
        "admin_dashboard.html",
        db=db,
        session_user=admin,
        admin=admin,
        users=users,
        activities=activities,
        scans=scans,
        selected_user=selected_user,
        selected_user_id=selected_user_id,
        selected_platform=platform,
        q=q,
        user_q=user_q,
        scan_q=scan_q,
        date_from=date_from,
        date_to=date_to,
        user_count=user_count,
        verified_count=db.scalar(select(func.count(User.id)).where(User.is_verified.is_(True), *user_filters)) or 0,
        activity_count=db.scalar(select(func.count(Activity.id)).where(Activity.platform.not_in(EXCLUDED_PLATFORMS))) or 0,
        scan_count=scan_count,
        filtered_activity_count=filtered_activity_count,
        platforms=list(db.scalars(select(Activity.platform).where(Activity.platform.not_in(EXCLUDED_PLATFORMS)).distinct().order_by(Activity.platform))),
        platform_labels=PLATFORM_LABELS,
        activity_type_labels=ACTIVITY_TYPE_LABELS,
        status_labels=STATUS_LABELS,
        user_page=user_page,
        scan_page=scan_page,
        activity_page=activity_page,
        user_total_pages=user_total_pages,
        scan_total_pages=scan_total_pages,
        activity_total_pages=activity_total_pages,
    )


@app.post("/admin/data/purge")
def admin_purge_all_collected_data(
    request: Request,
    password: str = Form(...),
    confirmation: str = Form(...),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
    require_csrf(request, csrf)
    admin = require_web_admin(request, db)
    if isinstance(admin, RedirectResponse):
        return admin

    if confirmation.strip() != "전체삭제":
        return RedirectResponse("/admin?purge_error=confirmation", status_code=303)
    if not verify_password(password, admin.password_hash):
        return RedirectResponse("/admin?purge_error=password", status_code=303)

    activity_count = db.scalar(select(func.count(Activity.id))) or 0
    scan_count = db.scalar(select(func.count(ScanLog.id))) or 0

    db.execute(delete(ScanLog))
    db.execute(delete(Activity))
    db.commit()

    return RedirectResponse(
        f"/admin?purge_ok=1&deleted_activities={activity_count}&deleted_scans={scan_count}",
        status_code=303,
    )


@app.get("/privacy", response_class=HTMLResponse)
def privacy_page(request: Request, db: Session = Depends(get_db)):
    return render(request, "privacy.html", db=db)


@app.get("/supported-sites", response_class=HTMLResponse)
def supported_sites(request: Request, db: Session = Depends(get_db)):
    user = get_session_user(request, db)
    return render(request, "supported_sites.html", db=db, session_user=user, sites=SUPPORTED_SITES, platform_labels=PLATFORM_LABELS)


@app.post("/api/collector/import")
def collector_import(
    payload: CollectorImport,
    user: User = Depends(collector_user),
):
    if len(payload.items) > settings.collector_max_items:
        raise HTTPException(413, f"한 번에 최대 {settings.collector_max_items}개까지 가져올 수 있습니다.")
    try:
        job = collector_queue.enqueue(
            "app.tasks.process_collector_import",
            payload.model_dump(mode="json"),
            user.id,
            result_ttl=3600,
            failure_ttl=86400,
            job_timeout=900,
            retry=Retry(max=3, interval=[10, 60, 300]),
        )
    except Exception as exc:
        raise HTTPException(503, "수집 작업 큐에 연결할 수 없습니다. 잠시 후 다시 시도하세요.") from exc
    return {"ok": True, "queued": True, "job_id": job.id, "status_url": f"/api/collector/jobs/{job.id}"}


@app.get("/api/collector/jobs/{job_id}")
def collector_job_status(job_id: str, user: User = Depends(collector_user)):
    try:
        job = Job.fetch(job_id, connection=redis_connection)
    except Exception as exc:
        raise HTTPException(404, "수집 작업을 찾을 수 없습니다.") from exc
    args = job.args or ()
    if len(args) < 2 or int(args[1]) != user.id:
        raise HTTPException(404, "수집 작업을 찾을 수 없습니다.")
    status = job.get_status(refresh=True)
    if status == "finished":
        return {"ok": True, "queued": False, "status": status, **(job.result or {})}
    if status == "failed":
        return {"ok": False, "queued": False, "status": status, "detail": "수집 작업 처리에 실패했습니다."}
    return {"ok": True, "queued": True, "status": status}


@app.get("/api/collector/status")
def collector_status(db: Session = Depends(get_db), user: User = Depends(collector_user)):
    db.commit()
    return {
        "ok": True,
        "mode": "multi_user",
        "workspace": f"{user.email}의 활동 보관함",
        "app": settings.app_name,
        "user_id": user.id,
        "user_email": user.email,
        "is_admin": user.is_admin,
    }


@app.get("/health")
def health():
    return {"status": "ok", "mode": "multi_user", "version": "1.0.4"}


@app.api_route("/robots.txt", methods=["GET", "HEAD"], include_in_schema=False)
def robots_txt():
    return FileResponse(
        Path(__file__).resolve().parent.parent / "robots.txt",
        media_type="text/plain",
    )
