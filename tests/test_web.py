from urllib.parse import urlsplit
import re
import json
import httpx

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import Base, engine
from app.main import app
from app.models import Activity, User, UserEmail


def reset_database() -> None:
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)


def extract_value(html: str, name: str) -> str:
    match = re.search(rf'name="{re.escape(name)}"[^>]*value="([^"]+)"', html)
    assert match, f"missing input {name}"
    return match.group(1)


def login(client: TestClient, email: str) -> None:
    signup = client.get("/signup")
    csrf = extract_value(signup.text, "csrf")
    sent = client.post("/auth/signup/request-code", data={
        "email": email,
        "password": "TraceLens1234",
        "password_confirm": "TraceLens1234",
        "csrf": csrf,
    })
    assert sent.status_code == 200
    code_match = re.search(r'<div class="dev-link-box">.*?<p>(\d{6})</p>', sent.text, re.S)
    assert code_match
    verify_csrf = extract_value(sent.text, "csrf")
    verified = client.post("/auth/signup/verify", data={
        "email": email, "code": code_match.group(1), "csrf": verify_csrf
    }, follow_redirects=False)
    assert verified.status_code == 303
    assert verified.headers["location"] == "/app"


def extension_token(client: TestClient) -> str:
    page = client.get("/app")
    assert page.status_code == 200
    match = re.search(r'<meta name="tracelens-extension-token" content="([^"]+)"', page.text)
    assert match
    return match.group(1)


def test_public_landing_and_login_flow() -> None:
    reset_database()
    with TestClient(app) as client:
        landing = client.get("/")
        assert landing.status_code == 200
        assert "이메일로 시작하기" in landing.text
        login(client, "owner@example.com")
        app_page = client.get("/app")
        assert "owner@example.com" in app_page.text
        assert "서버 수집기" in app_page.text
        admin = client.get("/admin")
        assert admin.status_code == 200
        assert "ADMIN CONSOLE" in admin.text

    with Session(engine) as db:
        owner = db.scalar(select(User).where(User.email == "owner@example.com"))
        assert owner and owner.is_verified and owner.is_admin
        linked = db.scalar(select(UserEmail).where(UserEmail.email == "owner@example.com"))
        assert linked and linked.is_verified


def test_only_configured_email_is_admin() -> None:
    reset_database()
    with TestClient(app) as client:
        login(client, "first-user@example.com")
        assert client.get("/admin", follow_redirects=False).headers["location"] == "/app"

    with Session(engine) as db:
        first_user = db.scalar(select(User).where(User.email == "first-user@example.com"))
        configured_admin = db.scalar(select(User).where(User.email == "owner@example.com"))
        assert first_user and not first_user.is_admin
        assert configured_admin and configured_admin.is_admin


def test_collector_requires_user_token() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.get("/api/collector/status")
    assert response.status_code == 401


def test_user_data_is_isolated_and_admin_can_inspect() -> None:
    reset_database()
    with TestClient(app) as owner_client:
        login(owner_client, "owner@example.com")
        owner_token = extension_token(owner_client)
        response = owner_client.post("/api/collector/import", headers={"Authorization": f"Bearer {owner_token}"}, json={
            "platform": "youtube", "status": "success", "items": [{
                "external_id": "owner-comment", "activity_type": "comment", "title": "관리자 댓글",
                "content": "첫 번째 사용자 데이터", "source_url": "https://www.youtube.com/watch?v=1"
            }]
        })
        assert response.status_code == 200 and response.json()["found"] == 1

        with TestClient(app) as user_client:
            login(user_client, "user@example.com")
            user_token = extension_token(user_client)
            response = user_client.post("/api/collector/import", headers={"Authorization": f"Bearer {user_token}"}, json={
                "platform": "youtube", "status": "success", "items": [{
                    "external_id": "user-comment", "activity_type": "comment", "title": "사용자 댓글",
                    "content": "두 번째 사용자 데이터", "source_url": "https://www.youtube.com/watch?v=2"
                }]
            })
            assert response.status_code == 200 and response.json()["found"] == 1
            user_page = user_client.get("/app")
            assert "사용자 댓글" in user_page.text
            assert "관리자 댓글" not in user_page.text
            assert user_client.get("/admin", follow_redirects=False).headers["location"] == "/app"

        owner_page = owner_client.get("/app")
        assert "관리자 댓글" in owner_page.text
        assert "사용자 댓글" not in owner_page.text
        admin_page = owner_client.get("/admin")
        assert "관리자 댓글" in admin_page.text
        assert "사용자 댓글" in admin_page.text


def test_threads_accepts_only_verified_owner_activity() -> None:
    reset_database()
    with TestClient(app) as client:
        login(client, "threads@example.com")
        token = extension_token(client)
        headers = {"Authorization": f"Bearer {token}"}
        valid = client.post("/api/collector/import", headers=headers, json={
            "platform": "threads", "status": "success", "account_label": "@myname", "items": [{
                "external_id": "threads-own", "activity_type": "post", "title": "내 Threads 글", "content": "",
                "source_url": "https://www.threads.com/@myname/post/ABC",
                "metadata": {
                    "captured_from": "https://www.threads.com/@myname",
                    "ownership_scope": "self_activity", "ownership_verified": True,
                    "threads_owner": "myname", "threads_actor": "myname"
                }
            }]
        })
        invalid = client.post("/api/collector/import", headers=headers, json={
            "platform": "threads", "status": "success", "items": [{
                "external_id": "threads-other", "activity_type": "post", "title": "타인 글", "content": "",
                "source_url": "https://www.threads.com/@other/post/XYZ",
                "metadata": {
                    "captured_from": "https://www.threads.com/@myname",
                    "ownership_scope": "self_activity", "ownership_verified": True,
                    "threads_owner": "myname", "threads_actor": "other"
                }
            }]
        })
    assert valid.json()["found"] == 1
    assert invalid.json()["found"] == 0


def test_connected_email_verification_stays_same_user() -> None:
    reset_database()
    with TestClient(app) as client:
        login(client, "primary@example.com")
        page = client.get("/app/account")
        csrf = extract_value(page.text, "csrf")
        added = client.post("/app/account/emails", data={"email": "second@example.com", "csrf": csrf})
        link = re.search(r'href="(http://testserver/auth/verify\?token=[^"]+)"', added.text)
        assert link
        parsed = urlsplit(link.group(1))
        assert client.get(f"{parsed.path}?{parsed.query}", follow_redirects=False).status_code == 303
    with Session(engine) as db:
        primary = db.scalar(select(User).where(User.email == "primary@example.com"))
        second = db.scalar(select(UserEmail).where(UserEmail.email == "second@example.com"))
        assert primary and second and second.user_id == primary.id and second.is_verified


def test_github_is_removed_from_public_product() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.get("/supported-sites")
    assert "GitHub" not in response.text
    assert "Threads" in response.text


def test_user_dashboard_contains_web_scan_controls() -> None:
    reset_database()
    with TestClient(app) as client:
        login(client, "scanner@example.com")
        response = client.get("/app")
        assert response.status_code == 200
        assert 'id="web-start-scan"' in response.text
        assert 'value="threads"' in response.text


def test_server_browser_requires_login_and_csrf(monkeypatch) -> None:
    reset_database()
    with TestClient(app) as client:
        assert client.post("/api/browser/open", json={"site": "x"}).status_code == 401
        login(client, "browser@example.com")
        dashboard = client.get("/app")
        assert dashboard.status_code == 200
        site = client.get("/app/site?site=x")
        assert site.status_code == 200
        assert "서버에서 실행하는 전용 브라우저" in site.text
        assert client.post("/api/browser/open", json={"site": "x"}).status_code == 400
        csrf = extract_value(dashboard.text, "csrf")
        calls = []

        class FakeCollector:
            def __init__(self, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def post(self, url, *, content, headers):
                calls.append((url, content, headers))
                if json.loads(content).get("revision") == "frame-1":
                    return httpx.Response(204, headers={"x-frame-revision": "frame-1"})
                return httpx.Response(200, content=b"image-bytes", headers={"content-type": "image/jpeg", "x-frame-revision": "frame-1"})

        monkeypatch.setattr("app.main.httpx.AsyncClient", FakeCollector)
        response = client.post("/api/browser/frame", json={"site": "x"}, headers={"X-TraceLens-CSRF": csrf})
        assert response.status_code == 200 and response.content == b"image-bytes"
        assert response.headers["content-type"] == "image/jpeg"
        assert response.headers["x-frame-revision"] == "frame-1"
        assert calls[0][0].endswith(":3080/frame")
        assert calls[0][2]["Authorization"].startswith("Bearer ")
        unchanged = client.post("/api/browser/frame", json={"site": "x", "revision": "frame-1"}, headers={"X-TraceLens-CSRF": csrf})
        assert unchanged.status_code == 204



def test_dashboard_groups_scans_and_activities_by_platform_account() -> None:
    reset_database()
    with TestClient(app) as client:
        login(client, "grouped@example.com")
        token = extension_token(client)
        headers = {"Authorization": f"Bearer {token}"}
        first = client.post("/api/collector/import", headers=headers, json={
            "platform": "naver_kin", "account_label": "네이버 로그인 계정", "scan_scope": "question", "status": "success",
            "message": "질문 조회 완료", "items": [{
                "external_id": "kin-question-1", "activity_type": "question", "title": "내 질문", "content": "질문 내용",
                "source_url": "https://kin.naver.com/qna/detail.naver?d1id=1"
            }]
        })
        second = client.post("/api/collector/import", headers=headers, json={
            "platform": "naver_kin", "account_label": "네이버 로그인 계정", "scan_scope": "answer", "status": "success",
            "message": "답변 조회 완료", "items": [{
                "external_id": "kin-answer-1", "activity_type": "answer", "title": "내 답변", "content": "답변 내용",
                "source_url": "https://kin.naver.com/qna/detail.naver?d1id=2"
            }]
        })
        assert first.status_code == 200 and second.status_code == 200
        page = client.get("/app")
        assert page.status_code == 200
        assert page.text.count('class="scan-group"') == 1
        assert "<b>질문</b> 1" in page.text
        assert "<b>답변</b> 1" in page.text
        assert page.text.count('class="activity-group"') == 1
        assert "1개 그룹 · 2개 기록" in page.text
        assert 'id="expand-activity-groups"' in page.text


def test_admin_filter_accepts_empty_optional_query_values() -> None:
    reset_database()
    with TestClient(app) as client:
        login(client, "owner@example.com")
        response = client.get("/admin?q=&user_id=&platform=")
        assert response.status_code == 200
        assert "최근 수집 활동" in response.text


def test_admin_filter_accepts_valid_user_and_ignores_invalid_user_id() -> None:
    reset_database()
    with TestClient(app) as client:
        login(client, "owner@example.com")
        with Session(engine) as db:
            owner = db.scalar(select(User).where(User.email == "owner@example.com"))
            assert owner
            owner_id = owner.id

        valid = client.get(f"/admin?user_id={owner_id}")
        invalid = client.get("/admin?user_id=not-a-number")
        assert valid.status_code == 200
        assert invalid.status_code == 200


def test_privacy_page_is_public() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.get("/privacy")
        assert response.status_code == 200
        assert "TraceLens 개인정보처리방침" in response.text


def test_navigation_starts_with_my_activity_for_logged_in_user() -> None:
    reset_database()
    with TestClient(app) as client:
        login(client, "nav-order@example.com")
        page = client.get("/app/account")
        nav = re.search(r"<nav>(.*?)</nav>", page.text, re.S)
        assert nav
        assert nav.group(1).find('href="/app"') < nav.group(1).find('href="/supported-sites"')


def test_account_deletion_preserves_activity_and_allows_fresh_signup() -> None:
    reset_database()
    with TestClient(app) as client:
        login(client, "delete-me@example.com")
        token = extension_token(client)
        imported = client.post("/api/collector/import", headers={"Authorization": f"Bearer {token}"}, json={
            "platform": "youtube", "status": "success", "items": [{
                "external_id": "kept-after-delete", "activity_type": "comment", "title": "보관 기록",
                "content": "탈퇴 후에도 남는 활동", "source_url": "https://www.youtube.com/watch?v=kept"
            }]
        })
        assert imported.status_code == 200

        account = client.get("/app/account")
        csrf = extract_value(account.text, "csrf")
        deleted = client.post("/app/account/delete", data={
            "password": "TraceLens1234", "confirmation": "회원탈퇴", "csrf": csrf,
        }, follow_redirects=False)
        assert deleted.status_code == 303
        assert deleted.headers["location"] == "/?account_deleted=1"
        assert client.get("/app", follow_redirects=False).headers["location"].startswith("/login")

        login(client, "delete-me@example.com")
        fresh_page = client.get("/app")
        assert "탈퇴 후에도 남는 활동" not in fresh_page.text

    with Session(engine) as db:
        active = db.scalar(select(User).where(User.email == "delete-me@example.com"))
        deleted_user = db.scalar(select(User).where(User.deleted_at.is_not(None)))
        kept_activity = db.scalar(select(Activity).where(Activity.external_id == "kept-after-delete"))
        assert active and active.deleted_at is None
        assert deleted_user and deleted_user.id != active.id
        assert kept_activity and kept_activity.user_id == deleted_user.id
