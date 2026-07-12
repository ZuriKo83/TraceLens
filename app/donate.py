from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import User

settings = get_settings()
templates = Jinja2Templates(directory="app/templates")
router = APIRouter()


@router.get("/donate", response_class=HTMLResponse)
def donate_page(request: Request, db: Session = Depends(get_db)):
    session_user = None
    user_id = request.session.get("user_id")
    if user_id:
        try:
            user = db.get(User, int(user_id))
        except (TypeError, ValueError):
            user = None
        if user and user.deleted_at is None and user.is_verified:
            session_user = user

    return templates.TemplateResponse(
        request=request,
        name="donate.html",
        context={
            "request": request,
            "app_name": settings.app_name,
            "session_user": session_user,
            "csrf_token": request.session.get("csrf_token", ""),
            "donate_url": "https://aq.gy/f/I9J3b",
        },
    )
