(() => {
  const previousExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  chrome.scripting.executeScript = async function(details, callback) {
    if (details?.func?.name !== "clickBatchHiddenV8") {
      const results = await previousExecuteScript(details);
      if (typeof callback === "function") callback(results);
      return results;
    }

    const tabId = Number(details?.target?.tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.windowId) {
      await chrome.windows.update(tab.windowId, {focused: true}).catch(() => undefined);
    }
    await chrome.tabs.update(tabId, {active: true}).catch(() => undefined);
    await chrome.tabs.setZoom(tabId, 0.25).catch(() => undefined);
    await sleep(350);

    const results = await previousExecuteScript(details);

    // Let Google finish applying sequential removals before the worker reloads
    // the same small focused popup for the complete verification collection.
    await sleep(1500);

    if (typeof callback === "function") callback(results);
    return results;
  };
})();
