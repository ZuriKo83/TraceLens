(() => {
  const PORT_NAME = "tracelens-delete-batch-v3";

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;

    let running = false;
    port.onMessage.addListener((message) => {
      if (message?.type !== "START_DELETE_BATCH" || running) return;
      running = true;
      port.postMessage({type: "DELETE_BATCH_ACCEPTED", jobId: message.job?.job_id || null});
      runBatch(message.job, message.config, port)
        .then((result) => port.postMessage({type: "DELETE_BATCH_RESULT", result}))
        .catch((error) => port.postMessage({
          type: "DELETE_BATCH_RESULT",
          result: {ok: false, error: String(error?.message || error), jobId: message.job?.job_id || null},
        }))
        .finally(() => {
          running = false;
        });
    });
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeServer = (value) => String(value || "").trim().replace(/\/+$/, "");

  function pageFor(item) {
    const locator = item?.locator && typeof item.locator === "object" ? item.locator : {};
    const declared = String(locator.page || locator.my_activity_page || "").trim();
    if (declared === "youtube_live_chat") return "youtube_live_chat";
    if (declared === "youtube_comments") return "youtube_comments";
    const kind = String(locator.youtube_activity_kind || "").toLowerCase();
    const title = String(locator.title || item?.title || "").trim();
    return kind === "live_chat" || title.startsWith("[실시간 채팅]")
      ? "youtube_live_chat"
      : "youtube_comments";
  }

  function pageUrl(page) {
    const url = new URL("https://myactivity.google.com/page");
    url.searchParams.set("page", page);
    url.searchParams.set("hl", "ko");
    url.searchParams.set("utm_medium", "web");
    url.searchParams.set("utm_source", "youtube");
    return url.href;
  }

  function waitForTabComplete(tabId, timeoutMs = 45000) {
    return new Promise(async (resolve, reject) => {
      const current = await chrome.tabs.get(tabId).catch(() => null);
      if (!current) {
        reject(new Error("삭제 탭을 찾을 수 없습니다."));
        return;
      }
      if (current.status === "complete") {
        resolve(current);
        return;
      }

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

  async function invoke(tabId, func, args = []) {
    const injected = await chrome.scripting.executeScript({
      target: {tabId},
      func,
      args,
    });
    return injected?.[0]?.result;
  }

  async function postResults(config, jobId, outcomes) {
    const response = await fetch(`${config.serverUrl}/api/deletion-jobs/batch/${encodeURIComponent(jobId)}/results`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.collectorToken}`,
      },
      body: JSON.stringify({
        items: outcomes.map((outcome) => ({
          item_id: outcome.item_id,
          status: outcome.ok ? "success" : "failed",
          reason: outcome.reason || null,
          diagnostics: outcome.diagnostics || {},
        })),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `서버 응답 ${response.status}`);
    }
    return payload;
  }

  async function runPage(tabId, pageItems, page, progress) {
    const initialized = await invoke(tabId, initializeBatchPageV4, [pageItems, page]);
    if (!initialized?.ok) {
      throw new Error(initialized?.error || "Google 내 활동 배치 삭제 엔진을 초기화하지 못했습니다.");
    }

    let stable = 0;
    let previousSignature = "";
    let noMove = 0;
    const maxSteps = 1600;

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const step = await invoke(tabId, batchPrimaryStepV4);
      if (!step?.ok) {
        throw new Error(step?.error || "Google 내 활동 배치 삭제 단계에 실패했습니다.");
      }

      if (step.action === "clicked") {
        let verified = false;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await sleep(attempt < 2 ? 120 : 180);
          const check = await invoke(tabId, batchCheckClickedV4, [step.item_id]);
          if (!check?.ok) break;
          if (check.status === "success") {
            verified = true;
            break;
          }
        }
        if (!verified) {
          await invoke(tabId, batchMarkForRescanV4, [step.item_id]);
        }
        progress();
        stable = 0;
        previousSignature = "";
        noMove = 0;
        await sleep(80);
        continue;
      }

      if (step.done) break;
      const signature = String(step.signature || "");
      stable = signature && signature === previousSignature ? stable + 1 : 0;
      previousSignature = signature;
      noMove = step.moved ? 0 : noMove + 1;
      if (stable >= 12 || noMove >= 12) break;
      await sleep(step.moved ? 130 : 320);
    }

    const verifyStart = await invoke(tabId, batchBeginRescanV4);
    if (verifyStart?.count > 0) {
      stable = 0;
      previousSignature = "";
      noMove = 0;
      for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
        const step = await invoke(tabId, batchRescanStepV4);
        if (!step?.ok || step.done) break;
        const signature = String(step.signature || "");
        stable = signature && signature === previousSignature ? stable + 1 : 0;
        previousSignature = signature;
        noMove = step.moved ? 0 : noMove + 1;
        if (stable >= 12 || noMove >= 12) break;
        await sleep(step.moved ? 130 : 320);
      }
      await invoke(tabId, batchFinishRescanV4);
    }

    const finalized = await invoke(tabId, batchFinalizeV4);
    if (!Array.isArray(finalized?.outcomes)) {
      throw new Error("Google 내 활동 배치 삭제 결과를 만들지 못했습니다.");
    }
    return finalized.outcomes;
  }

  async function runBatch(job, explicitConfig, port) {
    const items = Array.isArray(job?.items) ? job.items : [];
    if (!job?.job_id || !items.length || items.length > 100) {
      throw new Error("삭제 배치 작업 정보가 올바르지 않습니다.");
    }

    const config = {
      serverUrl: normalizeServer(explicitConfig?.serverUrl),
      collectorToken: String(explicitConfig?.collectorToken || ""),
    };
    if (!config.serverUrl || !config.collectorToken) {
      throw new Error("TraceLens 삭제 연결 정보가 없습니다. 삭제 페이지를 다시 여세요.");
    }

    const grouped = new Map();
    for (const item of items) {
      const page = pageFor(item);
      if (!grouped.has(page)) grouped.set(page, []);
      grouped.get(page).push(item);
    }

    const outcomes = [];
    let observed = 0;
    for (const [page, pageItems] of grouped) {
      port.postMessage({
        type: "DELETE_BATCH_PROGRESS",
        jobId: job.job_id,
        processed: observed,
        total: items.length,
        page,
        message: `${page === "youtube_live_chat" ? "실시간 채팅" : "댓글"} 페이지를 빠른 단계 방식으로 처리합니다.`,
      });

      let tab = null;
      try {
        tab = await chrome.tabs.create({url: pageUrl(page), active: false});
        await waitForTabComplete(tab.id);
        await sleep(550);
        const pageOutcomes = await runPage(tab.id, pageItems, page, () => {
          observed += 1;
          try {
            port.postMessage({
              type: "DELETE_BATCH_PROGRESS",
              jobId: job.job_id,
              processed: Math.min(observed, items.length),
              total: items.length,
              page,
              message: `${Math.min(observed, items.length)}/${items.length}건 삭제·검증 중`,
            });
          } catch {
            // UI disconnect handler cancels the job and refunds reserved credits.
          }
        });
        outcomes.push(...pageOutcomes);
      } catch (error) {
        const reason = String(error?.message || error);
        for (const item of pageItems) {
          outcomes.push({
            item_id: item.item_id,
            ok: false,
            reason,
            diagnostics: {stage: "page", expected_page: page},
          });
        }
      } finally {
        if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => undefined);
      }
    }

    const byItem = new Map(outcomes.map((outcome) => [Number(outcome.item_id), outcome]));
    const completeOutcomes = items.map((item) => byItem.get(Number(item.item_id)) || ({
      item_id: item.item_id,
      ok: false,
      reason: "삭제 결과가 누락되었습니다.",
      diagnostics: {stage: "result_missing"},
    }));

    let server;
    try {
      server = await postResults(config, job.job_id, completeOutcomes);
    } catch (error) {
      return {
        ok: false,
        externalDeletedCount: completeOutcomes.filter((outcome) => outcome.ok).length,
        jobId: job.job_id,
        outcomes: completeOutcomes,
        error: `삭제 결과 저장 실패: ${String(error?.message || error)}`,
      };
    }

    return {
      ok: server.status === "success" || server.status === "partial",
      jobId: job.job_id,
      outcomes: completeOutcomes,
      server,
      successfulCount: Number(server.successful_count || 0),
      failedCount: Number(server.failed_count || 0),
    };
  }

  function initializeBatchPageV4(items, expectedPage) {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const fnv = (value) => {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    };
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const decodeValues = (raw) => {
      const queue = [String(raw || "")];
      const output = [];
      const seen = new Set();
      while (queue.length && output.length < 36) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        output.push(current);
        const unescaped = current
          .replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&")
          .replace(/\\u003f/gi, "?").replace(/\\u002f/gi, "/")
          .replace(/\\x3d/gi, "=").replace(/\\x26/gi, "&")
          .replace(/\\x2f/gi, "/").replace(/\\\//g, "/");
        if (!seen.has(unescaped)) queue.push(unescaped);
        try {
          const decoded = decodeURIComponent(unescaped);
          if (!seen.has(decoded)) queue.push(decoded);
        } catch {
          // Google attributes may contain incomplete percent encoding.
        }
      }
      return output;
    };
    const sourceKeys = (raw) => {
      const keys = new Set();
      for (const value of decodeValues(raw)) {
        for (const match of value.matchAll(/(?:youtube\.com)?\/post\/([A-Za-z0-9_-]{10,160})/gi)) keys.add(`post:${match[1]}`);
        for (const match of value.matchAll(/[?&]v=([A-Za-z0-9_-]{6,20})/gi)) keys.add(`video:${match[1]}`);
        for (const match of value.matchAll(/\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{6,20})/gi)) keys.add(`video:${match[1]}`);
        for (const match of value.matchAll(/youtu\.be\/([A-Za-z0-9_-]{6,20})/gi)) keys.add(`video:${match[1]}`);
      }
      return keys;
    };

    const actualPage = new URL(location.href).searchParams.get("page");
    if (location.hostname !== "myactivity.google.com" || actualPage !== expectedPage) {
      return {ok: false, error: `Google 내 활동의 ${expectedPage} 페이지가 아닙니다.`};
    }

    const targets = new Map(items.map((item) => {
      const locator = item?.locator && typeof item.locator === "object" ? item.locator : {};
      const content = clean(locator.content || item.content || "");
      const sourceType = clean(locator.source_type || "").toLowerCase();
      const sourceId = clean(locator.source_id || "");
      const target = {
        itemId: Number(item.item_id),
        contentNeedle: content.length > 300 ? content.slice(0, 300) : content,
        sourceKey: sourceType && sourceId ? `${sourceType}:${sourceId}` : "",
        rowDataId: String(locator.row_data_id || ""),
        rowJsdata: String(locator.row_jsdata || ""),
        rowVed: String(locator.row_data_ved || ""),
        rowHash: String(locator.row_text_hash || ""),
        status: "pending",
        ambiguity: 0,
        confirmed: false,
      };
      return [target.itemId, target];
    }));

    const deleteButtons = () => [...document.querySelectorAll("button,[role='button']")].filter((button) => {
      if (!visible(button)) return false;
      const label = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
      const text = clean(button.innerText || button.textContent);
      return /삭제|delete|remove|활동 삭제/i.test(label) || ["×", "✕", "X"].includes(text);
    });
    const rowForButton = (button) => {
      const direct = button.closest("[role='listitem'],article,li,div[data-id]");
      if (direct) return direct;
      let node = button.parentElement;
      for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
        const text = clean(node.innerText || node.textContent);
        if (text.length >= 3 && text.length <= 12000 && /YouTube/i.test(text)) return node;
      }
      return null;
    };
    const descriptor = (row, button = null) => {
      const text = clean(row.innerText || row.textContent);
      return {
        row,
        button,
        text,
        hash: fnv(text),
        dataId: String(row.getAttribute("data-id") || ""),
        jsdata: String(row.getAttribute("jsdata") || ""),
        ved: String(row.getAttribute("data-ved") || ""),
        sources: sourceKeys(`${row.outerHTML || ""} ${[...row.querySelectorAll("a[href]")].map((anchor) => anchor.href).join(" ")}`),
      };
    };
    const stableMatch = (target, desc) => Boolean(
      (target.rowDataId && target.rowDataId === desc.dataId)
      || (target.rowJsdata && target.rowJsdata === desc.jsdata)
      || (target.rowVed && target.rowVed === desc.ved)
      || (target.rowHash && target.rowHash === desc.hash)
    );
    const matchesTarget = (target, desc) => {
      if (!target.contentNeedle || !desc.text.includes(target.contentNeedle)) return false;
      if (target.sourceKey) return desc.sources.has(target.sourceKey);
      return stableMatch(target, desc);
    };
    const rows = () => {
      const result = [];
      for (const button of deleteButtons()) {
        const row = rowForButton(button);
        if (row) result.push(descriptor(row, button));
      }
      return result;
    };
    const confirmDialog = () => {
      const dialogs = [...document.querySelectorAll("[role='dialog'],dialog")].filter(visible);
      for (const dialog of dialogs) {
        if (!/삭제|delete|remove/i.test(clean(dialog.innerText || dialog.textContent))) continue;
        const actions = [...dialog.querySelectorAll("button,[role='button']")]
          .filter(visible)
          .map((button) => ({
            button,
            label: clean(`${button.innerText || button.textContent || ""} ${button.getAttribute("aria-label") || ""}`),
          }));
        const explicit = actions.find(({label}) => (
          /삭제|delete|remove|확인|confirm|yes|예/i.test(label)
          && !/취소|cancel|아니오|no/i.test(label)
        ));
        if (explicit) return explicit.button;
        const nonCancel = actions.filter(({label}) => !/취소|cancel|아니오|no|닫기|close/i.test(label));
        if (actions.length >= 2 && nonCancel.length === 1) return nonCancel[0].button;
      }
      return null;
    };
    const scrollers = () => {
      const doc = document.scrollingElement || document.documentElement;
      return [doc, document.documentElement, document.body, ...document.querySelectorAll("main,c-wiz,section,div")]
        .filter(Boolean)
        .filter((node, index, all) => all.indexOf(node) === index)
        .filter((node) => node === doc || node.scrollHeight > node.clientHeight + 40)
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))
        .slice(0, 8);
    };
    const reset = () => {
      const doc = document.scrollingElement || document.documentElement;
      window.scrollTo(0, 0);
      doc.scrollTop = 0;
      for (const node of scrollers()) node.scrollTop = 0;
    };
    const moveDown = () => {
      let moved = false;
      for (const node of scrollers()) {
        const before = node.scrollTop || 0;
        const bottom = Math.max(0, node.scrollHeight - node.clientHeight);
        const amount = Math.max(480, Math.floor((node.clientHeight || innerHeight) * 0.88));
        node.scrollTop = Math.min(bottom, before + amount);
        node.dispatchEvent(new Event("scroll", {bubbles: true}));
        if ((node.scrollTop || 0) !== before) moved = true;
      }
      const doc = document.scrollingElement || document.documentElement;
      window.scrollTo(0, doc.scrollTop || 0);
      return moved;
    };
    const signature = () => scrollers()
      .map((node) => `${Math.round(node.scrollTop || 0)}:${Math.round(node.scrollHeight || 0)}`)
      .join("|");
    const endReached = () => /더 이상 표시할 콘텐츠가 없습니다|no more content/i.test(clean(document.body?.innerText || ""));

    reset();
    globalThis.__TRACELENS_DELETE_BATCH_V4 = {
      expectedPage,
      targets,
      outcomes: new Map(),
      verifyIds: [],
      verifyPresent: new Set(),
      verifyEndSeen: 0,
      rows,
      stableMatch,
      matchesTarget,
      confirmDialog,
      moveDown,
      reset,
      signature,
      endReached,
    };
    return {ok: true, count: targets.size};
  }

  function batchPrimaryStepV4() {
    const state = globalThis.__TRACELENS_DELETE_BATCH_V4;
    if (!state) return {ok: false, error: "배치 삭제 상태가 없습니다."};
    const pending = [...state.targets.values()].filter((target) => target.status === "pending");
    if (!pending.length) return {ok: true, done: true};

    for (const desc of state.rows()) {
      const matches = pending.filter((target) => state.matchesTarget(target, desc));
      if (!matches.length) continue;
      let chosen = null;
      if (matches.length === 1) {
        chosen = matches[0];
      } else {
        const exact = matches.filter((target) => state.stableMatch(target, desc));
        if (exact.length === 1) chosen = exact[0];
        else matches.forEach((target) => { target.ambiguity += 1; });
      }
      if (!chosen) continue;

      chosen.status = "clicked";
      chosen.clickedHash = desc.hash;
      chosen.clickedDataId = desc.dataId;
      chosen.clickedJsdata = desc.jsdata;
      chosen.clickedVed = desc.ved;
      desc.button.click();
      return {ok: true, action: "clicked", item_id: chosen.itemId};
    }

    const end = state.endReached();
    const moved = end ? false : state.moveDown();
    return {
      ok: true,
      action: "scrolled",
      moved,
      done: end,
      signature: state.signature(),
    };
  }

  function batchCheckClickedV4(itemId) {
    const state = globalThis.__TRACELENS_DELETE_BATCH_V4;
    const target = state?.targets.get(Number(itemId));
    if (!state || !target) return {ok: false, error: "삭제 대상을 찾을 수 없습니다."};

    const confirm = state.confirmDialog();
    if (confirm) {
      confirm.click();
      target.confirmed = true;
      return {ok: true, status: "pending", confirmed: true};
    }

    const stillVisible = state.rows().some((desc) => state.matchesTarget(target, desc));
    if (!stillVisible) {
      target.status = "success";
      state.outcomes.set(target.itemId, {
        item_id: target.itemId,
        ok: true,
        diagnostics: {
          stage: "viewport_absent_fast",
          expected_page: state.expectedPage,
          confirmed: Boolean(target.confirmed),
          source_key: target.sourceKey || null,
        },
      });
      return {ok: true, status: "success"};
    }
    return {ok: true, status: "pending"};
  }

  function batchMarkForRescanV4(itemId) {
    const state = globalThis.__TRACELENS_DELETE_BATCH_V4;
    const target = state?.targets.get(Number(itemId));
    if (!state || !target) return {ok: false};
    target.status = "verify";
    return {ok: true};
  }

  function batchBeginRescanV4() {
    const state = globalThis.__TRACELENS_DELETE_BATCH_V4;
    if (!state) return {ok: false, count: 0};
    state.verifyIds = [...state.targets.values()]
      .filter((target) => target.status === "verify")
      .map((target) => target.itemId);
    state.verifyPresent = new Set();
    state.verifyEndSeen = 0;
    state.reset();
    return {ok: true, count: state.verifyIds.length};
  }

  function batchRescanStepV4() {
    const state = globalThis.__TRACELENS_DELETE_BATCH_V4;
    if (!state) return {ok: false, done: true};
    const verifyTargets = state.verifyIds.map((id) => state.targets.get(id)).filter(Boolean);
    for (const desc of state.rows()) {
      for (const target of verifyTargets) {
        if (!state.verifyPresent.has(target.itemId) && state.matchesTarget(target, desc)) {
          state.verifyPresent.add(target.itemId);
        }
      }
    }
    if (state.verifyPresent.size === verifyTargets.length) return {ok: true, done: true};

    const end = state.endReached();
    state.verifyEndSeen = end ? state.verifyEndSeen + 1 : 0;
    const done = state.verifyEndSeen >= 2;
    const moved = done ? false : state.moveDown();
    return {ok: true, done, moved, signature: state.signature()};
  }

  function batchFinishRescanV4() {
    const state = globalThis.__TRACELENS_DELETE_BATCH_V4;
    if (!state) return {ok: false};
    for (const itemId of state.verifyIds) {
      const target = state.targets.get(itemId);
      if (!target) continue;
      if (state.verifyPresent.has(itemId)) {
        target.status = "failed";
        state.outcomes.set(itemId, {
          item_id: itemId,
          ok: false,
          reason: "삭제 버튼을 눌렀지만 동일한 기록이 Google 내 활동에 남아 있습니다.",
          diagnostics: {
            stage: "verification_present",
            expected_page: state.expectedPage,
            confirmed: Boolean(target.confirmed),
            source_key: target.sourceKey || null,
          },
        });
      } else {
        target.status = "success";
        state.outcomes.set(itemId, {
          item_id: itemId,
          ok: true,
          diagnostics: {
            stage: "verified_absent_rescan_fast",
            expected_page: state.expectedPage,
            confirmed: Boolean(target.confirmed),
            source_key: target.sourceKey || null,
          },
        });
      }
    }
    return {ok: true};
  }

  function batchFinalizeV4() {
    const state = globalThis.__TRACELENS_DELETE_BATCH_V4;
    if (!state) return {ok: false, outcomes: []};
    for (const target of state.targets.values()) {
      if (state.outcomes.has(target.itemId)) continue;
      state.outcomes.set(target.itemId, {
        item_id: target.itemId,
        ok: false,
        reason: target.ambiguity
          ? "동일한 삭제 후보가 여러 개 발견되어 안전상 삭제하지 않았습니다."
          : "Google 내 활동에서 선택한 기록을 찾지 못했습니다.",
        diagnostics: {
          stage: target.ambiguity ? "ambiguous" : "not_found",
          ambiguity_count: target.ambiguity,
          expected_page: state.expectedPage,
          source_key: target.sourceKey || null,
        },
      });
    }
    return {
      ok: true,
      outcomes: [...state.targets.keys()].map((itemId) => state.outcomes.get(itemId)),
    };
  }
})();
