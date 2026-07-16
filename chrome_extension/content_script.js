(() => {
  const MAX_YOUTUBE_DELETE_SELECTION = 100;
  const DELETE_RESULT_STORAGE_KEY = "tracelens:last-delete-result:v4";
  const DELETE_RESULT_MAX_AGE_MS = 30 * 60 * 1000;
  const token = document.querySelector('meta[name="tracelens-extension-token"]')?.content?.trim();
  const serverUrl = document.querySelector('meta[name="tracelens-server-url"]')?.content?.trim() || location.origin;
  const userEmail = document.querySelector('meta[name="tracelens-user-email"]')?.content?.trim() || "";
  if (!token) return;

  const config = {serverUrl, collectorToken: token, userEmail};
  const deletionPage = location.pathname === "/delete-credits/purchase";
  const publish = (detail) => window.dispatchEvent(new CustomEvent("TRACELENS_EXTENSION_EVENT", {detail}));

  chrome.runtime.sendMessage({type: "WEB_CONNECT", config}, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      publish({type: "CONNECTION", connected: false, error: chrome.runtime.lastError?.message || response?.error || "연결 실패"});
      if (deletionPage) updateDeletionStatus("확장 프로그램 연결에 실패했습니다. 확장 프로그램을 새로고침하세요.", "error");
      return;
    }
    document.documentElement.dataset.tracelensExtension = "connected";
    document.documentElement.dataset.tracelensExtensionUser = response.userEmail || userEmail;
    publish({type: "CONNECTION", connected: true, userEmail: response.userEmail || userEmail});
    if (deletionPage) installPurchaseDeletionBridge();
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

  chrome.runtime.onMessage.addListener((message) => {
    if (!deletionPage || message?.type !== "PLATFORM_DELETE_PROGRESS") return false;
    if (!["youtube", "youtube_live_chat"].includes(message?.platform)) return false;
    updateDeletionStatus(message.message || "");
    return false;
  });

  function readStoredDeletionStatus() {
    try {
      const raw = sessionStorage.getItem(DELETE_RESULT_STORAGE_KEY);
      if (!raw) return null;
      const stored = JSON.parse(raw);
      if (!stored?.message || !Number.isFinite(Number(stored.savedAt))) {
        sessionStorage.removeItem(DELETE_RESULT_STORAGE_KEY);
        return null;
      }
      if (Date.now() - Number(stored.savedAt) > DELETE_RESULT_MAX_AGE_MS) {
        sessionStorage.removeItem(DELETE_RESULT_STORAGE_KEY);
        return null;
      }
      return stored;
    } catch {
      return null;
    }
  }

  function storeDeletionStatus(message, kind, result) {
    try {
      sessionStorage.setItem(DELETE_RESULT_STORAGE_KEY, JSON.stringify({message, kind, result: result || null, savedAt: Date.now()}));
    } catch {}
  }

  function clearStoredDeletionStatus() {
    try { sessionStorage.removeItem(DELETE_RESULT_STORAGE_KEY); } catch {}
  }

  function restoreStoredDeletionStatus() {
    const stored = readStoredDeletionStatus();
    if (!stored) return false;
    updateDeletionStatus(`마지막 삭제 결과 · ${stored.message}`, stored.kind || "");
    return true;
  }

  function installPurchaseDeletionBridge() {
    if (document.documentElement.dataset.tracelensDeleteBridge === "ready") return;
    document.documentElement.dataset.tracelensDeleteBridge = "ready";
    const supportedRows = [...document.querySelectorAll('.delete-activity-row[data-supported="1"]')];
    supportedRows.forEach((row, index) => {
      row.dataset.tracelensYoutubeTargetId = `youtube-activity-${row.dataset.activityId || index + 1}`;
    });
    if (!restoreStoredDeletionStatus()) {
      updateDeletionStatus("확장 프로그램 연결됨 · YouTube 댓글 또는 실시간 채팅을 최대 100개까지 선택할 수 있습니다.", "success");
    }
    window.dispatchEvent(new CustomEvent("TRACELENS_DELETE_READY"));
    window.addEventListener("TRACELENS_DELETE_REQUEST", (event) => {
      const detail = event.detail || {};
      if (detail.platform !== "youtube" || !["comment", "live_chat"].includes(detail.activityType)) return;
      startYouTubeDeletion(detail.activityType);
    });
  }

  function selectedDeletionRows() {
    return [...document.querySelectorAll('.delete-activity-row[data-supported="1"]')]
      .filter((row) => row.querySelector(".delete-activity-checkbox")?.checked);
  }

  function rowTarget(row) {
    let metadata = {};
    try { metadata = JSON.parse(row.dataset.metadata || "{}"); } catch { metadata = {}; }
    const locator = metadata.deletion_locator && typeof metadata.deletion_locator === "object" ? metadata.deletion_locator : {};
    const visibleTitle = row.querySelector("h3")?.textContent?.trim() || "";
    const visibleContent = row.querySelector("p")?.textContent?.trim() || "";
    return {
      id: row.dataset.tracelensYoutubeTargetId || `youtube-activity-${row.dataset.activityId || "unknown"}`,
      title: visibleTitle || locator.title || "",
      content: visibleContent || locator.content || "",
      sourceUrl: row.querySelector("a.delete-source")?.href || locator.source_url || "",
      commentId: "",
      locator: {
        ...locator,
        title: visibleTitle || locator.title || "",
        content: visibleContent || locator.content || "",
      },
    };
  }

  function startYouTubeDeletion(requestedKind) {
    const rows = selectedDeletionRows();
    if (!rows.length) {
      updateDeletionStatus("삭제할 YouTube 항목을 선택하세요.", "error");
      return;
    }
    if (rows.length > MAX_YOUTUBE_DELETE_SELECTION) {
      updateDeletionStatus(`한 번에 최대 ${MAX_YOUTUBE_DELETE_SELECTION}개까지 선택할 수 있습니다.`, "error");
      return;
    }
    const kinds = new Set(rows.map((row) => row.dataset.youtubeKind || "comment"));
    if (kinds.size !== 1) {
      updateDeletionStatus("일반 댓글과 실시간 채팅은 서로 다른 Google 페이지에서 삭제되므로 한 종류씩 선택하세요.", "error");
      return;
    }
    const activityKind = [...kinds][0];
    if (requestedKind && requestedKind !== activityKind) {
      updateDeletionStatus("현재 선택한 항목 유형과 삭제 메뉴가 일치하지 않습니다.", "error");
      return;
    }
    const liveChat = activityKind === "live_chat";
    const label = liveChat ? "실시간 채팅" : "댓글";
    const platformKey = liveChat ? "youtube_live_chat" : "youtube";
    const confirmed = confirm(`선택한 YouTube ${label} ${rows.length}개에 삭제를 요청합니다.\n\nYouTube 실제 화면 반영에는 시간이 걸릴 수 있으며 되돌릴 수 없습니다. 계속하시겠습니까?`);
    if (!confirmed) return;
    clearStoredDeletionStatus();
    setDeletionControlsDisabled(true, label);
    updateDeletionStatus(`전체 ${label} 기록에서 대상을 찾은 뒤 삭제를 요청합니다. 작업 창을 닫거나 이동하지 마세요.`);
    chrome.runtime.sendMessage({type: "DELETE_PLATFORM_ITEMS", platform: platformKey, targets: rows.map(rowTarget), config}, (response) => {
      if (chrome.runtime.lastError) {
        finishDeletion({ok: false, platform: platformKey, error: chrome.runtime.lastError.message}, {label});
        return;
      }
      finishDeletion(response || {ok: false, platform: platformKey, error: "삭제 결과를 받지 못했습니다."}, {label});
    });
  }

  function setDeletionControlsDisabled(disabled, label = "항목") {
    for (const element of document.querySelectorAll("#selected-delete-button, #select-visible, #clear-selected, #reset-delete-filters, #delete-search, #delete-platform-filter, #delete-type-filter, .youtube-kind-filter, .delete-activity-checkbox")) {
      const unsupported = element.classList.contains("delete-activity-checkbox") && element.closest(".delete-activity-row")?.dataset.supported !== "1";
      element.disabled = unsupported || disabled;
    }
    const button = document.getElementById("selected-delete-button");
    if (!button) return;
    if (disabled) {
      button.dataset.running = "1";
      button.textContent = `${label} 삭제 요청 중…`;
    } else {
      delete button.dataset.running;
      button.textContent = "선택 항목 삭제";
    }
  }

  function updateDeletionStatus(message, kind = "") {
    const status = document.getElementById("delete-operation-status");
    if (!status || !message) return;
    status.textContent = message;
    status.classList.toggle("error", kind === "error");
    status.classList.toggle("success", kind === "success");
  }

  function showFinalDeletionStatus(message, kind, result) {
    storeDeletionStatus(message, kind, result);
    updateDeletionStatus(message, kind);
  }

  function finishDeletion(result, context = {}) {
    const liveChat = result?.platform === "youtube_live_chat";
    const label = context.label || (liveChat ? "실시간 채팅" : "댓글");
    const pending = Number(result?.pending || 0);
    const alreadyMissing = Number(result?.alreadyMissing || 0);
    const failed = Number(result?.failed || 0);
    const firstFailure = Array.isArray(result?.failures) ? result.failures[0]?.reason : "";

    if (failed > 0 || (!result?.ok && pending === 0 && alreadyMissing === 0)) {
      const summary = `${label} 삭제 요청 ${pending}개, Google 내 활동에 이미 없음 ${alreadyMissing}개, 확인 실패 ${failed}개`;
      const reason = firstFailure || result?.error || `삭제 대상이나 Google ${label} 삭제 버튼을 확인하지 못했습니다.`;
      showFinalDeletionStatus(`${summary} · ${reason}`, "error", result);
    } else if (pending > 0) {
      showFinalDeletionStatus(
        `${label} 삭제 요청 ${pending}개가 접수됐습니다. YouTube 실제 댓글 반영을 기다리는 중이며, 반영 전까지 TraceLens 목록을 유지합니다.`,
        "",
        result,
      );
    } else if (alreadyMissing > 0) {
      showFinalDeletionStatus(
        `${label} ${alreadyMissing}개는 Google 내 활동에 이미 없습니다. YouTube 실제 댓글 삭제 여부는 확인되지 않았습니다.`,
        "",
        result,
      );
    } else {
      showFinalDeletionStatus(`${label} 삭제 요청 결과를 확인하지 못했습니다.`, "error", result);
    }

    window.dispatchEvent(new CustomEvent("TRACELENS_DELETE_FINISHED", {detail: result || {ok: false}}));
    setTimeout(() => location.reload(), 1800);
  }
})();