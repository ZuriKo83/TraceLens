(() => {
  const previousWindowsCreate = chrome.windows.create.bind(chrome.windows);
  const previousWindowsUpdate = chrome.windows.update.bind(chrome.windows);
  const previousWindowsRemove = chrome.windows.remove.bind(chrome.windows);
  const previousExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);

  const managedWindows = new Map();

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
    const width = 220;
    const height = 140;
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

  async function keepVisibleUnfocused(windowId) {
    const state = managedWindows.get(Number(windowId));
    if (!state) return;
    await previousWindowsUpdate(Number(windowId), {
      state: "normal",
      focused: false,
      ...state.bounds,
    }).catch(() => undefined);
    if (state.originalWindowId) {
      await previousWindowsUpdate(state.originalWindowId, {focused: true}).catch(() => undefined);
    }
  }

  chrome.windows.create = async function(createData, callback) {
    if (!isDeletionPage(createData?.url)) {
      const created = await previousWindowsCreate(createData);
      if (typeof callback === "function") callback(created);
      return created;
    }

    const original = await chrome.windows.getLastFocused().catch(() => null);
    const created = await previousWindowsCreate({...createData, focused: false});
    managedWindows.set(Number(created.id), {
      originalWindowId: original?.id || null,
      bounds: compactBounds(original),
    });
    await keepVisibleUnfocused(created.id);

    if (typeof callback === "function") callback(created);
    return created;
  };

  chrome.windows.update = async function(windowId, updateInfo, callback) {
    const state = managedWindows.get(Number(windowId));
    let nextInfo = updateInfo;

    // A minimized/fully hidden My Activity window is heavily timer-throttled by
    // Chrome. Keep a tiny 220x140 window rendered, but never steal focus during
    // normal scanning/deletion. Foreground fallback remains allowed explicitly.
    if (state && updateInfo?.state === "minimized" && updateInfo?.focused !== true) {
      nextInfo = {
        ...updateInfo,
        state: "normal",
        focused: false,
        ...state.bounds,
      };
    }

    const updated = await previousWindowsUpdate(windowId, nextInfo);
    if (typeof callback === "function") callback(updated);
    return updated;
  };

  chrome.windows.remove = async function(windowId, callback) {
    managedWindows.delete(Number(windowId));
    const removed = await previousWindowsRemove(windowId).catch(() => undefined);
    if (typeof callback === "function") callback();
    return removed;
  };

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

  chrome.scripting.executeScript = async function(details, callback) {
    if (details?.func?.name !== "scanThenDeleteV16") {
      const results = await previousExecuteScript(details);
      if (typeof callback === "function") callback(results);
      return results;
    }

    const tabId = Number(details?.target?.tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.windowId && managedWindows.has(Number(tab.windowId))) {
      await keepVisibleUnfocused(tab.windowId);
    }

    await installFastTimers(tabId);
    let results;
    try {
      results = await previousExecuteScript(details);
    } finally {
      await restoreTimers(tabId);
      const latestTab = await chrome.tabs.get(tabId).catch(() => null);
      if (latestTab?.windowId && managedWindows.has(Number(latestTab.windowId))) {
        await keepVisibleUnfocused(latestTab.windowId);
      }
    }

    if (typeof callback === "function") callback(results);
    return results;
  };
})();
