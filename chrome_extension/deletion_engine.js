(() => {
  const adapters = new Map();
  const runningPlatforms = new Set();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  async function activateTab(tabId, focusWindow = true) {
    if (!tabId) return null;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    await chrome.tabs.update(tabId, {active: true}).catch(() => undefined);
    if (focusWindow && Number.isInteger(tab.windowId)) {
      await chrome.windows.update(tab.windowId, {focused: true}).catch(() => undefined);
    }
    return tab;
  }

  async function assertTaskTab(tabId, state, adapter) {
    if (state.closed) throw new Error("삭제 작업 탭이 닫혔습니다.");
    if (state.navigated) throw new Error("삭제 작업 탭의 주소가 변경되어 작업을 중단했습니다.");
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !adapter.isTaskUrl(tab.url || "")) {
      throw new Error(`${adapter.label || adapter.platform} 삭제 페이지를 확인하지 못했습니다.`);
    }
    return tab;
  }

  async function reloadAndWait(tabId, state, adapter, focusWindow = false) {
    await activateTab(tabId, focusWindow);
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId, adapter.loadTimeoutMs || 45000);
    await waitForPageSettled(tabId, adapter.settleTimeoutMs || 15000);
    await activateTab(tabId, focusWindow);
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
    await activateTab(tabId, true);
    const payload = await executePageFunction(
      tabId,
      adapter.deletePageFunction,
      [targets, {
        batchSize: adapter.batchSize || 20,
        batchPauseMs: adapter.batchPauseMs || 500,
      }],
      `${adapter.label || adapter.platform} 삭제 페이지에서 결과를 받지 못했습니다.`,
    );
    const attempted = payload.attemptedIds?.length
      || payload.clickedIds?.length
      || (payload.failed || []).filter((entry) => /X 삭제 버튼을 눌렀지만/.test(String(entry?.reason || ""))).length;
    publish(webTabId, adapter, {
      stage: "deleting",
      message: `${payload.scannedUnique || payload.scanned || 0}개 행 탐색, ${attempted || 0}개 삭제 요청 완료`,
      progress: payload.progress || null,
    });
    return payload;
  }

  async function verificationPass(tabId, targets, adapter, webTabId) {
    await activateTab(tabId, false);
    const payload = await executePageFunction(
      tabId,
      adapter.verifyPageFunction,
      [targets],
      `${adapter.label || adapter.platform} 삭제 결과 확인에 실패했습니다.`,
    );
    publish(webTabId, adapter, {
      stage: "verifying",
      message: `뒤쪽 작업 창에서 확인 완료: Google 내 활동에 남아 있는 대상 ${payload.foundIds?.length || 0}개`,
      progress: payload.progress || null,
    });
    return payload;
  }

  async function syncArchive(adapter, config, tabId, verification) {
    if (typeof adapter.syncFromVerification === "function") {
      return adapter.syncFromVerification(verification, config, tabId);
    }
    if (typeof adapter.syncCurrentTab === "function") {
      return adapter.syncCurrentTab(tabId, config);
    }
    if (typeof adapter.syncArchive === "function") return adapter.syncArchive(config, tabId, verification);
    const sites = Array.isArray(adapter.syncSites) && adapter.syncSites.length ? adapter.syncSites : [adapter.platform];
    const result = await scanSites(sites, config);
    const lines = result?.lines || [];
    const synced = typeof adapter.isSyncSuccessful === "function"
      ? Boolean(adapter.isSyncSuccessful(lines, result))
      : lines.some((line) => line.startsWith("✓"));
    return {synced, lines, raw: result};
  }

  async function createTaskWindow(url) {
    const created = await chrome.windows.create({url, focused: true, type: "popup"});
    let taskTab = created?.tabs?.[0] || null;
    if (!taskTab && Number.isInteger(created?.id)) {
      taskTab = (await chrome.tabs.query({windowId: created.id}))[0] || null;
    }
    if (!taskTab?.id) throw new Error("삭제 작업 창을 열지 못했습니다.");
    return {windowId: created.id, tab: taskTab};
  }

  async function runDeletion(adapter, rawTargets, config, webTabId) {
    const targets = adapter.normalizeTargets(rawTargets);
    const maxTargets = Math.max(1, Number(adapter.maxTargets) || 100);
    if (!targets.length) throw new Error(`삭제할 ${adapter.itemLabel || "항목"}을 선택하세요.`);
    if (targets.length > maxTargets) throw new Error(`한 번에 최대 ${maxTargets}개까지 삭제할 수 있습니다.`);

    let tab = null;
    let taskWindowId = null;
    let completed = false;
    const state = {closed: false, navigated: false};
    const onRemoved = (tabId) => { if (tabId === tab?.id) state.closed = true; };
    const onWindowRemoved = (windowId) => { if (windowId === taskWindowId) state.closed = true; };
    const onUpdated = (tabId, changeInfo) => {
      if (tabId === tab?.id && changeInfo.url && !adapter.isTaskUrl(changeInfo.url)) state.navigated = true;
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.windows.onRemoved.addListener(onWindowRemoved);
    chrome.tabs.onUpdated.addListener(onUpdated);

    const closeTaskWindow = async () => {
      if (state.closed) return;
      state.closed = true;
      if (Number.isInteger(taskWindowId)) {
        await chrome.windows.remove(taskWindowId).catch(() => undefined);
      } else if (tab?.id) {
        await chrome.tabs.remove(tab.id).catch(() => undefined);
      }
    };

    const returnToWebTab = async () => {
      if (!webTabId) return;
      await activateTab(webTabId, true);
    };

    try {
      publish(webTabId, adapter, {stage: "opening", message: adapter.openingMessage || `${adapter.label} 삭제 페이지를 여는 중입니다.`});
      const taskSurface = await createTaskWindow(adapter.taskUrl);
      taskWindowId = taskSurface.windowId;
      tab = taskSurface.tab;
      const taskTabId = tab.id;
      await activateTab(taskTabId, true);
      await waitForTabComplete(taskTabId, adapter.loadTimeoutMs || 45000);
      await waitForPageSettled(taskTabId, adapter.settleTimeoutMs || 15000);
      await activateTab(taskTabId, true);
      await assertTaskTab(taskTabId, state, adapter);

      publish(webTabId, adapter, {
        stage: "discovering",
        message: adapter.discoveryMessage?.(targets.length)
          || `${targets.length}개 대상을 전체 기록에서 탐색한 뒤 아래쪽부터 삭제를 요청합니다.`,
      });
      const firstPass = await deletionPass(taskTabId, targets, adapter, webTabId);
      await assertTaskTab(taskTabId, state, adapter);

      const verificationDelayMs = Math.max(500, Number(adapter.verificationDelayMs) || 1800);
      publish(webTabId, adapter, {
        stage: "settling",
        message: `삭제 요청 반영을 ${Math.ceil(verificationDelayMs / 1000)}초 기다린 뒤 Google 내 활동에서 확인합니다.`,
      });
      await sleep(verificationDelayMs);
      await returnToWebTab();

      publish(webTabId, adapter, {stage: "verifying", message: "TraceLens 화면을 유지한 채 뒤쪽 작업 창에서 한 번만 확인합니다."});
      await reloadAndWait(taskTabId, state, adapter, false);
      let verification = await verificationPass(taskTabId, targets, adapter, webTabId);

      const retryTargets = targets.filter((target) => verification.foundIds?.includes(target.id));
      let retryPass = {clickedIds: [], attemptedIds: [], failed: [], unmatchedIds: []};
      if (retryTargets.length && adapter.retry !== false) {
        publish(webTabId, adapter, {stage: "retrying", message: `${retryTargets.length}개 남은 항목만 작업 창을 다시 열어 처리합니다.`});
        retryPass = await deletionPass(taskTabId, retryTargets, adapter, webTabId);
        await sleep(verificationDelayMs);
        await returnToWebTab();
        await reloadAndWait(taskTabId, state, adapter, false);
        verification = await verificationPass(taskTabId, targets, adapter, webTabId);
      }

      const clicked = new Set([...(firstPass.clickedIds || []), ...(retryPass.clickedIds || [])]);
      const attempted = new Set([
        ...(firstPass.attemptedIds || []),
        ...(retryPass.attemptedIds || []),
        ...clicked,
      ]);
      for (const entry of [...(firstPass.failed || []), ...(retryPass.failed || [])]) {
        if (/X 삭제 버튼을 눌렀지만/.test(String(entry?.reason || ""))) attempted.add(entry.id);
      }

      const found = new Set(verification.foundIds || []);
      const firstFailures = new Map((firstPass.failed || []).map((entry) => [entry.id, entry.reason]));
      const retryFailures = new Map((retryPass.failed || []).map((entry) => [entry.id, entry.reason]));
      const unmatched = new Set([...(firstPass.unmatchedIds || []), ...(retryPass.unmatchedIds || [])]);
      const pendingIds = [];
      const alreadyMissingIds = [];
      const failures = [];

      for (const target of targets) {
        if (found.has(target.id)) {
          failures.push({id: target.id, reason: "새로고침 후에도 동일한 항목이 Google 내 활동에 남아 있습니다."});
        } else if (!verification.complete) {
          failures.push({id: target.id, reason: "Google 내 활동 전체 확인이 끝나지 않아 삭제 요청 결과를 확정할 수 없습니다."});
        } else if (attempted.has(target.id)) {
          pendingIds.push(target.id);
        } else if (firstFailures.has(target.id) || retryFailures.has(target.id)) {
          failures.push({id: target.id, reason: retryFailures.get(target.id) || firstFailures.get(target.id)});
        } else if (unmatched.has(target.id) && firstPass.discoveryComplete === true) {
          alreadyMissingIds.push(target.id);
        } else {
          failures.push({id: target.id, reason: "삭제 버튼 클릭 기록이 없어 삭제 요청 여부를 확정할 수 없습니다."});
        }
      }

      await assertTaskTab(taskTabId, state, adapter);
      let sync = {synced: false, deferred: false, lines: []};
      if (adapter.deferArchiveSync === true) {
        sync = {
          synced: false,
          deferred: true,
          lines: ["YouTube 실제 댓글 반영이 확인되기 전까지 TraceLens 보관함을 유지합니다."],
        };
        publish(webTabId, adapter, {
          stage: "syncing",
          message: "YouTube 실제 반영 전까지 TraceLens 보관함 기록을 유지합니다.",
        });
      } else {
        publish(webTabId, adapter, {stage: "syncing", message: "확인 결과로 TraceLens 보관함을 동기화합니다."});
        sync = await syncArchive(adapter, config, taskTabId, verification);
      }

      const result = {
        ok: failures.length === 0,
        platform: adapter.platform,
        requested: targets.length,
        deleted: 0,
        deletedIds: [],
        pending: pendingIds.length,
        pendingIds,
        alreadyMissing: alreadyMissingIds.length,
        alreadyMissingIds,
        failed: failures.length,
        failures,
        verificationComplete: Boolean(verification.complete),
        synced: sync.synced,
        syncDeferred: Boolean(sync.deferred),
        lines: sync.lines,
        warning: sync.deferred || sync.synced ? null : (adapter.syncError || "삭제 후 보관함 동기화에 실패했습니다."),
        error: failures.length ? failures[0]?.reason : null,
      };

      completed = true;
      publish(webTabId, adapter, {stage: "closing", message: "뒤쪽 확인이 끝나 작업 창을 닫습니다."});
      await closeTaskWindow();
      await returnToWebTab();
      publish(webTabId, adapter, {
        stage: "done",
        message: result.ok ? "삭제 요청 확인이 완료되었습니다." : "일부 항목이 Google 내 활동에 남아 있습니다.",
        result,
      });
      return result;
    } catch (error) {
      publish(webTabId, adapter, {
        stage: "error",
        message: `삭제 확인 중 오류가 발생했습니다. 작업 창은 확인을 위해 뒤에 남겨 둡니다: ${error.message || String(error)}`,
      });
      await returnToWebTab();
      throw error;
    } finally {
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.windows.onRemoved.removeListener(onWindowRemoved);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (completed) await closeTaskWindow();
    }
  }
})();