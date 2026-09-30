import json

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db import Base
from app.models import Activity, User
from app.youtube_delete import DeleteConfirmation, DeleteSelection, delete_confirm, delete_targets


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add_all([User(id=1, email="mine@example.com"), User(id=2, email="other@example.com")])
        session.add_all([
            Activity(id=1, user_id=1, platform="youtube", activity_type="comment", external_id="one", content="Video\nMy comment",
                     metadata_json=json.dumps({"ownership_verified": True, "comment_id": "Ugx-one", "youtube_activity_kind": "comment"})),
            Activity(id=2, user_id=2, platform="youtube", activity_type="comment", external_id="other", content="Other comment",
                     metadata_json=json.dumps({"ownership_verified": True, "comment_id": "Ugx-other"})),
            Activity(id=3, user_id=1, platform="youtube", activity_type="comment", external_id="no-id", content="No ID"),
            Activity(id=4, user_id=1, platform="youtube", activity_type="comment", external_id="chat", content="Live chat",
                     metadata_json=json.dumps({"ownership_verified": True, "comment_id": "chat-id", "youtube_activity_kind": "live_chat"})),
        ])
        session.commit()
        yield session
    engine.dispose()


def test_pc_youtube_delete_rejects_other_users_missing_ids_and_chat(db):
    user = db.get(User, 1)
    for ids in ([2], [1, 2], [3], [4], [999]):
        with pytest.raises(HTTPException):
            delete_targets(DeleteSelection(activity_ids=ids), db, user)
    assert db.get(Activity, 1) is not None


def test_pc_youtube_delete_reconciles_selected_only_and_is_idempotent(db):
    user = db.get(User, 1)
    approved = delete_targets(DeleteSelection(activity_ids=[1]), db, user)
    assert approved["targets"][0]["strictMatch"] is True
    assert approved["targets"][0]["commentId"] == "Ugx-one"
    request = DeleteConfirmation(activity_ids=[1], receipt=approved["receipt"], verification_complete=True)
    assert delete_confirm(request, db, user)["removed_ids"] == [1]
    assert delete_confirm(request, db, user)["removed_ids"] == []
    assert db.get(Activity, 2) is not None
    assert db.get(Activity, 3) is not None


def test_pc_youtube_delete_requires_signed_selection_and_complete_verification(db):
    user = db.get(User, 1)
    approved = delete_targets(DeleteSelection(activity_ids=[1]), db, user)
    for ids, receipt, complete, actor in [
        ([1], "tampered", True, user), ([3], approved["receipt"], True, user),
        ([1], approved["receipt"], False, user), ([1], approved["receipt"], True, db.get(User, 2)),
    ]:
        with pytest.raises(HTTPException):
            delete_confirm(DeleteConfirmation(activity_ids=ids, receipt=receipt, verification_complete=complete), db, actor)
    assert db.get(Activity, 1) is not None


def test_pc_youtube_delete_does_not_remove_a_replaced_row(db):
    user = db.get(User, 1)
    approved = delete_targets(DeleteSelection(activity_ids=[1]), db, user)
    db.get(Activity, 1).external_id = "new-comment-reusing-id"
    db.commit()
    result = delete_confirm(DeleteConfirmation(activity_ids=[1], receipt=approved["receipt"], verification_complete=True), db, user)
    assert result["removed_ids"] == []
    assert db.get(Activity, 1).external_id == "new-comment-reusing-id"
