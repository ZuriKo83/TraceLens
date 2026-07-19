const TRACELENS_WEB_ORIGINS = new Set([
  "https://tracelens.kr",
  "https://www.tracelens.kr",
  "http://localhost",
  "http://127.0.0.1",
]);

function traceLensExternalSenderAllowed(sender) {
  try {
    return TRACELENS_WEB_ORIGINS.has(new URL(sender?.url || "").origin);
  } catch {
    return false;
  }
}

async function traceLensSaveExternalConfig(config) {
  if (!config?.serverUrl || !config?.collectorToken) {
    throw new Error("연결 정보가 없습니다.");
  }
  const normalized = {
    serverUrl: normalizeServer(config.serverUrl),
    collectorToken: config.collectorToken,
    userEmail: config.userEmail || "",
  };
  await chrome.storage.local.set(normalized);
  return normalized;
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!traceLensExternalSenderAllowed(sender)) return false;

  if (message?.type === "WEB_CONNECT_EXTERNAL") {
    traceLensSaveExternalConfig(message.config || {})
      .then((config) => sendResponse({
        ok: true,
        userEmail: config.userEmail,
        extensionVersion: chrome.runtime.getManifest().version,
      }))
      .catch((error) => sendResponse({ok: false, error: error.message}));
    return true;
  }

  if (message?.type === "SCAN_SITES_EXTERNAL") {
    const sites = Array.isArray(message.sites) ? message.sites : [];
    traceLensSaveExternalConfig(message.config || {})
      .then((config) => scanSites(sites, config))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ok: false, error: error.message}));
    return true;
  }

  return false;
});
