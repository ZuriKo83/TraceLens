import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_reusable_deletion_engine_and_youtube_adapter_are_loaded() -> None:
    manifest = json.loads(read(EXTENSION / "manifest.json"))
    worker = read(EXTENSION / "service_worker.js")

    assert manifest["version"] == "1.1.1"
    assert "deletion_engine.js" in worker
    assert "youtube_delete_page.js" in worker
    assert "youtube_verify_page.js" in worker
    assert "youtube_deletion_adapter.js" in worker
    assert "youtube_delete_worker.js" not in worker
    assert "youtube_activity_deleter.js" not in worker
    assert manifest["content_scripts"][0]["js"] == ["content_script.js"]
    assert "https://myactivity.google.com/*" in manifest["host_permissions"]


def test_generic_engine_controls_tabs_retry_verification_and_sync() -> None:
    engine = read(EXTENSION / "deletion_engine.js")

    assert "registerAdapter(platform, adapter)" in engine
    assert 'message?.type !== "DELETE_PLATFORM_ITEMS"' in engine
    assert "runningPlatforms" in engine
    assert "chrome.tabs.reload" in engine
    assert "verification.complete" in engine
    assert "adapter.deletePageFunction" in engine
    assert "adapter.verifyPageFunction" in engine
    assert "syncArchive(adapter, config)" in engine


def test_youtube_adapter_limits_batches_to_100_items() -> None:
    adapter = read(EXTENSION / "youtube_deletion_adapter.js")

    assert 'registerAdapter("youtube"' in adapter
    assert "maxTargets: 100" in adapter
    assert "batchSize: 20" in adapter
    assert "batchPauseMs: 800" in adapter
    assert "traceLensDeleteYouTubeTargetsInPage" in adapter
    assert "traceLensVerifyYouTubeTargetsInPage" in adapter
    assert "snapshot_complete" not in adapter


def test_youtube_deletion_uses_cached_bottom_up_batches() -> None:
    deleter = read(EXTENSION / "youtube_delete_page.js")

    assert "const discovered = new Map()" in deleter
    assert "const position = ()" in deleter
    assert "const restore = async" in deleter
    assert "saved?.rank" in deleter
    assert "b.row.viewportTop - a.row.viewportTop" in deleter
    assert "batchClicks >= batchSize" in deleter
    assert "batchPauseMs" in deleter


def test_delete_controls_only_install_in_dedicated_delete_mode() -> None:
    content = read(EXTENSION / "content_script.js")
    base = read(ROOT / "app" / "templates" / "base.html")

    assert 'query.get("mode") === "delete"' in content
    assert "if (deletionMode) installDeletionCenter()" in content
    assert "/app?mode=delete&platform=youtube&activity_type=comment" in content
    assert "tracelens-platform-grid" in content
    assert "Instagram" in content
    assert "Threads" in content
    assert "Facebook" in content
    assert "MAX_YOUTUBE_DELETE_SELECTION = 100" in content
    assert 'type: "DELETE_PLATFORM_ITEMS"' in content
    assert 'platform: "youtube"' in content
    assert "/app?mode=delete&platform=youtube&activity_type=comment" in base
    assert "/delete-credits/purchase" not in base


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
