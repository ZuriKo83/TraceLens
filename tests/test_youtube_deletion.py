import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_reusable_deletion_engine_and_shared_youtube_pages_are_loaded() -> None:
    manifest = json.loads(read(EXTENSION / "manifest.json"))
    worker = read(EXTENSION / "service_worker.js")

    assert manifest["version"] == "1.2.5"
    assert "deletion_engine.js" in worker
    assert "youtube_delete_page.js" in worker
    assert "youtube_activity_verify_page.js" in worker
    assert "youtube_deletion_adapter.js" in worker
    assert "youtube_live_chat_delete_page.js" not in worker
    assert "youtube_live_chat_verify_page.js" not in worker
    assert "https://myactivity.google.com/*" in manifest["host_permissions"]


def test_engine_uses_separate_task_window_and_hidden_verification() -> None:
    engine = read(EXTENSION / "deletion_engine.js")

    assert 'chrome.windows.create({url, focused: true, type: "popup"})' in engine
    assert "const taskTabId = tab.id" in engine
    assert "await returnToWebTab()" in engine
    assert "reloadAndWait(taskTabId, state, adapter, false)" in engine
    assert "verificationPass(taskTabId" in engine
    assert "closeTaskWindow" in engine


def test_comment_and_live_chat_adapters_share_page_functions_and_defer_sync() -> None:
    adapter = read(EXTENSION / "youtube_deletion_adapter.js")

    assert 'key: "youtube"' in adapter
    assert 'key: "youtube_live_chat"' in adapter
    assert 'page: "youtube_comments"' in adapter
    assert 'page: "youtube_live_chat"' in adapter
    assert "deletePageFunction: traceLensDeleteYouTubeTargetsInPage" in adapter
    assert "verifyPageFunction: traceLensVerifyYouTubeActivityTargetsInPage" in adapter
    assert "deferArchiveSync: true" in adapter
    assert "maxTargets: 100" in adapter
    assert "batchSize: 20" in adapter


def test_adapter_does_not_trust_google_activity_token_as_comment_id() -> None:
    adapter = read(EXTENSION / "youtube_deletion_adapter.js")

    assert 'parseUrl(rawSourceUrl)?.searchParams.get("lc")' in adapter
    assert "comment_id: urlCommentId || null" in adapter
    assert "activity_token: null" in adapter
    assert "legacy_activity_token" in adapter


def test_deleter_scrolls_actual_container_and_tracks_complete_scan() -> None:
    deleter = read(EXTENSION / "youtube_delete_page.js")

    assert "pickScrollRoot" in deleter
    assert 'document.querySelectorAll("body *")' in deleter
    assert "/(auto|scroll)/.test(style.overflowY" in deleter
    assert "step < 1600" in deleter
    assert "root.scrollTop = next" in deleter
    assert "scanComplete" in deleter
    assert "discoveryComplete: scanComplete" in deleter
    assert "attemptedIds.push(target.id)" in deleter
    assert "clickConfirmIfPresent" in deleter
    assert "Google 내 활동에서 사라지지 않았습니다." in deleter


def test_deleter_uses_normalized_content_title_and_source_matching() -> None:
    deleter = read(EXTENSION / "youtube_delete_page.js")

    assert '.normalize("NFKC")' in deleter
    assert "const loose =" in deleter
    assert "semantic_hash" in deleter
    assert "row_text_hash" in deleter
    assert "target.sourceKey === item.sourceKey" in deleter
    assert "wantedContentLoose" in deleter
    assert "wantedTitleLoose" in deleter
    assert "trustedCommentId" in deleter


def test_verifier_scrolls_actual_container_to_stable_bottom() -> None:
    verifier = read(EXTENSION / "youtube_activity_verify_page.js")

    assert "pickScrollRoot" in verifier
    assert 'document.querySelectorAll("body *")' in verifier
    assert "step < 1800" in verifier
    assert "stableBottom >= 8" in verifier
    assert "foundIds" in verifier
    assert 'extractor_version: "1.7.0"' in verifier
    assert "snapshot_complete: complete" in verifier


def test_engine_returns_pending_instead_of_false_deleted_success() -> None:
    engine = read(EXTENSION / "deletion_engine.js")

    assert "const pendingIds = []" in engine
    assert "pendingIds.push(target.id)" in engine
    assert "deleted: 0" in engine
    assert "pending: pendingIds.length" in engine
    assert "deferArchiveSync" in engine
    assert "YouTube 실제 반영 전까지 TraceLens 보관함 기록을 유지합니다." in engine


def test_purchase_page_keeps_pending_rows_and_does_not_reconcile_by_server_id() -> None:
    content = read(EXTENSION / "content_script.js")
    purchase = read(ROOT / "app" / "templates" / "delete_credit_purchase.html")

    assert 'const DELETE_RESULT_STORAGE_KEY = "tracelens:last-delete-result:v3"' in content
    assert "reconcileWithServerList" not in content
    assert "삭제 요청" in content
    assert "반영 전까지 TraceLens 목록을 유지합니다." in content
    assert "setTimeout(() => location.reload(), 1800)" in content
    assert 'data-kind="comment"' in purchase
    assert 'data-kind="live_chat"' in purchase


def test_youtube_collector_displays_completed_empty_scope_as_no_records() -> None:
    collector = read(EXTENSION / "youtube_activity_collector.js")
    dashboard = read(ROOT / "app" / "templates" / "user_dashboard.html")

    assert 'status: complete ? "success" : "partial"' in collector
    assert "기록이 없습니다. 끝까지 확인했습니다." in collector
    assert "entry.status == 'success' and entry.found_count == 0" in dashboard
    assert "기록 없음" in dashboard


def test_complete_snapshot_requires_two_consecutive_misses_before_pruning() -> None:
    tasks = read(ROOT / "app" / "tasks.py")

    assert "_reconcile_complete_youtube_snapshot" in tasks
    assert 'Activity.status.in_(["visible", "missing_once"])' in tasks
    assert 'if activity.status == "missing_once"' in tasks
    assert 'activity.status = "missing_once"' in tasks
    assert "db.delete(activity)" in tasks


def test_replaced_duplicate_youtube_files_are_removed() -> None:
    assert not (EXTENSION / "youtube_verify_page.js").exists()
    assert not (EXTENSION / "youtube_live_chat_delete_page.js").exists()
    assert not (EXTENSION / "youtube_live_chat_verify_page.js").exists()