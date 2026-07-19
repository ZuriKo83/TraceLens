from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "app" / "static"
TEMPLATES = ROOT / "app" / "templates"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_recent_scans_are_collapsed_by_platform_in_browser() -> None:
    script = read(STATIC / "recent_scan_groups.js")
    base = read(TEMPLATES / "base.html")

    assert "recent_scan_groups.js" in base
    assert 'location.pathname !== "/app"' in script
    assert "latestByPlatform" in script
    assert "platformKey(group)" in script
    assert "existingScopes" in script
    assert "group.remove()" in script
    assert "여러 계정" in script
    assert "updateStatus(group)" in script
    assert "list.dataset.platformMerged" in script


def test_recent_scan_history_is_not_deleted_from_database() -> None:
    script = read(STATIC / "recent_scan_groups.js")
    assert "fetch(" not in script
    assert "XMLHttpRequest" not in script
    assert "delete" not in script.lower()
