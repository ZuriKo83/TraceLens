(() => {
  const previousWindowsCreate = chrome.windows.create.bind(chrome.windows);
  const previousWindowsUpdate = chrome.windows.update.bind(chrome.windows);
  const previousWindowsRemove = chrome.windows.remove.bind(chrome.windows);
  const previousTabsUpdate = chrome.tabs.update.bind(chrome.tabs);
  const previousTabsReload = chrome.tabs.reload.bind(chrome.tabs);
  const previousSetZoom = chrome.tabs.setZoom.bind(chrome.tabs);
  const previousExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
  const previousRunExtractor = runExtractor;
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

  const workersByWindow = new Map();
  const workersByTab = new Map();
  const sleep = (ms) => new Promise((resolve) => nativeSetTimeout(resolve, ms));

  function isDeletionPage(url) {
    try {
      const parsed = new URL(String(url || ""));
      return parsed.hostname === "myactivity.google.com"
        && parsed.pathname.replace(/\/$/, "") === "/page"
        && ["youtube_comments", "youtube_live_chat"].includes(parsed.searchParams.get("page"));
    } catch {
      return false;
    }
  }

  function adjustedWorkerDelay(delay) {
    const numeric = Number(delay || 0);
    if (!workersByWindow.size) return numeric;
    if (numeric === 900) return 450;
    if (numeric === 1200) return 650;
    if (numeric === 1400) return 750;
    if (numeric === 2800) return 1700;
    if (numeric === 3800) return 2300;
    return numeric;
  }

  globalThis.setTimeout = (handler, delay, ...args) => (
    nativeSetTimeout(handler, adjustedWorkerDelay(delay), ...args)
  );

  async function returnToOriginalWindow(state) {
    if (!state?.originalWindowId) return;
    await previousWindowsUpdate(state.originalWindowId, {focused: true}).catch(() => undefined);
  }

  async function showWorkerForFallback(state) {
    if (!state) return;
    state.allowForeground = true;
    await previousWindowsUpdate(state.windowId, {focused: true}).catch(() => undefined);
    await previousTabsUpdate(state.tabId, {active: true}).catch(() => undefined);
    await previousSetZoom(state.tabId, 0.25).catch(() => undefined);
    await sleep(300);
  }

  async function hideWorkerAgain(state) {
    if (!state) return;
    state.allowForeground = false;
    await returnToOriginalWindow(state);
  }

  async function installFastScanTimers(tabId) {
    await previousExecuteScript({
      target: {tabId},
      func: () => {
        if (globalThis.__TRACELENS_NATIVE_TIMEOUT_V17) return;
        const nativeTimeout = globalThis.setTimeout.bind(globalThis);
        globalThis.__TRACELENS_NATIVE_TIMEOUT_V17 = nativeTimeout;
        globalThis.setTimeout = (handler, delay, ...args) => {
          const numeric = Number(delay || 0);
          let adjusted = numeric;
          if (numeric === 500) adjusted = 300;
          else if (numeric === 800) adjusted = 500;
          else if (numeric === 120) adjusted = 80;
          else if (numeric === 320) adjusted = 220;
          else if (numeric === 450) adjusted = 300;
          else if (numeric === 180) adjusted = 130;
          else if (numeric === 260) adjusted = 180;
          else if (numeric === 850) adjusted = 500;
          return nativeTimeout(handler, adjusted, ...args);
        };
      },
    }).catch(() => undefined);
  }

  async function restoreScanTimers(tabId) {
    await previousExecuteScript({
      target: {tabId},
      func: () => {
        if (!globalThis.__TRACELENS_NATIVE_TIMEOUT_V17) return;
        globalThis.setTimeout = globalThis.__TRACELENS_NATIVE_TIMEOUT_V17;
        delete globalThis.__TRACELENS_NATIVE_TIMEOUT_V17;
      },
    }).catch(() => undefined);
  }

  function retryableItemIds(result, items) {
    if (!result?.ok) return new Set(items.map((item) => Number(item.item_id)));
    const retryableStages = new Set([
      "scan_incomplete",
      "not_found_after_full_scan",
      "saved_position_miss",
      "click_unconfirmed",
    ]);
    return new Set(
      (result.failures || [])
        .filter((failure) => retryableStages.has(String(failure?.diagnostics?.stage || "")))
        .map((failure) => Number(failure.item_id))
        .filter((itemId) => Number.isFinite(itemId) && itemId > 0)
    );
  }

  function mergeScanResults(first, retry, retryIds) {
    const clicked = new Set([
      ...(first?.clicked_item_ids || []).map(Number),
      ...(retry?.clicked_item_ids || []).map(Number),
    ]);
    const retainedFailures = (first?.failures || []).filter(
      (failure) => !retryIds.has(Number(failure.item_id))
    );
    const failures = [...retainedFailures, ...(retry?.failures || [])];

    return {
      ...(first || {}),
      ...(retry || {}),
      ok: Boolean(first?.ok || retry?.ok),
      planned_count: Math.max(
        Number(first?.planned_count || 0),
        clicked.size + failures.length
      ),
      clicked_item_ids: [...clicked],
      failures,
      // Keep the first full-scan counts because they represent the state before
      // any successful background deletion. Retry counts may already be lower.
      baseline_counts: {
        ...(retry?.baseline_counts || {}),
        ...(first?.baseline_counts || {}),
      },
      evidence_by_item: {
        ...(first?.evidence_by_item || {}),
        ...(retry?.evidence_by_item || {}),
      },
      foreground_fallback_used: true,
    };
  }

  chrome.windows.create = async function(createData, callback) {
    if (!isDeletionPage(createData?.url)) {
      const created = await previousWindowsCreate(createData);
      if (typeof callback === "function") callback(created);
      return created;
    }

    const originalWindow = await chrome.windows.getLastFocused().catch(() => null);
    const created = await previousWindowsCreate({...createData, focused: false});
    const tab = created.tabs?.[0]
      || (await chrome.tabs.query({windowId: created.id, active: true}))[0];

    if (tab?.id) {
      const currentZoom = await chrome.tabs.getZoom(tab.id).catch(() => 1);
      const state = {
        windowId: created.id,
        tabId: tab.id,
        originalWindowId: originalWindow?.id || null,
        restoreZoom: Number.isFinite(currentZoom) && currentZoom > 0 ? currentZoom : 1,
        allowForeground: false,
      };
      workersByWindow.set(created.id, state);
      workersByTab.set(tab.id, state);
      await previousSetZoom(tab.id, 0.25).catch(() => undefined);
      await returnToOriginalWindow(state);
    }

    if (typeof callback === "function") callback(created);
    return created;
  };

  chrome.windows.update = async function(windowId, updateInfo, callback) {
    const state = workersByWindow.get(Number(windowId));
    if (state && updateInfo?.focused === true && !state.allowForeground) {
      const current = await chrome.windows.get(Number(windowId)).catch(() => null);
      if (typeof callback === "function") callback(current);
      return current;
    }

    const updated = await previousWindowsUpdate(windowId, updateInfo);
    if (typeof callback === "function") callback(updated);
    return updated;
  };

  chrome.scripting.executeScript = async function(details, callback) {
    if (details?.func?.name !== "scanThenDeleteV16") {
      const results = await previousExecuteScript(details);
      if (typeof callback === "function") callback(results);
      return results;
    }

    const tabId = Number(details?.target?.tabId);
    const state = workersByTab.get(tabId);
    const items = Array.isArray(details?.args?.[0]) ? details.args[0] : [];
    const expectedPage = details?.args?.[1];

    if (!state) {
      const results = await previousExecuteScript(details);
      if (typeof callback === "function") callback(results);
      return results;
    }

    state.allowForeground = false;
    await returnToOriginalWindow(state);
    await installFastScanTimers(tabId);

    let firstResults = null;
    let firstError = null;
    try {
      firstResults = await previousExecuteScript(details);
    } catch (error) {
      firstError = error;
    } finally {
      await restoreScanTimers(tabId);
    }

    const firstResult = firstResults?.[0]?.result;
    const retryIds = retryableItemIds(firstResult, items);
    if (firstError && !retryIds.size) {
      for (const item of items) retryIds.add(Number(item.item_id));
    }

    if (!retryIds.size) {
      if (typeof callback === "function") callback(firstResults);
      return firstResults;
    }

    const retryItems = items.filter((item) => retryIds.has(Number(item.item_id)));
    await showWorkerForFallback(state);

    let retryResults;
    try {
      await previousTabsReload(tabId);
      await previousSetZoom(tabId, 0.25).catch(() => undefined);
      await sleep(450);
      await installFastScanTimers(tabId);
      retryResults = await previousExecuteScript({
        ...details,
        args: [retryItems, expectedPage],
      });
    } finally {
      await restoreScanTimers(tabId);
      await hideWorkerAgain(state);
    }

    if (!firstResults) {
      if (typeof callback === "function") callback(retryResults);
      return retryResults;
    }

    const retryResult = retryResults?.[0]?.result;
    const merged = mergeScanResults(firstResult, retryResult, retryIds);
    const mergedResults = [{...firstResults[0], result: merged}, ...firstResults.slice(1)];
    if (typeof callback === "function") callback(mergedResults);
    return mergedResults;
  };

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    const state = workersByTab.get(Number(tabId));
    const first = await previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    if (!state || first?.snapshot_complete) return first;

    await showWorkerForFallback(state);
    let retry;
    try {
      retry = await previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    } finally {
      await hideWorkerAgain(state);
    }
    return retry || first;
  };

  chrome.windows.remove = async function(windowId, callback) {
    const state = workersByWindow.get(Number(windowId));
    if (state?.tabId) {
      await previousSetZoom(state.tabId, state.restoreZoom).catch(() => undefined);
      await sleep(80);
    }

    const removed = await previousWindowsRemove(windowId).catch(() => undefined);
    if (state) {
      workersByWindow.delete(state.windowId);
      workersByTab.delete(state.tabId);
      await returnToOriginalWindow(state);
    }
    if (typeof callback === "function") callback();
    return removed;
  };
})();
