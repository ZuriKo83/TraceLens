(() => {
  function normalizeServer(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  async function resolveConfig(explicitConfig) {
    if (explicitConfig?.serverUrl && explicitConfig?.collectorToken) {
      return {
        serverUrl: normalizeServer(explicitConfig.serverUrl),
        collectorToken: String(explicitConfig.collectorToken),
      };
    }
    const stored = await chrome.storage.local.get(["serverUrl", "collectorToken"]);
    if (!stored.serverUrl || !stored.collectorToken) {
      throw new Error("TraceLens 삭제 연결 정보가 없습니다. 삭제 페이지를 다시 여세요.");
    }
    return {
      serverUrl: normalizeServer(stored.serverUrl),
      collectorToken: String(stored.collectorToken),
    };
  }

  async function request(config, path, options = {}) {
    const response = await fetch(`${config.serverUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.collectorToken}`,
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `서버 응답 ${response.status}`);
    }
    return payload;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "CREATE_DELETE_BATCH_JOB") {
      Promise.resolve()
        .then(() => resolveConfig(message.config))
        .then((config) => request(config, "/api/deletion-jobs/batch", {
          method: "POST",
          body: JSON.stringify({activity_ids: message.activityIds || []}),
        }))
        .then((job) => sendResponse({ok: true, job}))
        .catch((error) => sendResponse({ok: false, error: String(error?.message || error)}));
      return true;
    }

    if (message?.type === "CANCEL_DELETE_BATCH_JOB") {
      Promise.resolve()
        .then(() => resolveConfig(message.config))
        .then((config) => request(
          config,
          `/api/deletion-jobs/batch/${encodeURIComponent(message.jobId || "")}/cancel`,
          {
            method: "POST",
            body: JSON.stringify({reason: message.reason || "확장 프로그램 배치 실행 취소"}),
          },
        ))
        .then((result) => sendResponse({ok: true, result}))
        .catch((error) => sendResponse({ok: false, error: String(error?.message || error)}));
      return true;
    }

    return false;
  });
})();
