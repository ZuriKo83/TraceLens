from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db import Base
from app.models import Activity, User
from app import tasks


def test_replacement_keeps_other_users_accounts_scopes_and_failed_results(monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(tasks, "engine", engine)
    with Session(engine) as db:
        db.add_all([User(id=1, email="first@example.com"), User(id=2, email="second@example.com")])
        db.commit()

    def upload(user, account, scope, external, status="success", replace=False):
        return tasks.process_collector_import({
            "platform": "naver_kin", "account_label": account, "scan_scope": scope,
            "status": status, "replace_existing": replace,
            "items": [] if external is None else [{"external_id": external, "activity_type": scope, "content": external}],
        }, user)

    upload(1, "mine", "question", "old-question")
    upload(1, "mine", "answer", "old-answer")
    upload(1, "other-account", "question", "other-account-question")
    upload(2, "mine", "question", "other-user-question")
    assert upload(1, "mine", "question", "new-question", replace=True)["replaced"] == 1
    upload(1, "mine", "answer", None, status="error", replace=True)
    with Session(engine) as db:
        assert set(db.scalars(select(Activity.external_id))) == {
            "new-question", "old-answer", "other-account-question", "other-user-question",
        }
    assert upload(1, "mine", "question", None, replace=True)["replaced"] == 1
    with Session(engine) as db:
        assert set(db.scalars(select(Activity.external_id))) == {
            "old-answer", "other-account-question", "other-user-question",
        }
    engine.dispose()
