(() => {
  const originalCreate = chrome.tabs.create.bind(chrome.tabs);
  const originalGet = chrome.tabs.get.bind(chrome.tabs);
  const originalUpdate = chrome.tabs.update.bind(chrome.tabs);
  const originalRemove = chrome.tabs.remove.bind(chrome.tabs);
  const originalSetTimeout = globalThis.setTimeout.bind(globalThis);

  const managedTabs = new Set();
  const tabsByPage = new Map();
  let batchActive = false;
  let cleanupTimer = null;
  let shortenNextLoadWait = false;

  function pageFromUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.hostname !== "myactivity.google.com" || url.pathname.replace(/\/$/, "") !== "/page") return null;
      const page = url.searchParams.get("page");
      return page === "youtube_comments" || page === "youtube_live_chat" ? page : null;
    } catch {
      return null;
    }
  }

  function clearCleanupTimer() {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }

  async function closeManagedTabs() {
    clearCleanupTimer();
    const ids = [...managedTabs];
    managedTabs.clear();
    tabsByPage.clear();
    if (!ids.length) return;
    await originalRemove(ids).catch(() => undefined);
  }

  function scheduleFallbackCleanup(delayMs = 20000) {
    clearCleanupTimer();
    cleanupTimer = originalSetTimeout(() => {
      batchActive = false;
      closeManagedTabs().catch(() => undefined);
    }, delayMs);
  }

  async function reusableTab(page) {
    const tabId = tabsByPage.get(page);
    if (!tabId) return null;
    const tab = await originalGet(tabId).catch(() => null);
    if (!tab || pageFromUrl(tab.url) !== page) {
      tabsByPage.delete(page);
      managedTabs.delete(tabId);
      if (tab) await originalRemove(tabId).catch(() => undefined);
      return null;
    }
    return tab;
  }

  async function createForBatch(properties) {
    const page = pageFromUrl(properties?.url);
    if (!batchActive || !page) return originalCreate(properties);

    clearCleanupTimer();
    const cached = await reusableTab(page);
    if (cached) {
      shortenNextLoadWait = true;
      if (cached.active) {
        await originalUpdate(cached.id, {active: false}).catch(() => undefined);
      }
      return await originalGet(cached.id).catch(() => cached);
    }

    const tab = await originalCreate({...properties, active: false});
    managedTabs.add(tab.id);
    tabsByPage.set(page, tab.id);
    return tab;
  }

  chrome.tabs.create = function(properties, callback) {
    const operation = createForBatch(properties);
    if (typeof callback === "function") {
      operation.then((tab) => callback(tab)).catch(() => callback(undefined));
      return undefined;
    }
    return operation;
  };

  chrome.tabs.remove = function(tabIds, callback) {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    const suppressed = batchActive && ids.some((id) => managedTabs.has(id));
    const removable = ids.filter((id) => !managedTabs.has(id));

    if (!suppressed) return originalRemove(tabIds, callback);

    const operation = removable.length
      ? originalRemove(removable.length === 1 ? removable[0] : removable)
      : Promise.resolve();
    scheduleFallbackCleanup();
    if (typeof callback === "function") {
      operation.then(() => callback()).catch(() => callback());
      return undefined;
    }
    return operation;
  };

  // delete_worker_v2 waits 1.8 seconds after every tab creation. The first tab
  // still gets the full wait; reused, already-loaded tabs only need a short DOM tick.
  globalThis.setTimeout = function(handler, delay, ...args) {
    let adjusted = delay;
    if (shortenNextLoadWait && Number(delay) === 1800) {
      shortenNextLoadWait = false;
      adjusted = 250;
    }
    return originalSetTimeout(handler, adjusted, ...args);
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "DELETE_YOUTUBE_ACTIVITY") {
      batchActive = true;
      clearCleanupTimer();
      return false;
    }

    if (message?.type === "DELETE_BATCH_END") {
      batchActive = false;
      closeManagedTabs()
        .then(() => sendResponse({ok: true}))
        .catch((error) => sendResponse({ok: false, error: String(error?.message || error)}));
      return true;
    }

    return false;
  });
})();
