from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(name: str) -> str:
    return (EXTENSION / name).read_text(encoding="utf-8")


def test_manifest_loads_separate_user_message_layers() -> None:
    manifest = read("manifest.json")
    assert '"user_experience_messages.js"' in manifest
    assert '"dashboard_user_messages.js"' in manifest
    assert '"google_activity_user_messages.js"' in manifest


def test_delete_page_explains_outcome_and_credit_usage() -> None:
    copy = read("user_experience_messages.js")
    assert "삭제 보류" in copy
    assert "삭제 실패" in copy
    assert "삭제 완료" in copy
    assert "목록 정리 완료" in copy
    assert "삭제권은 사용되지 않았습니다" in copy
    assert "남은 삭제권은" in copy
    assert "목록에 그대로 두었습니다" in copy


def test_internal_details_are_hidden_from_user_messages() -> None:
    delete_copy = read("user_experience_messages.js")
    dashboard_copy = read("dashboard_user_messages.js")
    google_copy = read("google_activity_user_messages.js")
    for content in (delete_copy, dashboard_copy, google_copy):
        assert "console.warn" in content
        assert "처리 중 문제가 발생했습니다" in content
        assert "HTTP\\s*\\d+" in content
        assert "CSRF" in content
        assert "활동 ID" in content


def test_google_task_window_uses_plain_language() -> None:
    copy = read("google_activity_user_messages.js")
    assert "선택한 ${label}을 찾고 있습니다" in copy
    assert "안전을 위해 삭제하지 않습니다" in copy
    assert "삭제 결과를 확인하고 있습니다" in copy


def test_dashboard_uses_user_oriented_scan_labels() -> None:
    copy = read("dashboard_user_messages.js")
    assert "사이트 활동 조회" in copy
    assert "최근 조회 결과" in copy
    assert "확인 필요" in copy
    assert "일부 확인" in copy
    assert "새로 저장" in copy
