(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "DELETE_YOUTUBE_ACTIVITY") return false;
    resolveConfig(message.config)
      .then((config) => runDeletionJob(message.job, config))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ok: false, error: String(error?.message || error)}));
    return true;
  });

  async function resolveConfig(explicitConfig) {
    if (explicitConfig?.serverUrl && explicitConfig?.collectorToken) {
      return {
        serverUrl: normalizeServer(explicitConfig.serverUrl),
        collectorToken: explicitConfig.collectorToken,
      };
    }
    const stored = await chrome.storage.local.get(["serverUrl", "collectorToken"]);
    if (!stored.serverUrl || !stored.collectorToken) {
      throw new Error("TraceLens 웹사이트에 로그인한 뒤 삭제 페이지를 다시 여세요.");
    }
    return {
      serverUrl: normalizeServer(stored.serverUrl),
      collectorToken: stored.collectorToken,
    };
  }

  function normalizeServer(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function deletionPageFor(item) {
    const locator = item?.locator && typeof item.locator === "object" ? item.locator : {};
    const declared = String(
      locator.page
      || locator.my_activity_page
      || locator.youtube_activity_page
      || ""
    ).trim();
    if (declared === "youtube_live_chat") return "youtube_live_chat";
    if (declared === "youtube_comments") return "youtube_comments";

    const kind = String(locator.youtube_activity_kind || "").trim().toLowerCase();
    const title = String(locator.title || item?.title || "").trim();
    if (kind === "live_chat" || title.startsWith("[실시간 채팅]")) {
      return "youtube_live_chat";
    }
    return "youtube_comments";
  }

  function deletionPageUrl(page) {
    const url = new URL("https://myactivity.google.com/page");
    url.searchParams.set("page", page);
    url.searchParams.set("hl", "ko");
    url.searchParams.set("utm_medium", "web");
    url.searchParams.set("utm_source", "youtube");
    return url.href;
  }

  function waitForTabComplete(tabId, timeoutMs = 40000) {
    return new Promise(async (resolve, reject) => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) {
        reject(new Error("삭제 탭을 찾을 수 없습니다."));
        return;
      }
      if (tab.status === "complete") {
        resolve(tab);
        return;
      }

      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("Google 내 활동 페이지 로딩 시간이 초과되었습니다."));
      }, timeoutMs);

      function listener(updatedTabId, changeInfo, updatedTab) {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(updatedTab);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  async function postResult(config, jobId, item, outcome) {
    const body = {
      items: [{
        item_id: item.item_id,
        status: outcome.ok ? "success" : "failed",
        reason: outcome.reason || null,
        diagnostics: outcome.diagnostics || {},
      }],
    };

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${config.serverUrl}/api/deletion-jobs/${encodeURIComponent(jobId)}/results`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.collectorToken}`,
          },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.detail || payload.error || `서버 응답 ${response.status}`);
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await sleep(900 * (attempt + 1));
      }
    }
    throw lastError || new Error("삭제 결과를 서버에 저장하지 못했습니다.");
  }

  async function runDeletionJob(job, config) {
    const items = Array.isArray(job?.items) ? job.items : [];
    if (!job?.job_id || items.length !== 1) {
      throw new Error("삭제 작업 정보가 올바르지 않습니다.");
    }

    const item = items[0];
    if (item.platform !== "youtube" || item.activity_type !== "comment") {
      throw new Error("현재는 YouTube 댓글 또는 실시간 채팅 한 건 삭제만 지원합니다.");
    }

    const expectedPage = deletionPageFor(item);
    let tab = null;
    let outcome = {
      ok: false,
      reason: "삭제 작업을 시작하지 못했습니다.",
      diagnostics: {stage: "start", expected_page: expectedPage},
    };

    try {
      tab = await chrome.tabs.create({url: deletionPageUrl(expectedPage), active: true});
      await waitForTabComplete(tab.id);
      await sleep(1800);

      const injected = await chrome.scripting.executeScript({
        target: {tabId: tab.id},
        func: deleteYouTubeActivity,
        args: [item, expectedPage],
      });
      outcome = injected?.[0]?.result || {
        ok: false,
        reason: "Google 내 활동에서 삭제 결과를 확인하지 못했습니다.",
        diagnostics: {stage: "injection", expected_page: expectedPage},
      };
    } catch (error) {
      outcome = {
        ok: false,
        reason: String(error?.message || error),
        diagnostics: {stage: "extension", expected_page: expectedPage},
      };
    }

    try {
      const server = await postResult(config, job.job_id, item, outcome);
      return {
        ok: Boolean(outcome.ok && server.status === "success"),
        externalDeleted: Boolean(outcome.ok),
        jobId: job.job_id,
        outcome,
        server,
        error: outcome.ok ? null : outcome.reason,
      };
    } catch (error) {
      return {
        ok: false,
        externalDeleted: Boolean(outcome.ok),
        jobId: job.job_id,
        outcome,
        error: `삭제 결과 저장 실패: ${String(error?.message || error)}`,
      };
    } finally {
      if (tab?.id) {
        await sleep(1000);
        await chrome.tabs.remove(tab.id).catch(() => undefined);
      }
    }
  }

  async function deleteYouTubeActivity(item, expectedPage) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
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
          // Serialized Google attributes often contain incomplete percent encoding.
        }
      }
      return output;
    };
    const sourceKeys = (raw) => {
      const keys = new Set();
      for (const value of decodeValues(raw)) {
        for (const match of value.matchAll(/(?:youtube\.com)?\/post\/([A-Za-z0-9_-]{10,160})/gi)) {
          keys.add(`post:${match[1]}`);
        }
        for (const match of value.matchAll(/[?&]v=([A-Za-z0-9_-]{6,20})/gi)) {
          keys.add(`video:${match[1]}`);
        }
        for (const match of value.matchAll(/\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{6,20})/gi)) {
          keys.add(`video:${match[1]}`);
        }
        for (const match of value.matchAll(/youtu\.be\/([A-Za-z0-9_-]{6,20})/gi)) {
          keys.add(`video:${match[1]}`);
        }
      }
      return keys;
    };

    const page = new URL(location.href).searchParams.get("page");
    if (location.hostname !== "myactivity.google.com" || page !== expectedPage) {
      return {
        ok: false,
        reason: `Google 내 활동의 ${expectedPage} 페이지가 아닙니다.`,
        diagnostics: {stage: "page", url: location.href, expected_page: expectedPage, actual_page: page},
      };
    }
    if (
      document.querySelector("input[type='password']")
      || /(로그인|sign in).{0,80}(비밀번호|password|계정|account)/i.test(clean(document.body?.innerText).slice(0, 1800))
    ) {
      return {
        ok: false,
        reason: "현재 Chrome 프로필에서 Google 로그인 상태를 확인하지 못했습니다.",
        diagnostics: {stage: "login", expected_page: expectedPage},
      };
    }

    const locator = item?.locator && typeof item.locator === "object" ? item.locator : {};
    const expectedContent = clean(locator.content || item.content || "");
    const expectedTitle = clean(locator.title || item.title || "").replace(/^\[실시간 채팅\]\s*/, "");
    const expectedSourceType = clean(locator.source_type || "").toLowerCase();
    const expectedSourceId = clean(locator.source_id || "");
    const expectedSourceKey = expectedSourceType && expectedSourceId
      ? `${expectedSourceType}:${expectedSourceId}`
      : "";
    const expectedRowId = String(locator.row_data_id || "");
    const expectedJsdata = String(locator.row_jsdata || "");
    const expectedVed = String(locator.row_data_ved || "");
    const expectedRowHash = String(locator.row_text_hash || "");
    const contentNeedle = expectedContent.length > 300 ? expectedContent.slice(0, 300) : expectedContent;
    const activityLabel = expectedPage === "youtube_live_chat" ? "실시간 채팅" : "댓글";

    if (!contentNeedle) {
      return {
        ok: false,
        reason: `삭제 대상 ${activityLabel} 내용이 없습니다.`,
        diagnostics: {stage: "input", expected_page: expectedPage},
      };
    }

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
        if (text.length >= 3 && text.length <= 10000 && /YouTube/i.test(text)) return node;
      }
      return null;
    };
    const descriptorFor = (row, button) => {
      const rowText = clean(row.innerText || row.textContent);
      const rowHash = fnv(rowText);
      const rowDataId = String(row.getAttribute("data-id") || "");
      const rowJsdata = String(row.getAttribute("jsdata") || "");
      const rowVed = String(row.getAttribute("data-ved") || "");
      const sources = sourceKeys(`${row.outerHTML || ""} ${[...row.querySelectorAll("a[href]")].map((anchor) => anchor.href).join(" ")}`);
      const contentMatch = rowText.includes(contentNeedle);
      const titleMatch = Boolean(expectedTitle && rowText.includes(expectedTitle));
      const sourceMatch = Boolean(expectedSourceKey && sources.has(expectedSourceKey));
      const rowIdMatch = Boolean(expectedRowId && rowDataId === expectedRowId);
      const jsdataMatch = Boolean(expectedJsdata && rowJsdata === expectedJsdata);
      const vedMatch = Boolean(expectedVed && rowVed === expectedVed);
      const rowHashMatch = Boolean(expectedRowHash && rowHash === expectedRowHash);
      const stableMatch = rowIdMatch || jsdataMatch || vedMatch || rowHashMatch;
      const qualified = expectedSourceKey
        ? contentMatch && sourceMatch
        : contentMatch && stableMatch;
      let score = 0;
      if (contentMatch) score += 100;
      if (sourceMatch) score += 160;
      if (rowIdMatch) score += 120;
      if (jsdataMatch) score += 100;
      if (vedMatch) score += 80;
      if (rowHashMatch) score += 90;
      if (titleMatch) score += 25;
      const sourceList = [...sources].sort();
      const key = `${expectedSourceKey || sourceList.join(",")}|${rowHash}|${rowDataId}|${rowJsdata}|${rowVed}`;
      return {
        key,
        row,
        button,
        rowHash,
        rowDataId,
        rowJsdata,
        rowVed,
        sourceList,
        contentMatch,
        sourceMatch,
        rowHashMatch,
        rowIdMatch,
        jsdataMatch,
        vedMatch,
        qualified,
        score,
      };
    };
    const scrollers = () => {
      const nodes = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll("body *")]
        .filter(Boolean)
        .filter((node) => {
          const rect = node.getBoundingClientRect?.() || {height: 0};
          const style = getComputedStyle(node);
          return rect.height >= 250
            && node.scrollHeight > node.clientHeight + 100
            && /(auto|scroll)/.test(style.overflowY || "");
        });
      return [...new Set(nodes)].sort((left, right) => (
        (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight)
      ));
    };
    const resetScroll = () => {
      window.scrollTo(0, 0);
      for (const scroller of scrollers().slice(0, 4)) scroller.scrollTop = 0;
    };
    const moveDown = () => {
      let moved = false;
      for (const scroller of scrollers().slice(0, 4)) {
        const before = scroller.scrollTop;
        const amount = Math.max(600, Math.floor((scroller.clientHeight || innerHeight) * 0.82));
        scroller.scrollTop = Math.min(scroller.scrollHeight, before + amount);
        if (scroller.scrollTop !== before) moved = true;
      }
      if (!moved) window.scrollBy(0, Math.max(650, innerHeight * 0.82));
      return moved;
    };
    const collectCurrent = (map) => {
      for (const button of deleteButtons()) {
        const row = rowForButton(button);
        if (!row) continue;
        const descriptor = descriptorFor(row, button);
        if (descriptor.qualified && !map.has(descriptor.key)) {
          map.set(descriptor.key, {
            key: descriptor.key,
            rowHash: descriptor.rowHash,
            rowDataId: descriptor.rowDataId,
            rowJsdata: descriptor.rowJsdata,
            rowVed: descriptor.rowVed,
            sourceList: descriptor.sourceList,
            score: descriptor.score,
            rowHashMatch: descriptor.rowHashMatch,
            rowIdMatch: descriptor.rowIdMatch,
            jsdataMatch: descriptor.jsdataMatch,
            vedMatch: descriptor.vedMatch,
          });
        }
      }
    };
    const currentToast = () => clean(
      [...document.querySelectorAll("[role='status'],[role='alert'],tp-yt-paper-toast")]
        .filter(visible)
        .map((node) => node.innerText || node.textContent)
        .join(" ")
    );
    const deletionConfirmed = (target) => {
      const toast = currentToast();
      if (/삭제|deleted|removed/i.test(toast)) return "toast";
      if (!document.contains(target.row)) return "removed";
      return null;
    };
    const visibleDialogs = () => [...document.querySelectorAll("[role='dialog'],dialog")].filter(visible);
    const dialogActionInfo = (dialog) => [...dialog.querySelectorAll("button,[role='button']")]
      .filter(visible)
      .map((button) => ({
        button,
        label: clean(`${button.innerText || button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`),
      }));
    const confirmButtonFor = (dialog) => {
      const actions = dialogActionInfo(dialog);
      const explicit = actions.find(({label}) => (
        /삭제|delete|remove|확인|confirm|yes|예/i.test(label)
        && !/취소|cancel|아니오|no/i.test(label)
      ));
      if (explicit) return {button: explicit.button, labels: actions.map(({label}) => label)};
      const nonCancel = actions.filter(({label}) => !/취소|cancel|아니오|no|닫기|close/i.test(label));
      if (actions.length >= 2 && nonCancel.length === 1) {
        return {button: nonCancel[0].button, labels: actions.map(({label}) => label)};
      }
      return {button: null, labels: actions.map(({label}) => label)};
    };

    resetScroll();
    await wait(500);
    const candidates = new Map();
    let stable = 0;
    let previous = "";
    for (let step = 0; step < 500 && candidates.size < 20; step += 1) {
      collectCurrent(candidates);
      const active = scrollers().slice(0, 4);
      const signature = `${candidates.size}|${document.documentElement.scrollHeight}|${active.map((node) => `${node.scrollTop}:${node.scrollHeight}`).join(",")}`;
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable >= 16) break;
      moveDown();
      await wait(420);
    }

    const matches = [...candidates.values()].sort((left, right) => right.score - left.score);
    if (!matches.length) {
      resetScroll();
      return {
        ok: false,
        reason: `Google 내 활동의 ${activityLabel} 페이지에서 원문과 내용이 모두 일치하는 기록을 찾지 못했습니다.`,
        diagnostics: {
          stage: "diagnosis",
          candidate_count: 0,
          source_type: expectedSourceType || null,
          source_id: expectedSourceId || null,
          expected_page: expectedPage,
        },
      };
    }

    let selected = matches[0];
    if (matches.length > 1) {
      const stableExact = matches.filter((entry) => (
        entry.rowHashMatch || entry.rowIdMatch || entry.jsdataMatch || entry.vedMatch
      ));
      if (stableExact.length !== 1) {
        resetScroll();
        return {
          ok: false,
          reason: `동일한 삭제 후보가 ${matches.length}개 발견되어 안전상 삭제하지 않았습니다.`,
          diagnostics: {
            stage: "diagnosis",
            candidate_count: matches.length,
            stable_candidate_count: stableExact.length,
            expected_page: expectedPage,
          },
        };
      }
      selected = stableExact[0];
    }

    resetScroll();
    await wait(500);
    let target = null;
    stable = 0;
    previous = "";
    for (let step = 0; step < 500 && !target; step += 1) {
      for (const button of deleteButtons()) {
        const row = rowForButton(button);
        if (!row) continue;
        const descriptor = descriptorFor(row, button);
        const same = descriptor.key === selected.key
          || (
            descriptor.rowHash === selected.rowHash
            && descriptor.contentMatch
            && (!expectedSourceKey || descriptor.sourceMatch)
          );
        if (same) {
          target = descriptor;
          break;
        }
      }
      if (target) break;
      const active = scrollers().slice(0, 4);
      const signature = `${document.documentElement.scrollHeight}|${active.map((node) => `${node.scrollTop}:${node.scrollHeight}`).join(",")}`;
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable >= 16) break;
      moveDown();
      await wait(420);
    }

    if (!target) {
      resetScroll();
      return {
        ok: false,
        reason: `진단한 ${activityLabel} 행을 삭제 단계에서 다시 찾지 못했습니다.`,
        diagnostics: {
          stage: "refind",
          candidate_count: matches.length,
          selected_hash: selected.rowHash,
          expected_page: expectedPage,
        },
      };
    }

    target.row.scrollIntoView({block: "center"});
    await wait(450);
    target.button.click();

    let confirmClicked = false;
    let lastDialogLabels = [];
    for (let attempt = 0; attempt < 16; attempt += 1) {
      await wait(350);
      const verified = deletionConfirmed(target);
      if (verified) {
        return {
          ok: true,
          diagnostics: {
            stage: verified === "toast" ? "verified_toast" : "verified_removed",
            candidate_count: matches.length,
            source_type: expectedSourceType || null,
            source_id: expectedSourceId || null,
            selected_hash: selected.rowHash,
            expected_page: expectedPage,
            confirm_clicked: confirmClicked,
          },
        };
      }

      const dialog = visibleDialogs().find((node) => (
        /삭제|delete|remove/i.test(clean(node.innerText || node.textContent))
      ));
      if (!dialog || confirmClicked) continue;

      const confirm = confirmButtonFor(dialog);
      lastDialogLabels = confirm.labels;
      if (confirm.button) {
        confirm.button.click();
        confirmClicked = true;
      }
    }

    const blockingDialog = visibleDialogs().find((node) => (
      /삭제|delete|remove/i.test(clean(node.innerText || node.textContent))
    ));
    if (blockingDialog && !confirmClicked) {
      const info = confirmButtonFor(blockingDialog);
      return {
        ok: false,
        reason: "삭제 확인 창에서 확인 버튼을 찾지 못했습니다.",
        diagnostics: {
          stage: "confirm",
          candidate_count: matches.length,
          expected_page: expectedPage,
          dialog_actions: info.labels.length ? info.labels : lastDialogLabels,
        },
      };
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(500);
      const verified = deletionConfirmed(target);
      if (verified) {
        return {
          ok: true,
          diagnostics: {
            stage: verified === "toast" ? "verified_toast" : "verified_removed",
            candidate_count: matches.length,
            source_type: expectedSourceType || null,
            source_id: expectedSourceId || null,
            selected_hash: selected.rowHash,
            expected_page: expectedPage,
            confirm_clicked: confirmClicked,
          },
        };
      }
    }

    resetScroll();
    await wait(650);
    let stillExists = false;
    stable = 0;
    previous = "";
    for (let step = 0; step < 220 && !stillExists; step += 1) {
      for (const button of deleteButtons()) {
        const row = rowForButton(button);
        if (!row) continue;
        const descriptor = descriptorFor(row, button);
        if (
          descriptor.qualified
          && (descriptor.key === selected.key || descriptor.rowHash === selected.rowHash)
        ) {
          stillExists = true;
          break;
        }
      }
      if (stillExists) break;
      const active = scrollers().slice(0, 4);
      const signature = `${document.documentElement.scrollHeight}|${active.map((node) => `${node.scrollTop}:${node.scrollHeight}`).join(",")}`;
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable >= 14) break;
      moveDown();
      await wait(380);
    }
    resetScroll();

    if (stillExists) {
      return {
        ok: false,
        reason: `삭제 동작 후에도 동일한 ${activityLabel} 기록이 Google 내 활동에 남아 있습니다.`,
        diagnostics: {
          stage: "verification",
          candidate_count: matches.length,
          selected_hash: selected.rowHash,
          expected_page: expectedPage,
          confirm_clicked: confirmClicked,
        },
      };
    }

    return {
      ok: true,
      diagnostics: {
        stage: "verified_absent",
        candidate_count: matches.length,
        source_type: expectedSourceType || null,
        source_id: expectedSourceId || null,
        selected_hash: selected.rowHash,
        expected_page: expectedPage,
        confirm_clicked: confirmClicked,
      },
    };
  }
})();
