globalThis.traceLensProcessYouTubeActivityPage = async function(targets, options = null) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const norm = (value) => clean(value).toLowerCase();
  const loose = (value) => norm(value).replace(/[^\p{L}\p{N}]+/gu, "");
  const fnv = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };

  const inputTargets = Array.isArray(targets) ? targets : [];
  const mode = options && typeof options === "object" ? "delete" : "verify";
  const activityKind = inputTargets[0]?.activityKind === "live_chat" ? "live_chat" : "comment";
  const expectedPage = activityKind === "live_chat" ? "youtube_live_chat" : "youtube_comments";
  const itemLabel = activityKind === "live_chat" ? "실시간 채팅" : "댓글";
  const batchSize = Math.max(1, Math.min(20, Number(options?.batchSize) || 20));
  const batchPauseMs = Math.max(250, Number(options?.batchPauseMs) || 800);
  const maxClickAttempts = 3;

  const validPage = () => location.hostname === "myactivity.google.com"
    && new URL(location.href).searchParams.get("page") === expectedPage;
  if (!validPage()) throw new Error(`Google 내 활동의 YouTube ${itemLabel} 페이지가 아닙니다.`);

  const parseUrl = (value, base = location.href) => {
    try { return value ? new URL(value, base) : null; } catch { return null; }
  };

  const decodedCandidates = (value) => {
    const output = [];
    const queue = [String(value || "")];
    const seen = new Set();
    while (queue.length && seen.size < 36) {
      const current = queue.shift()?.trim();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      output.push(current);
      const unescaped = current
        .replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&").replace(/\\u002f/gi, "/")
        .replace(/\\x3d/gi, "=").replace(/\\x26/gi, "&").replace(/\\x2f/gi, "/")
        .replace(/\\\//g, "/");
      if (!seen.has(unescaped)) queue.push(unescaped);
      try {
        const decoded = decodeURIComponent(unescaped);
        if (!seen.has(decoded)) queue.push(decoded);
      } catch {}
      const parsed = parseUrl(unescaped);
      if (parsed) {
        for (const key of ["url", "q", "continue", "redirect", "target", "u", "dest", "href"]) {
          const nested = parsed.searchParams.get(key);
          if (nested) queue.push(nested);
        }
      }
    }
    return output;
  };

  const extractParam = (value, name) => {
    for (const candidate of decodedCandidates(value)) {
      const parsed = parseUrl(candidate);
      const direct = parsed?.searchParams.get(name);
      if (direct) return clean(direct);
      const match = candidate.match(new RegExp(`[?&]${name}=([^&#\\s]+)`, "i"));
      if (match?.[1]) {
        try { return clean(decodeURIComponent(match[1])); } catch { return clean(match[1]); }
      }
    }
    return "";
  };

  const sourceInfo = (value) => {
    for (const candidate of decodedCandidates(value)) {
      const parsed = parseUrl(candidate);
      if (!parsed) continue;
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (host === "youtu.be") {
        const id = parsed.pathname.split("/").filter(Boolean)[0];
        if (id) return {key: id, url: `https://www.youtube.com/watch?v=${id}`, type: "video", id};
      }
      if (!["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) continue;
      const postId = parsed.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
      if (postId) return {key: `post:${postId}`, url: `https://www.youtube.com/post/${postId}`, type: "post", id: postId};
      const videoId = parsed.searchParams.get("v")
        || parsed.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i)?.[1];
      if (videoId) return {key: videoId, url: `https://www.youtube.com/watch?v=${videoId}`, type: "video", id: videoId};
    }
    return {key: "", url: null, type: null, id: ""};
  };

  const isVisible = (element) => {
    if (!element?.isConnected || element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  };

  const looksLikeDeleteButton = (button) => {
    const label = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
    const text = clean(button.innerText || button.textContent);
    return button.matches?.('button[jslog^="114566"]')
      || /(활동\s*항목.*삭제|활동\s*삭제|삭제$|delete\s*activity|delete$|remove$)/i.test(label)
      || ["×", "✕", "X"].includes(text);
  };

  const visibleDeleteButtons = () => [...document.querySelectorAll('button[jslog^="114566"],button,[role="button"]')]
    .filter(isVisible)
    .filter(looksLikeDeleteButton);

  const wrapperForButton = (button) => {
    const exact = button.closest('c-wiz[jsname="Ttx95"],c-wiz[data-show-delete-individual="true"]');
    if (exact) return exact;
    let node = button.parentElement;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      const text = clean(node.innerText || node.textContent);
      const hasYoutubeLink = Boolean(node.querySelector?.('a[href*="youtube"],a[href*="youtu.be"],a[jsname="BLHFSc"]'));
      if (hasYoutubeLink && text.length >= 3 && text.length <= 12000) return node;
    }
    return button.closest('[role="listitem"],article,li,div[data-id]');
  };

  const itemWrappers = () => {
    const exact = [...document.querySelectorAll('c-wiz[jsname="Ttx95"],c-wiz[data-show-delete-individual="true"]')];
    const fallback = visibleDeleteButtons().map(wrapperForButton).filter(Boolean);
    return [...new Set([...exact, ...fallback])].filter((wrapper) => wrapper.querySelector('button,[role="button"]'));
  };

  const deleteButtonFor = (wrapper) => {
    const exact = wrapper.querySelector('button[jslog^="114566"]');
    if (isVisible(exact)) return exact;
    return [...wrapper.querySelectorAll('button,[role="button"]')].filter(isVisible).find(looksLikeDeleteButton) || null;
  };

  const parseItem = (wrapper) => {
    const card = wrapper.querySelector('[role="listitem"][aria-label*="YouTube"],[role="listitem"]') || wrapper;
    const lines = String(card.innerText || card.textContent || "").split(/\r?\n/).map(clean).filter(Boolean);
    const anchors = [...wrapper.querySelectorAll('a[href],a[jsname="BLHFSc"]')];
    const relationPattern = /\s*(?:에\s*남긴\s*댓글|에\s*작성한\s*댓글|에서\s*메시지를\s*전송함|commented on|sent a message)\s*$/i;
    const relationAnchor = anchors.find((anchor) => relationPattern.test(clean(anchor.innerText || anchor.textContent)));
    const relationLine = lines.find((line) => relationPattern.test(line))
      || clean(relationAnchor?.innerText || relationAnchor?.textContent);
    const title = clean(relationLine.replace(relationPattern, ""))
      || clean(relationAnchor?.innerText || relationAnchor?.textContent).replace(relationPattern, "")
      || (activityKind === "live_chat" ? "YouTube 실시간 스트리밍" : "YouTube 동영상");

    const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM|×|✕|X)$/i;
    const dateLine = /^(?:\d{4}[.\-/]\s*)?\d{1,2}[.\-/]\s*\d{1,2}|\d{1,2}:\d{2}|오늘|어제|today|yesterday/i;
    const directNode = wrapper.querySelector('.QTGV3c[jsname="r4nke"],[jsname="r4nke"],.QTGV3c');
    const directText = clean(directNode?.innerText || directNode?.textContent);
    const content = directText && !relationPattern.test(directText) && directText !== title
      ? directText
      : lines.find((line) => !control.test(line)
        && !dateLine.test(line)
        && !relationPattern.test(line)
        && line !== title) || "";
    if (!content) return null;

    const hrefValues = anchors.flatMap((anchor) => [anchor.href, anchor.getAttribute("href")]).filter(Boolean);
    const commentId = hrefValues.map((value) => extractParam(value, "lc")).find(Boolean) || "";
    const source = hrefValues.map(sourceInfo).find((entry) => entry.key) || {key: "", url: null, type: null, id: ""};
    const fullText = clean(card.innerText || card.textContent || wrapper.innerText || wrapper.textContent);

    return {
      wrapper,
      button: deleteButtonFor(wrapper),
      commentId,
      title,
      content,
      source,
      fullTextNorm: norm(fullText),
      fullTextLoose: loose(fullText),
      signature: commentId || `${source.key}|${loose(content)}|${loose(title)}`,
    };
  };

  const scanVisibleItems = () => itemWrappers().map(parseItem).filter((item) => item?.button);

  const score = (target, item) => {
    const locator = target.locator || {};
    const targetId = clean(target.commentId || locator.comment_id);
    const wantedContent = norm(target.content || locator.content);
    const wantedContentLoose = loose(target.content || locator.content);
    const wantedTitle = norm(target.title || locator.title).replace(/^\[실시간 채팅\]\s*/, "");
    const wantedTitleLoose = loose(wantedTitle);
    const itemContent = norm(item.content);
    const itemContentLoose = loose(item.content);
    let value = 0;
    let strong = false;

    if (targetId && item.commentId) {
      if (targetId === item.commentId) { value += 1000; strong = true; }
      else value -= 400;
    }
    if (wantedContent && wantedContent === itemContent) { value += 260; strong = true; }
    else if (wantedContentLoose.length >= 2 && wantedContentLoose === itemContentLoose) { value += 240; strong = true; }
    else if (wantedContent && item.fullTextNorm.includes(wantedContent)) { value += 190; strong = true; }
    else if (wantedContentLoose.length >= 3 && item.fullTextLoose.includes(wantedContentLoose)) { value += 170; strong = true; }

    if (target.sourceKey && item.source.key && target.sourceKey === item.source.key) value += 110;
    if (wantedTitle && norm(item.title) === wantedTitle) value += 90;
    else if (wantedTitleLoose.length >= 3 && item.fullTextLoose.includes(wantedTitleLoose)) value += 70;
    return {value, strong};
  };

  const bestFor = (target, items) => {
    const ranked = items.map((item) => ({item, ...score(target, item)})).sort((left, right) => right.value - left.value);
    const best = ranked[0];
    if (!best || best.value < 170 || !best.strong) return null;
    const second = ranked[1];
    if (second && second.value === best.value && best.value < 1000) return null;
    return best;
  };

  const isDocumentRoot = (element) => [document.scrollingElement, document.documentElement, document.body].includes(element);
  const pickScrollRoot = () => {
    const buttons = visibleDeleteButtons();
    const candidates = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll("body *")]
      .filter(Boolean)
      .filter((element) => {
        const rect = element.getBoundingClientRect?.() || {height: 0};
        const style = getComputedStyle(element);
        return rect.height >= 220
          && element.scrollHeight > element.clientHeight + 60
          && (isDocumentRoot(element) || /(auto|scroll)/.test(style.overflowY || ""));
      });
    return [...new Set(candidates)].map((element) => ({
      element,
      score: buttons.filter((button) => isDocumentRoot(element) || element.contains(button)).length * 1000000
        + Math.max(0, element.scrollHeight - element.clientHeight),
    })).sort((left, right) => right.score - left.score)[0]?.element
      || document.scrollingElement
      || document.documentElement;
  };

  let root = pickScrollRoot();
  const currentTop = () => isDocumentRoot(root) ? (window.scrollY || root.scrollTop || 0) : root.scrollTop;
  const maxTop = () => Math.max(0, root.scrollHeight - root.clientHeight);
  const setTop = async (top, delayMs = 300) => {
    const next = Math.max(0, Math.min(Number(top) || 0, maxTop()));
    const before = currentTop();
    if (isDocumentRoot(root)) window.scrollTo(0, next);
    root.scrollTop = next;
    if (Math.abs(before - next) > 2) root.dispatchEvent(new Event("scroll", {bubbles: true}));
    await sleep(delayMs);
  };

  let banner = document.getElementById("tracelens-delete-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "tracelens-delete-banner";
    Object.assign(banner.style, {
      position: "fixed", top: "0", left: "0", right: "0", zIndex: "2147483647",
      padding: "12px", background: "#8b1e1e", color: "white",
      font: "600 14px sans-serif", textAlign: "center",
    });
    document.documentElement.appendChild(banner);
  }
  banner.textContent = mode === "delete"
    ? `TraceLens가 전체 ${itemLabel} 기록에서 선택 대상을 찾고 있습니다.`
    : `삭제 후 전체 ${itemLabel} 기록을 끝까지 전수 확인하고 있습니다.`;

  await setTop(0, 500);
  const discovered = new Map();
  const collected = new Map();
  let stableBottom = 0;
  let previousBottomSignature = "";
  let complete = false;

  const collectCurrent = () => {
    const items = scanVisibleItems();
    for (const item of items) collected.set(item.signature, item);
    const savedTop = currentTop();
    for (const target of inputTargets) {
      if (discovered.has(target.id)) continue;
      const match = bestFor(target, items);
      if (match) discovered.set(target.id, {scrollTop: savedTop, score: match.value});
    }
    return items;
  };

  for (let step = 0; step < 1200 && collected.size < 5000; step += 1) {
    if (!validPage()) throw new Error("작업 중 Google 내 활동 페이지 주소가 변경되었습니다.");
    if (step > 0 && step % 24 === 0) {
      const nextRoot = pickScrollRoot();
      if (nextRoot && nextRoot !== root
        && nextRoot.scrollHeight - nextRoot.clientHeight > root.scrollHeight - root.clientHeight) root = nextRoot;
    }

    collectCurrent();
    if (mode === "delete" && inputTargets.length > 0 && discovered.size === inputTargets.length) break;
    if (mode === "verify" && inputTargets.length > 0 && discovered.size === inputTargets.length) break;

    const max = maxTop();
    const top = currentTop();
    const atBottom = max <= 3 || top >= max - 6;
    if (atBottom) {
      await sleep(550);
      collectCurrent();
      const refreshedMax = maxTop();
      const signature = `${Math.round(refreshedMax)}|${collected.size}|${discovered.size}`;
      stableBottom = signature === previousBottomSignature ? stableBottom + 1 : 0;
      previousBottomSignature = signature;
      if (stableBottom >= 5) {
        complete = true;
        break;
      }
      if (currentTop() < refreshedMax - 3) await setTop(refreshedMax, 380);
      else await sleep(350);
      continue;
    }

    stableBottom = 0;
    previousBottomSignature = "";
    const viewport = Math.max(500, root.clientHeight || innerHeight || 800);
    await setTop(Math.min(max, top + Math.max(420, Math.floor(viewport * 0.65))));
  }

  if (mode === "verify") {
    const foundIds = [...discovered.keys()];
    const items = [...collected.values()].map((entry) => ({
      external_id: `youtube-${activityKind}-${fnv(`${expectedPage}|${entry.source.key}|${entry.title}|${entry.content}|${entry.signature}`)}`,
      activity_type: "comment",
      title: activityKind === "live_chat" ? `[실시간 채팅] ${entry.title}` : entry.title,
      content: entry.content,
      source_url: entry.source.url,
      occurred_at: null,
      metadata: {
        captured_from: location.href,
        page_title: document.title,
        ownership_scope: "self_activity",
        ownership_verified: true,
        extractor_version: "1.9.0",
        youtube_activity_kind: activityKind,
        my_activity_page: expectedPage,
        comment_id: entry.commentId || null,
        source_type: entry.source.type,
        source_id: entry.source.id || null,
        video_id: entry.source.type === "video" ? entry.source.id : null,
        post_id: entry.source.type === "post" ? entry.source.id : null,
      },
    }));
    banner.textContent = complete
      ? `삭제 후 전체 ${itemLabel} 기록 ${items.length}개 전수 확인을 완료했습니다.`
      : `전체 ${itemLabel} 기록 확인이 끝까지 완료되지 않았습니다.`;
    return {
      complete,
      foundIds,
      scannedUnique: collected.size,
      extraction: {
        platform: "youtube",
        source_url: location.href,
        scan_scope: activityKind,
        status: complete ? "success" : "partial",
        snapshot_complete: complete,
        message: complete
          ? items.length
            ? `YouTube ${itemLabel} ${items.length}개를 삭제 후 끝까지 전수 확인했습니다.`
            : `YouTube ${itemLabel} 기록이 없습니다. 삭제 후 끝까지 전수 확인했습니다.`
          : `YouTube ${itemLabel} ${items.length}개를 확인했지만 끝까지 완료하지 못했습니다.`,
        account_label: null,
        items,
      },
      progress: {found: foundIds.length, total: inputTargets.length, collected: items.length},
    };
  }

  const unmatchedIds = inputTargets.filter((target) => !discovered.has(target.id)).map((target) => target.id);
  const pending = inputTargets.filter((target) => discovered.has(target.id))
    .sort((left, right) => (discovered.get(right.id)?.scrollTop || 0) - (discovered.get(left.id)?.scrollTop || 0));
  const clickedIds = [];
  const attemptedIds = [];
  const failed = [];
  let batchClicks = 0;

  const findCurrent = (target) => bestFor(target, scanVisibleItems())?.item || null;
  const restoreAndFind = async (target) => {
    const saved = discovered.get(target.id);
    if (!saved) return null;
    const viewport = Math.max(500, root.clientHeight || innerHeight || 800);
    for (const offset of [0, -0.35, 0.35, -0.75, 0.75, -1.15, 1.15]) {
      await setTop(saved.scrollTop + viewport * offset, 280);
      const item = findCurrent(target);
      if (item) return item;
    }
    return null;
  };

  const waitRemoved = async (target, item, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!item.wrapper.isConnected || !findCurrent(target)) return true;
      await sleep(100);
    }
    return false;
  };

  const clickConfirmIfPresent = async () => {
    const deadline = Date.now() + 1700;
    while (Date.now() < deadline) {
      for (const dialog of [...document.querySelectorAll("[role='dialog'],dialog,[aria-modal='true']")].filter(isVisible)) {
        const confirmButton = [...dialog.querySelectorAll("button,[role='button']")].filter(isVisible).find((button) => {
          const label = clean(`${button.getAttribute("aria-label") || ""} ${button.innerText || button.textContent || ""}`);
          return /^(활동\s*삭제|삭제하기|삭제|확인|delete\s*activity|delete|remove|confirm|ok)$/i.test(label);
        });
        if (confirmButton) {
          confirmButton.click();
          return true;
        }
      }
      await sleep(100);
    }
    return false;
  };

  banner.textContent = pending.length
    ? `대상을 찾았습니다. 아래쪽 ${itemLabel}부터 삭제를 요청합니다.`
    : `선택한 ${itemLabel}이 보이지 않아 전체 기록 확인 결과로 처리합니다.`;

  for (const target of pending) {
    let removed = false;
    let lastReason = `X 삭제 버튼을 눌렀지만 ${itemLabel} 카드가 Google 내 활동에서 사라지지 않았습니다.`;
    for (let attempt = 1; attempt <= maxClickAttempts && !removed; attempt += 1) {
      const current = await restoreAndFind(target);
      if (!current) {
        if (attempt > 1 && !findCurrent(target)) {
          removed = true;
          break;
        }
        lastReason = `저장한 위치에서 대상 ${itemLabel}을 다시 찾지 못했습니다.`;
        break;
      }
      current.wrapper.scrollIntoView({block: "center", behavior: "auto"});
      await sleep(180 + attempt * 80);
      const refreshed = findCurrent(target) || current;
      const button = refreshed.button || deleteButtonFor(refreshed.wrapper);
      if (!button) {
        lastReason = `${itemLabel} 카드의 X 삭제 버튼을 찾지 못했습니다.`;
        break;
      }
      try {
        button.focus?.({preventScroll: true});
        button.click();
        if (!attemptedIds.includes(target.id)) attemptedIds.push(target.id);
        removed = await waitRemoved(target, refreshed, 1200 + attempt * 500);
        if (!removed && await clickConfirmIfPresent()) {
          removed = await waitRemoved(target, refreshed, 2200 + attempt * 700);
        }
        if (!removed && attempt < maxClickAttempts) await sleep(400 + attempt * 250);
      } catch (error) {
        lastReason = error.message || String(error);
        if (attempt < maxClickAttempts) await sleep(400 + attempt * 250);
      }
    }
    if (removed) clickedIds.push(target.id);
    else failed.push({id: target.id, reason: lastReason});

    batchClicks += 1;
    if (batchClicks >= batchSize) {
      await sleep(batchPauseMs);
      batchClicks = 0;
    } else {
      await sleep(220);
    }
  }

  banner.textContent = attemptedIds.length
    ? `${attemptedIds.length}개 삭제 요청 완료 · 새로고침 후 전체 ${itemLabel} 기록을 전수 확인합니다.`
    : complete
      ? `선택 대상은 현재 Google 내 활동에 없습니다. TraceLens 목록을 정리합니다.`
      : `선택한 ${itemLabel}을 찾지 못했고 전체 확인도 끝나지 않았습니다.`;

  return {
    clickedIds,
    attemptedIds,
    failed,
    unmatchedIds,
    scannedUnique: collected.size,
    scanComplete: complete,
    discoveryComplete: complete,
    progress: {
      found: discovered.size,
      clicked: clickedIds.length,
      attempted: attemptedIds.length,
      unmatched: unmatchedIds.length,
      failed: failed.length,
    },
  };
};

globalThis.traceLensDeleteYouTubeTargetsInPage = globalThis.traceLensProcessYouTubeActivityPage;
