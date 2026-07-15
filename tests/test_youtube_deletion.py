import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_reusable_deletion_engine_and_shared_youtube_pages_are_loaded() -> None:
    manifest = json.loads(read(EXTENSION / "manifest.json"))
    worker = read(EXTENSION / "service_worker.js")

    assert manifest["version"] == "1.2.4"
    assert "deletion_engine.js" in worker
    assert "youtube_delete_page.js" in worker
    assert "youtube_activity_verify_page.js" in worker
    assert "youtube_deletion_adapter.js" in worker
    assert "youtube_verify_page.js" not in worker
    assert "youtube_live_chat_delete_page.js" not in worker
    assert "youtube_live_chat_verify_page.js" not in worker
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
    assert "closeTaskWindow" in engine
    assert "뒤쪽 작업 창" in engine


def test_youtube_comment_and_live_chat_adapters_use_same_page_functions() -> None:
    adapter = read(EXTENSION / "youtube_deletion_adapter.js")

    assert 'key: "youtube"' in adapter
    assert 'key: "youtube_live_chat"' in adapter
    assert 'kind: "comment"' in adapter
    assert 'kind: "live_chat"' in adapter
    assert 'page: "youtube_comments"' in adapter
    assert 'page: "youtube_live_chat"' in adapter
    assert "deletePageFunction: traceLensDeleteYouTubeTargetsInPage" in adapter
    assert "verifyPageFunction: traceLensVerifyYouTubeActivityTargetsInPage" in adapter
    assert "traceLensDeleteYouTubeLiveChatTargetsInPage" not in adapter
    assert "traceLensVerifyYouTubeLiveChatTargetsInPage" not in adapter
    assert "activityKind" in adapter
    assert "maxTargets: 100" in adapter
    assert "batchSize: 20" in adapter
    assert "verificationDelayMs: 1800" in adapter
    assert "retry: false" in adapter
    assert "deferArchiveSync: true" in adapter


def test_adapter_does_not_treat_google_activity_token_as_comment_id() -> None:
    adapter = read(EXTENSION / "youtube_deletion_adapter.js")

    assert 'parseUrl(rawSourceUrl)?.searchParams.get("lc")' in adapter
    assert "comment_id: urlCommentId || null" in adapter
    assert "activity_token: null" in adapter
    assert "legacy_activity_token" in adapter
    assert "Google data-token은 항상 실제 댓글 ID가 아니므로" in adapter


def test_shared_youtube_deletion_selects_page_from_activity_kind() -> None:
    deleter = read(EXTENSION / "youtube_delete_page.js")

    assert 'targets?.[0]?.activityKind === "live_chat"' in deleter
    assert 'expectedPage = activityKind === "live_chat" ? "youtube_live_chat" : "youtube_comments"' in deleter
    assert 'itemLabel = activityKind === "live_chat" ? "실시간 채팅" : "댓글"' in deleter
    assert 'c-wiz[jsname="Ttx95"][data-token]' in deleter
    assert 'button[jslog^="114566"]' in deleter
    assert 'a[jsname="BLHFSc"][href*="lc="]' in deleter
    assert '.QTGV3c[jsname="r4nke"]' in deleter
    assert "lineContent" in deleter
    assert "scrollTop: savedTop" in deleter
    assert "restoreAndFind" in deleter
    assert "attemptedIds.push(target.id)" in deleter
    assert "clickConfirmIfPresent" in deleter
    assert "await waitRemoved(refreshed, 900)" in deleter
    assert "await waitRemoved(refreshed, 1800)" in deleter


def test_shared_youtube_verifier_separates_comment_id_and_activity_token() -> None:
    verifier = read(EXTENSION / "youtube_activity_verify_page.js")

    assert 'targets?.[0]?.activityKind === "live_chat"' in verifier
    assert 'page = kind === "live_chat" ? "youtube_live_chat" : "youtube_comments"' in verifier
    assert 'label = kind === "live_chat" ? "실시간 채팅" : "댓글"' in verifier
    assert 'scan_scope: kind' in verifier
    assert 'youtube_activity_kind: kind' in verifier
    assert 'extractor_version: "1.6.1"' in verifier
    assert "snapshot_complete: complete" in verifier
    assert 'commentId = clean(rawParsed?.searchParams.get("lc"))' in verifier
    assert "activityToken = clean(wrapper.getAttribute" in verifier
    assert "comment_id: entry.commentId || null" in verifier
    assert "activity_token: entry.activityToken || null" in verifier
    assert "uniqueMatch" in verifier
    assert "semantic_hash" in verifier
    assert "row_text_hash" in verifier


def test_engine_reports_pending_instead_of_immediate_youtube_success() -> None:
    engine = read(EXTENSION / "deletion_engine.js")

    assert "firstPass.attemptedIds" in engine
    assert "const attempted = new Set" in engine
    assert "attempted.has(target.id)" in engine
    assert "verificationDelayMs" in engine
    assert "await sleep(verificationDelayMs)" in engine
    assert "const pendingIds = []" in engine
    assert "pendingIds.push(target.id)" in engine
    assert "deleted: 0" in engine
    assert "syncDeferred" in engine
    assert "YouTube 실제 댓글 반영이 확인되기 전까지 TraceLens 보관함을 유지합니다." in engine


def test_purchase_page_refreshes_without_server_row_success_inference() -> None:
    content = read(EXTENSION / "content_script.js")
    base = read(ROOT / "app" / "templates" / "base.html")
    purchase = read(ROOT / "app" / "templates" / "delete_credit_purchase.html")
    credits = read(ROOT / "app" / "delete_credits.py")

    assert 'location.pathname === "/delete-credits/purchase"' in content
    assert "installPurchaseDeletionBridge" in content
    assert 'platformKey = liveChat ? "youtube_live_chat" : "youtube"' in content
    assert '["comment", "live_chat"]' in content
    assert "dataset.youtubeKind" in content
    assert "TRACELENS_DELETE_REQUEST" in content
    assert "/app?mode=delete" not in content
    assert 'const DELETE_RESULT_STORAGE_KEY = "tracelens:last-delete-result:v3"' in content
    assert "reconcileWithServerList" not in content
    assert "serverRemoved" not in content
    assert "삭제 요청 ${pending}개가 접수됐습니다." in content
    assert "반영 전까지 TraceLens 목록을 유지합니다." in content
    assert "setTimeout(() => location.reload(), 1800)" in content
    assert "마지막 삭제 결과" in content

    assert '<a href="/delete-credits/purchase">삭제</a>' in base
    assert "/app?mode=delete" not in base

    assert "삭제권 구매" in purchase
    assert "플랫폼별 삭제 실행" in purchase
    assert 'data-kind="comment"' in purchase
    assert 'data-kind="live_chat"' in purchase
    assert 'data-youtube-kind="{{ youtube_kind }}"' in purchase
    assert "실시간 채팅 · 최대 100개" in purchase
    assert "TRACELENS_DELETE_REQUEST" in purchase
    assert 'meta name="tracelens-extension-token"' in purchase

    assert '@router.get("/delete-credits/purchase"' in credits
    assert "issue_collector_token" in credits
    assert '"extension_token": extension_token' in credits


def test_youtube_collector_handles_virtualized_rows_and_empty_complete_scope() -> None:
    collector = read(EXTENSION / "youtube_activity_collector.js")
    dashboard = read(ROOT / "app" / "templates" / "user_dashboard.html")

    assert "collectYouTubeActivityPageV2" in collector
    assert 'activityType: "live_chat"' in collector
    assert 'page=youtube_live_chat' in collector
    assert "new WeakSet" not in collector
    assert "const collected = new Map()" in collector
    assert "MutationObserver" in collector
    assert "bottomStable >= 12" in collector
    assert "viewport * 0.62" in collector
    assert "step < 1200" in collector
    assert "snapshot_complete: complete" in collector
    assert 'status: complete ? "success" : "partial"' in collector
    assert "기록이 없습니다. 끝까지 확인했습니다." in collector
    assert 'extractor_version: "1.3.0"' in collector

    assert "entry.scope == 'live_chat'" in dashboard
    assert "entry.status == 'success' and entry.found_count == 0" in dashboard
    assert "실시간 채팅" in dashboard
    assert "기록 없음" in dashboard


def test_complete_snapshot_requires_two_misses_before_youtube_prune() -> None:
    schemas = read(ROOT / "app" / "schemas.py")
    tasks = read(ROOT / "app" / "tasks.py")

    assert "snapshot_complete: bool = False" in schemas
    assert "_reconcile_complete_youtube_snapshot" in tasks
    assert 'payload.scan_scope not in {"comment", "live_chat"}' in tasks
    assert 'Activity.status.in_(["visible", "missing_once"])' in tasks
    assert 'if activity.status == "missing_once"' in tasks
    assert 'activity.status = "missing_once"' in tasks
    assert "두 번 연속 완전 조회" in tasks
    assert "db.delete(activity)" in tasks


def test_replaced_duplicate_youtube_files_are_removed() -> None:
    assert not (EXTENSION / "youtube_verify_page.js").exists()
    assert not (EXTENSION / "youtube_live_chat_delete_page.js").exists()
    assert not (EXTENSION / "youtube_live_chat_verify_page.js").exists()