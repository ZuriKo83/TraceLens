from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.community_models import (
    CommunityAuditLog,
    CommunityChatMessage,
    CommunityComment,
    CommunityPost,
    CommunityReport,
    CommunityUserRestriction,
)
from app.db import get_db
from app.models import User, utcnow

router = APIRouter(prefix="/community/admin", tags=["community-admin"])
templates = Jinja2Templates(directory="app/templates")


def admin_user(request: Request, db: Session) -> User:
    user_id = request.session.get("user_id")
    user = db.get(User, int(user_id)) if user_id else None
    if user is None or user.deleted_at is not None or not user.is_verified or not user.is_admin:
        raise HTTPException(403, "관리자만 접근할 수 있습니다.")
    return user


def verify_csrf(request: Request, supplied: str) -> None:
    import secrets

    expected = request.session.get("csrf_token")
    if not expected or not secrets.compare_digest(expected, supplied or ""):
        raise HTTPException(400, "요청 검증에 실패했습니다.")


def audit(db: Session, user: User, action: str, target_type: str, target_id: int | None, detail: str = "") -> None:
    db.add(CommunityAuditLog(
        actor_id=user.id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        detail=detail[:500] or None,
    ))


def report_target_info(db: Session, report: CommunityReport) -> dict:
    info = {
        "label": f"{report.target_type} #{report.target_id}",
        "url": None,
        "preview": "대상이 삭제되었거나 존재하지 않습니다.",
        "author_id": None,
        "missing": True,
    }
    if report.target_type == "post":
        post = db.get(CommunityPost, report.target_id)
        if post is not None:
            info.update(
                label=f"게시글 #{post.id}",
                url=f"/community/{post.id}",
                preview=f"{post.title} — {post.content[:160]}",
                author_id=post.author_id,
                missing=False,
            )
    elif report.target_type == "comment":
        comment = db.get(CommunityComment, report.target_id)
        if comment is not None:
            info.update(
                label=f"댓글 #{comment.id}",
                url=f"/community/{comment.post_id}#comment-{comment.id}",
                preview=comment.content[:180],
                author_id=comment.author_id,
                missing=False,
            )
    elif report.target_type == "chat":
        message = db.get(CommunityChatMessage, report.target_id)
        if message is not None:
            info.update(
                label=f"채팅 #{message.id}",
                url=f"/community/chat#chat-message-{message.id}",
                preview=message.content[:180],
                author_id=message.author_id,
                missing=False,
            )
    return info


@router.get("", response_class=HTMLResponse)
def moderation_dashboard(request: Request, db: Session = Depends(get_db)):
    user = admin_user(request, db)
    reports = list(db.scalars(
        select(CommunityReport).order_by(
            (CommunityReport.status == "open").desc(),
            CommunityReport.created_at.desc(),
        ).limit(200)
    ))
    report_rows = [{"report": report, "target": report_target_info(db, report)} for report in reports]
    restrictions = list(db.scalars(
        select(CommunityUserRestriction).order_by(CommunityUserRestriction.updated_at.desc()).limit(100)
    ))
    stats = {
        "open_reports": db.scalar(select(func.count(CommunityReport.id)).where(CommunityReport.status == "open")) or 0,
        "posts": db.scalar(select(func.count(CommunityPost.id))) or 0,
        "comments": db.scalar(select(func.count(CommunityComment.id))) or 0,
        "chat": db.scalar(select(func.count(CommunityChatMessage.id))) or 0,
    }
    csrf = request.session.get("csrf_token")
    if not csrf:
        import secrets
        csrf = secrets.token_urlsafe(24)
        request.session["csrf_token"] = csrf
    return templates.TemplateResponse(
        request=request,
        name="community/admin.html",
        context={
            "request": request,
            "app_name": "TraceLens",
            "session_user": user,
            "csrf_token": csrf,
            "report_rows": report_rows,
            "restrictions": restrictions,
            "stats": stats,
        },
    )


@router.post("/reports/{report_id}")
def resolve_report(
    report_id: int,
    request: Request,
    decision: str = Form(...),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
    user = admin_user(request, db)
    verify_csrf(request, csrf)
    if decision not in {"resolved", "dismissed"}:
        raise HTTPException(400)
    report = db.get(CommunityReport, report_id)
    if report is None:
        raise HTTPException(404)
    report.status = decision
    report.resolved_by = user.id
    report.resolved_at = utcnow()
    audit(db, user, f"report_{decision}", report.target_type, report.target_id, report.reason)
    db.commit()
    return RedirectResponse("/community/admin", status_code=303)


@router.post("/restrictions")
def set_restriction(
    request: Request,
    user_id: int = Form(...),
    scope: str = Form(...),
    duration_hours: int = Form(24),
    reason: str = Form(""),
    csrf: str = Form(...),
    db: Session = Depends(get_db),
):
    admin = admin_user(request, db)
    verify_csrf(request, csrf)
    target = db.get(User, user_id)
    if target is None or target.is_admin:
        raise HTTPException(400, "관리자 또는 존재하지 않는 사용자는 제한할 수 없습니다.")
    if scope not in {"chat", "community", "all"}:
        raise HTTPException(400)
    hours = max(1, min(duration_hours, 24 * 3650))
    until = utcnow() + timedelta(hours=hours)
    restriction = db.scalar(select(CommunityUserRestriction).where(CommunityUserRestriction.user_id == user_id))
    if restriction is None:
        restriction = CommunityUserRestriction(user_id=user_id, updated_by=admin.id)
        db.add(restriction)
    if scope in {"chat", "all"}:
        restriction.chat_blocked_until = until
    if scope in {"community", "all"}:
        restriction.community_blocked_until = until
    restriction.reason = reason.strip()[:500] or None
    restriction.updated_by = admin.id
    audit(db, admin, "user_restrict", "user", user_id, f"scope={scope},hours={hours},reason={reason}")
    db.commit()
    return RedirectResponse("/community/admin", status_code=303)


@router.post("/restrictions/{user_id}/clear")
def clear_restriction(user_id: int, request: Request, csrf: str = Form(...), db: Session = Depends(get_db)):
    admin = admin_user(request, db)
    verify_csrf(request, csrf)
    restriction = db.scalar(select(CommunityUserRestriction).where(CommunityUserRestriction.user_id == user_id))
    if restriction is not None:
        db.delete(restriction)
        audit(db, admin, "user_restriction_clear", "user", user_id)
        db.commit()
    return RedirectResponse("/community/admin", status_code=303)
