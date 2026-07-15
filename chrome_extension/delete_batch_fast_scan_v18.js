(() => {
  const previousExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);

  chrome.scripting.executeScript = async function(details, callback) {
    const nextDetails = details?.func?.name === "scanThenDeleteV16"
      ? {...details, func: scanThenDeleteV18}
      : details;
    const results = await previousExecuteScript(nextDetails);
    if (typeof callback === "function") callback(results);
    return results;
  };

  async function scanThenDeleteV18(items, expectedPage) {
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
    const sourceKeyFromItem = (item, locator) => {
      const sourceType = cleanText(locator.source_type || "").toLowerCase();
      const sourceId = cleanText(locator.source_id || "");
      if (sourceType && sourceId) return `${sourceType}:${sourceId}`;
      const postId = cleanText(locator.post_id || locator.youtube_post_id || "");
      if (postId) return `post:${postId}`;
      const videoId = cleanText(locator.video_id || "");
      if (videoId) return `video:${videoId}`;
      const keys = sourceKeys(`${locator.source_url || ""} ${item.source_url || ""}`);
      return keys.values().next().value || "";
    };
    const actualPage = new URL(location.href).searchParams.get("page");
    if (location.hostname !== "myactivity.google.com" || actualPage !== expectedPage) {
      return {ok: false, error: `Google 내 활동의 ${expectedPage} 페이지가 아닙니다.`};
    }

    const targets = items.map((item) => {
      const locator = item?.locator && typeof item.locator === "object" ? item.locator : {};
      const sourceKey = sourceKeyFromItem(item, locator);
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

    const waitForMutation = (timeoutMs = 650) => new Promise((resolve) => {
      let finished = false;
      const finish = (changed) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(changed);
      };
      const observer = new MutationObserver(() => finish(true));
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-busy", "style", "class"],
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
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
    const scrollCandidates = () => {
      const doc = document.scrollingElement || document.documentElement;
      return [doc, document.documentElement, document.body, ...document.querySelectorAll("main,c-wiz,section,div")]
        .filter(Boolean)
        .filter((node, index, all) => all.indexOf(node) === index)
        .filter((node) => node === doc || node.scrollHeight > node.clientHeight + 40)
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
    };
    const primaryScroller = () => scrollCandidates()[0] || document.scrollingElement || document.documentElement;
    const isDocumentScroller = (node) => node === document.scrollingElement || node === document.documentElement || node === document.body;
    const readTop = (node) => isDocumentScroller(node) ? (window.scrollY || document.documentElement.scrollTop || 0) : Number(node.scrollTop || 0);
    const readHeight = (node) => isDocumentScroller(node)
      ? Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
      : Number(node.scrollHeight || 0);
    const readViewport = (node) => isDocumentScroller(node) ? window.innerHeight : Number(node.clientHeight || window.innerHeight);
    const writeTop = (node, value) => {
      const next = Math.max(0, Number(value || 0));
      if (isDocumentScroller(node)) {
        window.scrollTo(0, next);
        document.documentElement.scrollTop = next;
        if (document.body) document.body.scrollTop = next;
      } else {
        node.scrollTop = next;
      }
      node.dispatchEvent(new Event("scroll", {bubbles: true}));
    };
    const rowPosition = (row, scroller) => {
      const rect = row.getBoundingClientRect();
      if (isDocumentScroller(scroller)) return Math.max(0, readTop(scroller) + rect.top);
      const scrollerRect = scroller.getBoundingClientRect();
      return Math.max(0, readTop(scroller) + rect.top - scrollerRect.top);
    };
    const rowDescriptor = (row, button, scroller) => {
      const text = cleanText(row.innerText || row.textContent);
      return {
        row,
        button,
        text,
        position: rowPosition(row, scroller),
        hash: fnv(text),
        dataId: String(row.getAttribute("data-id") || ""),
        jsdata: String(row.getAttribute("jsdata") || ""),
        ved: String(row.getAttribute("data-ved") || ""),
        sources: sourceKeys(`${row.outerHTML || ""} ${[...row.querySelectorAll("a[href]")].map((anchor) => anchor.href).join(" ")}`),
      };
    };
    const visibleRows = (scroller = primaryScroller()) => deleteButtons().map((button) => {
      const row = rowForButton(button);
      return row ? rowDescriptor(row, button, scroller) : null;
    }).filter(Boolean);
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
    const endMarkerVisible = () => [...document.querySelectorAll("body *")].some((node) => {
      if (!visible(node)) return false;
      const text = cleanText(node.textContent || "");
      return text === "더 이상 표시할 콘텐츠가 없습니다." || /^no more content[.!]?$/i.test(text);
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

    const candidatesByKey = new Map();
    const seenCandidates = new Set();
    let scroller = primaryScroller();
    writeTop(scroller, 0);
    await waitForMutation(350);
    let complete = false;
    let bottomStableRounds = 0;
    let previousBottomSignature = "";

    for (let step = 0; step < 360; step += 1) {
      scroller = primaryScroller();
      const rows = visibleRows(scroller);
      for (const desc of rows) {
        for (const target of targets) {
          if (!rowMatchesTarget(desc, target)) continue;
          const candidateKey = `${target.key}\u0000${Math.round(desc.position)}\u0000${desc.hash}\u0000${desc.dataId}`;
          if (seenCandidates.has(candidateKey)) continue;
          seenCandidates.add(candidateKey);
          if (!candidatesByKey.has(target.key)) candidatesByKey.set(target.key, []);
          candidatesByKey.get(target.key).push({
            position: desc.position,
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
      if (more) {
        clickLikeUser(more);
        bottomStableRounds = 0;
        previousBottomSignature = "";
        await waitForMutation(900);
        continue;
      }

      const top = readTop(scroller);
      const height = readHeight(scroller);
      const viewport = Math.max(240, readViewport(scroller));
      const bottom = Math.max(0, height - viewport);
      const atBottom = top >= bottom - 6;

      if (!atBottom) {
        bottomStableRounds = 0;
        previousBottomSignature = "";
        writeTop(scroller, Math.min(bottom, top + Math.max(1100, Math.floor(viewport * 1.9))));
        await waitForMutation(420);
        continue;
      }

      writeTop(scroller, bottom);
      const changed = await waitForMutation(900);
      const nextScroller = primaryScroller();
      const nextHeight = readHeight(nextScroller);
      const nextTop = readTop(nextScroller);
      const rowSignature = visibleRows(nextScroller).map((row) => row.hash).join(",");
      const signature = `${Math.round(nextTop)}:${Math.round(nextHeight)}:${rowSignature}`;

      if (!changed && signature === previousBottomSignature) bottomStableRounds += 1;
      else bottomStableRounds = 0;
      previousBottomSignature = signature;

      if (bottomStableRounds >= 3) {
        complete = true;
        break;
      }
    }

    if (!complete) {
      return {
        ok: true,
        planned_count: 0,
        clicked_item_ids: [],
        failures: targets.map((target) => ({
          item_id: target.itemId,
          reason: "삭제 전 전체 목록 스캔이 제한 시간 안에 끝나지 않아 삭제하지 않았습니다.",
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
        .sort((left, right) => right.score - left.score || left.position - right.position);
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

    plans.sort((left, right) => right.candidate.position - left.candidate.position);
    const clicked = [];
    const evidenceByItem = {};

    for (const plan of plans) {
      let chosen = null;
      scroller = primaryScroller();
      const viewport = Math.max(240, readViewport(scroller));
      const offsets = [0, -Math.floor(viewport * 0.35), Math.floor(viewport * 0.35)];
      for (const offset of offsets) {
        writeTop(scroller, Math.max(0, plan.candidate.position - Math.floor(viewport * 0.42) + offset));
        await waitForMutation(320);
        const local = visibleRows(scroller).filter((desc) => rowMatchesTarget(desc, plan.target));
        local.sort((left, right) => {
          const leftStable = stableScore(left, plan.target);
          const rightStable = stableScore(right, plan.target);
          if (leftStable !== rightStable) return rightStable - leftStable;
          return Math.abs(left.position - plan.candidate.position) - Math.abs(right.position - plan.candidate.position);
        });
        chosen = local[0] || null;
        if (chosen?.button) break;
      }

      if (!chosen?.button) {
        failures.push({
          item_id: plan.target.itemId,
          reason: "저장한 위치로 이동했지만 해당 기록의 삭제 버튼을 다시 찾지 못했습니다.",
          diagnostics: {
            stage: "saved_position_miss",
            expected_page: expectedPage,
            saved_y: Math.round(plan.candidate.position),
          },
        });
        continue;
      }

      chosen.row.scrollIntoView({block: "center"});
      await wait(100);
      clickLikeUser(chosen.button);

      let confirmClicked = false;
      let evidence = "";
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await waitForMutation(attempt < 4 ? 260 : 420);
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
            saved_y: Math.round(plan.candidate.position),
          },
        });
        continue;
      }

      clicked.push(plan.target.itemId);
      evidenceByItem[String(plan.target.itemId)] = evidence;
      await wait(320);
    }

    return {
      ok: true,
      planned_count: plans.length,
      clicked_item_ids: clicked,
      failures,
      baseline_counts: baselineCounts,
      evidence_by_item: evidenceByItem,
      scan_version: 18,
    };
  }
})();
