from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(name: str) -> str:
    return (EXTENSION / name).read_text(encoding="utf-8")


def test_safe_match_guard_is_loaded_between_scanner_and_adapter() -> None:
    worker = read("service_worker.js")
    assert "youtube_delete_page.js" in worker
    assert "youtube_delete_match_safety.js" in worker
    assert "youtube_deletion_adapter.js" in worker
    assert worker.index("youtube_delete_page.js") < worker.index("youtube_delete_match_safety.js")
    assert worker.index("youtube_delete_match_safety.js") < worker.index("youtube_deletion_adapter.js")


def test_punctuation_comment_fallback_requires_video_identity_and_title() -> None:
    safety = read("youtube_delete_match_safety.js")
    assert "const originalProcess = globalThis.traceLensProcessYouTubeActivityPage" in safety
    assert "meaningfulCharacters(originalContent) === 0" in safety
    assert "sourceKey.length > 0" in safety
    assert "title.length >= 8" in safety
    assert "content: title" in safety
    assert "shortContentFallback: true" in safety


def test_unmatched_items_are_not_confirmed_absent_or_removed() -> None:
    safety = read("youtube_delete_match_safety.js")
    engine = read("deletion_engine_resilient.js")
    assert "result.discoveryComplete = false" in safety
    assert "result.unmatchedConfirmedAbsent = false" in safety
    assert "TraceLens 목록에 그대로 유지합니다." in safety
    assert "first.discoveryComplete === true" in engine
