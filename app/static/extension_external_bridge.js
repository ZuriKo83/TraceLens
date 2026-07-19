(() => {
  if (location.pathname !== "/app") return;

  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) return;

  const root = document.documentElement;
  const installUrl = document.getElementById("extension-status-card")?.dataset.installUrl || "";
  const discoveredStoreId = installUrl.match(/([a-p]{32})(?:[/?#]|$)/)?.[1] || "";
  const extensionIds = [...new Set([
    discoveredStoreId,
    "jhmhofomdmdecaceckglefamhnikgbap",
  ].filter((value) => /^[a-p]{32}$/.test(value)))];

  if (!extensionIds.length) return;

  const config = {
    serverUrl: location.origin,
    collectorToken: document.querySelector('meta[name="tracelens-extension-token"]')?.content?.trim() || "",
    userEmail: document.querySelector('meta[name="tracelens-user-email"]')?.content?.trim() || "",
  };

  let activeExtensionId = "";
  let connectionPromise = null;
  let scanRunning = false;

  const publish = (detail) => window.dispatchEvent(new CustomEvent("TRACELENS_EXTENSION_EVENT", {detail}));

  function send(extensionId, message) {
    return new Promise((resolve) => {
      try {
        runtime.sendMessage(extensionId, message, (response) => {
          const error = runtime.lastError?.message || "";
          if (error) {
            resolve({ok: false, error});
            return;
          }
          resolve(response || {ok: false, error: "응답이 없습니다."});
        });
      } catch (error) {
        resolve({ok: false, error: error?.message || String(error)});
      }
    });
  }

  async function connectDirectly(force = false) {
    if (root.dataset.tracelensExtension === "connected") return "";
    if (activeExtensionId && !force) return activeExtensionId;
    if (connectionPromise) return connectionPromise;

    connectionPromise = (async () => {
      for (const extensionId of extensionIds) {
        const response = await send(extensionId, {type: "WEB_CONNECT_EXTERNAL", config});
        if (!response?.ok) continue;
        activeExtensionId = extensionId;
        root.dataset.tracelensExternalBridge = "connected";
        publish({
          type: "CONNECTION",
          connected: true,
          userEmail: response.userEmail || config.userEmail,
          extensionVersion: response.extensionVersion || "",
        });
        return extensionId;
      }
      if (root.dataset.tracelensExtension !== "connected") {
        publish({type: "CONNECTION", connected: false, error: "확장 프로그램을 확인하지 못했습니다."});
      }
      return "";
    })().finally(() => {
      connectionPromise = null;
    });

    return connectionPromise;
  }

  async function scanDirectly(sites) {
    if (root.dataset.tracelensExtension === "connected" || scanRunning) return;
    scanRunning = true;
    try {
      const extensionId = await connectDirectly();
      if (!extensionId) {
        publish({type: "SCAN_RESULT", ok: false, error: "확장 프로그램을 연결하지 못했습니다."});
        return;
      }
      publish({type: "SCAN_STARTED", sites});
      const response = await send(extensionId, {
        type: "SCAN_SITES_EXTERNAL",
        sites,
        config,
      });
      publish({type: "SCAN_RESULT", ...(response || {ok: false, error: "응답이 없습니다."})});
    } finally {
      scanRunning = false;
    }
  }

  window.addEventListener("TRACELENS_WEB_COMMAND", (event) => {
    const detail = event.detail || {};
    if (detail.type === "PING") {
      if (root.dataset.tracelensExtension !== "connected") void connectDirectly(true);
      return;
    }
    if (detail.type === "START_SCAN") {
      const sites = Array.isArray(detail.sites) ? detail.sites : [];
      if (sites.length) void scanDirectly(sites);
    }
  });

  queueMicrotask(() => {
    if (root.dataset.tracelensExtension !== "connected") void connectDirectly();
  });
})();
