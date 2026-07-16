globalThis.traceLensDeleteYouTubeTargetsInPage = async function(targets, options = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const norm = (value) => clean(value).toLowerCase();
  const loose = (value) => norm(value).replace(/[^\p{L}\p{N}]+/gu, "");

  const activityKind = targets?.[0]?.activityKind === "live_chat" ? "live_chat" : "comment";
  const expectedPage = activityKind === "live_chat" ? "youtube_live_chat" : "youtube_comments";
  const itemLabel = activityKind === "live_chat" ? "실시간 채팅" : "댓글";
  const batchSize = Math.max(1, Math.min(20, Number(options.batchSize) || 20));
  const batchPauseMs = Math.max(250, Number(options.batchPauseMs) || 500);

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
    while (queue.length && seen.size < 40) {
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

  const sourceKeyFromValue = (value) => {
    for (const candidate of decodedCandidates(value)) {
      const parsed = parseUrl(candidate);
      if (!parsed) continue;
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (host === "youtu.be") {
        const id = parsed.pathname.split("/").filter(Boolean)[0];
        if (id) return id;
      }
      if (!["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) continue;
      const postId = parsed.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
      if (postId) return `post:${postId}`;
      const videoId = parsed.searchParams.get("v") || parsed.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i)?.[1];
      if (videoId) return videoId;
    }
    return "";
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
    const relationLine = lines.find((line) => relationPattern.test(line)) || clean(relationAnchor?.innerText || relationAnchor?.textContent);
    const title = clean(relationLine.replace(relationPattern, ""))
      || clean(relationAnchor?.innerText || relationAnchor?.textContent).replace(relationPattern, "")
      || (activityKind === "live_chat" ? "YouTube 실시간 스트리밍" : "YouTube 동영상");

    const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM|×|✕|X)$/i;
    const dateLine = /^(?:\d{4}[.\-/]\s*)?\d{1,2}[.\-/]\s*\d{1,2}|\d{1,2}:\d{2}|오늘|어제|today|yesterday/i;
    const directNode = wrapper.querySelector('.QTGV3c[jsname="r4nke"],[jsname="r4nke"],.QTGV3c');
    const directText = clean(directNode?.innerText || directNode?.textContent);
    const content = directText && !relationPattern.test(directText) && directText !== title
      ? directText
      : lines.find((line) => !control.test(line) && !dateLine.test(line) && !relationPattern.test(line) && line !== title) || "";

    const hrefValues = anchors.flatMap((anchor) => [anchor.href, anchor.getAttribute("href")]).filter(Boolean);
    const commentId = hrefValues.map((value) => extractParam(value, "lc")).find(Boolean) || "";
    const sourceKey = hrefValues.map(sourceKeyFromValue).find(Boolean) || "";
    const fullText = clean(card.innerText || card.textContent || wrapper.innerText || wrapper.textContent);

    return {
      wrapper,
      card,
      button: deleteButtonFor(wrapper),
      commentId,
      title,
      content,
      sourceKey,
      fullText,
      fullTextNorm: norm(fullText),
      fullTextLoose: loose(fullText),
      signature: commentId || `${sourceKey}|${loose(content)}|${loose(title)}`,
    };
  };

  const scanVisibleItems = () => itemWrappers().map(parseItem).filter((item) => item.content && item.button);

  const score = (target, item) => {
    const locator = target.locator || {};
    const targetId = clean(target.commentId || locator.comment_id);
    let value = 0;
    let strong = false;

    if (targetId && item.commentId) {
      if (targetId === item.commentId) { value += 1000; strong = true; }
      else value -= 400;
    }

    const wantedContent = norm(target.content || locator.content);
    const wantedContentLoose = loose(target.content || locator.content);
    const wantedTitle = norm(target.title || locator.title).replace(/^\[실시간 채팅\]\s*/, "");
    const wantedTitleLoose = loose(wantedTitle);
    const itemContent = norm(item.content);
    const itemContentLoose = loose(item.content);
    const itemTitle = norm(item.title);
    const itemTitleLoose = loose(item.title);

    if (wantedContent && wantedContent === itemContent) { value += 260; strong = true; }
    else if (wantedContentLoose.length >= 2 && wantedContentLoose === itemContentLoose) { value += 240; strong = true; }
    else if (wantedContent && item.fullTextNorm.includes(wantedContent)) { value += 190; strong = true; }
    else if (wantedContentLoose.length >= 3 && item.fullTextLoose.includes(wantedContentLoose)) { value += 170; strong = true; }

    if (target.sourceKey && item.sourceKey && target.sourceKey === item.sourceKey) value += 110;
    if (wantedTitle && wantedTitle === itemTitle) value += 90;
    else if (wantedTitleLoose.length >= 3 && item.fullTextLoose.includes(wantedTitleLoose)) value += 70;

    return {value, strong};
  };

  const bestFor = (target, items) => {
    const ranked = items.map((item) => ({item, ...score(target, item)})).sort((a, b) => b.value - a.value);
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
        return rect.height >= 220 && element.scrollHeight > element.clientHeight + 60
          && (isDocumentRoot(element) || /(auto|scroll)/.test(style.overflowY || ""));
      });
    return [...new Set(candidates)].map((element) => ({
      element,
      score: buttons.filter((button) => isDocumentRoot(element) || element.contains(button)).length * 1000000
        + Math.max(0, element.scrollHeight - element.clientHeight),
    })).sort((left, right) => right.score - left.score)[0]?.element || document.scrollingElement || document.documentElement;
  };

  let root = pickScrollRoot();
  const currentTop = () => isDocumentRoot(root) ? (window.scrollY || root.scrollTop || 0) : root.scrollTop;
  const maxTop = () => Math.max(0, root.scrollHeight - root.clientHeight);
  const setTop = async (top) => {
    const next = Math.max(0, Math.min(Number(top) || 0, maxTop()));
    if (isDocumentRoot(root)) window.scrollTo(0, next);
    root.scrollTop = next;
    root.dispatchEvent(new Event("scroll", {bubbles: true}));
    await sleep(300);
  };

  let banner = document.getElementById("tracelens-delete-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "tracelens-delete-banner";
    Object.assign(banner.style, {position:"fixed",top:"0",left:"0",right:"0",zIndex:"2147483647",padding:"12px",background:"#8b1e1e",color:"white",font:"600 14px sans-serif",textAlign:"center"});
    document.documentElement.appendChild(banner);
  }

  let mutationVersion = 0;
  const observer = new MutationObserver(() => { mutationVersion += 1; });
  observer.observe(document.documentElement, {subtree:true,childList:true});

  banner.textContent = `TraceLens가 전체 ${itemLabel} 기록에서 선택 대상을 찾고 있습니다.`;
  await setTop(0);
  const discovered = new Map();
  const scanned = new Set();
  let stableBottom = 0;
  let previousBottom = "";
  let scanComplete = false;

  try {
    for (let step = 0; step < 1800; step += 1) {
      if (!validPage()) throw new Error("삭제 작업 중 페이지 주소가 변경되었습니다.");
      if (step > 0 && step % 20 === 0) {
        const nextRoot = pickScrollRoot();
        if (nextRoot && nextRoot !== root && nextRoot.scrollHeight - nextRoot.clientHeight > root.scrollHeight - root.clientHeight) root = nextRoot;
      }
      const items = scanVisibleItems();
      items.forEach((item) => scanned.add(item.signature));
      const savedTop = currentTop();
      for (const target of targets) {
        if (discovered.has(target.id)) continue;
        const match = bestFor(target, items);
        if (match) discovered.set(target.id, {scrollTop:savedTop,score:match.value});
      }
      if (discovered.size === targets.length) break;

      const max = maxTop();
      const top = currentTop();
      const atBottom = max <= 3 || top >= max - 6;
      const signature = `${top}|${root.scrollHeight}|${scanned.size}|${mutationVersion}|${discovered.size}`;
      stableBottom = atBottom && signature === previousBottom ? stableBottom + 1 : 0;
      previousBottom = signature;
      if (atBottom && stableBottom >= 8) { scanComplete = true; break; }
      const viewport = Math.max(500, root.clientHeight || innerHeight || 800);
      await setTop(Math.min(max, top + Math.max(420, Math.floor(viewport * 0.65))));
    }

    const unmatchedIds = targets.filter((target) => !discovered.has(target.id)).map((target) => target.id);
    const pending = targets.filter((target) => discovered.has(target.id))
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
      for (const offset of [0,-0.35,0.35,-0.75,0.75,-1.15,1.15]) {
        await setTop(saved.scrollTop + viewport * offset);
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
      const deadline = Date.now() + 1400;
      while (Date.now() < deadline) {
        for (const dialog of [...document.querySelectorAll("[role='dialog'],dialog,[aria-modal='true']")].filter(isVisible)) {
          const confirm = [...dialog.querySelectorAll("button,[role='button']")].filter(isVisible).find((button) => {
            const label = clean(`${button.getAttribute("aria-label") || ""} ${button.innerText || button.textContent || ""}`);
            return /^(활동\s*삭제|삭제하기|삭제|확인|delete\s*activity|delete|remove|confirm|ok)$/i.test(label);
          });
          if (confirm) { confirm.click(); return true; }
        }
        await sleep(100);
      }
      return false;
    };

    banner.textContent = `대상을 찾았습니다. 아래쪽 ${itemLabel}부터 삭제를 요청합니다.`;
    for (const target of pending) {
      const current = await restoreAndFind(target);
      if (!current) { failed.push({id:target.id,reason:`저장한 위치에서 대상 ${itemLabel}을 다시 찾지 못했습니다.`}); continue; }
      current.wrapper.scrollIntoView({block:"center",behavior:"auto"});
      await sleep(160);
      const refreshed = findCurrent(target) || current;
      const button = refreshed.button || deleteButtonFor(refreshed.wrapper);
      if (!button) { failed.push({id:target.id,reason:`${itemLabel} 카드의 X 삭제 버튼을 찾지 못했습니다.`}); continue; }
      try {
        button.focus?.({preventScroll:true});
        button.click();
        attemptedIds.push(target.id);
        let removed = await waitRemoved(target, refreshed, 1200);
        if (!removed) {
          const confirmed = await clickConfirmIfPresent();
          if (confirmed) removed = await waitRemoved(target, refreshed, 2400);
        }
        if (removed) clickedIds.push(target.id);
        else failed.push({id:target.id,reason:`X 삭제 버튼을 눌렀지만 ${itemLabel} 카드가 Google 내 활동에서 사라지지 않았습니다.`});
      } catch (error) {
        failed.push({id:target.id,reason:error.message || String(error)});
      }
      batchClicks += 1;
      if (batchClicks >= batchSize) { await sleep(batchPauseMs); batchClicks = 0; }
      else await sleep(180);
    }

    banner.textContent = attemptedIds.length
      ? `${attemptedIds.length}개 삭제 요청 완료 · 새로고침 후 Google 내 활동에서 다시 확인합니다.`
      : `선택한 ${itemLabel}을 찾지 못해 삭제 버튼을 누르지 않았습니다.`;

    return {
      clickedIds,
      attemptedIds,
      failed,
      unmatchedIds,
      scannedUnique: scanned.size,
      scanComplete,
      discoveryComplete: unmatchedIds.length === 0,
      progress: {found:discovered.size,clicked:clickedIds.length,attempted:attemptedIds.length,unmatched:unmatchedIds.length,failed:failed.length},
    };
  } finally {
    observer.disconnect();
  }
};