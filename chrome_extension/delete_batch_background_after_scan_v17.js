(() => {
  const previousWindowsCreate = chrome.windows.create.bind(chrome.windows);
  const previousWindowsUpdate = chrome.windows.update.bind(chrome.windows);
  const previousWindowsRemove = chrome.windows.remove.bind(chrome.windows);
  const previousExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
  const previousSetZoom = chrome.tabs.setZoom.bind(chrome.tabs);

  const workersByWindow = new Map();
  const workersByTab = new Map();
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

  async function detectVisibleEndMarker(tabId) {
    const injected = await previousExecuteScript({
      target: {tabId},
      func: () => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const visible = (node) => {
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 0
            && rect.height > 0
            && style.display !== "none"
            && style.visibility !== "hidden";
        };
        return [...document.querySelectorAll("body *")].some((node) => {
          if (!visible(node)) return false;
          const text = clean(node.textContent || "");
          return text === "더 이상 표시할 콘텐츠가 없습니다."
            || /^no more content[.!]?$/i.test(text);
        });
      },
    }).catch(() => []);
    return Boolean(injected?.[0]?.result);
  }

  async function returnToOriginalWindow(state) {
    if (!state?.originalWindowId) return;
    await previousWindowsUpdate(state.originalWindowId, {focused: true}).catch(() => undefined);
  }

  async function watchForCompletedScan(state, stopSignal) {
    const deadline = Date.now() + 180000;
    while (!stopSignal.done && Date.now() < deadline) {
      if (await detectVisibleEndMarker(state.tabId)) {
        state.scanCompleted = true;
        state.suppressNextWorkerFocus = true;
        await returnToOriginalWindow(state);
        return true;
      }
      await sleep(180);
    }
    return false;
  }

  chrome.windows.create = async function(createData, callback) {
    if (!isDeletionPage(createData?.url)) {
      const created = await previousWindowsCreate(createData);
      if (typeof callback === "function") callback(created);
      return created;
    }

    const originalWindow = await chrome.windows.getLastFocused().catch(() => null);
    const created = await previousWindowsCreate(createData);
    const tab = created.tabs?.[0]
      || (await chrome.tabs.query({windowId: created.id, active: true}))[0];

    if (tab?.id) {
      const zoomSettings = await chrome.tabs.getZoomSettings(tab.id).catch(() => null);
      const currentZoom = await chrome.tabs.getZoom(tab.id).catch(() => 1);
      const restoreZoom = Number(zoomSettings?.defaultZoomFactor || currentZoom || 1);
      const state = {
        windowId: created.id,
        tabId: tab.id,
        originalWindowId: originalWindow?.id || null,
        restoreZoom: Number.isFinite(restoreZoom) && restoreZoom > 0 ? restoreZoom : 1,
        scanCompleted: false,
        suppressNextWorkerFocus: false,
      };
      workersByWindow.set(created.id, state);
      workersByTab.set(tab.id, state);
    }

    if (typeof callback === "function") callback(created);
    return created;
  };

  chrome.windows.update = async function(windowId, updateInfo, callback) {
    const state = workersByWindow.get(Number(windowId));
    if (state && updateInfo?.focused === true && state.suppressNextWorkerFocus) {
      state.suppressNextWorkerFocus = false;
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
    if (!state) {
      const results = await previousExecuteScript(details);
      if (typeof callback === "function") callback(results);
      return results;
    }

    state.scanCompleted = false;
    state.suppressNextWorkerFocus = false;
    const stopSignal = {done: false};
    const scanWatcher = watchForCompletedScan(state, stopSignal);

    let results;
    try {
      results = await previousExecuteScript(details);
    } finally {
      stopSignal.done = true;
    }
    await scanWatcher.catch(() => false);

    const result = results?.[0]?.result;
    if (!state.scanCompleted && result?.ok && Number(result.planned_count || 0) > 0) {
      state.scanCompleted = true;
      state.suppressNextWorkerFocus = true;
      await returnToOriginalWindow(state);
    }

    if (typeof callback === "function") callback(results);
    return results;
  };

  chrome.windows.remove = async function(windowId, callback) {
    const state = workersByWindow.get(Number(windowId));
    if (state?.tabId) {
      await previousSetZoom(state.tabId, state.restoreZoom).catch(() => undefined);
      await sleep(120);
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
