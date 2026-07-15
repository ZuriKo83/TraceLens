import json
from pathlib import Path


def read(name: str) -> str:
    root = Path(__file__).resolve().parents[1]
    return (root / "chrome_extension" / name).read_text(encoding="utf-8")


def test_manifest_has_required_hosts_and_current_version() -> None:
    manifest = json.loads(read("manifest.json"))
    assert manifest["version"] == "1.1.5"
    assert "https://www.threads.com/*" in manifest["host_permissions"]
    assert "https://www.instagram.com/*" in manifest["host_permissions"]
    assert "https://github.com/*" not in manifest["host_permissions"]
    assert manifest["content_scripts"][0]["js"] == ["content_script.js"]


def test_popup_uses_authenticated_user_token() -> None:
    popup = read("popup.js")
    assert "collectorToken" in popup
    assert "Authorization" in popup
    assert "threads" in popup
    assert "github" not in popup.lower()
    assert "웹 앱 로그인·연결" in read("popup.html")


def test_content_script_connects_from_logged_in_dashboard() -> None:
    content = read("content_script.js")
    assert 'meta[name="tracelens-extension-token"]' in content
    assert 'type: "WEB_CONNECT"' in content
    assert "tracelensExtension" in content


def test_background_has_threads_and_bearer_import() -> None:
    background = read("background.js")
    assert 'threads_posts' in background
    assert 'threads_replies' in background
    assert 'platform === "threads"' in background
    assert '"Authorization": `Bearer ${config.collectorToken || ""}`' in background
    assert "github" not in background.lower()


def test_web_bridge_is_present() -> None:
    root = Path(__file__).resolve().parents[1]
    content = (root / "chrome_extension" / "content_script.js").read_text(encoding="utf-8")
    background = (root / "chrome_extension" / "background.js").read_text(encoding="utf-8")
    assert "TRACELENS_WEB_COMMAND" in content
    assert "START_SCAN" in content
    assert "resolveCollectorConfig" in background


def test_instagram_parser_extracts_signed_in_visual_rows() -> None:
    background = read("background.js")
    assert 'ownership_verified: true' in background
    assert 'extractor_version: "1.0.0"' in background
    assert 'management-row-signed-in-visual-line' in background
    assert 'visualTextLines' in background
    assert 'signedInCommentFromRow' in background
    assert 'accountPrefixPattern' in background
    assert 'diagnosticAuthors' in background
    assert 'openManagementRow' not in background
    assert 'collectOwnCommentsFromPost' not in background


def test_instagram_identity_is_dynamic_and_not_user_specific() -> None:
    background = read("background.js")
    assert "instagramIdentityVerified" in background
    assert 'accountContext?.instagramUsername || ""' in background
    assert "yeon_o11" not in background.lower()
    assert "skykang01" not in background.lower()


def test_tracelens_brand_and_icons() -> None:
    manifest = json.loads(read("manifest.json"))
    assert manifest["name"] == "TraceLens"
    assert manifest["action"]["default_title"] == "TraceLens"
    assert manifest["icons"]["128"] == "icons/icon128.png"
    root = Path(__file__).resolve().parents[1]
    assert (root / "chrome_extension" / "icons" / "icon128.png").exists()


def test_public_domain_is_connected() -> None:
    manifest = json.loads(read("manifest.json"))
    assert "https://tracelens.kr/*" in manifest["host_permissions"]
    assert "https://tracelens.kr/*" in manifest["content_scripts"][0]["matches"]
    assert "https://tracelens.kr" in read("popup.js")
    assert "https://tracelens.kr" in read("background.js")
