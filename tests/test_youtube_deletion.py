import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_reusable_deletion_engine_and_youtube_adapter_are_loaded() -> None:
    manifest = json.loads(read(EXTENSION / "manifest.json"))
    worker = read(EXTENSION / "service_worker.js")

    assert manifest["version"] == "1.1.7"
    assert "deletion_engine.js" in worker
    assert "youtube_delete_page.js" in worker
    assert "youtube_verify_page.js" in worker
    assert "youtube_deletion_adapter.js" in worker
    assert "youtube_delete_worker.js" not in worker
    assert "youtube_activity_deleter.js" not in worker
    assert manifest["content_scripts"][0]["js"] == ["content_script.js"]
    assert "https://myactivity.google.com/*" in manifest["host_permissions"]


def test_engine_uses_separate_task_window_and_hides_verification() -> None:
    engine = read(EXTENSION / "deletion_engine.js")

    assert "registerAdapter(platform, adapter)" in engine
    assert 'message?.type !== "DELETE_PLATFORM_ITEMS"' in engine
    assert "runningPlatforms" in engine
    assert 'chrome.windows.create({url, focused: true, type: "popup"})' in engine
    assert "const taskTabId = tab.id" in engine
    assert "deletionPass(taskTabId" in engine
    assert "await returnToWebTab()" in engine
    assert "reloadAndWait(taskTabId, state, adapter, false)" in engine
    assert "verificationPass(taskTabId" in engine
    assert "syncArchive(adapter, config, taskTabId, verification)" in engine
    assert "closeTaskWindow" in engine
    assert "뒤쪽 작업 창" in engine


def test_youtube_adapter_uses_single_verification_snapshot() -> None:
    adapter = read(EXTENSION / "youtube_deletion_adapter.js")
    engine = read(EXTENSION / "deletion_engine.js")

    assert 'registerAdapter("youtube"' in adapter
    assert "maxTargets: 100" in adapter
    assert "batchSize: 20" in adapter
    assert "batchPauseMs: 500" in adapter
    assert "verificationDelayMs: 1800" in adapter
    assert "retry: false" in adapter
    assert "syncFromVerification" in adapter
    assert "postExtraction(config, extraction)" in adapter
    assert 'typeof adapter.syncFromVerification === "function"' in engine
    assert "adapter.syncFromVerification(verification, config, tabId)" in engine


def test_youtube_deletion_restores_position_and_tracks_click_attempts() -> None:
    deleter = read(EXTENSION / "youtube_delete_page.js")

    assert 'c-wiz[jsname="Ttx95"][data-token]' in deleter
    assert 'button[jslog^="114566"]' in deleter
    assert 'a[jsname="BLHFSc"][href*="lc="]' in deleter
    assert '.QTGV3c[jsname="r4nke"]' in deleter
    assert "commentId" in deleter
    assert "scrollTop: savedTop" in deleter
    assert "restoreAndFind" in deleter
    assert "await setScroll(saved.scrollTop" in deleter
    assert "wrapperByToken" in deleter
    assert "const attemptedIds = []" in deleter
    assert "attemptedIds.push(target.id)" in deleter
    assert "batchClicks >= batchSize" in deleter
    assert "clickConfirmIfPresent" in deleter
    assert "await waitRemoved(refreshed, 900)" in deleter


def test_engine_uses_reload_verification_after_immediate_dom_delay() -> None:
    engine = read(EXTENSION / "deletion_engine.js")

    assert "firstPass.attemptedIds" in engine
    assert "const attempted = new Set" in engine
    assert "attempted.has(target.id)" in engine
    assert "verificationDelayMs" in engine
    assert "await sleep(verificationDelayMs)" in engine
    assert "삭제 버튼 클릭 기록이 없어 삭제 여부를 확정할 수 없습니다." in engine
    assert "unmatched.has(target.id) && firstPass.discoveryComplete === true" in engine


def test_youtube_verification_uses_exact_comment_id_and_collects_snapshot() -> None:
    verifier = read(EXTENSION / "youtube_verify_page.js")

    assert 'c-wiz[jsname="Ttx95"][data-token]' in verifier
    assert 'button[jslog^="114566"]' in verifier
    assert "const collected = new Map()" in verifier
    assert "foundIds" in verifier
    assert "snapshot_complete: complete" in verifier
    assert "extraction" in verifier
    assert 'extractor_version: "1.4.1"' in verifier
    assert "if (targetCommentId) return Boolean(item.commentId && targetCommentId === item.commentId)" in verifier
    assert "sameSpecificTitle" in verifier
    assert "bottomStable >= 5" in verifier


def test_existing_purchase_page_keeps_credits_and_runs_deletion() -> None:
    content = read(EXTENSION / "content_script.js")
    base = read(ROOT / "app" / "templates" / "base.html")
    purchase = read(ROOT / "app" / "templates" / "delete_credit_purchase.html")
    credits = read(ROOT / "app" / "delete_credits.py")

    assert 'location.pathname === "/delete-credits/purchase"' in content
    assert "installPurchaseDeletionBridge" in content
    assert 'type: "DELETE_PLATFORM_ITEMS"' in content
    assert 'platform: "youtube"' in content
    assert "TRACELENS_DELETE_REQUEST" in content
    assert "/app?mode=delete" not in content
    assert "installDeletionCenter" not in content
    assert "firstFailure" in content

    assert '<a href="/delete-credits/purchase">삭제</a>' in base
    assert "/app?mode=delete" not in base

    assert "삭제권 구매" in purchase
    assert "현재 보유 삭제권" in purchase
    assert "플랫폼별 삭제 실행" in purchase
    assert "YouTube" in purchase
    assert "Instagram" in purchase
    assert "Threads" in purchase
    assert "Facebook" in purchase
    assert 'data-supported="{{ 1 if supported else 0 }}"' in purchase
    assert "TRACELENS_DELETE_REQUEST" in purchase
    assert 'meta name="tracelens-extension-token"' in purchase

    assert '@router.get("/delete-credits/purchase"' in credits
    assert "issue_collector_token" in credits
    assert '"extension_token": extension_token' in credits


def test_youtube_collector_handles_virtualized_rows_and_marks_only_complete_snapshots() -> None:
    collector = read(EXTENSION / "youtube_activity_collector.js")

    assert "collectYouTubeActivityPageV2" in collector
    assert "new WeakSet" not in collector
    assert "const collected = new Map()" in collector
    assert "MutationObserver" in collector
    assert "bottomStable >= 12" in collector
    assert "viewport * 0.62" in collector
    assert "step < 1200" in collector
    assert "snapshot_complete: complete" in collector
    assert 'status: items.length ? (complete ? "success" : "partial")' in collector
    assert 'extractor_version: "1.3.0"' in collector


def test_complete_snapshot_prunes_only_verified_missing_youtube_rows() -> None:
    schemas = read(ROOT / "app" / "schemas.py")
    tasks = read(ROOT / "app" / "tasks.py")

    assert "snapshot_complete: bool = False" in schemas
    assert "_prune_complete_youtube_snapshot" in tasks
    assert "payload.snapshot_complete" in tasks
    assert "db.delete(activity)" in tasks
