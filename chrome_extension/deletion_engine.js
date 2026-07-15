(() => {
  const adapters = new Map();
  const runningPlatforms = new Set();

  globalThis.TraceLensDeletionEngine = {
    registerAdapter(platform, adapter) {
      const key = String(platform || "").trim().toLowerCase();
      if (!key || !adapter || typeof adapter !== "object") throw new Error("삭제 어댑터 등록 정보가 올바르지 않습니다.");
      adapters.set(key, {...adapter, platform: key});
    },
    getAdapter(platform) {
      return adapters.get(String(platform || "").trim().toLowerCase()) || null;
    },
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "DELETE_PLATFORM_ITEMS") return false;
    const platform = String(message.platform || "").trim().toLowerCase();
    const adapter = adapters.get(platform);
    if (!adapter) {
      sendResponse({ok: false, error: "지원하지 않는 삭제 플랫폼입니다."});
      return false;
    }
    if (runningPlatforms.has(platform)) {
      sendResponse({ok: false, error: `이미 ${adapter.label || platform} 삭제 작업이 진행 중입니다.`});
      return false;
    }

    runningPlatforms.add(platform);
    resolveCollectorConfig(message.config)
      .then((config) => runDeletion(adapter, message.targets, config, sender.tab?.id))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ok: false, platform, error: error.message || String(error)}))
      .finally(() => runningPlatforms.delete(platform));
    return true;
  });

  function publish(webTabId, adapter, detail) {
    if (!webTabId) return;
    chrome.tabs.sendMessage(webTabId, {
      type: "PLATFORM_DELETE_PROGRESS",
      platform: adapter.platform,
      ...detail,
    }).catch(() => undefined);
  }

  async function assertTaskTab(tabId, state, adapter) {
    if (state.closed) throw new Error("삭제 작업 탭이 닫혔습니다.");
    if (state.navigated) throw new Error("삭제 작업 탭의 주소가 변경되어 작업을 중단했습니다.");
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !adapter.isTaskUrl(tab.url || "")) {
      throw new Error(`${adapter.label || adapter.platform} 삭제 페이지를 확인하지 못했습니다.`);
    }
  }

  async function reloadAndWait(tabId, state, adapter) {
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId, adapter.loadTimeoutMs || 45000);
    await waitForPageSettled(tabId, adapter.settleTimeoutMs || 15000);
    await assertTaskTab(tabId, state, adapter);
  }

  async function executePageFunction(tabId, func, args, errorMessage) {
    if (typeof func !== "function") throw new Error("삭제 어댑터의 페이지 함수가 등록되지 않았습니다.");
    const result = await chrome.scripting.executeScript({target: {tabId}, func, args});
    const payload = result?.[0]?.result;
    if (!payload) throw new Error(errorMessage);
    return payload;
  }

  async function deletionPass(tabId, targets, adapter, webTabId) {
    const payload = await executePageFunction(
      tabId,
      adapter.deletePageFunction,
      [targets, {
        batchSize: adapter.batchSize || 20,
        batchPauseMs: adapter.batchPauseMs || 800,
      }],
      `${adapter.label || adapter.platform} 삭제 페이지에서 결과를 받지 못했습니다.`,
    );
    publish(webTabId, adapter, {
      stage: "deleting",
      message: `${payload.scannedUnique || payload.scanned || 0}개 행 탐색, ${payload.clickedIds?.length || 0}개 삭제 요청 완료`,
      progress: payload.progress || null,
    });
    return payload;
  }

  async function verificationPass(tabId, targets, adapter, webTabId) {
    const payload = await executePageFunction(
      tabId,
      adapter.verifyPageFunction,
      [targets],
      `${adapter.label || adapter.platform} 삭제 결과 확인에 실패했습니다.`,
    );
    publish(webTabId, adapter, {
      stage: "verifying",
      message: `전체 기록 재검증 완료: 남아 있는 대상 ${payload.foundIds?.length || 0}개`,
      progress: payload.progress || null,
    });
    return payload;
  }

  async function syncArchive(adapter, config, tabId) {
    if (typeof adapter.syncCurrentTab === "function") {
      return adapter.syncCurrentTab(tabId, config);
    }
    if (typeof adapter.syncArchive === "function") return adapter.syncArchive(config, tabId);
    const sites = Array.isArray(adapter.syncSites) && adapter.syncSites.length ? adapter.syncSites : [adapter.platform];
    const result = await scanSites(sites, config);
    const lines = result?.lines || [];
    const synced = typeof adapter.isSyncSuccessful === "function"
      ? Boolean(adapter.isSyncSuccessful(lines, result))
      : lines.some((line) => line.startsWith("✓"));
    return {synced, lines, raw: result};
  }

  async function runDeletion(adapter, rawTargets, config, webTabId) {
    const targets = adapter.normalizeTargets(rawTargets);
    const maxTargets = Math.max(1, Number(adapter.maxTargets) || 100);
    if (!targets.length) throw new Error(`삭제할 ${adapter.itemLabel || "항목"}을 선택하세요.`);
    if (targets.length > maxTargets) throw new Error(`한 번에 최대 ${maxTargets}개까지 삭제할 수 있습니다.`);

    let tab = null;
    const state = {closed: false, navigated: false};
    const onRemoved = (tabId) => { if (tabId === tab?.id) state.closed = true; };
    const onUpdated = (tabId, changeInfo) => {
      if (tabId === tab?.id && changeInfo.url && !adapter.isTaskUrl(changeInfo.url)) state.navigated = true;
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onUpdated.addListener(onUpdated);

    const closeTaskTab = async () => {
      if (!tab?.id || state.closed) return;
      const tabId = tab.id;
      state.closed = true;
      await chrome.tabs.remove(tabId).catch(() => undefined);
    };

    try {
      publish(webTabId, adapter, {stage: "opening", message: adapter.openingMessage || `${adapter.label} 삭제 페이지를 여는 중입니다.`});
      tab = await chrome.tabs.create({url: adapter.taskUrl, active: true});
      await waitForTabComplete(tab.id, adapter.loadTimeoutMs || 45000);
      await waitForPageSettled(tab.id, adapter.settleTimeoutMs || 15000);
      await assertTaskTab(tab.id, state, adapter);

      publish(webTabId, adapter, {
        stage: "discovering",
        message: adapter.discoveryMessage?.(targets.length)
          || `${targets.length}개 대상을 전체 기록에서 탐색한 뒤 아래쪽부터 삭제합니다.`,
      });
      const firstPass = await deletionPass(tab.id, targets, adapter, webTabId);

      publish(webTabId, adapter, {stage: "verifying", message: "새로고침 후 전체 기록을 다시 확인합니다."});
      await reloadAndWait(tab.id, state, adapter);
      let verification = await verificationPass(tab.id, targets, adapter, webTabId);

      const retryTargets = targets.filter((target) => verification.foundIds?.includes(target.id));
      let retryPass = {clickedIds: []};
      if (retryTargets.length && adapter.retry !== false) {
        publish(webTabId, adapter, {stage: "retrying", message: `${retryTargets.length}개 남은 항목만 한 번 더 탐색합니다.`});
        retryPass = await deletionPass(tab.id, retryTargets, adapter, webTabId);
        await reloadAndWait(tab.id, state, adapter);
        verification = await verificationPass(tab.id, targets, adapter, webTabId);
      }

      const clicked = new Set([...(firstPass.clickedIds || []), ...(retryPass.clickedIds || [])]);
      const found = new Set(verification.foundIds || []);
      const deletedIds = [];
      const alreadyMissingIds = [];
      const failures = [];
      for (const target of targets) {
        if (found.has(target.id)) failures.push({id: target.id, reason: "새로고침 후에도 대상이 남아 있습니다."});
        else if (!verification.complete) failures.push({id: target.id, reason: "전체 기록 확인이 끝나지 않아 삭제 여부를 확정할 수 없습니다."});
        else if (clicked.has(target.id)) deletedIds.push(target.id);
        else alreadyMissingIds.push(target.id);
      }

      await assertTaskTab(tab.id, state, adapter);
      publish(webTabId, adapter, {stage: "syncing", message: "현재 작업 탭에서 최신 기록을 수집해 TraceLens 보관함과 동기화합니다."});
      const sync = await syncArchive(adapter, config, tab.id);
      const result = {
        ok: failures.length === 0 && sync.synced,
        platform: adapter.platform,
        requested: targets.length,
        deleted: deletedIds.length,
        deletedIds,
        alreadyMissing: alreadyMissingIds.length,
        alreadyMissingIds,
        failed: failures.length,
        failures,
        verificationComplete: Boolean(verification.complete),
        synced: sync.synced,
        lines: sync.lines,
        error: sync.synced ? null : (adapter.syncError || "삭제 후 TraceLens 보관함 동기화에 실패했습니다. 해당 사이트 조회를 다시 실행하세요."),
      };

      publish(webTabId, adapter, {stage: "closing", message: "확인과 동기화가 끝나 작업 탭을 닫습니다."});
      await closeTaskTab();
      publish(webTabId, adapter, {
        stage: "done",
        message: result.ok ? "삭제와 재검증이 완료되었습니다." : "일부 항목을 삭제하지 못했습니다.",
        result,
      });
      return result;
    } finally {
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      await closeTaskTab();
    }
  }
})();