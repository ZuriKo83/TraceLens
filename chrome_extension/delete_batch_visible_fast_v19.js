(() => {
  const previousWindowsCreate = chrome.windows.create.bind(chrome.windows);
  const previousWindowsUpdate = chrome.windows.update.bind(chrome.windows);
  const previousWindowsRemove = chrome.windows.remove.bind(chrome.windows);
  const previousExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
  const previousRunExtractor = runExtractor;

  const managedWindows = new Map();
  const managedTabs = new Map();

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

  function compactBounds(original) {
    const width = 280;
    const height = 180;
    return {
      width,
      height,
      left: original
        ? Math.max(0, Number(original.left || 0) + Number(original.width || width) - width - 12)
        : 0,
      top: original
        ? Math.max(0, Number(original.top || 0) + Number(original.height || height) - height - 48)
        : 0,
    };
  }

  async function focusWorker(state) {
    if (!state) return;
    await previousWindowsUpdate(state.windowId, {
      state: "normal",
      focused: true,
      ...state.bounds,
    }).catch(() => undefined);
    await chrome.tabs.update(state.tabId, {active: true}).catch(() => undefined);
    await chrome.tabs.setZoom(state.tabId, 0.25).catch(() => undefined);
  }

  async function restoreOriginal(state) {
    if (!state?.originalWindowId) return;
    await previousWindowsUpdate(state.originalWindowId, {focused: true}).catch(() => undefined);
  }

  async function runWithWorkerFocused(tabId, operation) {
    const state = managedTabs.get(Number(tabId));
    if (!state) return operation();

    await focusWorker(state);
    const focusTimer = setInterval(() => {
      void focusWorker(state);
    }, 700);

    try {
      return await operation();
    } finally {
      clearInterval(focusTimer);
      await restoreOriginal(state);
    }
  }

  async function installWorkerPulse(tabId) {
    await previousExecuteScript({
      target: {tabId},
      func: () => {
        if (globalThis.__TRACELENS_DELETE_WORKER_PULSE_V19) return;
        const send = () => {
          try {
            chrome.runtime.sendMessage({
              type: "DELETE_WORKER_PULSE",
              at: Date.now(),
            }).catch(() => undefined);
          } catch {
            // The next pulse wakes a restarted service worker.
          }
        };
        send();
        globalThis.__TRACELENS_DELETE_WORKER_PULSE_V19 = setInterval(send, 4000);
      },
    }).catch(() => undefined);
  }

  async function installFastTimers(tabId) {
    await previousExecuteScript({
      target: {tabId},
      func: () => {
        if (globalThis.__TRACELENS_NATIVE_TIMEOUT_V19) return;
        const nativeTimeout = globalThis.setTimeout.bind(globalThis);
        globalThis.__TRACELENS_NATIVE_TIMEOUT_V19 = nativeTimeout;
        globalThis.setTimeout = (handler, delay, ...args) => {
          const numeric = Number(delay || 0);
          let adjusted = numeric;
          if (numeric === 350) adjusted = 120;
          else if (numeric === 900) adjusted = 300;
          else if (numeric === 650) adjusted = 220;
          else if (numeric === 500) adjusted = 180;
          else if (numeric === 450) adjusted = 150;
          else if (numeric === 420) adjusted = 130;
          else if (numeric === 320) adjusted = 100;
          else if (numeric === 300) adjusted = 100;
          else if (numeric === 260) adjusted = 100;
          else if (numeric === 220) adjusted = 90;
          else if (numeric === 180) adjusted = 80;
          else if (numeric === 130) adjusted = 70;
          else if (numeric === 120) adjusted = 70;
          else if (numeric === 100) adjusted = 60;
          return nativeTimeout(handler, adjusted, ...args);
        };
      },
    }).catch(() => undefined);
  }

  async function restoreTimers(tabId) {
    await previousExecuteScript({
      target: {tabId},
      func: () => {
        if (!globalThis.__TRACELENS_NATIVE_TIMEOUT_V19) return;
        globalThis.setTimeout = globalThis.__TRACELENS_NATIVE_TIMEOUT_V19;
        delete globalThis.__TRACELENS_NATIVE_TIMEOUT_V19;
      },
    }).catch(() => undefined);
  }

  chrome.windows.create = async function(createData, callback) {
    if (!isDeletionPage(createData?.url)) {
      const created = await previousWindowsCreate(createData);
      if (typeof callback === "function") callback(created);
      return created;
    }

    const original = await chrome.windows.getLastFocused().catch(() => null);
    const bounds = compactBounds(original);
    const created = await previousWindowsCreate({
      ...createData,
      type: "popup",
      state: "normal",
      focused: true,
      ...bounds,
    });
    const tab = created.tabs?.[0]
      || (await chrome.tabs.query({windowId: created.id, active: true}))[0];

    if (tab?.id) {
      const currentZoom = await chrome.tabs.getZoom(tab.id).catch(() => 1);
      const state = {
        windowId: Number(created.id),
        tabId: Number(tab.id),
        originalWindowId: original?.id || null,
        restoreZoom: Number.isFinite(currentZoom) && currentZoom > 0 ? currentZoom : 1,
        bounds,
      };
      managedWindows.set(state.windowId, state);
      managedTabs.set(state.tabId, state);
      await focusWorker(state);
      await installWorkerPulse(state.tabId);
    }

    if (typeof callback === "function") callback(created);
    return created;
  };

  chrome.scripting.executeScript = async function(details, callback) {
    if (details?.func?.name !== "scanThenDeleteV16") {
      const results = await previousExecuteScript(details);
      if (typeof callback === "function") callback(results);
      return results;
    }

    const tabId = Number(details?.target?.tabId);
    const results = await runWithWorkerFocused(tabId, async () => {
      await installWorkerPulse(tabId);
      await installFastTimers(tabId);
      try {
        return await previousExecuteScript(details);
      } finally {
        await restoreTimers(tabId);
      }
    });

    if (typeof callback === "function") callback(results);
    return results;
  };

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    if (!managedTabs.has(Number(tabId))) {
      return previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    }

    return runWithWorkerFocused(Number(tabId), async () => {
      await installWorkerPulse(Number(tabId));
      return previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    });
  };

  chrome.windows.remove = async function(windowId, callback) {
    const state = managedWindows.get(Number(windowId));
    if (state) {
      await chrome.tabs.setZoom(state.tabId, state.restoreZoom).catch(() => undefined);
      managedWindows.delete(state.windowId);
      managedTabs.delete(state.tabId);
    }

    const removed = await previousWindowsRemove(windowId).catch(() => undefined);
    if (state) await restoreOriginal(state);
    if (typeof callback === "function") callback();
    return removed;
  };
})();
