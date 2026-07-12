import secrets

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.community_models import CommunityComment, CommunityPost, CommunityReaction
from app.db import get_db
from app.models import User

router = APIRouter(prefix="/community", tags=["community"])
templates = Jinja2Templates(directory="app/templates")

CATEGORIES = {
    "suggestion": "건의사항",
    "bug": "오류 제보",
    "site_request": "지원 사이트 요청",
    "free": "자유게시판",
}
STATUSES = {
    "received": "접수",
    "reviewing": "검토 중",
    "planned": "개발 예정",
    "completed": "반영 완료",
    "on_hold": "보류",
}


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


def render(request: Request, name: str, db: Session, user: User, **context):
    context.update({
        "request": request,
        "app_name": "TraceLens",
        "session_user": user,
        "csrf_token": csrf_token(request),
        "categories": CATEGORIES,
        "statuses": STATUSES,
    })
    return templates.TemplateResponse(request=request, name=name, context=context)


@router.get("", response_class=HTMLResponse)
def community_list(
    request: Request,
    category: str = "",
    status: str = "",
    q: str = "",
    sort: str = "latest",
    mine: bool = False,
    db: Session = Depends(get_db),
):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user

    reaction_count = select(func.count(CommunityReaction.id)).where(
        CommunityReaction.post_id == CommunityPost.id
    ).correlate(CommunityPost).scalar_subquery()
    comment_count = select(func.count(CommunityComment.id)).where(
        CommunityComment.post_id == CommunityPost.id,
        CommunityComment.is_hidden.is_(False),
    ).correlate(CommunityPost).scalar_subquery()

    stmt = select(CommunityPost, reaction_count.label("reaction_count"), comment_count.label("comment_count"))
    if user.is_admin:
        pass
    else:
        stmt = stmt.where(
            CommunityPost.is_hidden.is_(False),
            or_(CommunityPost.is_private.is_(False), CommunityPost.author_id == user.id),
        )
    if mine:
        stmt = stmt.where(CommunityPost.author_id == user.id)
    if category in CATEGORIES:
        stmt = stmt.where(CommunityPost.category == category)
    if status in STATUSES:
        stmt = stmt.where(CommunityPost.status == status)
    if q.strip():
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(or_(CommunityPost.title.ilike(pattern), CommunityPost.content.ilike(pattern)))

    if sort == "popular":
        stmt = stmt.order_by(CommunityPost.is_notice.desc(), reaction_count.desc(), CommunityPost.created_at.desc())
    elif sort == "waiting":
        stmt = stmt.where(CommunityPost.status.in_(["received", "reviewing"]))
        stmt = stmt.order_by(CommunityPost.is_notice.desc(), CommunityPost.created_at.asc())
    else:
        stmt = stmt.order_by(CommunityPost.is_notice.desc(), CommunityPost.created_at.desc())

    rows = db.execute(stmt.limit(100)).all()
    return render(
        request, "community/list.html", db, user,
        rows=rows, category=category, status=status, q=q, sort=sort, mine=mine,
    )


@router.get("/new", response_class=HTMLResponse)
def new_post_page(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    return render(request, "community/form.html", db, user, post=None, error=None)


@router.post("/new")
def create_post(
    request: Request,
    category: str = Form(...),
    title: str = Form(...),
    content: str = Form(...),
    related_site: str = Form(""),
    environment: str = Form(""),
    is_private: bool = Form(False),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    title, content = title.strip(), content.strip()
    if category not in CATEGORIES or not (2 <= len(title) <= 160) or not (5 <= len(content) <= 10000):
        return render(request, "community/form.html", db, user, post=None, error="카테고리, 제목, 내용을 올바르게 입력하세요.")
    post = CommunityPost(
        author_id=user.id,
        category=category,
        title=title,
        content=content,
        related_site=related_site.strip()[:80] or None,
        environment=environment.strip()[:500] or None,
        is_private=is_private,
    )
    db.add(post)
    db.commit()
    db.refresh(post)
    return RedirectResponse(f"/community/{post.id}", status_code=303)


@router.get("/{post_id}", response_class=HTMLResponse)
def post_detail(post_id: int, request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    post = db.scalar(
        select(CommunityPost)
        .options(selectinload(CommunityPost.comments), selectinload(CommunityPost.reactions))
        .where(CommunityPost.id == post_id)
    )
    if post is None:
        raise HTTPException(404, "게시글을 찾을 수 없습니다.")
    if not can_view(post, user):
        raise HTTPException(403, "이 비밀글을 볼 권한이 없습니다.")
    post.view_count += 1
    author = db.get(User, post.author_id)
    comment_authors = {comment.author_id: db.get(User, comment.author_id) for comment in post.comments}
    reacted = any(reaction.user_id == user.id for reaction in post.reactions)
    db.commit()
    return render(
        request, "community/detail.html", db, user,
        post=post, author=author, comment_authors=comment_authors, reacted=reacted,
    )


@router.get("/{post_id}/edit", response_class=HTMLResponse)
def edit_post_page(post_id: int, request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    post = db.get(CommunityPost, post_id)
    if post is None:
        raise HTTPException(404)
    if post.author_id != user.id and not user.is_admin:
        raise HTTPException(403)
    return render(request, "community/form.html", db, user, post=post, error=None)


@router.post("/{post_id}/edit")
def edit_post(
    post_id: int,
    request: Request,
    category: str = Form(...),
    title: str = Form(...),
    content: str = Form(...),
    related_site: str = Form(""),
    environment: str = Form(""),
    is_private: bool = Form(False),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    post = db.get(CommunityPost, post_id)
    if post is None:
        raise HTTPException(404)
    if post.author_id != user.id and not user.is_admin:
        raise HTTPException(403)
    title, content = title.strip(), content.strip()
    if category not in CATEGORIES or not (2 <= len(title) <= 160) or not (5 <= len(content) <= 10000):
        return render(request, "community/form.html", db, user, post=post, error="카테고리, 제목, 내용을 올바르게 입력하세요.")
    post.category = category
    post.title = title
    post.content = content
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
    db.delete(post)
    db.commit()
    return RedirectResponse("/community", status_code=303)


@router.post("/{post_id}/comments")
def add_comment(
    post_id: int,
    request: Request,
    content: str = Form(...),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
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
    db.add(CommunityComment(post_id=post.id, author_id=user.id, content=content, is_admin_reply=user.is_admin))
    db.commit()
    return RedirectResponse(f"/community/{post.id}#comments", status_code=303)


@router.post("/{post_id}/react")
def toggle_reaction(post_id: int, request: Request, csrf: str = Form(...), db: Session = Depends(get_db)):
    user = require_user(request, db)
    if isinstance(user, RedirectResponse):
        return user
    require_csrf(request, csrf)
    post = db.get(CommunityPost, post_id)
    if post is None or not can_view(post, user):
        raise HTTPException(403)
    existing = db.scalar(select(CommunityReaction).where(
        CommunityReaction.post_id == post.id, CommunityReaction.user_id == user.id
    ))
    if existing:
        db.delete(existing)
    else:
        db.add(CommunityReaction(post_id=post.id, user_id=user.id))
    db.commit()
    return RedirectResponse(f"/community/{post.id}", status_code=303)


@router.post("/{post_id}/admin")
def admin_update(
    post_id: int,
    request: Request,
    status: str = Form(...),
    is_notice: bool = Form(False),
    is_hidden: bool = Form(False),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
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
    post.status = status
    post.is_notice = is_notice
    post.is_hidden = is_hidden
    db.commit()
    return RedirectResponse(f"/community/{post.id}", status_code=303)
