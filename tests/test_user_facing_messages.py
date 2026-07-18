from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"
TEMPLATES = ROOT / "app" / "templates"


def read_extension(name: str) -> str:
    return (EXTENSION / name).read_text(encoding="utf-8")


def read_template(name: str) -> str:
    return (TEMPLATES / name).read_text(encoding="utf-8")


def test_manifest_loads_user_message_layers() -> None:
    manifest = read_extension("manifest.json")
    assert '"user_experience_messages.js"' in manifest
    assert '"dashboard_user_messages.js"' in manifest
    assert '"google_activity_user_messages.js"' in manifest


def test_delete_page_keeps_only_essential_copy() -> None:
    template = read_template("delete_credit_purchase.html")
    unwanted = [
        "DELETE ACTIVITY",
        "플랫폼별 삭제 실행",
        "삭제권 구매 영역과 실제 삭제 실행 영역을 분리했습니다.",
        "확장 프로그램 연결 확인 중입니다.",
        "확장 프로그램 v",
        "YouTube 댓글을 한 번에 최대 100개까지 처리합니다.",
        "삭제 가능",
    ]
    for text in unwanted:
        assert text not in template
    assert 'id="delete-operation-status" hidden' in template
    assert "작성한 항목 삭제" in template
    assert "삭제권 {{ balance }}개" in template
    assert "삭제할 기록이 없습니다" in template


def test_dashboard_removes_connection_and_explanation_copy() -> None:
    template = read_template("user_dashboard.html")
    unwanted = [
        "MY ACTIVITY",
        "웹에서 바로 조회",
        "조회할 사이트를 선택하세요",
        "확장 프로그램 팝업을 열지 않아도 됩니다",
        "확장 프로그램 연결 확인 중",
        "확장 프로그램 자동 연결됨",
        "플랫폼별 실행 결과",
        "게시글·댓글처럼 나뉜 조회",
        "영상·SNS·커뮤니티",
        "블로그·SNS 게시물",
    ]
    for text in unwanted:
        assert text not in template
    assert 'id="extension-status-card" data-install-url="{{ extension_store_url }}" hidden' in template
    assert "사이트 조회" in template
    assert "최근 조회" in template
    assert "작성한 게시글·댓글" in template


def test_popup_shows_login_and_status_only_when_needed() -> None:
    html = read_extension("popup.html")
    script = read_extension("popup.js")
    unwanted = [
        "MY ACTIVITY",
        "여러 사이트에서 작성한 게시글과 댓글을 찾아",
        "자동 연결",
        "내 활동만 확인",
        "진행 상태",
        'class="step"',
    ]
    for text in unwanted:
        assert text not in html
    assert 'id="connection-card" class="connection-card" hidden' in html
    assert 'id="log-wrap" class="log-wrap" hidden' in html
    assert 'connectionCard.hidden = true' in script
    assert 'logWrap.hidden = lines.length === 0' in script
    assert "TraceLens 로그인" in html
    assert "사이트 조회" in html


def test_delete_outcomes_explain_list_and_credit_result() -> None:
    copy = read_extension("user_experience_messages.js")
    assert "삭제 보류" in copy
    assert "삭제 실패" in copy
    assert "삭제 완료" in copy
    assert "목록 정리 완료" in copy
    assert "삭제권은 사용되지 않았습니다" in copy
    assert "남은 삭제권은" in copy
    assert "목록에 그대로 두었습니다" in copy
    assert 'hidden: true' in copy
    assert 'status.hidden = Boolean(result.hidden)' in copy


def test_internal_details_are_hidden_from_user_messages() -> None:
    for name in (
        "user_experience_messages.js",
        "dashboard_user_messages.js",
        "google_activity_user_messages.js",
    ):
        content = read_extension(name)
        assert "console.warn" in content
        assert "HTTP\\s*\\d+" in content
        assert "CSRF" in content


def test_google_task_window_uses_plain_language() -> None:
    copy = read_extension("google_activity_user_messages.js")
    assert "선택한 ${label}을 찾고 있습니다" in copy
    assert "안전을 위해 삭제하지 않습니다" in copy
    assert "삭제 결과를 확인하고 있습니다" in copy


def test_dashboard_defensively_hides_legacy_annotations() -> None:
    copy = read_extension("dashboard_user_messages.js")
    assert '".user-hero .lead"' in copy
    assert '".stats small"' in copy
    assert '"#web-scan-help"' in copy
    assert 'dataset.tracelensExtension === "connected"' in copy
    assert "확인 필요" in copy
    assert "새로 저장" in copy


def test_all_platform_progress_lines_are_simplified() -> None:
    dashboard = read_extension("dashboard_user_messages.js")
    popup = read_extension("popup.js")
    for content in (dashboard, popup):
        assert "taskLine" in content
        assert "개 새로 저장" in content
        assert "해당 사이트에 로그인한 뒤 다시 조회해 주세요" in content
        assert "사이트 응답이 늦어 조회를 마치지 못했습니다" in content
