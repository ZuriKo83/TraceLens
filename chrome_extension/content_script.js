(() => {
  const token = document.querySelector('meta[name="tracelens-extension-token"]')?.content?.trim();
  const serverUrl = document.querySelector('meta[name="tracelens-server-url"]')?.content?.trim() || location.origin;
  const userEmail = document.querySelector('meta[name="tracelens-user-email"]')?.content?.trim() || "";
  if (!token) return;

  const config = {serverUrl, collectorToken: token, userEmail};
  const publish = (detail) => window.dispatchEvent(new CustomEvent("TRACELENS_EXTENSION_EVENT", {detail}));
  const SCAN_PORT_NAME = "tracelens-scan-v2";

  let scanPort = null;
  let scanRunning = false;
  let heartbeat = null;

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  function ensureScanPort() {
    if (scanPort) return scanPort;

    scanPort = chrome.runtime.connect({name: SCAN_PORT_NAME});
    scanPort.onMessage.addListener((message) => {
      if (message?.type === "SCAN_ACCEPTED") {
        scanRunning = true;
        return;
      }
      if (message?.type !== "SCAN_RESULT") return;

      scanRunning = false;
      stopHeartbeat();
      publish({type: "SCAN_RESULT", ...(message.result || {ok: false, error: "응답이 없습니다."})});
    });
    scanPort.onDisconnect.addListener(() => {
      const wasRunning = scanRunning;
      scanPort = null;
      scanRunning = false;
      stopHeartbeat();
      if (wasRunning) {
        publish({
          type: "SCAN_RESULT",
          ok: false,
          error: "확장 프로그램 조회 연결이 중간에 종료되었습니다. 확장 프로그램을 새로고침한 뒤 다시 시도하세요.",
        });
      }
    });
    return scanPort;
  }

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

    if (detail.type === "DELETE_ACTIVITY") {
      const job = detail.job || null;
      if (!job?.job_id || !Array.isArray(job.items) || job.items.length !== 1) {
        publish({type: "DELETE_RESULT", ok: false, error: "삭제 작업 정보가 올바르지 않습니다."});
        return;
      }
      publish({type: "DELETE_STARTED", jobId: job.job_id, activityId: job.items[0]?.activity_id});
      chrome.runtime.sendMessage({type: "DELETE_YOUTUBE_ACTIVITY", job, config}, (response) => {
        if (chrome.runtime.lastError) {
          publish({type: "DELETE_RESULT", ok: false, jobId: job.job_id, error: chrome.runtime.lastError.message});
          return;
        }
        publish({type: "DELETE_RESULT", jobId: job.job_id, ...(response || {ok: false, error: "삭제 응답이 없습니다."})});
      });
      return;
    }

    if (detail.type !== "START_SCAN") return;
    const sites = Array.isArray(detail.sites) ? detail.sites : [];
    if (!sites.length) {
      publish({type: "SCAN_RESULT", ok: false, error: "조회할 사이트를 하나 이상 선택하세요."});
      return;
    }
    if (scanRunning) {
      publish({type: "SCAN_RESULT", ok: false, error: "이미 조회가 진행 중입니다."});
      return;
    }

    scanRunning = true;
    publish({type: "SCAN_STARTED", sites});
    const port = ensureScanPort();
    port.postMessage({type: "START_SCAN", sites, config});
    stopHeartbeat();
    heartbeat = setInterval(() => {
      try {
        port.postMessage({type: "PING", at: Date.now()});
      } catch {
        // onDisconnect handles user-facing failure.
      }
    }, 15000);
  });
})();
