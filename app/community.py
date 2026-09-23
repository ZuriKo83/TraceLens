import asyncio
import secrets
import time
from collections import defaultdict, deque
from datetime import timedelta

from fastapi import APIRouter, Depends, Form, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import delete, exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.community_models import (
    CommunityAuditLog,
    CommunityChatMessage,
    CommunityComment,
    CommunityNotification,
    CommunityPost,
    CommunityReaction,
    CommunityReport,
)
from app.db import engine, get_db
from app.models import User, utcnow

router = APIRouter(prefix="/community", tags=["community"])
templates = Jinja2Templates(directory="app/templates")

CATEGORIES = {
    "free": "자유게시판",
    "suggestion": "건의사항",
    "bug": "오류 제보",
    "site_request": "지원 사이트 요청",
}
STATUSES = {
    "received": "접수",
    "reviewing": "검토 중",
    "planned": "개발 예정",
    "completed": "반영 완료",
    "on_hold": "보류",
}
POSTS_PER_PAGE = 20
CHAT_VISIBLE_LIMIT = 200
CHAT_RATE_WINDOW = 60
CHAT_RATE_LIMIT = 20


class ChatManager:
    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()
        self.lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self.lock:
            self.connections.add(websocket)
        await self.broadcast({"type": "presence", "online": len(self.connections)})

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self.lock:
            self.connections.discard(websocket)
        await self.broadcast({"type": "presence", "online": len(self.connections)})

    async def broadcast(self, payload: dict) -> None:
        stale: list[WebSocket] = []
        for connection in tuple(self.connections):
            try:
                await connection.send_json(payload)
            except Exception:
                stale.append(connection)
        if stale:
            async with self.lock:
                for connection in stale:
                    self.connections.discard(connection)


chat_manager = ChatManager()
chat_rate: dict[int, deque[float]] = defaultdict(deque)
chat_last_text: dict[int, tuple[str, float]] = {}


def current_user(request: Request, db: Session) -> User | None:
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    user = db.get(User, int(user_id))
    if user is None or user.deleted_at is not None or not user.is_verified:
        request.session.clear()
        return None
    return user


def require_user(request: Request, db: Session) -> User | RedirectResponse:
    user = current_user(request, db)
    if user is None:
        return RedirectResponse(f"/login?next={request.url.path}", status_code=303)
    return user


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


def can_view(post: CommunityPost, user: User) -> bool:
    if post.is_hidden and not user.is_admin and post.author_id != user.id:
        return False
    return not post.is_private or user.is_admin or post.author_id == user.id


def audit(db: Session, user: User, action: str, target_type: str, target_id: int | None = None, detail: str | None = None) -> None:
    db.add(CommunityAuditLog(
        actor_id=user.id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        detail=(detail or "")[:500] or None,
    ))


def notify(db: Session, user_id: int, post_id: int | None, message: str) -> None:
    db.add(CommunityNotification(user_id=user_id, post_id=post_id, message=message[:300]))


def serialize_chat(message: CommunityChatMessage) -> dict:
    return {
        "id": message.id,
        "author_id": message.author_id,
        "content": message.content,
        "created_at": message.created_at.isoformat(),
    }


def validate_chat_send(user_id: int, content: str) -> str | None:
    now = time.monotonic()
    bucket = chat_rate[user_id]
    while bucket and now - bucket[0] > CHAT_RATE_WINDOW:
        bucket.popleft()
    if len(bucket) >= CHAT_RATE_LIMIT:
        return "채팅은 1분에 최대 20개까지 보낼 수 있습니다."
    last = chat_last_text.get(user_id)
    normalized = " ".join(content.lower().split())
    if last and last[0] == normalized and now - last[1] < 30:
        return "같은 메시지를 연속으로 보낼 수 없습니다."
    bucket.append(now)
    chat_last_text[user_id] = (normalized, now)
    return None


def render(request: Request, name: str, db: Session, user: User, **context):
    unread_notifications = db.scalar(select(func.count(CommunityNotification.id)).where(
        CommunityNotification.user_id == user.id,
        CommunityNotification.is_read.is_(False),
    )) or 0
    context.update({
        "request": request,
        "app_name": "TraceLens",
        "session_user": user,
        "csrf_token": csrf_token(request),
        "categories": CATEGORIES,
        "statuses": STATUSES,
        "unread_notifications": unread_notifications,
    })
    return templates.TemplateResponse(request=request, name=name, context=context)


@router.get("", response_class=HTMLResponse)
def community_list(
    request: Request,
    category: str = "free",
    status: str = "",
    q: str = "",
    sort: str = "latest",
    mine: bool = False,
    page: int = 1,
    db: Session = Depends(get_db),
):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    page = max(1, page)
    reaction_count = select(func.count(CommunityReaction.id)).where(CommunityReaction.post_id == CommunityPost.id).correlate(CommunityPost).scalar_subquery()
    comment_count = select(func.count(CommunityComment.id)).where(CommunityComment.post_id == CommunityPost.id).correlate(CommunityPost).scalar_subquery()
    filters = []
    if not user.is_admin:
        filters.extend([
            CommunityPost.is_hidden.is_(False),
            or_(CommunityPost.is_private.is_(False), CommunityPost.author_id == user.id),
        ])
    waiting_mode = sort == "waiting" and user.is_admin
    if mine:
        filters.append(CommunityPost.author_id == user.id)
    elif waiting_mode:
        admin_reply_exists = exists(select(CommunityComment.id).where(
            CommunityComment.post_id == CommunityPost.id,
            CommunityComment.is_admin_reply.is_(True),
        ))
        filters.extend([
            CommunityPost.status.in_(["received", "reviewing"]),
            ~admin_reply_exists,
        ])
        category = ""
    else:
        if category not in CATEGORIES:
            category = "free"
        filters.append(CommunityPost.category == category)
    if status in STATUSES:
        filters.append(CommunityPost.status == status)
    if q.strip():
        pattern = f"%{q.strip()}%"
        filters.append(or_(CommunityPost.title.ilike(pattern), CommunityPost.content.ilike(pattern)))
    total = db.scalar(select(func.count(CommunityPost.id)).where(*filters)) or 0
    total_pages = max(1, (total + POSTS_PER_PAGE - 1) // POSTS_PER_PAGE)
    page = min(page, total_pages)
    stmt = select(CommunityPost, reaction_count.label("reaction_count"), comment_count.label("comment_count")).where(*filters)
    if sort == "popular":
        stmt = stmt.order_by(CommunityPost.is_notice.desc(), reaction_count.desc(), CommunityPost.created_at.desc())
    elif waiting_mode:
        stmt = stmt.order_by(CommunityPost.is_notice.desc(), CommunityPost.created_at.asc())
    else:
        stmt = stmt.order_by(CommunityPost.is_notice.desc(), CommunityPost.created_at.desc())
    rows = db.execute(stmt.limit(POSTS_PER_PAGE).offset((page - 1) * POSTS_PER_PAGE)).all()
    return render(request, "community/list.html", db, user,
        rows=rows, category=category, status=status, q=q, sort=sort, mine=mine,
        waiting_mode=waiting_mode, page=page, total_pages=total_pages, total=total)


@router.get("/notifications", response_class=HTMLResponse)
def notifications_page(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    notifications = list(db.scalars(select(CommunityNotification).where(
        CommunityNotification.user_id == user.id
    ).order_by(CommunityNotification.created_at.desc()).limit(100)))
    db.query(CommunityNotification).filter(
        CommunityNotification.user_id == user.id,
        CommunityNotification.is_read.is_(False),
    ).update({"is_read": True}, synchronize_session=False)
    db.commit()
    return render(request, "community/notifications.html", db, user, notifications=notifications)


@router.get("/chat", response_class=HTMLResponse)
def chat_page(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    messages = list(db.scalars(select(CommunityChatMessage).where(
        CommunityChatMessage.is_hidden.is_(False)
    ).order_by(CommunityChatMessage.id.desc()).limit(CHAT_VISIBLE_LIMIT)))
    messages.reverse()
    return render(request, "community/chat.html", db, user, messages=messages, chat_limit=CHAT_VISIBLE_LIMIT)


@router.get("/chat/messages")
def chat_messages(request: Request, after_id: int = 0, db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return JSONResponse({"ok": False, "detail": "로그인이 필요합니다."}, status_code=401)
    stmt = select(CommunityChatMessage).where(
        CommunityChatMessage.id > max(0, after_id),
        CommunityChatMessage.is_hidden.is_(False),
    ).order_by(CommunityChatMessage.id).limit(CHAT_VISIBLE_LIMIT)
    return {"ok": True, "messages": [serialize_chat(message) for message in db.scalars(stmt)]}


@router.post("/chat/messages")
def send_chat_message(request: Request, content: str = Form(...), csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return JSONResponse({"ok": False, "detail": "로그인이 필요합니다."}, status_code=401)
    require_csrf(request, csrf)
    content = content.strip()
    if not (1 <= len(content) <= 500):
        return JSONResponse({"ok": False, "detail": "메시지는 1자 이상 500자 이하로 입력하세요."}, status_code=400)
    error = validate_chat_send(user.id, content)
    if error:
        return JSONResponse({"ok": False, "detail": error}, status_code=429)
    message = CommunityChatMessage(author_id=user.id, content=content)
    db.add(message)
    db.commit()
    db.refresh(message)
    return {"ok": True, "message": serialize_chat(message)}


@router.post("/chat/report/{message_id}")
def report_chat(message_id: int, request: Request, reason: str = Form("부적절한 내용"), csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    message = db.get(CommunityChatMessage, message_id)
    if message is None:
        raise HTTPException(404)
    try:
        db.add(CommunityReport(reporter_id=user.id, target_type="chat", target_id=message.id, reason=reason.strip()[:500] or "부적절한 내용"))
        db.commit()
    except IntegrityError:
        db.rollback()
    return RedirectResponse("/community/chat", status_code=303)


@router.post("/chat/admin/clear")
def clear_chat(request: Request, csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    if not user.is_admin:
        raise HTTPException(403)
    deleted_count = db.scalar(select(func.count(CommunityChatMessage.id))) or 0
    db.execute(delete(CommunityChatMessage))
    audit(db, user, "chat_clear_all", "chat", detail=f"deleted={deleted_count}")
    db.commit()
    return RedirectResponse("/community/chat", status_code=303)


@router.post("/chat/admin/{message_id}/delete")
def delete_chat_message(message_id: int, request: Request, csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    if not user.is_admin:
        raise HTTPException(403)
    message = db.get(CommunityChatMessage, message_id)
    if message is None:
        raise HTTPException(404)
    db.delete(message)
    audit(db, user, "chat_delete", "chat", message_id)
    db.commit()
    return RedirectResponse("/community/chat", status_code=303)


@router.websocket("/chat/ws")
async def chat_socket(websocket: WebSocket):
    session = websocket.scope.get("session") or {}
    user_id = session.get("user_id")
    if not user_id:
        await websocket.close(code=4401)
        return
    with Session(engine) as db:
        user = db.get(User, int(user_id))
        if user is None or user.deleted_at is not None or not user.is_verified:
            await websocket.close(code=4401)
            return
    await chat_manager.connect(websocket)
    try:
        while True:
            payload = await websocket.receive_json()
            content = str(payload.get("content") or "").strip()
            if not (1 <= len(content) <= 500):
                await websocket.send_json({"type": "error", "message": "메시지는 1자 이상 500자 이하로 입력하세요."})
                continue
            error = validate_chat_send(int(user_id), content)
            if error:
                await websocket.send_json({"type": "error", "message": error})
                continue
            with Session(engine) as db:
                user = db.get(User, int(user_id))
                if user is None or user.deleted_at is not None or not user.is_verified:
                    await websocket.close(code=4401)
                    return
                message = CommunityChatMessage(author_id=user.id, content=content)
                db.add(message)
                db.commit()
                db.refresh(message)
                outgoing = {"type": "message", **serialize_chat(message)}
            await chat_manager.broadcast(outgoing)
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        await chat_manager.disconnect(websocket)


@router.get("/new", response_class=HTMLResponse)
def new_post_page(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    return render(request, "community/form.html", db, user, post=None, error=None)


@router.post("/new")
def create_post(request: Request, category: str = Form(...), title: str = Form(...), content: str = Form(...), related_site: str = Form(""), environment: str = Form(""), is_private: bool = Form(False), csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    title, content = title.strip(), content.strip()
    if category not in CATEGORIES or not (2 <= len(title) <= 160) or not (5 <= len(content) <= 10000):
        return render(request, "community/form.html", db, user, post=None, error="카테고리, 제목, 내용을 올바르게 입력하세요.")
    post = CommunityPost(author_id=user.id, category=category, title=title, content=content, related_site=related_site.strip()[:80] or None, environment=environment.strip()[:500] or None, is_private=is_private)
    db.add(post)
    db.commit()
    db.refresh(post)
    return RedirectResponse(f"/community/{post.id}", status_code=303)


@router.get("/{post_id}", response_class=HTMLResponse)
def post_detail(post_id: int, request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    post = db.scalar(select(CommunityPost).options(selectinload(CommunityPost.comments), selectinload(CommunityPost.reactions)).where(CommunityPost.id == post_id))
    if post is None:
        raise HTTPException(404, "게시글을 찾을 수 없습니다.")
    if not can_view(post, user):
        raise HTTPException(403, "이 게시글을 볼 권한이 없습니다.")
    viewed = set(str(request.session.get("community_viewed", "")).split(","))
    key = str(post.id)
    if key not in viewed:
        post.view_count += 1
        viewed.add(key)
        request.session["community_viewed"] = ",".join(list(viewed)[-200:])
    reacted = any(reaction.user_id == user.id for reaction in post.reactions)
    db.commit()
    return render(request, "community/detail.html", db, user, post=post, reacted=reacted)


@router.get("/{post_id}/edit", response_class=HTMLResponse)
def edit_post_page(post_id: int, request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    post = db.get(CommunityPost, post_id)
    if post is None:
        raise HTTPException(404)
    if post.author_id != user.id:
        raise HTTPException(403, "작성자만 게시글을 수정할 수 있습니다.")
    return render(request, "community/form.html", db, user, post=post, error=None)


@router.post("/{post_id}/edit")
def edit_post(post_id: int, request: Request, category: str = Form(...), title: str = Form(...), content: str = Form(...), related_site: str = Form(""), environment: str = Form(""), is_private: bool = Form(False), csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    post = db.get(CommunityPost, post_id)
    if post is None:
        raise HTTPException(404)
    if post.author_id != user.id:
        raise HTTPException(403, "작성자만 게시글을 수정할 수 있습니다.")
    title, content = title.strip(), content.strip()
    if category not in CATEGORIES or not (2 <= len(title) <= 160) or not (5 <= len(content) <= 10000):
        return render(request, "community/form.html", db, user, post=post, error="카테고리, 제목, 내용을 올바르게 입력하세요.")
    post.category, post.title, post.content = category, title, content
    post.related_site = related_site.strip()[:80] or None
    post.environment = environment.strip()[:500] or None
    post.is_private = is_private
    db.commit()
    return RedirectResponse(f"/community/{post.id}", status_code=303)


@router.post("/{post_id}/delete")
def delete_post(post_id: int, request: Request, csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    post = db.get(CommunityPost, post_id)
    if post is None:
        raise HTTPException(404)
    if post.author_id != user.id and not user.is_admin:
        raise HTTPException(403)
    category = post.category
    audit(db, user, "post_delete", "post", post.id)
    db.delete(post)
    db.commit()
    return RedirectResponse(f"/community?category={category}", status_code=303)


@router.post("/{post_id}/comments")
def add_comment(post_id: int, request: Request, content: str = Form(...), csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    post = db.get(CommunityPost, post_id)
    if post is None or not can_view(post, user):
        raise HTTPException(403)
    content = content.strip()
    if not (1 <= len(content) <= 3000):
        raise HTTPException(400, "댓글은 1자 이상 3000자 이하로 입력하세요.")
    comment = CommunityComment(post_id=post.id, author_id=user.id, content=content, is_admin_reply=user.is_admin)
    db.add(comment)
    if user.is_admin and post.author_id != user.id:
        notify(db, post.author_id, post.id, f"'{post.title[:40]}' 게시글에 관리자 답변이 등록되었습니다.")
    db.commit()
    return RedirectResponse(f"/community/{post.id}#comments", status_code=303)


@router.post("/{post_id}/comments/{comment_id}/delete")
def delete_comment(post_id: int, comment_id: int, request: Request, csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    post = db.get(CommunityPost, post_id)
    comment = db.get(CommunityComment, comment_id)
    if post is None or comment is None or comment.post_id != post.id:
        raise HTTPException(404)
    if not can_view(post, user):
        raise HTTPException(403)
    if comment.author_id != user.id and not user.is_admin:
        raise HTTPException(403, "본인 댓글만 삭제할 수 있습니다.")
    audit(db, user, "comment_delete", "comment", comment.id)
    db.delete(comment)
    db.commit()
    return RedirectResponse(f"/community/{post.id}#comments", status_code=303)


@router.post("/{post_id}/report")
def report_post(post_id: int, request: Request, reason: str = Form("부적절한 내용"), csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    post = db.get(CommunityPost, post_id)
    if post is None or not can_view(post, user):
        raise HTTPException(404)
    try:
        db.add(CommunityReport(reporter_id=user.id, target_type="post", target_id=post.id, reason=reason.strip()[:500] or "부적절한 내용"))
        db.commit()
    except IntegrityError:
        db.rollback()
    return RedirectResponse(f"/community/{post.id}", status_code=303)


@router.post("/{post_id}/comments/{comment_id}/report")
def report_comment(post_id: int, comment_id: int, request: Request, reason: str = Form("부적절한 내용"), csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    comment = db.get(CommunityComment, comment_id)
    if comment is None or comment.post_id != post_id:
        raise HTTPException(404)
    try:
        db.add(CommunityReport(reporter_id=user.id, target_type="comment", target_id=comment.id, reason=reason.strip()[:500] or "부적절한 내용"))
        db.commit()
    except IntegrityError:
        db.rollback()
    return RedirectResponse(f"/community/{post_id}#comments", status_code=303)


@router.post("/{post_id}/react")
def toggle_reaction(post_id: int, request: Request, csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    post = db.get(CommunityPost, post_id)
    if post is None or not can_view(post, user):
        raise HTTPException(403)
    existing = db.scalar(select(CommunityReaction).where(CommunityReaction.post_id == post.id, CommunityReaction.user_id == user.id))
    if existing:
        db.delete(existing)
    else:
        db.add(CommunityReaction(post_id=post.id, user_id=user.id))
    db.commit()
    return RedirectResponse(f"/community/{post.id}", status_code=303)


@router.post("/{post_id}/admin")
def admin_update(post_id: int, request: Request, status: str = Form(...), is_notice: bool = Form(False), is_hidden: bool = Form(False), csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    if not user.is_admin:
        raise HTTPException(403)
    post = db.get(CommunityPost, post_id)
    if post is None:
        raise HTTPException(404)
    if status not in STATUSES:
        raise HTTPException(400)
    old_status = post.status
    post.status, post.is_notice, post.is_hidden = status, is_notice, is_hidden
    if old_status != status and post.author_id != user.id:
        notify(db, post.author_id, post.id, f"'{post.title[:40]}' 게시글 상태가 {STATUSES[status]}(으)로 변경되었습니다.")
    audit(db, user, "post_admin_update", "post", post.id, f"status={status},notice={is_notice},hidden={is_hidden}")
    db.commit()
    return RedirectResponse(f"/community/{post.id}", status_code=303)
