import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "chrome_extension"
STATIC = ROOT / "app" / "static"
TEMPLATES = ROOT / "app" / "templates"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_manifest_allows_direct_messages_from_tracelens_web() -> None:
    manifest = json.loads(read(EXTENSION / "manifest.json"))
    matches = set(manifest["externally_connectable"]["matches"])
    assert "https://tracelens.kr/*" in matches
    assert "https://www.tracelens.kr/*" in matches
    assert "http://localhost/*" in matches
    assert "http://127.0.0.1/*" in matches


def test_service_worker_accepts_only_tracelens_external_messages() -> None:
    worker = read(EXTENSION / "service_worker.js")
    bridge = read(EXTENSION / "external_web_bridge.js")
    assert '"external_web_bridge.js"' in worker
    assert "chrome.runtime.onMessageExternal.addListener" in bridge
    assert "traceLensExternalSenderAllowed" in bridge
    assert '"https://tracelens.kr"' in bridge
    assert '"https://www.tracelens.kr"' in bridge
    assert 'message?.type === "WEB_CONNECT_EXTERNAL"' in bridge
    assert 'message?.type === "SCAN_SITES_EXTERNAL"' in bridge
    assert "scanSites(sites, config)" in bridge


def test_dashboard_connects_automatically_without_content_script_access() -> None:
    base = read(TEMPLATES / "base.html")
    bridge = read(STATIC / "extension_external_bridge.js")
    messages = read(EXTENSION / "dashboard_user_messages.js")
    assert "extension_external_bridge.js" in base
    assert base.index("extension_external_bridge.js") < base.index("{% block scripts %}")
    assert "queueMicrotask" in bridge
    assert "runtime.sendMessage(extensionId" in bridge
    assert "WEB_CONNECT_EXTERNAL" in bridge
    assert "SCAN_SITES_EXTERNAL" in bridge
    assert "jhmhofomdmdecaceckglefamhnikgbap" in bridge
    assert "discoveredStoreId" in bridge
    assert 'root.dataset.tracelensExtension === "connected"' in bridge
    assert 'root.tracelensExternalBridge === "connected"' in messages
