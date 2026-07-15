globalThis.traceLensDeleteYouTubeTargetsInPage = async function(targets, options = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const norm = (value) => clean(value).toLowerCase();
  const batchSize = Math.max(1, Math.min(20, Number(options.batchSize) || 20));
  const batchPauseMs = Math.max(250, Number(options.batchPauseMs) || 500);
  const expectedPage = "youtube_comments";
  const validPage = () => location.hostname === "myactivity.google.com"
    && new URL(location.href).searchParams.get("page") === expectedPage;
  if (!validPage()) throw new Error("Google 내 활동의 YouTube 댓글 페이지가 아닙니다.");

  const fnv = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };

  const parseUrl = (value) => {
    try { return value ? new URL(value, location.href) : null; } catch { return null; }
  };

  const commentIdFromUrl = (value) => parseUrl(value)?.searchParams.get("lc") || "";

  const sourceKey = (value) => {
    const url = parseUrl(value);
    if (!url) return "";
    const postId = url.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
    return postId ? `post:${postId}` : (url.searchParams.get("v") || "");
  };

  const isVisible = (element) => {
    if (!element?.isConnected || element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  };

  const itemWrappers = () => [...document.querySelectorAll(
    'c-wiz[jsname="Ttx95"][data-token], c-wiz[data-show-delete-individual="true"][data-token]'
  )].filter((wrapper) => wrapper.querySelector('[role="listitem"][aria-label*="YouTube"], [role="listitem"]'));

  const deleteButtonFor = (wrapper, card) => {
    const exact = wrapper.querySelector('button[jslog^="114566"]');
    if (isVisible(exact)) return exact;
    const candidates = [...wrapper.querySelectorAll("button,[role='button']")].filter(isVisible);
    return candidates.find((button) => {
      const label = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
      return /(활동\s*항목.*삭제|활동\s*삭제|삭제$|delete\s*activity|delete$|remove$)/i.test(label)
        && (!card || card.contains(button));
    }) || null;
  };

  const parseItem = (wrapper) => {
    const card = wrapper.querySelector('[role="listitem"][aria-label*="YouTube"]')
      || wrapper.querySelector('[role="listitem"]')
      || wrapper;
    const commentAnchor = wrapper.querySelector('a[jsname="BLHFSc"][href*="lc="], a[href*="lc="]');
    const sourceUrl = commentAnchor?.href || commentAnchor?.getAttribute("href") || "";
    const commentId = clean(wrapper.getAttribute("data-token")) || commentIdFromUrl(sourceUrl);
    const contentNode = wrapper.querySelector('.QTGV3c[jsname="r4nke"], [jsname="r4nke"], .QTGV3c');
    const titleNode = commentAnchor?.querySelector(".hFYxqd") || commentAnchor;
    const content = clean(contentNode?.innerText || contentNode?.textContent);
    const title = clean(titleNode?.innerText || titleNode?.textContent);
    const fullText = clean(card.innerText || card.textContent);
    const button = deleteButtonFor(wrapper, card);
    return {
      wrapper,
      card,
      button,
      commentId,
      title,
      content,
      fullText,
      fullTextNorm: norm(fullText),
      sourceUrl,
      sourceKey: sourceKey(sourceUrl),
      semanticHash: fnv(`${expectedPage}|${sourceKey(sourceUrl)}|${title}|${content}`),
      rowTextHash: fnv(fullText),
      signature: commentId || `${sourceKey(sourceUrl)}|${fnv(fullText)}`,
      documentTop: (wrapper.getBoundingClientRect?.().top || 0) + (window.scrollY || 0),
    };
  };

  const score = (target, item) => {
    const locator = target.locator || {};
    const targetCommentId = clean(target.commentId || locator.comment_id || locator.activity_token);
    let value = 0;
    let strong = false;
    if (targetCommentId && item.commentId && targetCommentId === item.commentId) {
      value += 400;
      strong = true;
    }
    if (locator.semantic_hash && locator.semantic_hash === item.semanticHash) {
      value += 150;
      strong = true;
    }
    if (locator.row_text_hash && locator.row_text_hash === item.rowTextHash) {
      value += 90;
      strong = true;
    }
    const targetContent = norm(target.content || locator.content);
    const targetTitle = norm(target.title || locator.title);
    const exactContent = Boolean(targetContent && targetContent === norm(item.content));
    const contentInItem = Boolean(targetContent && item.fullTextNorm.includes(targetContent));
    const sameSource = Boolean(target.sourceKey && item.sourceKey && target.sourceKey === item.sourceKey);
    const exactTitle = Boolean(targetTitle && targetTitle === norm(item.title));
    if (exactContent) { value += 120; strong = true; }
    else if (contentInItem) { value += 90; strong = true; }
    if (sameSource) value += 45;
    if (exactTitle) value += 30;
    return {value, strong};
  };

  const bestFor = (target, items) => {
    const ranked = items.map((item) => ({item, ...score(target, item)}))
      .sort((left, right) => right.value - left.value);
    const best = ranked[0];
    if (!best || best.value < 90 || !best.strong) return null;
    const second = ranked[1]?.value || 0;
    if (second && best.value === second && best.value < 400) return null;
    return best;
  };

  const root = document.scrollingElement || document.documentElement;
  const scanItems = () => itemWrappers().map(parseItem);
  const scrollToTop = async () => {
    window.scrollTo(0, 0);
    root.scrollTop = 0;
    root.dispatchEvent(new Event("scroll", {bubbles: true}));
    await sleep(180);
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

  banner.textContent = "TraceLens가 선택한 댓글을 찾고 있습니다. 이 탭을 닫지 마세요.";
  await scrollToTop();

  const discovered = new Map();
  const scanned = new Set();
  let bottomStable = 0;
  let previousBottom = "";

  for (let step = 0; step < 700; step += 1) {
    if (!validPage()) throw new Error("삭제 작업 중 페이지 주소가 변경되었습니다.");
    const items = scanItems();
    items.forEach((item) => scanned.add(item.signature));
    for (const target of targets) {
      if (discovered.has(target.id)) continue;
      const best = bestFor(target, items);
      if (best) discovered.set(target.id, best.item);
    }
    if (discovered.size === targets.length) break;

    const max = Math.max(0, root.scrollHeight - root.clientHeight);
    const atBottom = root.scrollTop >= max - 8;
    const bottomSignature = `${root.scrollTop}|${root.scrollHeight}|${items.length}|${discovered.size}`;
    bottomStable = atBottom && bottomSignature === previousBottom ? bottomStable + 1 : 0;
    previousBottom = bottomSignature;
    if (atBottom && bottomStable >= 5) break;

    const before = root.scrollTop;
    root.scrollTop = Math.min(max, before + Math.max(700, Math.floor((root.clientHeight || innerHeight) * 0.9)));
    root.dispatchEvent(new Event("scroll", {bubbles: true}));
    if (root.scrollTop === before && !atBottom) window.scrollBy(0, Math.max(700, innerHeight * 0.9));
    await sleep(220);
  }

  const pending = targets
    .filter((target) => discovered.has(target.id))
    .sort((left, right) => (discovered.get(right.id)?.documentTop || 0) - (discovered.get(left.id)?.documentTop || 0));
  const clickedIds = [];
  const failed = [];
  const unmatchedIds = targets.filter((target) => !discovered.has(target.id)).map((target) => target.id);
  let batchClicks = 0;

  const findCurrentItem = (target) => {
    const locator = target.locator || {};
    const token = clean(target.commentId || locator.comment_id || locator.activity_token || discovered.get(target.id)?.commentId);
    if (token && globalThis.CSS?.escape) {
      const exact = document.querySelector(`c-wiz[data-token="${CSS.escape(token)}"]`);
      if (exact) return parseItem(exact);
    }
    const best = bestFor(target, scanItems());
    return best?.item || null;
  };

  const waitRemoved = async (item, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!item.wrapper.isConnected) return true;
      if (item.commentId && globalThis.CSS?.escape
        && !document.querySelector(`c-wiz[data-token="${CSS.escape(item.commentId)}"]`)) return true;
      await sleep(90);
    }
    return false;
  };

  const clickConfirmIfPresent = async () => {
    const deadline = Date.now() + 900;
    while (Date.now() < deadline) {
      const dialogs = [...document.querySelectorAll("[role='dialog'],dialog,[aria-modal='true']")].filter(isVisible);
      for (const dialog of dialogs) {
        const confirm = [...dialog.querySelectorAll("button,[role='button']")].filter(isVisible).find((button) => {
          const label = clean(`${button.getAttribute("aria-label") || ""} ${button.innerText || button.textContent || ""}`);
          return /^(활동\s*삭제|삭제하기|삭제|확인|delete\s*activity|delete|remove|confirm|ok)$/i.test(label);
        });
        if (confirm) {
          confirm.click();
          return true;
        }
      }
      await sleep(90);
    }
    return false;
  };

  banner.textContent = "TraceLens가 아래쪽 댓글부터 삭제하고 있습니다.";
  for (const target of pending) {
    const item = findCurrentItem(target);
    if (!item) {
      failed.push({id: target.id, reason: "저장된 대상 댓글을 현재 화면에서 다시 찾지 못했습니다."});
      continue;
    }
    item.wrapper.scrollIntoView({block: "center", behavior: "auto"});
    await sleep(90);
    const current = findCurrentItem(target) || item;
    const button = current.button || deleteButtonFor(current.wrapper, current.card);
    if (!button) {
      failed.push({id: target.id, reason: "댓글 카드의 X 삭제 버튼(jslog 114566)을 찾지 못했습니다."});
      continue;
    }

    try {
      button.focus?.({preventScroll: true});
      button.click();
      let removed = await waitRemoved(current, 900);
      if (!removed) {
        const confirmed = await clickConfirmIfPresent();
        if (confirmed) removed = await waitRemoved(current, 1800);
      }
      if (removed) clickedIds.push(target.id);
      else failed.push({id: target.id, reason: "X 삭제 버튼을 눌렀지만 댓글 카드가 사라지지 않았습니다."});
    } catch (error) {
      failed.push({id: target.id, reason: error.message || String(error)});
    }

    batchClicks += 1;
    if (batchClicks >= batchSize) {
      banner.textContent = `${clickedIds.length}개 삭제 완료 · 잠시 안정화를 기다립니다.`;
      await sleep(batchPauseMs);
      batchClicks = 0;
    } else {
      await sleep(120);
    }
  }

  banner.textContent = clickedIds.length
    ? `${clickedIds.length}개 삭제 요청 완료 · 새로고침 후 한 번만 확인합니다.`
    : "삭제된 댓글이 없습니다. 실패 원인을 TraceLens로 전달합니다.";

  return {
    clickedIds,
    failed,
    unmatchedIds,
    scannedUnique: scanned.size,
    discoveryComplete: unmatchedIds.length === 0,
    batchSize,
    progress: {clicked: clickedIds.length, unmatched: unmatchedIds.length, failed: failed.length},
  };
};