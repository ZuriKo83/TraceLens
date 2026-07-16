globalThis.traceLensVerifyYouTubeActivityTargetsInPage = async function(targets) {
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

  const kind = targets?.[0]?.activityKind === "live_chat" ? "live_chat" : "comment";
  const page = kind === "live_chat" ? "youtube_live_chat" : "youtube_comments";
  const label = kind === "live_chat" ? "실시간 채팅" : "댓글";
  if (location.hostname !== "myactivity.google.com" || new URL(location.href).searchParams.get("page") !== page) {
    throw new Error(`Google 내 활동의 YouTube ${label} 페이지가 아닙니다.`);
  }

  const parseUrl = (value) => {
    try { return value ? new URL(value, location.href) : null; } catch { return null; }
  };
  const canonicalUrl = (value) => {
    const url = parseUrl(value);
    if (!url) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : null;
    }
    if (!["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) return null;
    const postId = url.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
    if (postId) return `https://www.youtube.com/post/${postId}`;
    const videoId = url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i)?.[1];
    return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
  };
  const sourceIdentity = (value) => {
    const url = parseUrl(value);
    if (!url) return {type: null, id: "", key: ""};
    const postId = url.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
    if (postId) return {type: "post", id: postId, key: `post:${postId}`};
    const videoId = url.searchParams.get("v") || "";
    return videoId ? {type: "video", id: videoId, key: videoId} : {type: null, id: "", key: ""};
  };

  const isVisible = (element) => {
    if (!element?.isConnected || element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  };
  const looksLikeDeleteButton = (button) => {
    const labelText = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
    const text = clean(button.innerText || button.textContent);
    return button.matches?.('button[jslog^="114566"]')
      || /(활동\s*항목.*삭제|활동\s*삭제|삭제$|delete\s*activity|delete$|remove$)/i.test(labelText)
      || ["×", "✕", "X"].includes(text);
  };
  const deleteButtons = () => [...document.querySelectorAll('button[jslog^="114566"],button,[role="button"]')]
    .filter(isVisible)
    .filter(looksLikeDeleteButton);
  const wrappers = () => {
    const exact = [...document.querySelectorAll(
      'c-wiz[jsname="Ttx95"][data-token],c-wiz[data-show-delete-individual="true"][data-token]'
    )];
    const fallback = deleteButtons().map((button) => button.closest(
      'c-wiz[data-token],[role="listitem"],article,li,div[data-id]'
    )).filter(Boolean);
    return [...new Set([...exact, ...fallback])]
      .filter((wrapper) => wrapper.querySelector('button,[role="button"]'));
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
    const parsed = parseUrl(rawSourceUrl);
    const sourceUrl = canonicalUrl(rawSourceUrl);
    const source = sourceIdentity(sourceUrl);
    const commentId = clean(parsed?.searchParams.get("lc"));
    const activityToken = clean(wrapper.getAttribute("data-token") || wrapper.closest("c-wiz[data-token]")?.getAttribute("data-token"));
    const titleNode = anchor?.querySelector?.(".hFYxqd") || anchor;
    const title = clean(titleNode?.innerText || titleNode?.textContent)
      || (kind === "live_chat" ? "YouTube 실시간 스트리밍" : "YouTube 동영상");
    const contentNode = wrapper.querySelector('.QTGV3c[jsname="r4nke"],[jsname="r4nke"],.QTGV3c');
    const content = clean(contentNode?.innerText || contentNode?.textContent) || fallbackContent(card, title);
    const rowText = clean(card.innerText || card.textContent);
    return {
      commentId,
      activityToken,
      title,
      content,
      rowText,
      rowTextNorm: norm(rowText),
      rowTextLoose: loose(rowText),
      source,
      sourceUrl,
      semanticHash: fnv(`${page}|${source.key}|${title}|${content}`),
      rowTextHash: fnv(rowText),
      signature: commentId || `${activityToken}|${source.key}|${fnv(rowText)}`,
      button: [...wrapper.querySelectorAll('button[jslog^="114566"],button,[role="button"]')]
        .find((button) => isVisible(button) && looksLikeDeleteButton(button)) || null,
    };
  };
  const visibleItems = () => wrappers().map(parseItem).filter((item) => item.content);

  const targetTitle = (target, locator) => norm(target.title || locator.title).replace(/^\[실시간 채팅\]\s*/, "");
  const score = (target, item) => {
    const locator = target.locator || {};
    const exactId = clean(target.commentId || locator.comment_id);
    if (exactId) return exactId === item.commentId ? 1000 : 0;

    let value = 0;
    if (locator.semantic_hash && locator.semantic_hash === item.semanticHash) value += 360;
    if (locator.row_text_hash && locator.row_text_hash === item.rowTextHash) value += 220;

    const wantedContent = norm(target.content || locator.content);
    const wantedContentLoose = loose(target.content || locator.content);
    const wantedTitle = targetTitle(target, locator);
    const wantedTitleLoose = loose(wantedTitle);
    const itemContent = norm(item.content);
    const itemContentLoose = loose(item.content);
    const itemTitle = norm(item.title);
    const itemTitleLoose = loose(item.title);

    if (wantedContent && wantedContent === itemContent) value += 180;
    else if (wantedContentLoose.length >= 2 && wantedContentLoose === itemContentLoose) value += 165;
    else if (wantedContent && item.rowTextNorm.includes(wantedContent)) value += 125;
    else if (wantedContentLoose.length >= 4 && item.rowTextLoose.includes(wantedContentLoose)) value += 110;

    if (target.sourceKey && item.source.key && target.sourceKey === item.source.key) value += 70;
    if (wantedTitle && wantedTitle === itemTitle) value += 55;
    else if (wantedTitleLoose.length >= 4 && wantedTitleLoose === itemTitleLoose) value += 45;
    return value;
  };
  const uniqueMatch = (target, items) => {
    const ranked = items.map((item) => score(target, item)).sort((a, b) => b - a);
    return Boolean(ranked[0] >= 110 && !(ranked[1] === ranked[0] && ranked[0] < 1000));
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
    await sleep(240);
  };

  let mutationVersion = 0;
  const observer = new MutationObserver(() => { mutationVersion += 1; });
  observer.observe(document.documentElement, {subtree: true, childList: true});

  const collected = new Map();
  const foundIds = new Set();
  let stableBottom = 0;
  let previousBottom = "";
  let complete = false;

  try {
    await setTop(0);
    for (let step = 0; step < 1800 && collected.size < 5000; step += 1) {
      if (step > 0 && step % 25 === 0) {
        const nextRoot = pickScrollRoot();
        if (nextRoot && nextRoot !== root && nextRoot.scrollHeight - nextRoot.clientHeight > root.scrollHeight - root.clientHeight) root = nextRoot;
      }

      const current = visibleItems();
      current.forEach((item) => collected.set(item.signature, item));
      for (const target of targets) {
        if (!foundIds.has(target.id) && uniqueMatch(target, current)) foundIds.add(target.id);
      }

      const max = maxTop();
      const top = currentTop();
      const atBottom = max <= 3 || top >= max - 6;
      const signature = `${top}|${root.scrollHeight}|${collected.size}|${mutationVersion}`;
      stableBottom = atBottom && signature === previousBottom ? stableBottom + 1 : 0;
      previousBottom = signature;
      if (atBottom && stableBottom >= 8) {
        complete = true;
        break;
      }

      const viewport = Math.max(500, root.clientHeight || innerHeight || 800);
      await setTop(Math.min(max, top + Math.max(420, Math.floor(viewport * 0.68))));
    }
  } finally {
    observer.disconnect();
  }

  const items = [...collected.values()].map((entry) => ({
    external_id: `youtube-${kind}-${fnv(`${page}|${entry.source.key}|${entry.title}|${entry.content}|${entry.rowTextHash}`)}`,
    activity_type: "comment",
    title: kind === "live_chat" ? `[실시간 채팅] ${entry.title}` : entry.title,
    content: entry.content,
    source_url: entry.sourceUrl,
    occurred_at: null,
    metadata: {
      captured_from: location.href,
      page_title: document.title,
      ownership_scope: "self_activity",
      ownership_verified: true,
      extractor_version: "1.7.0",
      youtube_activity_kind: kind,
      my_activity_page: page,
      comment_id: entry.commentId || null,
      activity_token: entry.activityToken || null,
      original_url: entry.sourceUrl,
      original_link_resolved: Boolean(entry.sourceUrl),
      original_link_status: entry.sourceUrl ? "resolved" : "not_exposed",
      source_type: entry.source.type,
      source_id: entry.source.id || null,
      video_id: entry.source.type === "video" ? entry.source.id : null,
      post_id: entry.source.type === "post" ? entry.source.id : null,
      youtube_post_id: entry.source.type === "post" ? entry.source.id : null,
      deletion_locator: {
        version: 6,
        page,
        activity_token: entry.activityToken || null,
        comment_id: entry.commentId || null,
        row_text_hash: entry.rowTextHash,
        semantic_hash: entry.semanticHash,
        button_tag: entry.button?.tagName || null,
        button_role: entry.button?.getAttribute("role") || null,
        button_aria_label: entry.button?.getAttribute("aria-label") || null,
        button_title: entry.button?.getAttribute("title") || null,
        button_jslog: entry.button?.getAttribute("jslog") || null,
        title: entry.title,
        content: entry.content,
        source_type: entry.source.type,
        source_id: entry.source.id || null,
        source_url: entry.sourceUrl,
        video_id: entry.source.type === "video" ? entry.source.id : null,
        video_url: entry.source.type === "video" ? entry.sourceUrl : null,
        post_id: entry.source.type === "post" ? entry.source.id : null,
        post_url: entry.source.type === "post" ? entry.sourceUrl : null,
      },
    },
  }));

  return {
    complete,
    foundIds: [...foundIds],
    scannedUnique: collected.size,
    extraction: {
      platform: "youtube",
      source_url: location.href,
      scan_scope: kind,
      status: complete ? "success" : "partial",
      snapshot_complete: complete,
      message: complete
        ? `YouTube ${label} ${items.length}개를 끝까지 확인했습니다.`
        : `YouTube ${label} ${items.length}개를 확인했지만 끝까지 확인하지 못했습니다.`,
      account_label: null,
      items,
    },
    progress: {found: foundIds.size, total: targets.length, collected: items.length},
  };
};