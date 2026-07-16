globalThis.traceLensDeleteYouTubeTargetsInPage = async function(targets, options = {}) {
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

  const activityKind = targets?.[0]?.activityKind === "live_chat" ? "live_chat" : "comment";
  const expectedPage = activityKind === "live_chat" ? "youtube_live_chat" : "youtube_comments";
  const itemLabel = activityKind === "live_chat" ? "실시간 채팅" : "댓글";
  const batchSize = Math.max(1, Math.min(20, Number(options.batchSize) || 20));
  const batchPauseMs = Math.max(250, Number(options.batchPauseMs) || 500);
  const validPage = () => location.hostname === "myactivity.google.com"
    && new URL(location.href).searchParams.get("page") === expectedPage;
  if (!validPage()) throw new Error(`Google 내 활동의 YouTube ${itemLabel} 페이지가 아닙니다.`);

  const parseUrl = (value) => {
    try { return value ? new URL(value, location.href) : null; } catch { return null; }
  };
  const sourceKey = (value) => {
    const url = parseUrl(value);
    if (!url) return "";
    const postId = url.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
    return postId ? `post:${postId}` : (url.searchParams.get("v") || "");
  };
  const trustedCommentId = (value) => clean(parseUrl(value)?.searchParams.get("lc"));

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
  const deleteButtons = () => [...document.querySelectorAll('button[jslog^="114566"],button,[role="button"]')]
    .filter(isVisible)
    .filter(looksLikeDeleteButton);
  const itemWrappers = () => {
    const exact = [...document.querySelectorAll(
      'c-wiz[jsname="Ttx95"][data-token],c-wiz[data-show-delete-individual="true"][data-token]'
    )];
    const fallback = deleteButtons().map((button) => button.closest(
      'c-wiz[data-token],[role="listitem"],article,li,div[data-id]'
    )).filter(Boolean);
    return [...new Set([...exact, ...fallback])]
      .filter((wrapper) => wrapper.querySelector('button,[role="button"]'));
  };
  const deleteButtonFor = (wrapper) => {
    const exact = wrapper.querySelector('button[jslog^="114566"]');
    if (isVisible(exact)) return exact;
    return [...wrapper.querySelectorAll('button,[role="button"]')]
      .filter(isVisible)
      .find(looksLikeDeleteButton) || null;
  };
  const fallbackContent = (card, title) => {
    const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM|×|✕|X)$/i;
    const relation = /에\s*남긴\s*댓글|에\s*작성한\s*댓글|에서\s*메시지를\s*전송함|commented on|sent a message/i;
    const dateLine = /^(?:\d{4}[.\-/]\s*)?\d{1,2}[.\-/]\s*\d{1,2}|\d{1,2}:\d{2}|오늘|어제|today|yesterday/i;
    return String(card.innerText || card.textContent || "")
      .split(/\r?\n/)
      .map(clean)
      .filter(Boolean)
      .find((line) => !control.test(line) && !relation.test(line) && !dateLine.test(line) && line !== title) || "";
  };
  const parseItem = (wrapper) => {
    const card = wrapper.querySelector('[role="listitem"][aria-label*="YouTube"],[role="listitem"]') || wrapper;
    const anchor = wrapper.querySelector('a[jsname="BLHFSc"][href*="lc="],a[href*="lc="]')
      || wrapper.querySelector('a[jsname="BLHFSc"][href],a[href*="youtube.com"],a[href*="youtu.be"]');
    const rawSourceUrl = anchor?.href || anchor?.getAttribute("href") || "";
    const commentId = trustedCommentId(rawSourceUrl);
    const activityToken = clean(wrapper.getAttribute("data-token") || wrapper.closest("c-wiz[data-token]")?.getAttribute("data-token"));
    const titleNode = anchor?.querySelector?.(".hFYxqd") || anchor;
    const title = clean(titleNode?.innerText || titleNode?.textContent)
      || (activityKind === "live_chat" ? "YouTube 실시간 스트리밍" : "YouTube 동영상");
    const contentNode = wrapper.querySelector('.QTGV3c[jsname="r4nke"],[jsname="r4nke"],.QTGV3c');
    const content = clean(contentNode?.innerText || contentNode?.textContent) || fallbackContent(card, title);
    const fullText = clean(card.innerText || card.textContent);
    const key = sourceKey(rawSourceUrl);
    return {
      wrapper,
      card,
      button: deleteButtonFor(wrapper),
      commentId,
      activityToken,
      title,
      content,
      fullText,
      fullTextNorm: norm(fullText),
      fullTextLoose: loose(fullText),
      sourceUrl: rawSourceUrl,
      sourceKey: key,
      semanticHash: fnv(`${expectedPage}|${key}|${title}|${content}`),
      rowTextHash: fnv(fullText),
      signature: commentId || `${activityToken}|${key}|${fnv(fullText)}`,
    };
  };
  const scanVisibleItems = () => itemWrappers().map(parseItem).filter((item) => item.content);

  const targetTitle = (target, locator) => norm(target.title || locator.title).replace(/^\[실시간 채팅\]\s*/, "");
  const score = (target, item) => {
    const locator = target.locator || {};
    const exactId = clean(target.commentId || locator.comment_id);
    if (exactId) return {value: exactId === item.commentId ? 1000 : 0, strong: exactId === item.commentId};

    let value = 0;
    let strong = false;
    if (locator.semantic_hash && locator.semantic_hash === item.semanticHash) { value += 360; strong = true; }
    if (locator.row_text_hash && locator.row_text_hash === item.rowTextHash) { value += 220; strong = true; }

    const wantedContent = norm(target.content || locator.content);
    const wantedContentLoose = loose(target.content || locator.content);
    const wantedTitle = targetTitle(target, locator);
    const wantedTitleLoose = loose(wantedTitle);
    const itemContent = norm(item.content);
    const itemContentLoose = loose(item.content);
    const itemTitle = norm(item.title);
    const itemTitleLoose = loose(item.title);

    if (wantedContent && wantedContent === itemContent) { value += 180; strong = true; }
    else if (wantedContentLoose.length >= 2 && wantedContentLoose === itemContentLoose) { value += 165; strong = true; }
    else if (wantedContent && item.fullTextNorm.includes(wantedContent)) { value += 125; strong = true; }
    else if (wantedContentLoose.length >= 4 && item.fullTextLoose.includes(wantedContentLoose)) { value += 110; strong = true; }

    if (target.sourceKey && item.sourceKey && target.sourceKey === item.sourceKey) value += 70;
    if (wantedTitle && wantedTitle === itemTitle) value += 55;
    else if (wantedTitleLoose.length >= 4 && wantedTitleLoose === itemTitleLoose) value += 45;
    return {value, strong};
  };
  const bestFor = (target, items) => {
    const ranked = items.map((item) => ({item, ...score(target, item)})).sort((a, b) => b.value - a.value);
    const best = ranked[0];
    if (!best || best.value < 110 || !best.strong) return null;
    const second = ranked[1];
    if (second && second.value === best.value && best.value < 1000) return null;
    return best;
  };

  const isDocumentRoot = (element) => [document.scrollingElement, document.documentElement, document.body].includes(element);
  const pickScrollRoot = () => {
    const buttons = deleteButtons();
    const candidates = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll("body *")]
      .filter(Boolean)
      .filter((element) => {
        const rect = element.getBoundingClientRect?.() || {height: 0};
        const style = getComputedStyle(element);
        return rect.height >= 220
          && element.scrollHeight > element.clientHeight + 60
          && (isDocumentRoot(element) || /(auto|scroll)/.test(style.overflowY || ""));
      });
    return [...new Set(candidates)]
      .map((element) => ({
        element,
        score: buttons.filter((button) => isDocumentRoot(element) || element.contains(button)).length * 1_000_000
          + Math.max(0, element.scrollHeight - element.clientHeight),
      }))
      .sort((a, b) => b.score - a.score)[0]?.element
      || document.scrollingElement
      || document.documentElement;
  };

  let root = pickScrollRoot();
  const currentTop = () => isDocumentRoot(root) ? (window.scrollY || root.scrollTop || 0) : root.scrollTop;
  const maxTop = () => Math.max(0, root.scrollHeight - root.clientHeight);
  const setTop = async (top) => {
    const next = Math.max(0, Math.min(Number(top) || 0, maxTop()));
    if (isDocumentRoot(root)) window.scrollTo(0, next);
    root.scrollTop = next;
    root.dispatchEvent(new Event("scroll", {bubbles: true}));
    await sleep(260);
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

  let mutationVersion = 0;
  const observer = new MutationObserver(() => { mutationVersion += 1; });
  observer.observe(document.documentElement, {subtree: true, childList: true});

  banner.textContent = `TraceLens가 전체 ${itemLabel} 기록에서 선택 대상을 찾고 있습니다.`;
  await setTop(0);
  const discovered = new Map();
  const scanned = new Set();
  let stableBottom = 0;
  let previousBottom = "";
  let scanComplete = false;

  try {
    for (let step = 0; step < 1600; step += 1) {
      if (!validPage()) throw new Error("삭제 작업 중 페이지 주소가 변경되었습니다.");
      if (step > 0 && step % 25 === 0) {
        const nextRoot = pickScrollRoot();
        if (nextRoot && nextRoot !== root && nextRoot.scrollHeight - nextRoot.clientHeight > root.scrollHeight - root.clientHeight) root = nextRoot;
      }

      const items = scanVisibleItems();
      items.forEach((item) => scanned.add(item.signature));
      const savedTop = currentTop();
      for (const target of targets) {
        if (discovered.has(target.id)) continue;
        const match = bestFor(target, items);
        if (match) discovered.set(target.id, {item: match.item, scrollTop: savedTop, score: match.value});
      }
      if (discovered.size === targets.length) break;

      const max = maxTop();
      const top = currentTop();
      const atBottom = max <= 3 || top >= max - 6;
      const signature = `${top}|${root.scrollHeight}|${scanned.size}|${mutationVersion}|${discovered.size}`;
      stableBottom = atBottom && signature === previousBottom ? stableBottom + 1 : 0;
      previousBottom = signature;
      if (atBottom && stableBottom >= 8) {
        scanComplete = true;
        break;
      }

      const viewport = Math.max(500, root.clientHeight || innerHeight || 800);
      await setTop(Math.min(max, top + Math.max(420, Math.floor(viewport * 0.68))));
    }

    const unmatchedIds = targets.filter((target) => !discovered.has(target.id)).map((target) => target.id);
    const pending = targets
      .filter((target) => discovered.has(target.id))
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
        await setTop(saved.scrollTop + viewport * offset);
        const item = findCurrent(target);
        if (item) return item;
      }
      return null;
    };
    const waitRemoved = async (target, item, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!item.wrapper.isConnected) return true;
        if (!findCurrent(target)) return true;
        await sleep(100);
      }
      return false;
    };
    const clickConfirmIfPresent = async () => {
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline) {
        const dialogs = [...document.querySelectorAll("[role='dialog'],dialog,[aria-modal='true']")].filter(isVisible);
        for (const dialog of dialogs) {
          const confirm = [...dialog.querySelectorAll("button,[role='button']")]
            .filter(isVisible)
            .find((button) => {
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
      if (!current) {
        failed.push({id: target.id, reason: `저장한 위치에서 대상 ${itemLabel}을 다시 찾지 못했습니다.`});
        continue;
      }
      current.wrapper.scrollIntoView({block: "center", behavior: "auto"});
      await sleep(140);
      const refreshed = findCurrent(target) || current;
      const button = refreshed.button || deleteButtonFor(refreshed.wrapper);
      if (!button) {
        failed.push({id: target.id, reason: `${itemLabel} 카드의 X 삭제 버튼을 찾지 못했습니다.`});
        continue;
      }

      try {
        button.focus?.({preventScroll: true});
        button.click();
        attemptedIds.push(target.id);
        let removed = await waitRemoved(target, refreshed, 1100);
        if (!removed) {
          const confirmed = await clickConfirmIfPresent();
          if (confirmed) removed = await waitRemoved(target, refreshed, 2200);
        }
        if (removed) clickedIds.push(target.id);
        else failed.push({id: target.id, reason: `X 삭제 버튼을 눌렀지만 ${itemLabel} 카드가 Google 내 활동에서 사라지지 않았습니다.`});
      } catch (error) {
        failed.push({id: target.id, reason: error.message || String(error)});
      }

      batchClicks += 1;
      if (batchClicks >= batchSize) {
        banner.textContent = `${attemptedIds.length}개 삭제 요청 완료 · 잠시 반영을 기다립니다.`;
        await sleep(batchPauseMs);
        batchClicks = 0;
      } else {
        await sleep(160);
      }
    }

    banner.textContent = attemptedIds.length
      ? `${attemptedIds.length}개 삭제 요청 완료 · 새로고침 후 Google 내 활동에서 다시 확인합니다.`
      : `삭제 요청된 ${itemLabel}이 없습니다.`;

    return {
      clickedIds,
      attemptedIds,
      failed,
      unmatchedIds,
      scannedUnique: scanned.size,
      scanComplete,
      discoveryComplete: scanComplete,
      progress: {
        found: discovered.size,
        clicked: clickedIds.length,
        attempted: attemptedIds.length,
        unmatched: unmatchedIds.length,
        failed: failed.length,
      },
    };
  } finally {
    observer.disconnect();
  }
};