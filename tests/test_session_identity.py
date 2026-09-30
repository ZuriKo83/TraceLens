from starlette.requests import Request
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db import Base
from app.main import bootstrap_users, get_session_user
from app.models import User
from app.session_identity import session_identity


def test_registered_admin_and_session_identity_survive_without_auto_creation(monkeypatch):
    from app.main import settings
    monkeypatch.setattr(settings, "admin_emails", "drkoby0803@gmail.com")
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        bootstrap_users(db)
        db.commit()
        assert db.scalar(select(User)) is None
        user = User(email="drkoby0803@gmail.com", is_verified=True, password_hash="new-registration-hash")
        db.add(user)
        db.commit()
        bootstrap_users(db)
        assert user.is_admin
        valid = {"user_id": user.id, "account_identity": session_identity(user)}
        request = Request({"type": "http", "session": valid})
        assert get_session_user(request, db) is user
        user.password_hash = "another-registration-or-password"
        assert get_session_user(request, db) is None
        assert valid == {}
        legacy = Request({"type": "http", "session": {"user_id": user.id}})
        assert get_session_user(legacy, db) is None
    engine.dispose()
