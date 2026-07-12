(() => {
  const token = document.querySelector('meta[name="tracelens-extension-token"]')?.content?.trim();
  const serverUrl = document.querySelector('meta[name="tracelens-server-url"]')?.content?.trim() || location.origin;
  const userEmail = document.querySelector('meta[name="tracelens-user-email"]')?.content?.trim() || "";
  if (!token) return;

  const config = {serverUrl, collectorToken: token, userEmail};
  const publish = (detail) => window.dispatchEvent(new CustomEvent("TRACELENS_EXTENSION_EVENT", {detail}));

  chrome.runtime.sendMessage({type: "WEB_CONNECT", config}, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      publish({type: "CONNECTION", connected: false, error: chrome.runtime.lastError?.message || response?.error || "연결 실패"});
      return;
    }
    document.documentElement.dataset.tracelensExtension = "connected";
    document.documentElement.dataset.tracelensExtensionUser = response.userEmail || userEmail;
    publish({type: "CONNECTION", connected: true, userEmail: response.userEmail || userEmail});
  });

  window.addEventListener("TRACELENS_WEB_COMMAND", (event) => {
    const detail = event.detail || {};
    if (detail.type === "PING") {
      publish({type: "CONNECTION", connected: true, userEmail});
      return;
    }
    if (detail.type !== "START_SCAN") return;

    const sites = Array.isArray(detail.sites) ? detail.sites : [];
    if (!sites.length) {
      publish({type: "SCAN_RESULT", ok: false, error: "조회할 사이트를 하나 이상 선택하세요."});
      return;
    }

    publish({type: "SCAN_STARTED", sites});
    chrome.runtime.sendMessage({type: "SCAN_SITES", sites, config}, (response) => {
      if (chrome.runtime.lastError) {
        publish({type: "SCAN_RESULT", ok: false, error: chrome.runtime.lastError.message});
        return;
      }
      publish({type: "SCAN_RESULT", ...(response || {ok: false, error: "응답이 없습니다."})});
    });
  });
})();
