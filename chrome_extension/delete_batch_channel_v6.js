(() => {
  const PORT_NAME = "tracelens-delete-batch-v3";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeServer = (value) => String(value || "").trim().replace(/\/+$/, "");
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

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

  function descriptorFromJob(item) {
    const locator = item?.locator && typeof item.locator === "object" ? item.locator : {};
    const sourceType = clean(locator.source_type || "").toLowerCase();
    const sourceId = clean(locator.source_id || "");
    return {
      itemId: Number(item.item_id),
      content: clean(locator.content || item.content || ""),
      sourceKey: sourceType && sourceId ? `${sourceType}:${sourceId}` : "",
      rowDataId: String(locator.row_data_id || ""),
      rowJsdata: String(locator.row_jsdata || ""),
      rowVed: String(locator.row_data_ved || ""),
      rowHash: String(locator.row_text_hash || ""),
    };
  }

  function descriptorFromCollected(item) {
    const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
    const locator = metadata.deletion_locator && typeof metadata.deletion_locator === "object"
      ? metadata.deletion_locator
      : {};
    const sourceType = clean(locator.source_type || metadata.source_type || "").toLowerCase();
    const sourceId = clean(locator.source_id || metadata.source_id || "");
    return {
      content: clean(locator.content || item.content || ""),
      sourceKey: sourceType && sourceId ? `${sourceType}:${sourceId}` : "",
      rowDataId: String(locator.row_data_id || ""),
      rowJsdata: String(locator.row_jsdata || ""),
      rowVed: String(locator.row_data_ved || ""),
      rowHash: String(locator.row_text_hash || ""),
    };
  }

  function sameRecord(target, current) {
    if (!target.content || target.content !== current.content) return false;
    if (target.sourceKey) return target.sourceKey === current.sourceKey;
    return Boolean(
      (target.rowDataId && target.rowDataId === current.rowDataId)
      || (target.rowJsdata && target.rowJsdata === current.rowJsdata)
      || (target.rowVed && target.rowVed === current.rowVed)
      || (target.rowHash && target.rowHash === current.rowHash)
    );
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

  async function clickPageTargets(tabId, pageItems, page, onClick) {
    const initialized = await invoke(tabId, initializeBatchClickV6, [pageItems, page]);
    if (!initialized?.ok) {
      throw new Error(initialized?.error || "Google 내 활동 삭제 엔진을 초기화하지 못했습니다.");
    }

    let previousSignature = "";
    let stable = 0;
    let noMove = 0;
    for (let index = 0; index < 2200; index += 1) {
      const step = await invoke(tabId, batchClickStepV6);
      if (!step?.ok) throw new Error(step?.error || "삭제 단계 실행에 실패했습니다.");

      if (step.action === "clicked") {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await sleep(attempt < 2 ? 180 : 260);
          const confirmed = await invoke(tabId, batchConfirmStepV6);
          if (!confirmed?.dialog_present) break;
        }
        onClick();
        previousSignature = "";
        stable = 0;
        noMove = 0;
        await sleep(700);
        continue;
      }

      if (step.action === "load_more") {
        previousSignature = "";
        stable = 0;
        noMove = 0;
        await sleep(900);
        continue;
      }

      if (step.done) break;
      const signature = String(step.signature || "");
      stable = signature && signature === previousSignature ? stable + 1 : 0;
      previousSignature = signature;
      noMove = step.moved ? 0 : noMove + 1;
      if (stable >= 18 || noMove >= 18) break;
      await sleep(step.moved ? 170 : 420);
    }

    const state = await invoke(tabId, getBatchClickStateV6);
    if (!state?.ok) throw new Error("삭제 시도 결과를 확인하지 못했습니다.");
    return state;
  }

  async function reloadAndCollect(tabId, page) {
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    await sleep(900);
    const scope = page === "youtube_live_chat" ? "live_chat" : "comment";
    return runExtractor(tabId, "youtube", scope, "self_activity", null);
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
    let clickedCount = 0;
    for (const [page, pageItems] of grouped) {
      port.postMessage({
        type: "DELETE_BATCH_PROGRESS",
        jobId: job.job_id,
        processed: clickedCount,
        total: items.length,
        page,
        message: `${page === "youtube_live_chat" ? "실시간 채팅" : "댓글"} 삭제 대상을 찾고 있습니다.`,
      });

      let tab = null;
      try {
        tab = await chrome.tabs.create({url: pageUrl(page), active: false});
        await waitForTabComplete(tab.id);
        await sleep(700);

        const clickState = await clickPageTargets(tab.id, pageItems, page, () => {
          clickedCount += 1;
          try {
            port.postMessage({
              type: "DELETE_BATCH_PROGRESS",
              jobId: job.job_id,
              processed: Math.min(clickedCount, items.length),
              total: items.length,
              page,
              message: `${Math.min(clickedCount, items.length)}/${items.length}건 삭제 시도 · 실제 성공 여부는 새로고침 후 전체 재수집으로 확인`,
            });
          } catch {
            // The UI disconnect handler cancels and refunds the unfinished job.
          }
        });

        port.postMessage({
          type: "DELETE_BATCH_PROGRESS",
          jobId: job.job_id,
          processed: Math.min(clickedCount, items.length),
          total: items.length,
          page,
          message: "Google 내 활동 페이지를 새로고침하고 전체 기록을 다시 수집해 실제 삭제 여부를 확인합니다.",
        });

        const collected = await reloadAndCollect(tab.id, page);
        const complete = Boolean(collected?.snapshot_complete);
        const currentDescriptors = (collected?.items || []).map(descriptorFromCollected);
        const clickedIds = new Set((clickState.clicked_item_ids || []).map(Number));
        const unclicked = new Map((clickState.failures || []).map((failure) => [Number(failure.item_id), failure]));

        for (const item of pageItems) {
          const itemId = Number(item.item_id);
          const target = descriptorFromJob(item);
          if (!clickedIds.has(itemId)) {
            const failure = unclicked.get(itemId);
            outcomes.push({
              item_id: itemId,
              ok: false,
              reason: failure?.reason || "Google 내 활동에서 선택한 기록을 찾지 못했습니다.",
              diagnostics: failure?.diagnostics || {stage: "not_found", expected_page: page},
            });
            continue;
          }

          if (!complete) {
            outcomes.push({
              item_id: itemId,
              ok: false,
              reason: "삭제 버튼은 눌렀지만 새로고침 후 전체 재수집이 끝나지 않아 성공 처리하지 않았습니다.",
              diagnostics: {
                stage: "verification_incomplete",
                expected_page: page,
                snapshot_complete: false,
                collected_count: currentDescriptors.length,
              },
            });
            continue;
          }

          const stillPresent = currentDescriptors.some((current) => sameRecord(target, current));
          outcomes.push(stillPresent ? {
            item_id: itemId,
            ok: false,
            reason: "삭제 버튼을 눌렀지만 새로고침 후 전체 재수집에서도 동일한 기록이 확인됐습니다.",
            diagnostics: {
              stage: "verification_present",
              expected_page: page,
              snapshot_complete: true,
              collected_count: currentDescriptors.length,
            },
          } : {
            item_id: itemId,
            ok: true,
            diagnostics: {
              stage: "verified_absent_after_reload_collection",
              expected_page: page,
              snapshot_complete: true,
              collected_count: currentDescriptors.length,
            },
          });
        }
      } catch (error) {
        const reason = String(error?.message || error);
        for (const item of pageItems) {
          if (outcomes.some((outcome) => Number(outcome.item_id) === Number(item.item_id))) continue;
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

  function initializeBatchClickV6(items, expectedPage) {
    const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const fnv = (value) => {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
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
      const sourceType = cleanText(locator.source_type || "").toLowerCase();
      const sourceId = cleanText(locator.source_id || "");
      const target = {
        itemId: Number(item.item_id),
        content: cleanText(locator.content || item.content || ""),
        sourceKey: sourceType && sourceId ? `${sourceType}:${sourceId}` : "",
        rowDataId: String(locator.row_data_id || ""),
        rowJsdata: String(locator.row_jsdata || ""),
        rowVed: String(locator.row_data_ved || ""),
        rowHash: String(locator.row_text_hash || ""),
        status: "pending",
        ambiguity: 0,
      };
      return [target.itemId, target];
    }));

    const deleteButtons = () => [...document.querySelectorAll("button,[role='button']")].filter((button) => {
      if (!visible(button)) return false;
      const label = cleanText(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
      const text = cleanText(button.innerText || button.textContent);
      return /삭제|delete|remove|활동 삭제/i.test(label) || ["×", "✕", "X"].includes(text);
    });
    const rowForButton = (button) => {
      const direct = button.closest("[role='listitem'],article,li,div[data-id]");
      if (direct) return direct;
      let node = button.parentElement;
      for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
        const text = cleanText(node.innerText || node.textContent);
        if (text.length >= 3 && text.length <= 12000 && /YouTube/i.test(text)) return node;
      }
      return null;
    };
    const descriptor = (row, button = null) => {
      const text = cleanText(row.innerText || row.textContent);
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
    const matches = (target, desc) => {
      if (!target.content || !desc.text.includes(target.content)) return false;
      if (target.sourceKey) return desc.sources.has(target.sourceKey);
      return stableMatch(target, desc);
    };
    const rows = () => {
      const output = [];
      for (const button of deleteButtons()) {
        const row = rowForButton(button);
        if (row) output.push(descriptor(row, button));
      }
      return output;
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
    const moveDown = () => {
      let moved = false;
      for (const node of scrollers()) {
        const before = node.scrollTop || 0;
        const bottom = Math.max(0, node.scrollHeight - node.clientHeight);
        const amount = Math.max(460, Math.floor((node.clientHeight || innerHeight) * 0.82));
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
    const pageEnded = () => /더 이상 표시할 콘텐츠가 없습니다|no more content/i.test(cleanText(document.body?.innerText || ""));
    const loadMoreButton = () => [...document.querySelectorAll("button,[role='button']")].find((button) => {
      if (!visible(button)) return false;
      const text = cleanText(`${button.innerText || button.textContent || ""} ${button.getAttribute("aria-label") || ""}`);
      return /^(더 보기|더보기|더 불러오기|추가로 불러오기|load more|show more)$/i.test(text);
    }) || null;

    window.scrollTo(0, 0);
    for (const node of scrollers()) node.scrollTop = 0;
    globalThis.__TRACELENS_DELETE_BATCH_V6 = {
      expectedPage,
      targets,
      clicked: [],
      rows,
      matches,
      stableMatch,
      moveDown,
      signature,
      pageEnded,
      loadMoreButton,
    };
    return {ok: true, count: targets.size};
  }

  function batchClickStepV6() {
    const state = globalThis.__TRACELENS_DELETE_BATCH_V6;
    if (!state) return {ok: false, error: "삭제 상태가 없습니다."};
    const pending = [...state.targets.values()].filter((target) => target.status === "pending");
    if (!pending.length) return {ok: true, done: true};

    for (const desc of state.rows()) {
      const candidates = pending.filter((target) => state.matches(target, desc));
      if (!candidates.length) continue;
      let chosen = null;
      if (candidates.length === 1) {
        chosen = candidates[0];
      } else {
        const exact = candidates.filter((target) => state.stableMatch(target, desc));
        if (exact.length === 1) chosen = exact[0];
        else candidates.forEach((target) => { target.ambiguity += 1; });
      }
      if (!chosen) continue;

      chosen.status = "clicked";
      state.clicked.push(chosen.itemId);
      desc.button.click();
      return {ok: true, action: "clicked", item_id: chosen.itemId};
    }

    const loadMore = state.loadMoreButton();
    if (loadMore && state.pageEnded()) {
      loadMore.click();
      return {ok: true, action: "load_more", moved: false, done: false, signature: state.signature()};
    }
    if (state.pageEnded()) return {ok: true, action: "scrolled", moved: false, done: true, signature: state.signature()};
    return {ok: true, action: "scrolled", moved: state.moveDown(), done: false, signature: state.signature()};
  }

  function batchConfirmStepV6() {
    const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const dialogs = [...document.querySelectorAll("[role='dialog'],dialog")].filter(visible);
    for (const dialog of dialogs) {
      if (!/삭제|delete|remove/i.test(cleanText(dialog.innerText || dialog.textContent))) continue;
      const actions = [...dialog.querySelectorAll("button,[role='button']")]
        .filter(visible)
        .map((button) => ({
          button,
          label: cleanText(`${button.innerText || button.textContent || ""} ${button.getAttribute("aria-label") || ""}`),
        }));
      const confirm = actions.find(({label}) => (
        /삭제|delete|remove|확인|confirm|yes|예/i.test(label)
        && !/취소|cancel|아니오|no/i.test(label)
      ));
      if (confirm) {
        confirm.button.click();
        return {ok: true, dialog_present: true, confirmed: true};
      }
      return {ok: true, dialog_present: true, confirmed: false};
    }
    return {ok: true, dialog_present: false, confirmed: false};
  }

  function getBatchClickStateV6() {
    const state = globalThis.__TRACELENS_DELETE_BATCH_V6;
    if (!state) return {ok: false};
    const failures = [];
    for (const target of state.targets.values()) {
      if (target.status === "clicked") continue;
      failures.push({
        item_id: target.itemId,
        reason: target.ambiguity
          ? "동일한 삭제 후보가 여러 개 발견되어 안전상 삭제하지 않았습니다."
          : "Google 내 활동에서 선택한 기록을 찾지 못했습니다.",
        diagnostics: {
          stage: target.ambiguity ? "ambiguous" : "not_found",
          ambiguity_count: target.ambiguity,
          expected_page: state.expectedPage,
        },
      });
    }
    return {
      ok: true,
      clicked_item_ids: state.clicked,
      failures,
    };
  }
})();
