(() => {
  const adapters = new Map();
  const running = new Set();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  globalThis.TraceLensDeletionEngine = {
    registerAdapter(platform, adapter) {
      const key = String(platform || "").trim().toLowerCase();
      if (!key || !adapter || typeof adapter !== "object") throw new Error("삭제 어댑터 등록 정보가 올바르지 않습니다.");
      adapters.set(key, {...adapter, platform: key});
    },
    getAdapter(platform) {
      return adapters.get(String(platform || "").trim().toLowerCase()) || null;
    },
  };

  const publish = (webTabId, adapter, detail) => {
    if (!webTabId) return;
    chrome.tabs.sendMessage(webTabId, {
      type: "PLATFORM_DELETE_PROGRESS",
      platform: adapter.platform,
      ...detail,
    }).catch(() => undefined);
  };

  const activate = async (tabId, focus = true) => {
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    if (!tab) return null;
    await chrome.tabs.update(tabId, {active: true}).catch(() => undefined);
    if (focus && Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, {focused: true}).catch(() => undefined);
    return tab;
  };

  const createSurface = async (url, focused) => {
    const created = await chrome.windows.create({url, focused, type: "popup"});
    let tab = created?.tabs?.[0] || null;
    if (!tab && Number.isInteger(created?.id)) tab = (await chrome.tabs.query({windowId: created.id}))[0] || null;
    if (!tab?.id) throw new Error("삭제 작업 창을 열지 못했습니다.");
    return {windowId: created.id, tab};
  };

  const execute = async (tabId, func, args, message) => {
    if (typeof func !== "function") throw new Error("삭제 페이지 함수가 등록되지 않았습니다.");
    const result = await chrome.scripting.executeScript({target: {tabId}, func, args});
    const payload = result?.[0]?.result;
    if (!payload) throw new Error(message);
    return payload;
  };

  async function runDeletion(adapter, rawTargets, config, webTabId) {
    const targets = adapter.normalizeTargets(rawTargets);
    const maximum = Math.max(1, Number(adapter.maxTargets) || 100);
    if (!targets.length) throw new Error(`삭제할 ${adapter.itemLabel || "항목"}을 선택하세요.`);
    if (targets.length > maximum) throw new Error(`한 번에 최대 ${maximum}개까지 삭제할 수 있습니다.`);

    const state = {
      tab: null,
      windowId: null,
      interrupted: true,
      intentional: false,
      attempts: 0,
      completed: false,
    };
    const maxAttempts = 4;

    const isValid = async () => {
      if (state.interrupted || !state.tab?.id) return null;
      const tab = await chrome.tabs.get(state.tab.id).catch(() => null);
      return tab && adapter.isTaskUrl(tab.url || "") ? tab : null;
    };

    const interrupted = (text) => {
      if (state.intentional || state.completed) return;
      state.interrupted = true;
      publish(webTabId, adapter, {
        stage: "recovering",
        message: `${text} 삭제 작업은 취소되지 않으며 자동으로 다시 엽니다.`,
      });
    };

    const onTabRemoved = (tabId) => {
      if (tabId === state.tab?.id) interrupted("삭제 작업 탭이 닫혔습니다.");
    };
    const onWindowRemoved = (windowId) => {
      if (windowId === state.windowId) interrupted("삭제 작업 창이 닫혔습니다.");
    };
    const onTabUpdated = (tabId, changeInfo) => {
      if (tabId === state.tab?.id && changeInfo.url && !adapter.isTaskUrl(changeInfo.url)) {
        interrupted("삭제 작업 페이지에서 다른 주소로 이동했습니다.");
      }
    };
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    chrome.windows.onRemoved.addListener(onWindowRemoved);
    chrome.tabs.onUpdated.addListener(onTabUpdated);

    const closeSurface = async () => {
      const windowId = state.windowId;
      const tabId = state.tab?.id;
      state.intentional = true;
      state.interrupted = true;
      state.windowId = null;
      state.tab = null;
      if (Number.isInteger(windowId)) await chrome.windows.remove(windowId).catch(() => undefined);
      else if (tabId) await chrome.tabs.remove(tabId).catch(() => undefined);
      state.intentional = false;
    };

    const ensureSurface = async (reason, focus = true) => {
      const current = await isValid();
      if (current) {
        await activate(current.id, focus);
        return current.id;
      }
      while (state.attempts < maxAttempts) {
        state.attempts += 1;
        if (state.attempts > 1) {
          publish(webTabId, adapter, {
            stage: "recovering",
            message: `${reason}을 계속하기 위해 작업 창을 자동 복구합니다. (${state.attempts - 1}/3)`,
          });
        }
        state.interrupted = false;
        try {
          const surface = await createSurface(adapter.taskUrl, focus);
          state.windowId = surface.windowId;
          state.tab = surface.tab;
          await activate(state.tab.id, focus);
          await waitForTabComplete(state.tab.id, adapter.loadTimeoutMs || 45000);
          await waitForPageSettled(state.tab.id, adapter.settleTimeoutMs || 15000);
          const loaded = await chrome.tabs.get(state.tab.id).catch(() => null);
          if (!loaded || !adapter.isTaskUrl(loaded.url || "")) throw new Error("삭제 작업 페이지 주소가 올바르지 않습니다.");
          return state.tab.id;
        } catch (error) {
          state.interrupted = true;
          if (state.attempts >= maxAttempts) throw new Error(`작업 창 자동 복구에 실패했습니다: ${error.message || String(error)}`);
        }
      }
      throw new Error("작업 창 자동 복구 한도를 초과했습니다.");
    };

    const stage = async (reason, focus, action) => {
      while (true) {
        const tabId = await ensureSurface(reason, focus);
        try {
          return await action(tabId);
        } catch (error) {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          const lost = state.interrupted || !tab || !adapter.isTaskUrl(tab.url || "");
          if (!lost) throw error;
          state.interrupted = true;
          if (state.attempts >= maxAttempts) throw new Error(`작업 창을 반복해서 닫아 자동 복구에 실패했습니다: ${error.message || String(error)}`);
        }
      }
    };

    const deletePass = (items) => stage("삭제 대상 탐색과 삭제", true, async (tabId) => {
      const payload = await execute(tabId, adapter.deletePageFunction, [items, {
        batchSize: adapter.batchSize || 20,
        batchPauseMs: adapter.batchPauseMs || 500,
      }], `${adapter.label} 삭제 결과를 받지 못했습니다.`);
      const attempted = payload.attemptedIds?.length || payload.clickedIds?.length || 0;
      publish(webTabId, adapter, {
        stage: "deleting",
        message: `${payload.scannedUnique || 0}개 행 탐색, ${attempted}개 삭제 요청 완료`,
        progress: payload.progress || null,
      });
      return payload;
    });

    const verifyPass = (items, reason) => stage(reason, false, async (tabId) => {
      await activate(tabId, false);
      await chrome.tabs.reload(tabId);
      await waitForTabComplete(tabId, adapter.loadTimeoutMs || 45000);
      await waitForPageSettled(tabId, adapter.settleTimeoutMs || 15000);
      const payload = await execute(tabId, adapter.verifyPageFunction, [items], `${adapter.label} 삭제 결과 확인에 실패했습니다.`);
      publish(webTabId, adapter, {
        stage: "verifying",
        message: `Google 내 활동 전체 확인 완료: 남은 대상 ${payload.foundIds?.length || 0}개`,
        progress: payload.progress || null,
      });
      return payload;
    });

    try {
      publish(webTabId, adapter, {stage: "opening", message: adapter.openingMessage || `${adapter.label} 삭제 페이지를 여는 중입니다.`});
      await ensureSurface("삭제 작업 준비", true);
      publish(webTabId, adapter, {
        stage: "discovering",
        message: adapter.discoveryMessage?.(targets.length) || `${targets.length}개 대상을 전체 기록에서 찾습니다.`,
      });

      const first = await deletePass(targets);
      const delay = Math.max(500, Number(adapter.verificationDelayMs) || 1800);
      publish(webTabId, adapter, {
        stage: "settling",
        message: `삭제 반영을 ${Math.ceil(delay / 1000)}초 기다립니다. 작업 창을 닫아도 자동으로 복구됩니다.`,
      });
      await sleep(delay);
      if (webTabId) await activate(webTabId, true);

      let verification = await verifyPass(targets, "삭제 결과 전수 확인");
      const retryTargets = targets.filter((target) => verification.foundIds?.includes(target.id));
      let retry = {clickedIds: [], attemptedIds: [], failed: [], unmatchedIds: []};
      if (retryTargets.length && adapter.retry !== false) {
        publish(webTabId, adapter, {stage: "retrying", message: `${retryTargets.length}개 남은 항목만 다시 삭제합니다.`});
        retry = await deletePass(retryTargets);
        await sleep(delay);
        if (webTabId) await activate(webTabId, true);
        verification = await verifyPass(targets, "재삭제 결과 전수 확인");
      }

      const attempted = new Set([
        ...(first.attemptedIds || []), ...(first.clickedIds || []),
        ...(retry.attemptedIds || []), ...(retry.clickedIds || []),
      ]);
      const found = new Set(verification.foundIds || []);
      const unmatched = new Set([...(first.unmatchedIds || []), ...(retry.unmatchedIds || [])]);
      const verifiedDeletedIds = [];
      const alreadyMissingIds = [];
      const failures = [];

      for (const target of targets) {
        if (found.has(target.id)) failures.push({id: target.id, reason: "새로고침 후에도 동일한 항목이 Google 내 활동에 남아 있습니다."});
        else if (!verification.complete) failures.push({id: target.id, reason: "Google 내 활동 전체 확인이 끝나지 않아 결과를 확정할 수 없습니다."});
        else if (attempted.has(target.id)) verifiedDeletedIds.push(target.id);
        else if (unmatched.has(target.id) && first.discoveryComplete === true) alreadyMissingIds.push(target.id);
        else failures.push({id: target.id, reason: "삭제 버튼 클릭 기록이 없어 삭제 여부를 확정할 수 없습니다."});
      }

      const absent = new Set([...verifiedDeletedIds, ...alreadyMissingIds]);
      const absentTargets = targets.filter((target) => absent.has(target.id));
      let sync = {synced: absentTargets.length === 0, raw: null, lines: []};
      if (absentTargets.length && typeof adapter.confirmDeletedTargets === "function") {
        const raw = await adapter.confirmDeletedTargets(absentTargets, config);
        const expected = [...new Set(absentTargets.map((target) => Number(target.activityId || 0)).filter((id) => id > 0))];
        const removed = new Set((raw?.deleted_ids || []).map(Number));
        const synced = expected.length > 0 && expected.every((id) => removed.has(id));
        sync = {synced, raw, lines: [synced ? `✓ TraceLens 목록 ${expected.length}개 정리` : `✕ TraceLens 목록 ${raw?.deleted || 0}/${expected.length}개 정리`]};
      }

      const result = {
        ok: failures.length === 0 && sync.synced,
        platform: adapter.platform,
        requested: targets.length,
        deleted: verifiedDeletedIds.length,
        deletedIds: verifiedDeletedIds,
        deletedActivityIds: sync.raw?.deleted_ids || [],
        alreadyMissing: alreadyMissingIds.length,
        alreadyMissingIds,
        failed: failures.length,
        failures,
        verificationComplete: Boolean(verification.complete),
        synced: sync.synced,
        taskWindowRecoveries: Math.max(0, state.attempts - 1),
        lines: sync.lines,
        warning: absentTargets.length && !sync.synced ? (adapter.syncError || "TraceLens 목록 동기화에 실패했습니다.") : null,
        error: failures[0]?.reason || null,
      };

      state.completed = true;
      publish(webTabId, adapter, {stage: "closing", message: "삭제·전수 확인·동기화가 끝나 작업 창을 닫습니다."});
      await closeSurface();
      if (webTabId) await activate(webTabId, true);
      publish(webTabId, adapter, {stage: "done", message: "삭제 작업이 완료됐습니다.", result});
      return result;
    } catch (error) {
      publish(webTabId, adapter, {stage: "error", message: `자동 복구에도 실패했습니다: ${error.message || String(error)}`});
      if (webTabId) await activate(webTabId, true);
      throw error;
    } finally {
      chrome.tabs.onRemoved.removeListener(onTabRemoved);
      chrome.windows.onRemoved.removeListener(onWindowRemoved);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      if (state.completed) await closeSurface();
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "DELETE_PLATFORM_ITEMS") return false;
    const platform = String(message.platform || "").trim().toLowerCase();
    const adapter = adapters.get(platform);
    if (!adapter) {
      sendResponse({ok: false, error: "지원하지 않는 삭제 플랫폼입니다."});
      return false;
    }
    if (running.has(platform)) {
      sendResponse({ok: false, error: `이미 ${adapter.label || platform} 삭제 작업이 진행 중입니다.`});
      return false;
    }
    running.add(platform);
    resolveCollectorConfig(message.config)
      .then((config) => runDeletion(adapter, message.targets, config, sender.tab?.id))
      .then(sendResponse)
      .catch((error) => sendResponse({ok: false, platform, error: error.message || String(error)}))
      .finally(() => running.delete(platform));
    return true;
  });
})();