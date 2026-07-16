import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_reusable_deletion_engine_and_shared_youtube_pages_are_loaded() -> None:
    manifest = json.loads(read(EXTENSION / "manifest.json"))
    worker = read(EXTENSION / "service_worker.js")

    assert manifest["version"] == "1.2.6"
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


def test_deleter_handles_legacy_and_current_google_activity_cards() -> None:
    deleter = read(EXTENSION / "youtube_delete_page.js")

    assert 'c-wiz[jsname="Ttx95"]' in deleter
    assert 'c-wiz[data-show-delete-individual="true"]' in deleter
    assert "wrapperForButton" in deleter
    assert "depth < 14" in deleter
    assert "relationPattern" in deleter
    assert "에\\s*남긴\\s*댓글" in deleter
    assert "directNode" in deleter
    assert "visibleDeleteButtons" in deleter


def test_deleter_decodes_nested_google_redirect_urls() -> None:
    deleter = read(EXTENSION / "youtube_delete_page.js")

    assert "decodedCandidates" in deleter
    assert 'for (const key of ["url", "q", "continue", "redirect", "target", "u", "dest", "href"])' in deleter
    assert 'extractParam(value, "lc")' in deleter
    assert "sourceKeyFromValue" in deleter
    assert "decodeURIComponent" in deleter


def test_deleter_falls_back_to_content_when_only_one_side_has_comment_id() -> None:
    deleter = read(EXTENSION / "youtube_delete_page.js")

    assert "if (targetId && item.commentId)" in deleter
    assert "value -= 400" in deleter
    assert "wantedContent" in deleter
    assert "item.fullTextNorm.includes(wantedContent)" in deleter
    assert "target.sourceKey === item.sourceKey" in deleter
    assert "best.value < 170" in deleter


def test_deleter_scrolls_actual_container_and_never_marks_unmatched_as_missing() -> None:
    deleter = read(EXTENSION / "youtube_delete_page.js")

    assert "pickScrollRoot" in deleter
    assert 'document.querySelectorAll("body *")' in deleter
    assert "/(auto|scroll)/.test(style.overflowY" in deleter
    assert "step < 1800" in deleter
    assert "root.scrollTop = next" in deleter
    assert "scanComplete" in deleter
    assert "discoveryComplete: unmatchedIds.length === 0" in deleter
    assert "attemptedIds.push(target.id)" in deleter
    assert "clickConfirmIfPresent" in deleter


def test_verifier_uses_same_robust_matching_rules() -> None:
    verifier = read(EXTENSION / "youtube_activity_verify_page.js")

    assert "decodedCandidates" in verifier
    assert "wrapperForButton" in verifier
    assert "relationPattern" in verifier
    assert "if (targetId && item.commentId)" in verifier
    assert "item.rowTextNorm.includes(wantedContent)" in verifier
    assert "step < 2000" in verifier
    assert 'extractor_version:"1.8.0"' in verifier
    assert "snapshot_complete:complete" in verifier


def test_engine_returns_pending_instead_of_false_deleted_success() -> None:
    engine = read(EXTENSION / "deletion_engine.js")

    assert "const pendingIds = []" in engine
    assert "pendingIds.push(target.id)" in engine
    assert "deleted: 0" in engine
    assert "pending: pendingIds.length" in engine
    assert "deferArchiveSync" in engine
    assert "YouTube 실제 반영 전까지 TraceLens 보관함 기록을 유지합니다." in engine


def test_purchase_page_prefers_visible_title_and_content() -> None:
    content = read(EXTENSION / "content_script.js")
    purchase = read(ROOT / "app" / "templates" / "delete_credit_purchase.html")

    assert 'const DELETE_RESULT_STORAGE_KEY = "tracelens:last-delete-result:v4"' in content
    assert "const visibleTitle" in content
    assert "const visibleContent" in content
    assert "title: visibleTitle || locator.title" in content
    assert "content: visibleContent || locator.content" in content
    assert "reconcileWithServerList" not in content
    assert "반영 전까지 TraceLens 목록을 유지합니다." in content
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