from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(name: str) -> str:
    return (EXTENSION / name).read_text(encoding="utf-8")


def test_collection_uses_original_self_contained_scanner() -> None:
    worker = read("service_worker.js")
    collector = read("youtube_activity_collector.js")

    assert "youtube_delete_page.js" in worker
    assert "youtube_delete_match_safety.js" not in worker
    assert not (EXTENSION / "youtube_delete_match_safety.js").exists()
    assert "globalThis.traceLensProcessYouTubeActivityPage" in collector
    assert "func: scanner" in collector


def test_punctuation_comment_fallback_is_normalized_in_adapter() -> None:
    adapter = read("youtube_deletion_adapter.js")

    assert "meaningfulCharacters" in adapter
    assert "meaningfulCharacters(originalContent) === 0" in adapter
    assert "sourceKey" in adapter
    assert "title.length >= 8" in adapter
    assert "const content = shortContentFallback ? title : originalContent" in adapter
    assert "shortContentFallback" in adapter
    assert "original_short_content" in adapter


def test_unmatched_items_are_kept_in_tracelens() -> None:
    engine = read("deletion_engine_resilient.js")

    assert "Google 내 활동에서 대상을 정확히 특정하지 못해 TraceLens 목록에 유지합니다." in engine
    assert "else if (unmatched.has(target.id)) failures.push" in engine
    assert "first.discoveryComplete === true) alreadyMissingIds.push" not in engine
