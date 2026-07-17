(() => {
  const MAX_YOUTUBE_DELETE_SELECTION = 100;
  const DELETE_RESULT_STORAGE_KEY = "tracelens:last-delete-result:v12";
  const DELETE_RESULT_MAX_AGE_MS = 30 * 60 * 1000;
  const extensionVersion = chrome.runtime.getManifest?.().version || "";
  const token = document.querySelector('meta[name="tracelens-extension-token"]')?.content?.trim();
  const csrfToken = document.querySelector('form[action="/logout"] input[name="csrf"]')?.value?.trim() || "";
  // 삭제 API는 현재 로그인한 TraceLens 사이트와 동일한 origin으로만 호출한다.
  // PUBLIC_BASE_URL 기본값(127.0.0.1)이 브라우저에 전달되어 동기화가 실패하는 것을 막는다.
  const serverUrl = location.origin;
  const userEmail = document.querySelector('meta[name="tracelens-user-email"]')?.content?.trim() || "";
  if (!token) return;

  const config = {serverUrl, collectorToken: token, userEmail};
  const deletionPage = location.pathname === "/delete-credits/purchase";
  const publish = (detail) => window.dispatchEvent(new CustomEvent("TRACELENS_EXTENSION_EVENT", {detail}));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const positiveIds = (values) => [...new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))];

  chrome.runtime.sendMessage({type: "WEB_CONNECT", config}, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      publish({type: "CONNECTION", connected: false, error: chrome.runtime.lastError?.message || response?.error || "연결 실패"});
      if (deletionPage) updateDeletionStatus("확장 프로그램 연결에 실패했습니다. 확장 프로그램을 새로고침하세요.", "error");
      return;
    }
    document.documentElement.dataset.tracelensExtension = "connected";
    document.documentElement.dataset.tracelensExtensionUser = response.userEmail || userEmail;
    document.documentElement.dataset.tracelensExtensionVersion = extensionVersion;
    publish({type: "CONNECTION", connected: true, userEmail: response.userEmail || userEmail, extensionVersion});
    if (deletionPage) installPurchaseDeletionBridge();
  });

  window.addEventListener("TRACELENS_WEB_COMMAND", (event) => {
    const detail = event.detail || {};
    if (detail.type === "PING") {
      publish({type: "CONNECTION", connected: true, userEmail, extensionVersion});
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

  function storeDeletionStatus(message, kind, result, label) {
    try {
      sessionStorage.setItem(DELETE_RESULT_STORAGE_KEY, JSON.stringify({
        message,
        kind,
        result: result || null,
        label: label || null,
        savedAt: Date.now(),
      }));
    } catch {}
  }

  function clearStoredDeletionStatus() {
    try { sessionStorage.removeItem(DELETE_RESULT_STORAGE_KEY); } catch {}
  }

  function renderedActivityIds() {
    return new Set([...document.querySelectorAll('.delete-activity-row[data-activity-id]')]
      .map((row) => Number(row.dataset.activityId || 0))
      .filter((value) => Number.isInteger(value) && value > 0));
  }

  function labelForResult(result, fallback = "") {
    if (fallback) return fallback;
    return result?.platform === "youtube_live_chat" ? "실시간 채팅" : "댓글";
  }

  function normalizeSyncResult(result) {
    result = result || {ok: false};
    const resolved = Number(result.deleted || 0) + Number(result.alreadyMissing || 0);
    const confirmedActivityIds = positiveIds(result.deletedActivityIds || []);
    if (resolved > 0 && confirmedActivityIds.length >= resolved && (result.synced === false || result.warning)) {
      return {...result, synced: true, warning: null};
    }
    return result;
  }

  function creditSummary(result) {
    const charged = Number(result?.charged || 0);
    const balance = Number(result?.balance);
    if (charged <= 0) return "";
    return Number.isFinite(balance)
      ? ` · 삭제권 ${charged}개 차감, 잔여 ${balance}개`
      : ` · 삭제권 ${charged}개 차감`;
  }

  function buildFinalDeletionStatus(rawResult, label) {
    const result = normalizeSyncResult(rawResult);
    const deleted = Number(result?.deleted || 0);
    const alreadyMissing = Number(result?.alreadyMissing || 0);
    const failed = Number(result?.failed || 0);
    const resolved = deleted + alreadyMissing;
    const firstFailure = Array.isArray(result?.failures) ? result.failures[0]?.reason : "";
    const syncWarning = result?.warning || (resolved > 0 && result?.synced === false ? "TraceLens 목록 동기화에 실패했습니다." : "");
    const chargedText = creditSummary(result);

    if (failed > 0) {
      const deletedText = deleted > 0 ? `삭제 확인 ${deleted}개, ` : "";
      const missingText = alreadyMissing > 0 ? `이미 삭제됨 ${alreadyMissing}개, ` : "";
      const summary = `${label} ${deletedText}${missingText}실패 ${failed}개`;
      const reason = firstFailure || result?.error || `일부 ${label}이 Google 내 활동에 남아 있습니다.`;
      const syncText = syncWarning ? ` · ${syncWarning}` : "";
      return {message: `${summary} · ${reason}${syncText}${chargedText}`, kind: "error", result};
    }
    if (resolved > 0 && syncWarning) {
      return {
        message: `${label} 삭제 확인 ${deleted}개, 이미 삭제됨 ${alreadyMissing}개 · Google 내 활동 상태는 확인했지만 ${syncWarning}${chargedText}`,
        kind: "error",
        result,
      };
    }
    if (resolved > 0) {
      return {
        message: `${label} 삭제 확인 ${deleted}개, 이미 삭제됨 ${alreadyMissing}개 · 해당 항목을 TraceLens 목록에서도 제거했습니다.${chargedText}`,
        kind: "success",
        result,
      };
    }
    return {message: `${label} 삭제 결과를 확인하지 못했습니다.`, kind: "error", result};
  }

  function reconcileStoredDeletionStatus(stored) {
    const result = stored?.result;
    const requestedActivityIds = positiveIds(result?.requestedActivityIds || []);
    const resolved = Number(result?.deleted || 0) + Number(result?.alreadyMissing || 0);
    if (!result || !requestedActivityIds.length || resolved <= 0) return stored;
    if (result.synced !== false && !result.warning) return stored;

    const currentIds = renderedActivityIds();
    const absentCount = requestedActivityIds.filter((id) => !currentIds.has(id)).length;
    if (absentCount < resolved) return stored;

    const reconciledResult = {
      ...result,
      synced: true,
      warning: null,
      serverRowsReconciled: true,
    };
    const label = labelForResult(reconciledResult, stored.label || "");
    const final = buildFinalDeletionStatus(reconciledResult, label);
    const reconciled = {...stored, ...final, label, savedAt: Date.now()};
    storeDeletionStatus(final.message, final.kind, final.result, label);
    return reconciled;
  }

  function restoreStoredDeletionStatus() {
    const original = readStoredDeletionStatus();
    if (!original) return false;
    const stored = reconcileStoredDeletionStatus(original);
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
      const versionText = extensionVersion ? ` v${extensionVersion}` : "";
      updateDeletionStatus(`확장 프로그램${versionText} 연결됨 · YouTube 댓글 또는 실시간 채팅을 최대 100개까지 선택할 수 있습니다.`, "success");
    }
    window.dispatchEvent(new CustomEvent("TRACELENS_DELETE_READY"));
    window.addEventListener("TRACELENS_DELETE_REQUEST", (event) => {
      const detail = event.detail || {};
      if (detail.platform !== "youtube" || !["comment", "live_chat"].includes(detail.activityType)) return;
      void startYouTubeDeletion(detail.activityType);
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
    const activityId = Number(row.dataset.activityId || 0);
    return {
      id: row.dataset.tracelensYoutubeTargetId || `youtube-activity-${row.dataset.activityId || "unknown"}`,
      activityId: Number.isInteger(activityId) && activityId > 0 ? activityId : null,
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

  async function postDeleteApi(path, body) {
    let response;
    try {
      response = await fetch(`${serverUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "X-CSRF-Token": csrfToken,
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(`${serverUrl}${path} 요청 실패: ${error.message || String(error)}`);
    }
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.ok === false) {
      const detail = payload?.detail || payload?.error || response.statusText || "응답 본문 없음";
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    return payload || {};
  }

  async function checkDeleteCreditBalance(count) {
    const payload = await postDeleteApi("/api/delete-credits/check-balance", {requested_count: count});
    if (!payload.enough) {
      throw new Error(`삭제권이 부족합니다. 필요 ${count}개, 보유 ${Number(payload.balance || 0)}개입니다.`);
    }
    return payload;
  }

  async function startYouTubeDeletion(requestedKind) {
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
    const targets = rows.map(rowTarget);
    const requestedActivityIds = positiveIds(targets.map((target) => target.activityId));
    const targetActivityIds = Object.fromEntries(targets.map((target) => [target.id, target.activityId]));

    setDeletionControlsDisabled(true, label);
    updateDeletionStatus(`삭제권 ${rows.length}개를 확인합니다.`);
    try {
      await checkDeleteCreditBalance(rows.length);
    } catch (error) {
      setDeletionControlsDisabled(false, label);
      updateDeletionStatus(error.message || String(error), "error");
      return;
    }

    const confirmed = confirm(`선택한 YouTube ${label} ${rows.length}개를 실제로 삭제합니다.\n\n실제 삭제가 확인된 항목만 삭제권이 차감됩니다. 계속하시겠습니까?`);
    if (!confirmed) {
      setDeletionControlsDisabled(false, label);
      return;
    }
    clearStoredDeletionStatus();
    updateDeletionStatus(`전체 ${label} 기록에서 대상을 찾은 뒤 삭제 또는 이미 삭제된 상태를 확인합니다. 작업 창을 닫거나 이동하지 마세요.`);
    chrome.runtime.sendMessage({type: "DELETE_PLATFORM_ITEMS", platform: platformKey, targets, config}, (response) => {
      const context = {label, requestedActivityIds, targetActivityIds, activityKind};
      if (chrome.runtime.lastError) {
        void finishDeletion({ok: false, platform: platformKey, error: chrome.runtime.lastError.message}, context);
        return;
      }
      void finishDeletion(response || {ok: false, platform: platformKey, error: "삭제 결과를 받지 못했습니다."}, context);
    });
  }

  async function requestConfirmedRows(activityIds, chargeActivityIds, activityKind) {
    const payload = await postDeleteApi("/api/delete-credits/confirm-deleted", {
      activity_ids: activityIds,
      activity_kind: activityKind,
      charge_activity_ids: chargeActivityIds,
    });
    const returnedIds = positiveIds([...(payload.deleted_ids || []), ...(payload.resolved_ids || [])]);
    return {
      resolvedIds: returnedIds.length || Number(payload.deleted || 0) < activityIds.length ? returnedIds : activityIds,
      chargedIds: positiveIds([
        ...(payload.charged_activity_ids || []),
        ...(payload.already_charged_activity_ids || []),
      ]),
      charged: Number(payload.charged || 0),
      balance: Number(payload.balance),
      raw: payload,
    };
  }

  async function syncResolvedActivities(rawResult, context) {
    const result = {...(rawResult || {ok: false})};
    const deletedTargetIds = [...new Set(result.deletedIds || [])];
    const alreadyMissingTargetIds = [...new Set(result.alreadyMissingIds || [])];
    const resolvedTargetIds = [...new Set([...deletedTargetIds, ...alreadyMissingTargetIds])];
    const mappedIds = resolvedTargetIds.map((targetId) => context.targetActivityIds?.[targetId]);
    const activityIds = positiveIds([...(result.deletedActivityIds || []), ...mappedIds]);
    const chargeActivityIds = positiveIds(deletedTargetIds.map((targetId) => context.targetActivityIds?.[targetId]));
    const chargeSet = new Set(chargeActivityIds);
    const expected = Number(result.deleted || 0) + Number(result.alreadyMissing || 0);

    if (expected <= 0) return {...result, synced: true, warning: null, charged: 0};
    if (activityIds.length < expected) {
      return {
        ...result,
        synced: false,
        warning: `TraceLens 활동 ID가 ${expected - activityIds.length}개 부족해 목록 동기화를 완료하지 못했습니다.`,
        deletedActivityIds: activityIds,
      };
    }

    const resolvedIds = new Set();
    const chargedIds = new Set();
    const attempts = [];
    let balance = null;

    const mergePayload = (payload, requestedIds, round) => {
      payload.resolvedIds.forEach((id) => resolvedIds.add(id));
      payload.chargedIds.forEach((id) => chargedIds.add(id));
      if (Number.isFinite(payload.balance)) balance = payload.balance;
      attempts.push({
        round,
        requested_ids: requestedIds,
        resolved_ids: payload.resolvedIds,
        charged_ids: payload.chargedIds,
      });
    };

    try {
      const first = await requestConfirmedRows(activityIds, chargeActivityIds, context.activityKind);
      mergePayload(first, activityIds, 1);
    } catch (error) {
      attempts.push({round: 1, requested_ids: activityIds, resolved_ids: [], error: error.message || String(error)});
    }

    for (let round = 2; round <= 3; round += 1) {
      const missingIds = activityIds.filter((id) => !resolvedIds.has(id));
      if (!missingIds.length) break;
      await sleep(900);
      for (const id of missingIds) {
        try {
          const retried = await requestConfirmedRows([id], chargeSet.has(id) ? [id] : [], context.activityKind);
          mergePayload(retried, [id], round);
        } catch (error) {
          attempts.push({round, requested_ids: [id], resolved_ids: [], error: error.message || String(error)});
        }
      }
    }

    const finalIds = activityIds.filter((id) => resolvedIds.has(id));
    const synced = finalIds.length === activityIds.length;
    const firstError = attempts.find((attempt) => attempt.error)?.error || "";
    return {
      ...result,
      synced,
      warning: synced
        ? null
        : `TraceLens 목록 동기화 ${finalIds.length}/${activityIds.length}개 완료${firstError ? ` · ${firstError}` : ""}`,
      deletedActivityIds: finalIds,
      charged: chargedIds.size,
      chargedActivityIds: [...chargedIds],
      balance,
      syncAttempts: attempts,
    };
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
      button.textContent = `${label} 삭제 진행 중…`;
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

  function showFinalDeletionStatus(message, kind, result, label) {
    storeDeletionStatus(message, kind, result, label);
    updateDeletionStatus(message, kind);
  }

  async function finishDeletion(rawResult, context = {}) {
    const requestedActivityIds = positiveIds(context.requestedActivityIds || []);
    const engineResult = {
      ...(rawResult || {ok: false}),
      requestedActivityIds,
    };
    updateDeletionStatus("Google 삭제 확인이 끝났습니다. TraceLens 목록과 삭제권을 동기화합니다.");
    const syncedResult = await syncResolvedActivities(engineResult, context);
    const label = labelForResult(syncedResult, context.label || "");
    const final = buildFinalDeletionStatus(syncedResult, label);
    showFinalDeletionStatus(final.message, final.kind, final.result, label);
    window.dispatchEvent(new CustomEvent("TRACELENS_DELETE_FINISHED", {detail: final.result || {ok: false}}));
    setTimeout(() => location.reload(), 1800);
  }
})();