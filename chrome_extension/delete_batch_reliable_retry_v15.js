(() => {
  const previousWindowsCreate = chrome.windows.create.bind(chrome.windows);
  const previousWindowsUpdate = chrome.windows.update.bind(chrome.windows);
  const previousWindowsRemove = chrome.windows.remove.bind(chrome.windows);
  const previousExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
  const previousFetch = globalThis.fetch.bind(globalThis);
  const previousRunExtractor = runExtractor;

  const workerWindows = new Map();
  const contextsByTab = new Map();
  const pendingContexts = new Set();
  let internalCollectionDepth = 0;

  const MAX_RETRY_ROUNDS = 2;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

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

  function scopeForPage(page) {
    return page === "youtube_live_chat" ? "live_chat" : "comment";
  }

  function sourceIdentity(locator = {}, metadata = {}, sourceUrl = "") {
    const sourceType = clean(locator.source_type || metadata.source_type).toLowerCase();
    const sourceId = clean(locator.source_id || metadata.source_id);
    if (sourceType && sourceId) return `${sourceType}:${sourceId}`;

    const postId = clean(locator.post_id || metadata.post_id || metadata.youtube_post_id);
    if (postId) return `post:${postId}`;
    const videoId = clean(locator.video_id || metadata.video_id);
    if (videoId) return `video:${videoId}`;

    const source = String(sourceUrl || locator.source_url || "");
    const postMatch = source.match(/\/post\/([A-Za-z0-9_-]{10,160})/i);
    if (postMatch) return `post:${postMatch[1]}`;
    const videoMatch = source.match(/[?&]v=([A-Za-z0-9_-]{6,20})/i)
      || source.match(/\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,20})/i)
      || source.match(/youtu\.be\/([A-Za-z0-9_-]{6,20})/i);
    return videoMatch ? `video:${videoMatch[1]}` : "";
  }

  function jobDescriptor(item) {
    const locator = item?.locator && typeof item.locator === "object" ? item.locator : {};
    return {
      itemId: Number(item.item_id),
      title: clean(locator.title || item.title),
      content: clean(locator.content || item.content),
      sourceKey: sourceIdentity(locator, {}, item.source_url),
    };
  }

  function collectedDescriptor(item) {
    const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
    const locator = metadata.deletion_locator && typeof metadata.deletion_locator === "object"
      ? metadata.deletion_locator
      : {};
    return {
      title: clean(locator.title || metadata.title || item.title),
      content: clean(locator.content || item.content),
      sourceKey: sourceIdentity(locator, metadata, item.source_url),
    };
  }

  function fingerprint(descriptor) {
    return descriptor.sourceKey
      ? `${descriptor.sourceKey}\u0000${descriptor.content}`
      : `no-source\u0000${descriptor.title}\u0000${descriptor.content}`;
  }

  function countSnapshot(result) {
    const counts = new Map();
    for (const item of result?.items || []) {
      const key = fingerprint(collectedDescriptor(item));
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  function groupedTargets(context) {
    const grouped = new Map();
    for (const descriptor of context.targets.values()) {
      const key = fingerprint(descriptor);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(descriptor);
    }
    return grouped;
  }

  function classification(context, snapshot = context.after) {
    const baselineCounts = countSnapshot(context.baseline);
    const afterCounts = countSnapshot(snapshot);
    const removed = new Set();
    const alreadyAbsent = new Set();
    const unresolved = new Set();
    const diagnostics = new Map();

    for (const [key, descriptors] of groupedTargets(context)) {
      const baselineCount = baselineCounts.get(key) || 0;
      const afterCount = afterCounts.get(key) || 0;
      const missingBefore = Math.max(0, descriptors.length - baselineCount);
      const removedCount = Math.max(0, baselineCount - afterCount);

      const absentPriority = [...descriptors].sort((left, right) => {
        const leftApplied = context.appliedIds.has(left.itemId) ? 1 : 0;
        const rightApplied = context.appliedIds.has(right.itemId) ? 1 : 0;
        return leftApplied - rightApplied;
      });
      const absentIds = new Set(absentPriority.slice(0, missingBefore).map((entry) => entry.itemId));
      for (const itemId of absentIds) alreadyAbsent.add(itemId);

      const remaining = descriptors.filter((entry) => !absentIds.has(entry.itemId));
      const removedPriority = [...remaining].sort((left, right) => {
        const leftApplied = context.appliedIds.has(left.itemId) ? 0 : 1;
        const rightApplied = context.appliedIds.has(right.itemId) ? 0 : 1;
        if (leftApplied !== rightApplied) return leftApplied - rightApplied;
        return left.itemId - right.itemId;
      });
      const removedIds = new Set(removedPriority.slice(0, removedCount).map((entry) => entry.itemId));

      for (const descriptor of remaining) {
        if (removedIds.has(descriptor.itemId)) removed.add(descriptor.itemId);
        else unresolved.add(descriptor.itemId);
      }
      for (const descriptor of descriptors) {
        diagnostics.set(descriptor.itemId, {
          baselineCount,
          afterCount,
          removedCount,
          fingerprintMode: descriptor.sourceKey ? "source_content_count" : "title_content_count",
        });
      }
    }

    return {removed, alreadyAbsent, unresolved, diagnostics};
  }

  async function waitForTabComplete(tabId, timeoutMs = 45000) {
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (!current) throw new Error("삭제 확인 탭을 찾을 수 없습니다.");
    if (current.status === "complete") return current;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("Google 내 활동 페이지 로딩 시간이 초과되었습니다."));
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

  async function focusWorker(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    await previousWindowsUpdate(tab.windowId, {focused: true}).catch(() => undefined);
    await chrome.tabs.update(tabId, {active: true}).catch(() => undefined);
    await chrome.tabs.setZoom(tabId, 0.25).catch(() => undefined);
  }

  async function collectCompleteSnapshot(tabId, page, attempts = 2) {
    let lastResult = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await chrome.tabs.reload(tabId);
        await waitForTabComplete(tabId);
        await chrome.tabs.setZoom(tabId, 0.25).catch(() => undefined);
        await sleep(1000);
      }
      internalCollectionDepth += 1;
      try {
        lastResult = await previousRunExtractor(
          tabId,
          "youtube",
          scopeForPage(page),
          "self_activity",
          null
        );
      } finally {
        internalCollectionDepth -= 1;
      }
      if (lastResult?.snapshot_complete) return lastResult;
    }
    return lastResult;
  }

  async function reloadAndCollectComplete(tabId, page) {
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    await chrome.tabs.setZoom(tabId, 0.25).catch(() => undefined);
    await focusWorker(tabId);
    await sleep(1500);
    return collectCompleteSnapshot(tabId, page, 2);
  }

  function installSlowRetryTimingV15() {
    if (globalThis.__TRACELENS_NATIVE_TIMEOUT_V15) return;
    globalThis.__TRACELENS_NATIVE_TIMEOUT_V15 = globalThis.setTimeout.bind(globalThis);
    globalThis.setTimeout = (handler, delay, ...args) => {
      const numeric = Number(delay || 0);
      let adjusted = numeric;
      if (numeric === 180) adjusted = 950;
      else if (numeric === 120) adjusted = 300;
      else if (numeric === 110) adjusted = 240;
      else if (numeric === 160) adjusted = 340;
      return globalThis.__TRACELENS_NATIVE_TIMEOUT_V15(handler, adjusted, ...args);
    };
  }

  function restoreSlowRetryTimingV15() {
    if (!globalThis.__TRACELENS_NATIVE_TIMEOUT_V15) return;
    globalThis.setTimeout = globalThis.__TRACELENS_NATIVE_TIMEOUT_V15;
    delete globalThis.__TRACELENS_NATIVE_TIMEOUT_V15;
  }

  function mergeClickResult(context, result) {
    if (!result?.ok) return;
    for (const itemId of result.applied_item_ids || []) {
      const numeric = Number(itemId);
      context.appliedIds.add(numeric);
      context.failures.delete(numeric);
    }
    for (const failure of result.failures || []) {
      const numeric = Number(failure.item_id);
      if (!context.appliedIds.has(numeric)) context.failures.set(numeric, failure);
    }
    context.evidence = {...context.evidence, ...(result.evidence_by_item || {})};
  }

  async function retryUnresolved(context, unresolvedIds) {
    const retryItems = context.items.filter((item) => unresolvedIds.has(Number(item.item_id)));
    if (!retryItems.length || !context.clickFunc) return;

    await chrome.tabs.reload(context.tabId);
    await waitForTabComplete(context.tabId);
    await focusWorker(context.tabId);
    await sleep(1100);

    await previousExecuteScript({target: {tabId: context.tabId}, func: installSlowRetryTimingV15});
    let injected;
    try {
      injected = await previousExecuteScript({
        target: {tabId: context.tabId},
        func: context.clickFunc,
        args: [retryItems, context.page],
      });
    } finally {
      await previousExecuteScript({
        target: {tabId: context.tabId},
        func: restoreSlowRetryTimingV15,
      }).catch(() => undefined);
    }

    mergeClickResult(context, injected?.[0]?.result);
    context.retryRounds += 1;
    await sleep(2600);
    context.after = await reloadAndCollectComplete(context.tabId, context.page);
  }

  chrome.windows.create = async function(createData, callback) {
    if (!isDeletionPage(createData?.url)) {
      const created = await previousWindowsCreate(createData);
      if (typeof callback === "function") callback(created);
      return created;
    }

    const originalWindow = await chrome.windows.getLastFocused().catch(() => null);
    const width = 360;
    const height = 280;
    const left = originalWindow
      ? Math.max(0, Number(originalWindow.left || 0) + Number(originalWindow.width || width) - width - 16)
      : undefined;
    const top = originalWindow
      ? Math.max(0, Number(originalWindow.top || 0) + Number(originalWindow.height || height) - height - 48)
      : undefined;

    const created = await previousWindowsCreate({
      ...createData,
      type: "popup",
      focused: true,
      width,
      height,
      ...(Number.isFinite(left) ? {left} : {}),
      ...(Number.isFinite(top) ? {top} : {}),
    });
    const tab = created.tabs?.[0]
      || (await chrome.tabs.query({windowId: created.id, active: true}))[0];

    workerWindows.set(created.id, {
      originalWindowId: originalWindow?.id || null,
      tabId: tab?.id || null,
    });
    if (tab?.id) {
      await waitForTabComplete(tab.id).catch(() => undefined);
      await chrome.tabs.setZoom(tab.id, 0.25).catch(() => undefined);
    }

    if (typeof callback === "function") callback(created);
    return created;
  };

  chrome.windows.update = async function(windowId, updateInfo, callback) {
    const triesToRefocusOriginal = Boolean(
      updateInfo?.focused
      && [...workerWindows.values()].some((state) => state.originalWindowId === Number(windowId))
    );
    if (triesToRefocusOriginal) {
      const current = await chrome.windows.get(windowId).catch(() => null);
      if (typeof callback === "function") callback(current);
      return current;
    }

    const updated = await previousWindowsUpdate(windowId, updateInfo);
    if (typeof callback === "function") callback(updated);
    return updated;
  };

  chrome.windows.remove = async function(windowId, callback) {
    const state = workerWindows.get(Number(windowId)) || null;
    const removed = await previousWindowsRemove(windowId).catch(() => undefined);
    workerWindows.delete(Number(windowId));
    if (state?.originalWindowId) {
      await previousWindowsUpdate(state.originalWindowId, {focused: true}).catch(() => undefined);
    }
    if (typeof callback === "function") callback();
    return removed;
  };

  chrome.scripting.executeScript = async function(details, callback) {
    if (details?.func?.name !== "clickBatchHiddenV8") {
      const results = await previousExecuteScript(details);
      if (typeof callback === "function") callback(results);
      return results;
    }

    const tabId = Number(details?.target?.tabId);
    const page = String(details?.args?.[1] || "");
    const items = Array.isArray(details?.args?.[0]) ? details.args[0] : [];
    let context = contextsByTab.get(tabId);

    if (!context) {
      context = {
        tabId,
        page,
        items: [...items],
        targets: new Map(items.map((item) => {
          const descriptor = jobDescriptor(item);
          return [descriptor.itemId, descriptor];
        })),
        baseline: null,
        after: null,
        appliedIds: new Set(),
        failures: new Map(),
        evidence: {},
        clickFunc: details.func,
        clickStarted: false,
        retryRounds: 0,
        posted: false,
      };
      contextsByTab.set(tabId, context);
      pendingContexts.add(context);

      await focusWorker(tabId);
      context.baseline = await collectCompleteSnapshot(tabId, page, 2);
      if (!context.baseline?.snapshot_complete) {
        const failed = {
          ok: true,
          applied_item_ids: [],
          failures: items.map((item) => ({
            item_id: item.item_id,
            reason: "삭제 전 전체 목록 확인을 완료하지 못해 실제 삭제를 시작하지 않았습니다.",
            diagnostics: {stage: "baseline_incomplete", expected_page: page},
          })),
          evidence_by_item: {},
        };
        const fakeResults = [{result: failed}];
        if (typeof callback === "function") callback(fakeResults);
        return fakeResults;
      }
    } else {
      for (const item of items) {
        const descriptor = jobDescriptor(item);
        context.targets.set(descriptor.itemId, descriptor);
        if (!context.items.some((existing) => Number(existing.item_id) === descriptor.itemId)) {
          context.items.push(item);
        }
      }
    }

    context.clickStarted = true;
    await focusWorker(tabId);
    const results = await previousExecuteScript(details);
    mergeClickResult(context, results?.[0]?.result);
    await sleep(1800);

    if (typeof callback === "function") callback(results);
    return results;
  };

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    let result = await previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    const context = contextsByTab.get(Number(tabId));
    const expectedScope = context ? scopeForPage(context.page) : "";
    const isVerification = Boolean(
      internalCollectionDepth === 0
      && context?.clickStarted
      && platform === "youtube"
      && activityType === expectedScope
    );

    if (!isVerification) return result;

    if (!result?.snapshot_complete) {
      result = await reloadAndCollectComplete(Number(tabId), context.page);
    }
    context.after = result;

    while (
      context.after?.snapshot_complete
      && context.retryRounds < MAX_RETRY_ROUNDS
    ) {
      const current = classification(context, context.after);
      if (!current.unresolved.size) break;
      await retryUnresolved(context, current.unresolved);
    }

    return context.after || result;
  };

  function patchResultsBody(body) {
    let payload;
    try {
      payload = JSON.parse(String(body || "{}"));
    } catch {
      return body;
    }
    if (!Array.isArray(payload.items)) return body;

    const outputById = new Map(payload.items.map((item) => [Number(item.item_id), {...item}]));

    for (const context of pendingContexts) {
      if (context.posted || !context.baseline?.snapshot_complete || !context.after?.snapshot_complete) continue;
      const final = classification(context, context.after);

      for (const descriptor of context.targets.values()) {
        const current = outputById.get(descriptor.itemId);
        if (!current) continue;
        const detail = final.diagnostics.get(descriptor.itemId) || {};

        if (final.alreadyAbsent.has(descriptor.itemId)) {
          outputById.set(descriptor.itemId, {
            ...current,
            status: "success",
            reason: null,
            diagnostics: {
              ...(current.diagnostics || {}),
              stage: "verified_absent_before_current_job",
              click_evidence: "verification_only_not_found",
              snapshot_complete: true,
              baseline_count: detail.baselineCount || 0,
              after_count: detail.afterCount || 0,
              removed_count: detail.removedCount || 0,
              retry_rounds: context.retryRounds,
              fingerprint_mode: detail.fingerprintMode,
            },
          });
          continue;
        }

        if (final.removed.has(descriptor.itemId)) {
          const applied = context.appliedIds.has(descriptor.itemId);
          outputById.set(descriptor.itemId, {
            ...current,
            status: "success",
            reason: null,
            diagnostics: {
              ...(current.diagnostics || {}),
              stage: "verified_by_complete_before_after_count",
              click_evidence: applied
                ? (context.evidence[String(descriptor.itemId)] || "count_delta_after_click")
                : "count_delta_without_click_evidence",
              snapshot_complete: true,
              baseline_count: detail.baselineCount || 0,
              after_count: detail.afterCount || 0,
              removed_count: detail.removedCount || 0,
              retry_rounds: context.retryRounds,
              fingerprint_mode: detail.fingerprintMode,
            },
          });
          continue;
        }

        outputById.set(descriptor.itemId, {
          ...current,
          status: "failed",
          reason: context.retryRounds
            ? `느린 자동 재시도 ${context.retryRounds}회 후에도 동일한 기록 수가 줄지 않았습니다.`
            : "삭제 동작 후 전체 목록을 다시 확인했지만 동일한 기록 수가 줄지 않았습니다.",
          diagnostics: {
            ...(current.diagnostics || {}),
            stage: "verification_count_unchanged_after_retry",
            snapshot_complete: true,
            baseline_count: detail.baselineCount || 0,
            after_count: detail.afterCount || 0,
            removed_count: detail.removedCount || 0,
            retry_rounds: context.retryRounds,
            fingerprint_mode: detail.fingerprintMode,
          },
        });
      }
      context.posted = true;
    }

    payload.items = [...outputById.values()];
    return JSON.stringify(payload);
  }

  globalThis.fetch = async function(input, init = {}) {
    const url = typeof input === "string" ? input : String(input?.url || "");
    const isResultPost = /\/api\/deletion-jobs\/batch\/[^/]+\/results(?:\?|$)/.test(url)
      && String(init?.method || "GET").toUpperCase() === "POST";

    if (!isResultPost) return previousFetch(input, init);

    const response = await previousFetch(input, {
      ...init,
      body: patchResultsBody(init.body),
    });

    for (const context of [...pendingContexts]) {
      if (!context.posted) continue;
      pendingContexts.delete(context);
      contextsByTab.delete(context.tabId);
    }
    return response;
  };
})();
