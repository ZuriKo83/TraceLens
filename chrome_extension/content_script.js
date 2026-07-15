(() => {
  const MAX_YOUTUBE_DELETE_SELECTION = 100;
  const token = document.querySelector('meta[name="tracelens-extension-token"]')?.content?.trim();
  const serverUrl = document.querySelector('meta[name="tracelens-server-url"]')?.content?.trim() || location.origin;
  const userEmail = document.querySelector('meta[name="tracelens-user-email"]')?.content?.trim() || "";
  if (!token) return;

  const config = {serverUrl, collectorToken: token, userEmail};
  const deletionPage = location.pathname === "/delete-credits/purchase";
  const publish = (detail) => window.dispatchEvent(new CustomEvent("TRACELENS_EXTENSION_EVENT", {detail}));

  chrome.runtime.sendMessage({type: "WEB_CONNECT", config}, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      publish({
        type: "CONNECTION",
        connected: false,
        error: chrome.runtime.lastError?.message || response?.error || "연결 실패",
      });
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
    if (!deletionPage || message?.type !== "PLATFORM_DELETE_PROGRESS" || message?.platform !== "youtube") {
      return false;
    }
    updateDeletionStatus(message.message || "");
    return false;
  });

  function installPurchaseDeletionBridge() {
    if (document.documentElement.dataset.tracelensDeleteBridge === "ready") return;
    document.documentElement.dataset.tracelensDeleteBridge = "ready";

    const supportedRows = [...document.querySelectorAll('.delete-activity-row[data-supported="1"]')];
    supportedRows.forEach((row, index) => {
      row.dataset.tracelensYoutubeTargetId = `youtube-activity-${row.dataset.activityId || index + 1}`;
    });

    updateDeletionStatus("확장 프로그램 연결됨 · YouTube 댓글을 최대 100개까지 선택할 수 있습니다.", "success");
    window.dispatchEvent(new CustomEvent("TRACELENS_DELETE_READY"));

    window.addEventListener("TRACELENS_DELETE_REQUEST", (event) => {
      const detail = event.detail || {};
      if (detail.platform !== "youtube" || detail.activityType !== "comment") return;
      startYouTubeDeletion();
    });
  }

  function selectedDeletionRows() {
    return [...document.querySelectorAll('.delete-activity-row[data-supported="1"]')].filter((row) =>
      row.querySelector(".delete-activity-checkbox")?.checked
    );
  }

  function rowTarget(row) {
    let metadata = {};
    try {
      metadata = JSON.parse(row.dataset.metadata || "{}");
    } catch {
      metadata = {};
    }
    return {
      id: row.dataset.tracelensYoutubeTargetId || `youtube-activity-${row.dataset.activityId || "unknown"}`,
      title: row.querySelector("h3")?.textContent?.trim() || "",
      content: row.querySelector("p")?.textContent?.trim() || "",
      sourceUrl: row.querySelector("a.delete-source")?.href || "",
      locator: metadata.deletion_locator && typeof metadata.deletion_locator === "object"
        ? metadata.deletion_locator
        : {},
    };
  }

  function startYouTubeDeletion() {
    const rows = selectedDeletionRows();
    if (!rows.length) {
      updateDeletionStatus("삭제할 YouTube 댓글을 선택하세요.", "error");
      return;
    }
    if (rows.length > MAX_YOUTUBE_DELETE_SELECTION) {
      updateDeletionStatus(`한 번에 최대 ${MAX_YOUTUBE_DELETE_SELECTION}개까지 선택할 수 있습니다.`, "error");
      return;
    }

    const confirmed = confirm(
      `선택한 YouTube 댓글 ${rows.length}개를 실제로 삭제합니다.\n\n` +
      "삭제 후 되돌릴 수 없습니다. 계속하시겠습니까?"
    );
    if (!confirmed) return;

    setDeletionControlsDisabled(true);
    updateDeletionStatus("전체 기록에서 대상을 찾은 뒤 아래쪽부터 삭제합니다. 작업 탭을 닫거나 이동하지 마세요.");

    chrome.runtime.sendMessage({
      type: "DELETE_PLATFORM_ITEMS",
      platform: "youtube",
      targets: rows.map(rowTarget),
      config,
    }, (response) => {
      if (chrome.runtime.lastError) {
        finishDeletion({ok: false, error: chrome.runtime.lastError.message});
        return;
      }
      finishDeletion(response || {ok: false, error: "삭제 결과를 받지 못했습니다."});
    });
  }

  function setDeletionControlsDisabled(disabled) {
    for (const element of document.querySelectorAll(
      "#selected-delete-button, #select-visible, #clear-selected, #reset-delete-filters, " +
      "#delete-search, #delete-platform-filter, #delete-type-filter, .delete-activity-checkbox"
    )) {
      const unsupported = element.classList.contains("delete-activity-checkbox")
        && element.closest(".delete-activity-row")?.dataset.supported !== "1";
      element.disabled = unsupported || disabled;
    }

    const button = document.getElementById("selected-delete-button");
    if (button && disabled) {
      button.dataset.running = "1";
      button.textContent = "삭제 진행 중…";
    }
  }

  function updateDeletionStatus(message, kind = "") {
    const status = document.getElementById("delete-operation-status");
    if (!status || !message) return;
    status.textContent = message;
    status.classList.toggle("error", kind === "error");
    status.classList.toggle("success", kind === "success");
  }

  function finishDeletion(result) {
    const failed = !result?.ok && !result?.synced;
    if (failed) {
      updateDeletionStatus(result?.error || "삭제 작업에 실패했습니다.", "error");
      setDeletionControlsDisabled(false);
      window.dispatchEvent(new CustomEvent("TRACELENS_DELETE_FINISHED", {detail: result || {ok: false}}));
      return;
    }

    const summary = `삭제 확인 ${result.deleted || 0}개, 이미 없음 ${result.alreadyMissing || 0}개, 실패 ${result.failed || 0}개`;
    updateDeletionStatus(`${summary}. 삭제 목록을 새로고침합니다.`, result.failed ? "error" : "success");
    window.dispatchEvent(new CustomEvent("TRACELENS_DELETE_FINISHED", {detail: result}));
    setTimeout(() => location.reload(), 2200);
  }
})();
