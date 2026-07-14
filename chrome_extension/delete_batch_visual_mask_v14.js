(() => {
  const previousWindowsCreate = chrome.windows.create.bind(chrome.windows);
  const previousWindowsRemove = chrome.windows.remove.bind(chrome.windows);
  const previousTabsReload = chrome.tabs.reload.bind(chrome.tabs);
  const previousExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
  const previousRunExtractor = runExtractor;

  const workerTabs = new Set();
  const workerWindows = new Map();

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

  function waitForTabComplete(tabId, timeoutMs = 45000) {
    return new Promise(async (resolve, reject) => {
      const current = await chrome.tabs.get(tabId).catch(() => null);
      if (!current) {
        reject(new Error("삭제 작업 탭을 찾을 수 없습니다."));
        return;
      }
      if (current.status === "complete") {
        resolve(current);
        return;
      }

      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("삭제 작업 페이지 로딩 시간이 초과되었습니다."));
      }, timeoutMs);

      function listener(updatedTabId, changeInfo, tab) {
        if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }

      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  async function installMask(tabId) {
    if (!workerTabs.has(Number(tabId))) return;
    await previousExecuteScript({
      target: {tabId: Number(tabId)},
      func: () => {
        const MASK_ID = "__tracelens_delete_visual_mask_v14";
        let host = document.getElementById(MASK_ID);
        if (!host) {
          host = document.createElement("div");
          host.id = MASK_ID;
          host.setAttribute("aria-hidden", "true");
          host.style.position = "fixed";
          host.style.inset = "0";
          host.style.zIndex = "2147483647";
          host.style.pointerEvents = "none";
          host.style.background = "#f5f7fb";
          host.style.contain = "strict";

          const shadow = host.attachShadow({mode: "closed"});
          const shell = document.createElement("div");
          shell.style.cssText = [
            "position:absolute",
            "inset:0",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "background:#f5f7fb",
          ].join(";");

          const spinner = document.createElement("div");
          spinner.style.cssText = [
            "width:34px",
            "height:34px",
            "border:4px solid #d7dce7",
            "border-top-color:#5865f2",
            "border-radius:50%",
            "animation:tracelens-mask-spin .8s linear infinite",
          ].join(";");

          const style = document.createElement("style");
          style.textContent = "@keyframes tracelens-mask-spin{to{transform:rotate(360deg)}}";
          shell.appendChild(spinner);
          shadow.append(style, shell);
          document.documentElement.appendChild(host);
        }
      },
    }).catch(() => undefined);
  }

  chrome.windows.create = async function(createData, callback) {
    const created = await previousWindowsCreate(createData);
    if (isDeletionPage(createData?.url)) {
      const tab = created.tabs?.[0]
        || (await chrome.tabs.query({windowId: created.id, active: true}))[0];
      if (tab?.id) {
        workerTabs.add(tab.id);
        workerWindows.set(created.id, tab.id);
        await waitForTabComplete(tab.id).catch(() => undefined);
        await installMask(tab.id);
      }
    }
    if (typeof callback === "function") callback(created);
    return created;
  };

  chrome.tabs.reload = async function(tabId, reloadProperties, callback) {
    let properties = reloadProperties;
    let done = callback;
    if (typeof reloadProperties === "function") {
      done = reloadProperties;
      properties = undefined;
    }

    const result = properties === undefined
      ? await previousTabsReload(tabId)
      : await previousTabsReload(tabId, properties);

    if (workerTabs.has(Number(tabId))) {
      await waitForTabComplete(Number(tabId)).catch(() => undefined);
      await installMask(Number(tabId));
    }

    if (typeof done === "function") done();
    return result;
  };

  chrome.windows.remove = async function(windowId, callback) {
    const tabId = workerWindows.get(Number(windowId));
    if (tabId) workerTabs.delete(tabId);
    workerWindows.delete(Number(windowId));
    const result = await previousWindowsRemove(windowId).catch(() => undefined);
    if (typeof callback === "function") callback();
    return result;
  };

  chrome.scripting.executeScript = async function(details, callback) {
    const tabId = Number(details?.target?.tabId);
    if (workerTabs.has(tabId)) await installMask(tabId);
    const results = await previousExecuteScript(details);
    if (typeof callback === "function") callback(results);
    return results;
  };

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    if (workerTabs.has(Number(tabId))) await installMask(Number(tabId));
    return previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
  };
})();
