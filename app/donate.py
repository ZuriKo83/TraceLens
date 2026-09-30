from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import User

settings = get_settings()
templates = Jinja2Templates(directory="app/templates")
router = APIRouter()
QR_PATH = Path(__file__).resolve().parent / "templates" / "AQR.png"


@router.get("/donate", response_class=HTMLResponse)
def donate_page(request: Request, db: Session = Depends(get_db)):
    if settings.public_base_url.startswith(("http://localhost:", "http://127.0.0.1:")):
        raise HTTPException(status_code=404)
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
            "donate_url": "",
        },
    )


@router.get("/donate/qr", response_class=FileResponse)
def donate_qr():
    if settings.public_base_url.startswith(("http://localhost:", "http://127.0.0.1:")):
        raise HTTPException(status_code=404)
    if not QR_PATH.is_file():
        raise HTTPException(status_code=404, detail="후원 QR 이미지를 찾을 수 없습니다.")
    return FileResponse(
        path=QR_PATH,
        media_type="image/png",
        filename="TraceLens-AQR.png",
        headers={"Cache-Control": "public, max-age=3600"},
    )
