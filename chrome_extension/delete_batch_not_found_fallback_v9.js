(() => {
  const originalExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  chrome.scripting.executeScript = async function(details, callback) {
    const functionName = details?.func?.name || "";
    if (functionName !== "clickBatchHiddenV8") {
      const result = await originalExecuteScript(details);
      if (typeof callback === "function") callback(result);
      return result;
    }

    const tabId = Number(details?.target?.tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const workerWindowId = tab?.windowId || null;
    const focusedWindow = (await chrome.windows.getAll().catch(() => []))
      .find((windowInfo) => windowInfo.focused && windowInfo.id !== workerWindowId) || null;

    // The 420x300 popup used by v8 can render a compact My Activity layout
    // whose virtual list does not expose the same rows. Resize it behind the
    // TraceLens window before the first hidden attempt.
    if (workerWindowId) {
      await chrome.windows.update(workerWindowId, {
        width: 1100,
        height: 820,
        focused: false,
      }).catch(() => undefined);
      await sleep(250);
    }

    const firstResults = await originalExecuteScript(details);
    const first = firstResults?.[0]?.result;
    if (!first?.ok || !Array.isArray(first.failures)) {
      if (typeof callback === "function") callback(firstResults);
      return firstResults;
    }

    const notFoundIds = new Set(
      first.failures
        .filter((failure) => String(failure?.diagnostics?.stage || "") === "not_found")
        .map((failure) => Number(failure.item_id))
    );
    if (!notFoundIds.size || !workerWindowId) {
      if (typeof callback === "function") callback(firstResults);
      return firstResults;
    }

    const allItems = Array.isArray(details.args?.[0]) ? details.args[0] : [];
    const retryItems = allItems.filter((item) => notFoundIds.has(Number(item.item_id)));
    if (!retryItems.length) {
      if (typeof callback === "function") callback(firstResults);
      return firstResults;
    }

    // An unfocused Google My Activity window may stop virtual-list loading,
    // producing false not_found results. Focus only those failed records once,
    // then immediately return to TraceLens.
    await chrome.windows.update(workerWindowId, {focused: true}).catch(() => undefined);
    await chrome.tabs.update(tabId, {active: true}).catch(() => undefined);
    await sleep(350);

    const retryResults = await originalExecuteScript({
      ...details,
      args: [retryItems, ...(details.args || []).slice(1)],
    });
    const retried = retryResults?.[0]?.result;

    if (focusedWindow?.id) {
      await chrome.windows.update(focusedWindow.id, {focused: true}).catch(() => undefined);
    }

    if (!retried?.ok) {
      if (typeof callback === "function") callback(firstResults);
      return firstResults;
    }

    const retriedSuccessIds = new Set((retried.applied_item_ids || []).map(Number));
    const merged = {
      ...first,
      applied_item_ids: [...new Set([
        ...(first.applied_item_ids || []).map(Number),
        ...retriedSuccessIds,
      ])],
      failures: [
        ...(first.failures || []).filter((failure) => !notFoundIds.has(Number(failure.item_id))),
        ...(retried.failures || []),
      ],
      evidence_by_item: {
        ...(first.evidence_by_item || {}),
        ...(retried.evidence_by_item || {}),
      },
      not_found_focused_retry_count: retryItems.length,
    };

    const mergedResults = [{...firstResults[0], result: merged}, ...firstResults.slice(1)];
    if (typeof callback === "function") callback(mergedResults);
    return mergedResults;
  };
})();
