import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_context_guard_loads_before_content_script() -> None:
    manifest = json.loads(read(EXTENSION / "manifest.json"))
    scripts = manifest["content_scripts"][0]["js"]
    assert "extension_context_guard.js" in scripts
    assert scripts.index("extension_context_guard.js") < scripts.index("content_script.js")


def test_context_guard_recovers_only_invalidated_extension_context() -> None:
    guard = read(EXTENSION / "extension_context_guard.js")
    assert "extension context invalidated" in guard.lower()
    assert 'window.addEventListener("error"' in guard
    assert 'window.addEventListener("unhandledrejection"' in guard
    assert "event.preventDefault()" in guard
    assert "location.reload()" in guard
    assert "RELOAD_WINDOW_MS" in guard
    assert "sessionStorage" in guard
