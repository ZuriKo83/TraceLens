(() => {
  const originalTabsCreate = chrome.tabs.create.bind(chrome.tabs);
  const originalTabsRemove = chrome.tabs.remove.bind(chrome.tabs);
  const originalExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
  const workerTabs = new Map();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  chrome.tabs.create = async function(createProperties, callback) {
    if (!isDeletionPage(createProperties?.url) || createProperties?.active !== true) {
      const result = await originalTabsCreate(createProperties);
      if (typeof callback === "function") callback(result);
      return result;
    }

    const currentWindow = await chrome.windows.getLastFocused().catch(() => null);
    const workerWindow = await chrome.windows.create({
      url: createProperties.url,
      type: "popup",
      focused: false,
      width: 420,
      height: 300,
    });
    const tab = workerWindow.tabs?.[0]
      || (await chrome.tabs.query({windowId: workerWindow.id, active: true}))[0];

    if (!tab?.id) throw new Error("백그라운드 삭제 창을 만들지 못했습니다.");
    workerTabs.set(tab.id, {
      workerWindowId: workerWindow.id,
      originalWindowId: currentWindow?.id || null,
    });

    if (typeof callback === "function") callback(tab);
    return tab;
  };

  chrome.tabs.remove = async function(tabIds, callback) {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    const windowIds = new Set();
    for (const tabId of ids) {
      const state = workerTabs.get(Number(tabId));
      if (state?.workerWindowId) windowIds.add(state.workerWindowId);
      workerTabs.delete(Number(tabId));
    }

    let result;
    if (windowIds.size) {
      for (const windowId of windowIds) {
        await chrome.windows.remove(windowId).catch(() => undefined);
      }
      const remaining = ids.filter((tabId) => ![...windowIds].some((windowId) => {
        const state = workerTabs.get(Number(tabId));
        return state?.workerWindowId === windowId;
      }));
      if (remaining.length) result = await originalTabsRemove(remaining);
    } else {
      result = await originalTabsRemove(tabIds);
    }

    if (typeof callback === "function") callback();
    return result;
  };

  chrome.scripting.executeScript = async function(details, callback) {
    const firstResults = await originalExecuteScript(details);
    const tabId = Number(details?.target?.tabId);
    const state = workerTabs.get(tabId);
    const functionName = details?.func?.name || "";
    const first = firstResults?.[0]?.result;

    if (!state || functionName !== "clickBatchFastV8" || !first?.ok) {
      if (typeof callback === "function") callback(firstResults);
      return firstResults;
    }

    const retryableIds = new Set(
      (first.failures || [])
        .filter((failure) => ["click_not_applied", "click_unconfirmed_after_confirm"].includes(String(failure?.diagnostics?.stage || "")))
        .map((failure) => Number(failure.item_id))
    );
    if (!retryableIds.size) {
      if (typeof callback === "function") callback(firstResults);
      return firstResults;
    }

    const allItems = Array.isArray(details.args?.[0]) ? details.args[0] : [];
    const retryItems = allItems.filter((item) => retryableIds.has(Number(item.item_id)));
    if (!retryItems.length) {
      if (typeof callback === "function") callback(firstResults);
      return firstResults;
    }

    // Usually the separate popup stays behind the TraceLens window and clicks
    // still work because its tab is active inside that window. On systems where
    // Google ignores an unfocused window, briefly focus only for failed items.
    await chrome.windows.update(state.workerWindowId, {focused: true}).catch(() => undefined);
    await sleep(250);

    const retryResults = await originalExecuteScript({
      ...details,
      args: [retryItems, ...(details.args || []).slice(1)],
    });
    const retried = retryResults?.[0]?.result;

    if (state.originalWindowId) {
      await chrome.windows.update(state.originalWindowId, {focused: true}).catch(() => undefined);
    }

    if (!retried?.ok) {
      if (typeof callback === "function") callback(firstResults);
      return firstResults;
    }

    const retriedIds = new Set((retried.applied_item_ids || []).map(Number));
    const merged = {
      ...first,
      applied_item_ids: [...new Set([
        ...(first.applied_item_ids || []).map(Number),
        ...retriedIds,
      ])],
      failures: [
        ...(first.failures || []).filter((failure) => !retriedIds.has(Number(failure.item_id))),
        ...(retried.failures || []),
      ],
      evidence_by_item: {
        ...(first.evidence_by_item || {}),
        ...(retried.evidence_by_item || {}),
      },
      focused_fallback_count: retryItems.length,
    };
    const mergedResults = [{...firstResults[0], result: merged}, ...firstResults.slice(1)];
    if (typeof callback === "function") callback(mergedResults);
    return mergedResults;
  };
})();
