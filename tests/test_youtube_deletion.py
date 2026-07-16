import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_reusable_deletion_engine_and_shared_youtube_pages_are_loaded() -> None:
    manifest = json.loads(read(EXTENSION / "manifest.json"))
    worker = read(EXTENSION / "service_worker.js")
    assert manifest["version"] == "1.3.8"
    assert manifest["content_scripts"][0]["js"] == ["content_script.js"]
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


def test_comment_and_live_chat_adapters_share_page_functions() -> None:
    adapter = read(EXTENSION / "youtube_deletion_adapter.js")
    assert 'key: "youtube"' in adapter
    assert 'key: "youtube_live_chat"' in adapter
    assert 'page: "youtube_comments"' in adapter
    assert 'page: "youtube_live_chat"' in adapter
    assert "deletePageFunction: traceLensDeleteYouTubeTargetsInPage" in adapter
    assert "verifyPageFunction: traceLensVerifyYouTubeActivityTargetsInPage" in adapter
    assert "confirmDeletedTargets(targets)" in adapter
    assert "activityId" in adapter
    assert "maxTargets: 100" in adapter
    assert "batchSize: 20" in adapter
    assert "batchPauseMs: 800" in adapter
    assert "verificationDelayMs: 7000" in adapter
    assert "retry: true" in adapter


def test_adapter_only_returns_verified_activity_ids_and_does_not_call_server() -> None:
    adapter = read(EXTENSION / "youtube_deletion_adapter.js")
    assert "deferConfirmedTargets" in adapter
    assert "idFallback" in adapter
    assert "deferred_to_page: true" in adapter
    assert "deleted_ids: activityIds" in adapter
    assert "resolved_ids: activityIds" in adapter
    assert "/api/delete-credits/confirm-deleted" not in adapter
    assert "fetch(" not in adapter
    assert "requestConfirmedIds" not in adapter


def test_adapter_does_not_trust_google_activity_token_as_comment_id() -> None:
    adapter = read(EXTENSION / "youtube_deletion_adapter.js")
    assert 'parseUrl(rawSourceUrl)?.searchParams.get("lc")' in adapter
    assert "comment_id: urlCommentId || null" in adapter
    assert "activity_token: null" in adapter
    assert "legacy_activity_token" in adapter
    assert "title = clean(raw?.title || originalLocator.title)" in adapter


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


def test_deleter_scrolls_actual_container_and_retries_each_item() -> None:
    deleter = read(EXTENSION / "youtube_delete_page.js")
    assert "pickScrollRoot" in deleter
    assert 'document.querySelectorAll("body *")' in deleter
    assert "/(auto|scroll)/.test(style.overflowY" in deleter
    assert "step < 1800" in deleter
    assert "root.scrollTop = next" in deleter
    assert "scanComplete" in deleter
    assert "discoveryComplete: scanComplete" in deleter
    assert "const maxClickAttempts = 3" in deleter
    assert "attempt <= maxClickAttempts" in deleter
    assert "if (!attemptedIds.includes(target.id)) attemptedIds.push(target.id)" in deleter
    assert "clickConfirmIfPresent" in deleter
    assert "1200 + attempt * 500" in deleter
    assert "2200 + attempt * 700" in deleter


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


def test_engine_returns_resolved_target_and_activity_ids() -> None:
    engine = read(EXTENSION / "deletion_engine.js")
    assert "const retryTargets = targets.filter" in engine
    assert "adapter.retry !== false" in engine
    assert "retryPass = await deletionPass" in engine
    assert "verification = await verificationPass" in engine
    assert "const verifiedDeletedIds = []" in engine
    assert "const alreadyMissingIds = []" in engine
    assert "verifiedDeletedIds.push(target.id)" in engine
    assert "const absentIds = new Set([...verifiedDeletedIds, ...alreadyMissingIds])" in engine
    assert "const absentTargets" in engine
    assert "adapter.confirmDeletedTargets(absentTargets, config)" in engine
    assert "deletedIds: verifiedDeletedIds" in engine
    assert "deletedActivityIds: sync.raw?.deleted_ids || []" in engine
    assert "alreadyMissingIds" in engine


def test_purchase_page_performs_same_origin_sync_and_charges_only_verified_deletes() -> None:
    content = read(EXTENSION / "content_script.js")
    purchase = read(ROOT / "app" / "templates" / "delete_credit_purchase.html")
    delete_credits = read(ROOT / "app" / "delete_credits.py")

    assert 'const DELETE_RESULT_STORAGE_KEY = "tracelens:last-delete-result:v12"' in content
    assert "const serverUrl = location.origin" in content
    assert "checkDeleteCreditBalance" in content
    assert "/api/delete-credits/check-balance" in content
    assert "targetActivityIds" in content
    assert "requestConfirmedRows" in content
    assert "syncResolvedActivities" in content
    assert "/api/delete-credits/confirm-deleted" in content
    assert "charge_activity_ids: chargeActivityIds" in content
    assert "const deletedTargetIds" in content
    assert "const chargeActivityIds" in content
    assert "chargeSet.has(id) ? [id] : []" in content
    assert "HTTP ${response.status}" in content
    assert "삭제권 ${charged}개 차감" in content
    assert "setTimeout(() => location.reload(), 1800)" in content
    assert not (EXTENSION / "delete_result_reconciler.js").exists()

    assert 'data-kind="comment"' in purchase
    assert 'data-kind="live_chat"' in purchase
    assert '@router.post("/api/delete-credits/check-balance")' in delete_credits
    assert '@router.post("/api/delete-credits/confirm-deleted")' in delete_credits
    assert "class DeleteCreditUsage(Base)" in delete_credits
    assert 'UniqueConstraint("user_id", "activity_id"' in delete_credits
    assert "charge_activity_ids" in delete_credits
    assert "newly_charged_ids" in delete_credits
    assert "wallet.balance -= len(newly_charged_ids)" in delete_credits
    assert 'amount=-len(newly_charged_ids)' in delete_credits
    assert 'reason="YouTube 삭제 실행 차감"' in delete_credits
    assert '"charged": len(newly_charged_ids)' in delete_credits
    assert '"balance": int(wallet.balance)' in delete_credits
    assert "db.delete(row)" in delete_credits


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
    assert not (EXTENSION / "delete_result_reconciler.js").exists()