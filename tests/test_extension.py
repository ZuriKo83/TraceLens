import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(name: str) -> str:
    return (EXTENSION / name).read_text(encoding="utf-8")


def test_manifest_has_required_hosts_and_current_version() -> None:
    manifest = json.loads(read("manifest.json"))
    assert manifest["version"] == "1.1.0"
    assert "https://www.threads.com/*" in manifest["host_permissions"]
    assert "https://www.instagram.com/*" in manifest["host_permissions"]
    assert "https://github.com/*" not in manifest["host_permissions"]
    assert manifest["content_scripts"][0]["js"] == [
        "content_script.js",
        "user_experience_messages.js",
        "dashboard_user_messages.js",
    ]
    assert manifest["content_scripts"][1]["matches"] == ["https://myactivity.google.com/*"]
    assert manifest["content_scripts"][1]["js"] == ["google_activity_user_messages.js"]
    assert set(manifest["permissions"]) == {"activeTab", "storage", "tabs", "scripting"}


def test_popup_uses_authenticated_user_token() -> None:
    popup = read("popup.js")
    popup_html = read("popup.html")
    assert "collectorToken" in popup
    assert "Authorization" in popup
    assert "threads" in popup
    assert "github" not in popup.lower()
    assert "TraceLens 로그인" in popup_html
    assert "진행 상태" in popup_html
    assert "확인 필요" in popup
    assert "처리 중 문제가 발생했습니다" in popup
    assert "오류: ${error.message}" not in popup
    assert "workspace" not in popup


def test_content_script_connects_from_logged_in_dashboard() -> None:
    content = read("content_script.js")
    assert 'meta[name="tracelens-extension-token"]' in content
    assert 'type: "WEB_CONNECT"' in content
    assert "tracelensExtension" in content
    assert "chrome.runtime.getManifest" in content
    assert "tracelensExtensionVersion" in content


def test_delete_page_uses_current_origin_and_owns_credit_sync() -> None:
    assert not (EXTENSION / "delete_result_reconciler.js").exists()
    content = read("content_script.js")
    assert 'const DELETE_RESULT_STORAGE_KEY = "tracelens:last-delete-result:v12"' in content
    assert "const serverUrl = location.origin" in content
    assert 'form[action="/logout"] input[name="csrf"]' in content
    assert '"X-CSRF-Token": csrfToken' in content
    assert 'credentials: "same-origin"' in content
    assert "checkDeleteCreditBalance" in content
    assert "/api/delete-credits/check-balance" in content
    assert "requestConfirmedRows" in content
    assert "syncResolvedActivities" in content
    assert "/api/delete-credits/confirm-deleted" in content
    assert "charge_activity_ids" in content
    assert "targetActivityIds" in content
    assert "HTTP ${response.status}" in content
    assert "삭제권 ${charged}개 차감" in content
    assert "removeConfirmedRows" not in content
    assert "reconcileAlreadyMissing" not in content
    assert "reconcileStoredDeletionStatus" in content
    assert "renderedActivityIds" in content
    assert "serverRowsReconciled" in content


def test_user_facing_message_layer_hides_internal_terms() -> None:
    ux = read("user_experience_messages.js")
    dashboard_ux = read("dashboard_user_messages.js")
    google_ux = read("google_activity_user_messages.js")
    assert "삭제 완료" in ux
    assert "삭제 보류" in ux
    assert "목록 정리 완료" in ux
    assert "삭제권은 사용되지 않았습니다" in ux
    assert "처리 중 문제가 발생했습니다" in ux
    assert "HTTP\\s*\\d+" in ux
    assert "console.warn" in ux
    assert ".delete-operation-status.notice" in ux
    assert "최근 조회 결과" in dashboard_ux
    assert "확인 필요" in dashboard_ux
    assert "새로 저장" in dashboard_ux
    assert "공통 전수조사기" in dashboard_ux
    assert "안전을 위해 삭제하지" in google_ux
    assert "삭제 결과를 확인하고 있습니다" in google_ux


def test_youtube_scan_messages_are_plain_language() -> None:
    collector = read("youtube_activity_collector.js")
    assert "YouTube 조회 기능을 불러오지 못했습니다" in collector
    assert "원문을 바로 열 수 없는 항목" in collector
    assert "공통 전수조사기로 확인했습니다" not in collector
    assert "이동된 주소" not in collector


def test_delete_api_paths_are_dispatched_to_account_tools_app() -> None:
    middleware = (ROOT / "app" / "redis_session.py").read_text(encoding="utf-8")
    assert '"/delete-credits/purchase"' in middleware
    assert '"/api/delete-credits/check-balance"' in middleware
    assert '"/api/delete-credits/confirm-deleted"' in middleware
    assert "account_tools_app.include_router(delete_credits_router)" in middleware
    assert "elif path in ACCOUNT_TOOL_PATHS:" in middleware
    assert "target_app = account_tools_app"


def test_background_has_threads_and_bearer_import() -> None:
    background = read("background.js")
    assert 'threads_posts' in background
    assert 'threads_replies' in background
    assert 'platform === "threads"' in background
    assert '"Authorization": `Bearer ${config.collectorToken || ""}`' in background
    assert "github" not in background.lower()


def test_web_bridge_is_present() -> None:
    content = read("content_script.js")
    background = read("background.js")
    assert "TRACELENS_WEB_COMMAND" in content
    assert "START_SCAN" in content
    assert "resolveCollectorConfig" in background


def test_instagram_parser_extracts_signed_in_visual_rows() -> None:
    background = read("background.js")
    assert 'ownership_verified: true' in background
    assert 'extractor_version: "1.0.0"' in background
    assert 'management-row-signed-in-visual-line' in background
    assert 'visualTextLines' in background
    assert 'signedInCommentFromRow' in background
    assert 'accountPrefixPattern' in background
    assert 'diagnosticAuthors' in background
    assert 'openManagementRow' not in background
    assert 'collectOwnCommentsFromPost' not in background


def test_instagram_identity_is_dynamic_and_not_user_specific() -> None:
    background = read("background.js")
    assert "instagramIdentityVerified" in background
    assert 'accountContext?.instagramUsername || ""' in background
    assert "yeon_o11" not in background.lower()
    assert "skykang01" not in background.lower()


def test_tracelens_brand_and_icons() -> None:
    manifest = json.loads(read("manifest.json"))
    assert manifest["name"] == "TraceLens"
    assert manifest["action"]["default_title"] == "TraceLens"
    assert manifest["icons"]["128"] == "icons/icon128.png"
    assert (EXTENSION / "icons" / "icon128.png").exists()


def test_public_domain_is_connected() -> None:
    manifest = json.loads(read("manifest.json"))
    assert "https://tracelens.kr/*" in manifest["host_permissions"]
    assert "https://tracelens.kr/*" in manifest["content_scripts"][0]["matches"]
    assert "https://tracelens.kr" in read("popup.js")
    assert "https://tracelens.kr" in read("background.js")