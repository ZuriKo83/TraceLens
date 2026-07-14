(() => {
  const PORT_NAME = "tracelens-delete-batch-v3";
  const MAX_ITEMS = 100;
  const MAX_ROUNDS = 2;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const normalizeServer = (value) => String(value || "").trim().replace(/\/+$/, "");

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
          result: {
            ok: false,
            jobId: message.job?.job_id || null,
            error: String(error?.message || error),
          },
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

  function sourceIdentity(locator = {}, sourceUrl = "") {
    const sourceType = clean(locator.source_type).toLowerCase();
    const sourceId = clean(locator.source_id);
    if (sourceType && sourceId) return `${sourceType}:${sourceId}`;

    const postId = clean(locator.post_id || locator.youtube_post_id);
    if (postId) return `post:${postId}`;
    const videoId = clean(locator.video_id);
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
      sourceKey: sourceIdentity(locator, item.source_url),
      rowDataId: String(locator.row_data_id || ""),
      rowJsdata: String(locator.row_jsdata || ""),
      rowVed: String(locator.row_data_ved || ""),
      rowHash: String(locator.row_text_hash || ""),
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
      sourceKey: sourceIdentity({...metadata, ...locator}, item.source_url),
    };
  }

  function fingerprint(descriptor) {
    return descriptor.sourceKey
      ? `${descriptor.sourceKey}\u0000${descriptor.content}`
      : `no-source\u0000${descriptor.title}\u0000${descriptor.content}`;
  }

  function countCollected(result) {
    const counts = new Map();
    for (const item of result?.items || []) {
      const key = fingerprint(collectedDescriptor(item));
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
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
    await chrome.windows.update(tab.windowId, {focused: true}).catch(() => undefined);
    await chrome.tabs.update(tabId, {active: true}).catch(() => undefined);
    await chrome.tabs.setZoom(tabId, 0.25).catch(() => undefined);
  }

  async function collectComplete(tabId, page, attempts = 2) {
    const scope = page === "youtube_live_chat" ? "live_chat" : "comment";
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await chrome.tabs.reload(tabId);
        await waitForTabComplete(tabId);
        await focusWorker(tabId);
        await sleep(1200);
      }
      last = await runExtractor(tabId, "youtube", scope, "self_activity", null);
      if (last?.snapshot_complete) return last;
    }
    return last;
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
    if (!response.ok) throw new Error(payload.detail || payload.error || `서버 응답 ${response.status}`);
    return payload;
  }

  async function executeTwoPass(tabId, items, page) {
    const injected = await chrome.scripting.executeScript({
      target: {tabId},
      func: scanThenDeleteV16,
      args: [items, page],
    });
    const result = injected?.[0]?.result;
    if (!result?.ok) throw new Error(result?.error || "삭제 위치 스캔 또는 클릭 실행에 실패했습니다.");
    return result;
  }

  async function createWorkerWindow(url) {
    const original = await chrome.windows.getLastFocused().catch(() => null);
    const width = 360;
    const height = 280;
    const left = original
      ? Math.max(0, Number(original.left || 0) + Number(original.width || width) - width - 16)
      : undefined;
    const top = original
      ? Math.max(0, Number(original.top || 0) + Number(original.height || height) - height - 48)
      : undefined;

    const workerWindow = await chrome.windows.create({
      url,
      type: "popup",
      focused: true,
      width,
      height,
      ...(Number.isFinite(left) ? {left} : {}),
      ...(Number.isFinite(top) ? {top} : {}),
    });
    const tab = workerWindow.tabs?.[0]
      || (await chrome.tabs.query({windowId: workerWindow.id, active: true}))[0];
    if (!tab?.id) throw new Error("삭제 작업용 작은 창을 만들지 못했습니다.");
    await waitForTabComplete(tab.id);
    await focusWorker(tab.id);
    await sleep(900);
    return {workerWindow, tab, originalWindowId: original?.id || null};
  }

  function groupByFingerprint(items) {
    const grouped = new Map();
    for (const item of items) {
      const descriptor = jobDescriptor(item);
      const key = fingerprint(descriptor);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(descriptor);
    }
    return grouped;
  }

  function classifyRound(items, scanResult, afterResult) {
    const grouped = groupByFingerprint(items);
    const afterCounts = countCollected(afterResult);
    const clicked = new Set((scanResult.clicked_item_ids || []).map(Number));
    const clickFailures = new Map((scanResult.failures || []).map((failure) => [Number(failure.item_id), failure]));
    const outcomes = new Map();
    const unresolvedIds = new Set();

    for (const [key, descriptors] of grouped) {
      const baselineCount = Number(scanResult.baseline_counts?.[key] || 0);
      const afterCount = Number(afterCounts.get(key) || 0);
      const selectedCount = descriptors.length;
      const absentBefore = Math.max(0, selectedCount - baselineCount);
      const removedCount = Math.max(0, baselineCount - afterCount);

      const ordered = [...descriptors].sort((left, right) => {
        const leftClicked = clicked.has(left.itemId) ? 0 : 1;
        const rightClicked = clicked.has(right.itemId) ? 0 : 1;
        if (leftClicked !== rightClicked) return leftClicked - rightClicked;
        return left.itemId - right.itemId;
      });

      let alreadyAbsentRemaining = absentBefore;
      let removedRemaining = removedCount;
      for (const descriptor of ordered) {
        const detail = {
          baseline_count: baselineCount,
          after_count: afterCount,
          removed_count: removedCount,
          selected_count: selectedCount,
          fingerprint_mode: descriptor.sourceKey ? "source_content_count" : "title_content_count",
        };

        if (!clicked.has(descriptor.itemId) && alreadyAbsentRemaining > 0) {
          alreadyAbsentRemaining -= 1;
          outcomes.set(descriptor.itemId, {
            item_id: descriptor.itemId,
            ok: true,
            diagnostics: {
              stage: "verified_absent_before_current_job",
              click_evidence: "verification_only_not_found",
              snapshot_complete: true,
              ...detail,
            },
          });
          continue;
        }

        if (clicked.has(descriptor.itemId) && removedRemaining > 0) {
          removedRemaining -= 1;
          outcomes.set(descriptor.itemId, {
            item_id: descriptor.itemId,
            ok: true,
            diagnostics: {
              stage: "verified_after_two_pass_delete",
              click_evidence: scanResult.evidence_by_item?.[String(descriptor.itemId)] || "row_removed_or_confirmed",
              snapshot_complete: true,
              ...detail,
            },
          });
          continue;
        }

        unresolvedIds.add(descriptor.itemId);
        const clickFailure = clickFailures.get(descriptor.itemId);
        outcomes.set(descriptor.itemId, {
          item_id: descriptor.itemId,
          ok: false,
          reason: clickFailure?.reason || "삭제 후 전체 재검사에서 동일한 기록 수가 줄지 않았습니다.",
          diagnostics: {
            ...(clickFailure?.diagnostics || {}),
            stage: clicked.has(descriptor.itemId)
              ? "verification_count_unchanged"
              : (clickFailure?.diagnostics?.stage || "not_found"),
            snapshot_complete: true,
            ...detail,
          },
        });
      }
    }

    return {outcomes, unresolvedIds};
  }

  async function processPage(page, pageItems, port, jobId, total, processedBefore) {
    const {workerWindow, tab, originalWindowId} = await createWorkerWindow(pageUrl(page));
    let currentItems = [...pageItems];
    const finalOutcomes = new Map();
    let processed = processedBefore;

    try {
      for (let round = 1; round <= MAX_ROUNDS && currentItems.length; round += 1) {
        await focusWorker(tab.id);
        port.postMessage({
          type: "DELETE_BATCH_PROGRESS",
          jobId,
          processed,
          total,
          page,
          message: round === 1
            ? `${page === "youtube_live_chat" ? "실시간 채팅" : "댓글"} 전체 목록을 먼저 훑어 삭제 위치를 저장합니다.`
            : `남은 ${currentItems.length}건의 위치를 다시 훑어 재시도합니다.`,
        });

        const scanResult = await executeTwoPass(tab.id, currentItems, page);
        processed += (scanResult.clicked_item_ids || []).length;

        port.postMessage({
          type: "DELETE_BATCH_PROGRESS",
          jobId,
          processed: Math.min(processed, total),
          total,
          page,
          message: `${scanResult.planned_count || 0}개 위치 확인 · 아래쪽 기록부터 삭제 완료 · Google 반영 대기 중`,
        });

        await sleep(round === 1 ? 2800 : 3800);
        await chrome.tabs.reload(tab.id);
        await waitForTabComplete(tab.id);
        await focusWorker(tab.id);
        await sleep(1400);

        const afterResult = await collectComplete(tab.id, page, 2);
        if (!afterResult?.snapshot_complete) {
          for (const item of currentItems) {
            finalOutcomes.set(Number(item.item_id), {
              item_id: Number(item.item_id),
              ok: false,
              reason: "삭제 후 Google 내 활동 전체 목록 재검사를 완료하지 못했습니다.",
              diagnostics: {stage: "verification_incomplete", expected_page: page},
            });
          }
          currentItems = [];
          break;
        }

        const classified = classifyRound(currentItems, scanResult, afterResult);
        for (const [itemId, outcome] of classified.outcomes) finalOutcomes.set(itemId, outcome);

        const unresolved = classified.unresolvedIds;
        if (!unresolved.size || round >= MAX_ROUNDS) {
          currentItems = [];
          break;
        }

        currentItems = currentItems.filter((item) => unresolved.has(Number(item.item_id)));
        await chrome.tabs.reload(tab.id);
        await waitForTabComplete(tab.id);
        await focusWorker(tab.id);
        await sleep(1200);
      }
    } finally {
      await chrome.windows.remove(workerWindow.id).catch(() => undefined);
      if (originalWindowId) {
        await chrome.windows.update(originalWindowId, {focused: true}).catch(() => undefined);
      }
    }

    return {
      outcomes: pageItems.map((item) => finalOutcomes.get(Number(item.item_id)) || ({
        item_id: Number(item.item_id),
        ok: false,
        reason: "삭제 결과가 누락되었습니다.",
        diagnostics: {stage: "result_missing", expected_page: page},
      })),
      processed,
    };
  }

  async function runBatch(job, explicitConfig, port) {
    const items = Array.isArray(job?.items) ? job.items : [];
    if (!job?.job_id || !items.length || items.length > MAX_ITEMS) {
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
    let processed = 0;
    for (const [page, pageItems] of grouped) {
      try {
        const result = await processPage(page, pageItems, port, job.job_id, items.length, processed);
        outcomes.push(...result.outcomes);
        processed = result.processed;
      } catch (error) {
        const reason = String(error?.message || error);
        outcomes.push(...pageItems.map((item) => ({
          item_id: Number(item.item_id),
          ok: false,
          reason,
          diagnostics: {stage: "page", expected_page: page},
        })));
      }
    }

    const server = await postResults(config, job.job_id, outcomes);
    return {
      ok: server.status === "success" || server.status === "partial",
      jobId: job.job_id,
      outcomes,
      server,
      successfulCount: Number(server.successful_count || 0),
      failedCount: Number(server.failed_count || 0),
    };
  }

  async function scanThenDeleteV16(items, expectedPage) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
          // Ignore incomplete percent encoding in Google attributes.
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

    const targets = items.map((item) => {
      const locator = item?.locator && typeof item.locator === "object" ? item.locator : {};
      const sourceType = cleanText(locator.source_type || "").toLowerCase();
      const sourceId = cleanText(locator.source_id || "");
      const sourceKey = sourceType && sourceId ? `${sourceType}:${sourceId}` : "";
      const title = cleanText(locator.title || item.title || "");
      const content = cleanText(locator.content || item.content || "");
      return {
        itemId: Number(item.item_id),
        title,
        content,
        sourceKey,
        key: sourceKey ? `${sourceKey}\u0000${content}` : `no-source\u0000${title}\u0000${content}`,
        rowDataId: String(locator.row_data_id || ""),
        rowJsdata: String(locator.row_jsdata || ""),
        rowVed: String(locator.row_data_ved || ""),
        rowHash: String(locator.row_text_hash || ""),
      };
    });

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
    const rowDescriptor = (row, button = null) => {
      const text = cleanText(row.innerText || row.textContent);
      const rect = row.getBoundingClientRect();
      return {
        row,
        button,
        text,
        docY: Math.max(0, window.scrollY + rect.top),
        hash: fnv(text),
        dataId: String(row.getAttribute("data-id") || ""),
        jsdata: String(row.getAttribute("jsdata") || ""),
        ved: String(row.getAttribute("data-ved") || ""),
        sources: sourceKeys(`${row.outerHTML || ""} ${[...row.querySelectorAll("a[href]")].map((anchor) => anchor.href).join(" ")}`),
      };
    };
    const rowMatchesTarget = (desc, target) => {
      if (!target.content || !desc.text.includes(target.content)) return false;
      if (target.sourceKey) return desc.sources.has(target.sourceKey);
      if (target.title && !desc.text.includes(target.title)) return false;
      return true;
    };
    const stableScore = (desc, target) => {
      let score = 0;
      if (target.rowDataId && target.rowDataId === desc.dataId) score += 8;
      if (target.rowJsdata && target.rowJsdata === desc.jsdata) score += 6;
      if (target.rowVed && target.rowVed === desc.ved) score += 4;
      if (target.rowHash && target.rowHash === desc.hash) score += 3;
      return score;
    };
    const visibleRows = () => deleteButtons().map((button) => {
      const row = rowForButton(button);
      return row ? rowDescriptor(row, button) : null;
    }).filter(Boolean);
    const scrollers = () => {
      const doc = document.scrollingElement || document.documentElement;
      return [doc, document.documentElement, document.body, ...document.querySelectorAll("main,c-wiz,section,div")]
        .filter(Boolean)
        .filter((node, index, all) => all.indexOf(node) === index)
        .filter((node) => node === doc || node.scrollHeight > node.clientHeight + 40)
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))
        .slice(0, 8);
    };
    const resetTop = () => {
      window.scrollTo(0, 0);
      for (const node of scrollers()) node.scrollTop = 0;
    };
    const moveDown = () => {
      let moved = false;
      for (const node of scrollers()) {
        const before = node.scrollTop || 0;
        const bottom = Math.max(0, node.scrollHeight - node.clientHeight);
        node.scrollTop = Math.min(bottom, before + Math.max(620, Math.floor((node.clientHeight || innerHeight) * 0.9)));
        node.dispatchEvent(new Event("scroll", {bubbles: true}));
        if ((node.scrollTop || 0) !== before) moved = true;
      }
      return moved;
    };
    const signature = () => scrollers().map((node) => `${Math.round(node.scrollTop || 0)}:${Math.round(node.scrollHeight || 0)}`).join("|");
    const endMarkerVisible = () => [...document.querySelectorAll("body *")].some((node) => {
      if (!visible(node)) return false;
      const text = cleanText(node.textContent || "");
      return text === "더 이상 표시할 콘텐츠가 없습니다." || /no more content/i.test(text);
    });
    const loadMoreButton = () => [...document.querySelectorAll("button,[role='button']")].find((button) => {
      if (!visible(button)) return false;
      const text = cleanText(`${button.innerText || button.textContent || ""} ${button.getAttribute("aria-label") || ""}`);
      return /^(더 보기|더보기|더 불러오기|추가로 불러오기|load more|show more)$/i.test(text);
    }) || null;
    const clickLikeUser = (node) => {
      node.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true}));
      node.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, button: 0}));
      node.dispatchEvent(new PointerEvent("pointerup", {bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true}));
      node.dispatchEvent(new MouseEvent("mouseup", {bubbles: true, cancelable: true, button: 0}));
      node.click();
    };
    const toastText = () => cleanText([...document.querySelectorAll("[role='status'],[role='alert'],tp-yt-paper-toast")]
      .filter(visible).map((node) => node.innerText || node.textContent).join(" "));
    const confirmDialog = () => {
      const dialogs = [...document.querySelectorAll("[role='dialog'],[role='alertdialog'],dialog,[aria-modal='true']")].filter(visible);
      for (const dialog of dialogs) {
        const text = cleanText(dialog.innerText || dialog.textContent);
        if (!/삭제|delete|remove/i.test(text)) continue;
        const actions = [...dialog.querySelectorAll("button,[role='button']")]
          .filter(visible)
          .map((button) => ({
            button,
            label: cleanText(`${button.innerText || button.textContent || ""} ${button.getAttribute("aria-label") || ""}`),
          }));
        const explicit = actions.find(({label}) => /삭제|delete|remove|확인|confirm|yes|예/i.test(label)
          && !/취소|cancel|아니오|no|닫기|close/i.test(label));
        if (explicit) return explicit.button;
        const nonCancel = actions.filter(({label}) => !/취소|cancel|아니오|no|닫기|close/i.test(label));
        if (actions.length >= 2 && nonCancel.length === 1) return nonCancel[0].button;
      }
      return null;
    };

    // Pass 1: scroll the complete page and remember candidate coordinates.
    const candidatesByKey = new Map();
    const seenCandidateKeys = new Set();
    resetTop();
    await wait(500);
    let previousSignature = "";
    let stable = 0;
    let complete = false;

    for (let step = 0; step < 2600; step += 1) {
      for (const desc of visibleRows()) {
        for (const target of targets) {
          if (!rowMatchesTarget(desc, target)) continue;
          const candidateKey = `${target.key}\u0000${Math.round(desc.docY)}\u0000${desc.hash}\u0000${desc.dataId}`;
          if (seenCandidateKeys.has(candidateKey)) continue;
          seenCandidateKeys.add(candidateKey);
          if (!candidatesByKey.has(target.key)) candidatesByKey.set(target.key, []);
          candidatesByKey.get(target.key).push({
            docY: desc.docY,
            dataId: desc.dataId,
            jsdata: desc.jsdata,
            ved: desc.ved,
            hash: desc.hash,
            score: stableScore(desc, target),
          });
        }
      }

      const more = loadMoreButton();
      if (endMarkerVisible() && !more) {
        complete = true;
        break;
      }
      if (more && endMarkerVisible()) {
        clickLikeUser(more);
        previousSignature = "";
        stable = 0;
        await wait(800);
        continue;
      }

      const moved = moveDown();
      const current = signature();
      stable = current === previousSignature ? stable + 1 : 0;
      previousSignature = current;
      if (!moved && stable >= 18) break;
      await wait(moved ? 120 : 320);
    }

    if (!complete) {
      return {
        ok: true,
        planned_count: 0,
        clicked_item_ids: [],
        failures: targets.map((target) => ({
          item_id: target.itemId,
          reason: "삭제 전 전체 목록 스캔을 완료하지 못해 삭제하지 않았습니다.",
          diagnostics: {stage: "scan_incomplete", expected_page: expectedPage},
        })),
        baseline_counts: {},
        evidence_by_item: {},
      };
    }

    const baselineCounts = {};
    const plans = [];
    const failures = [];
    const groupedTargets = new Map();
    for (const target of targets) {
      if (!groupedTargets.has(target.key)) groupedTargets.set(target.key, []);
      groupedTargets.get(target.key).push(target);
    }

    for (const [key, group] of groupedTargets) {
      const candidates = [...(candidatesByKey.get(key) || [])]
        .sort((left, right) => right.score - left.score || left.docY - right.docY);
      baselineCounts[key] = candidates.length;
      const unused = [...candidates];

      for (const target of group) {
        let index = unused.findIndex((candidate) => candidate.score > 0);
        if (index < 0) index = 0;
        const candidate = unused.splice(index, 1)[0];
        if (!candidate) {
          failures.push({
            item_id: target.itemId,
            reason: "전체 목록을 훑었지만 선택한 기록과 짝지을 삭제 위치를 찾지 못했습니다.",
            diagnostics: {stage: "not_found_after_full_scan", expected_page: expectedPage},
          });
          continue;
        }
        plans.push({target, candidate});
      }
    }

    // Pass 2: process from bottom to top so deleting a row does not shift
    // the saved positions of rows that are still above it.
    plans.sort((left, right) => right.candidate.docY - left.candidate.docY);
    const clicked = [];
    const evidenceByItem = {};

    for (const plan of plans) {
      const targetY = Math.max(0, plan.candidate.docY - Math.floor(innerHeight * 0.42));
      window.scrollTo(0, targetY);
      const doc = document.scrollingElement || document.documentElement;
      doc.scrollTop = targetY;
      doc.dispatchEvent(new Event("scroll", {bubbles: true}));
      await wait(450);

      const local = visibleRows().filter((desc) => rowMatchesTarget(desc, plan.target));
      local.sort((left, right) => {
        const leftStable = stableScore(left, plan.target);
        const rightStable = stableScore(right, plan.target);
        if (leftStable !== rightStable) return rightStable - leftStable;
        return Math.abs(left.docY - plan.candidate.docY) - Math.abs(right.docY - plan.candidate.docY);
      });
      const chosen = local[0];
      if (!chosen?.button) {
        failures.push({
          item_id: plan.target.itemId,
          reason: "저장한 위치로 이동했지만 해당 기록의 삭제 버튼을 다시 찾지 못했습니다.",
          diagnostics: {
            stage: "saved_position_miss",
            expected_page: expectedPage,
            saved_y: Math.round(plan.candidate.docY),
          },
        });
        continue;
      }

      chosen.row.scrollIntoView({block: "center"});
      await wait(180);
      clickLikeUser(chosen.button);

      let confirmClicked = false;
      let evidence = "";
      for (let attempt = 0; attempt < 18; attempt += 1) {
        await wait(attempt < 5 ? 180 : 260);
        if (!document.contains(chosen.row)) {
          evidence = "row_removed";
          break;
        }
        if (/삭제|deleted|removed/i.test(toastText())) {
          evidence = "toast";
          break;
        }
        const confirm = confirmDialog();
        if (confirm && !confirmClicked) {
          clickLikeUser(confirm);
          confirmClicked = true;
          continue;
        }
        if (!confirm && confirmClicked) {
          evidence = "confirm_closed";
          break;
        }
      }

      if (!evidence) {
        failures.push({
          item_id: plan.target.itemId,
          reason: "삭제 버튼과 확인 버튼을 눌렀지만 Google의 삭제 반영 신호를 확인하지 못했습니다.",
          diagnostics: {
            stage: "click_unconfirmed",
            expected_page: expectedPage,
            confirm_clicked: confirmClicked,
            saved_y: Math.round(plan.candidate.docY),
          },
        });
        continue;
      }

      clicked.push(plan.target.itemId);
      evidenceByItem[String(plan.target.itemId)] = evidence;
      await wait(850);
    }

    return {
      ok: true,
      planned_count: plans.length,
      clicked_item_ids: clicked,
      failures,
      baseline_counts: baselineCounts,
      evidence_by_item: evidenceByItem,
    };
  }
})();
