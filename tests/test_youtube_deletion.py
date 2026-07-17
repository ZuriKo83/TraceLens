import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_reusable_deletion_engine_and_shared_youtube_pages_are_loaded() -> None:
    manifest = json.loads(read(EXTENSION / "manifest.json"))
    worker = read(EXTENSION / "service_worker.js")
    assert manifest["version"] == "1.4.0"
    assert manifest["content_scripts"][0]["js"] == ["content_script.js"]
    assert "deletion_engine.js" in worker
    assert "youtube_delete_page.js" in worker
    assert "youtube_activity_verify_page.js" in worker
    assert "youtube_deletion_adapter.js" in worker
    assert "https://myactivity.google.com/*" in manifest["host_permissions"]


def test_collection_delete_and_verify_share_one_page_scanner() -> None:
    page = read(EXTENSION / "youtube_delete_page.js")
    verifier = read(EXTENSION / "youtube_activity_verify_page.js")
    collector = read(EXTENSION / "youtube_activity_collector.js")
    assert "traceLensProcessYouTubeActivityPage" in page
    assert "traceLensDeleteYouTubeTargetsInPage = globalThis.traceLensProcessYouTubeActivityPage" in page
    assert verifier.strip() == (
        "globalThis.traceLensVerifyYouTubeActivityTargetsInPage = "
        "globalThis.traceLensProcessYouTubeActivityPage;"
    )
    assert "globalThis.traceLensProcessYouTubeActivityPage" in collector
    assert "func: scanner" in collector
    assert "entry.result?.extraction || entry.result" in collector
    assert "payload.snapshot_complete === true" in collector
    assert 'extractor_version: "2.0.0-shared"' in collector
    assert "collectYouTubeActivityPageV2" not in collector
    assert "MutationObserver" not in collector
    assert "rowForButton" not in collector
    assert "parseRow" not in collector


def test_full_scan_finishes_on_stable_bottom_without_mutation_counter() -> None:
    page = read(EXTENSION / "youtube_delete_page.js")
    assert "let stableBottom = 0" in page
    assert "previousBottomSignature" in page
    assert "Math.round(refreshedMax)" in page
    assert "${collected.size}|${discovered.size}" in page
    assert "stableBottom >= 5" in page
    assert "MutationObserver" not in page
    assert "mutationVersion" not in page
    assert "Math.abs(before - next) > 2" in page
    assert "삭제 후 전체 ${itemLabel} 기록을 끝까지 전수 확인" in page


def test_shared_scanner_handles_current_and_legacy_google_cards() -> None:
    page = read(EXTENSION / "youtube_delete_page.js")
    assert 'c-wiz[jsname="Ttx95"]' in page
    assert 'c-wiz[data-show-delete-individual="true"]' in page
    assert "wrapperForButton" in page
    assert "depth < 14" in page
    assert "relationPattern" in page
    assert "에\\s*남긴\\s*댓글" in page
    assert "directNode" in page
    assert "visibleDeleteButtons" in page
    assert "decodedCandidates" in page
    assert 'extractParam(value, "lc")' in page
    assert "sourceInfo" in page


def test_shared_scanner_matches_conservatively_and_retries_deletion() -> None:
    page = read(EXTENSION / "youtube_delete_page.js")
    assert "if (targetId && item.commentId)" in page
    assert "value -= 400" in page
    assert "wantedContent" in page
    assert "item.fullTextNorm.includes(wantedContent)" in page
    assert "target.sourceKey === item.source.key" in page
    assert "best.value < 170" in page
    assert "const maxClickAttempts = 3" in page
    assert "attempt <= maxClickAttempts" in page
    assert "clickConfirmIfPresent" in page
    assert "1200 + attempt * 500" in page
    assert "2200 + attempt * 700" in page


def test_verification_returns_complete_snapshot_and_found_ids() -> None:
    page = read(EXTENSION / "youtube_delete_page.js")
    assert 'const mode = options && typeof options === "object" ? "delete" : "verify"' in page
    assert 'if (mode === "verify")' in page
    assert "foundIds" in page
    assert 'extractor_version: "1.9.0"' in page
    assert "snapshot_complete: complete" in page
    assert "삭제 후 끝까지 전수 확인" in page


def test_comment_and_live_chat_adapters_use_shared_page_functions() -> None:
    adapter = read(EXTENSION / "youtube_deletion_adapter.js")
    assert 'key: "youtube"' in adapter
    assert 'key: "youtube_live_chat"' in adapter
    assert 'page: "youtube_comments"' in adapter
    assert 'page: "youtube_live_chat"' in adapter
    assert "deletePageFunction: traceLensDeleteYouTubeTargetsInPage" in adapter
    assert "verifyPageFunction: traceLensVerifyYouTubeActivityTargetsInPage" in adapter
    assert "confirmDeletedTargets(targets)" in adapter
    assert "maxTargets: 100" in adapter
    assert "batchSize: 20" in adapter
    assert "batchPauseMs: 800" in adapter
    assert "verificationDelayMs: 7000" in adapter
    assert "retry: true" in adapter


def test_engine_uses_separate_task_window_and_full_verification() -> None:
    engine = read(EXTENSION / "deletion_engine.js")
    assert 'chrome.windows.create({url, focused: true, type: "popup"})' in engine
    assert "const taskTabId = tab.id" in engine
    assert "reloadAndWait(taskTabId, state, adapter, false)" in engine
    assert "verificationPass(taskTabId" in engine
    assert "const retryTargets = targets.filter" in engine
    assert "verification.complete" in engine
    assert "alreadyMissingIds" in engine
    assert "closeTaskWindow" in engine


def test_purchase_page_syncs_verified_rows_and_charges_once() -> None:
    content = read(EXTENSION / "content_script.js")
    delete_credits = read(ROOT / "app" / "delete_credits.py")
    middleware = read(ROOT / "app" / "redis_session.py")

    assert "const serverUrl = location.origin" in content
    assert 'form[action="/logout"] input[name="csrf"]' in content
    assert '"X-CSRF-Token": csrfToken' in content
    assert 'credentials: "same-origin"' in content
    assert "/api/delete-credits/check-balance" in content
    assert "/api/delete-credits/confirm-deleted" in content
    assert "charge_activity_ids" in content
    assert "already_charged_activity_ids" in content
    assert "setTimeout(() => location.reload(), 1800)" in content

    assert '"/api/delete-credits/check-balance"' in middleware
    assert '"/api/delete-credits/confirm-deleted"' in middleware
    assert '@router.post("/api/delete-credits/confirm-deleted")' in delete_credits
    assert "class DeleteCreditUsage(Base)" in delete_credits
    assert 'UniqueConstraint("user_id", "activity_id"' in delete_credits
    assert "wallet.balance -= len(newly_charged_ids)" in delete_credits
    assert "db.delete(row)" in delete_credits


def test_complete_snapshot_keeps_two_scan_safety_for_unselected_stale_rows() -> None:
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
    assert not (EXTENSION / "delete_result_reconciler.js").exists()