from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db import Base
from app.models import Activity, User
from app.naver_blog import is_own_blog_post
from app import tasks
from app.main import cleanup_legacy_records


def test_naver_blog_owner_urls():
    assert is_own_blog_post("https://blog.naver.com/mine/123", "mine")
    assert is_own_blog_post("https://blog.naver.com/PostView.naver?logNo=123&blogId=mine", "mine")
    for source in ["https://blog.naver.com/blogpeople/150109857428", "https://blog.naver.com/other/123",
                   "https://evil.example/blog.naver.com/mine/123", "https://blog.naver.com/PostView.naver?blogId=mine&blogId=other&logNo=123"]:
        assert not is_own_blog_post(source, "mine")


def test_naver_blog_owner_import_and_legacy_cleanup(monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(tasks, "engine", engine)
    with Session(engine) as db:
        db.add(User(id=1, email="mine@example.com"))
        db.commit()
    result = tasks.process_collector_import({"platform": "naver_blog", "account_label": "mine", "scan_scope": "post",
        "items": [
            {"external_id": "own", "activity_type": "post", "title": "My post", "source_url": "https://blog.naver.com/mine/123"},
            {"external_id": "help", "activity_type": "post", "title": "Help", "source_url": "https://blog.naver.com/blogpeople/150109857428"},
        ]}, 1)
    assert result["imported"] == 1
    with Session(engine) as db:
        db.add(Activity(user_id=1, platform="naver_blog", activity_type="post", external_id="legacy-help", content="Help",
                        account_label="mine", source_url="https://blog.naver.com/blogpeople/150109857428"))
        db.commit()
        cleanup_legacy_records(db)
        db.commit()
        assert list(db.scalars(select(Activity.external_id))) == ["own"]
    engine.dispose()
