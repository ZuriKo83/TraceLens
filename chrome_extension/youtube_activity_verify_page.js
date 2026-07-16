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

  const sourceInfo = (value) => {
    for (const candidate of decodedCandidates(value)) {
      const parsed = parseUrl(candidate);
      if (!parsed) continue;
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (host === "youtu.be") {
        const id = parsed.pathname.split("/").filter(Boolean)[0];
        if (id) return {key:id,url:`https://www.youtube.com/watch?v=${id}`,type:"video",id};
      }
      if (!["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) continue;
      const postId = parsed.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
      if (postId) return {key:`post:${postId}`,url:`https://www.youtube.com/post/${postId}`,type:"post",id:postId};
      const videoId = parsed.searchParams.get("v") || parsed.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i)?.[1];
      if (videoId) return {key:videoId,url:`https://www.youtube.com/watch?v=${videoId}`,type:"video",id:videoId};
    }
    return {key:"",url:null,type:null,id:""};
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

  const wrappers = () => {
    const exact = [...document.querySelectorAll('c-wiz[jsname="Ttx95"],c-wiz[data-show-delete-individual="true"]')];
    const fallback = visibleDeleteButtons().map(wrapperForButton).filter(Boolean);
    return [...new Set([...exact, ...fallback])].filter((wrapper) => wrapper.querySelector('button,[role="button"]'));
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
      || (kind === "live_chat" ? "YouTube 실시간 스트리밍" : "YouTube 동영상");

    const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM|×|✕|X)$/i;
    const dateLine = /^(?:\d{4}[.\-/]\s*)?\d{1,2}[.\-/]\s*\d{1,2}|\d{1,2}:\d{2}|오늘|어제|today|yesterday/i;
    const directNode = wrapper.querySelector('.QTGV3c[jsname="r4nke"],[jsname="r4nke"],.QTGV3c');
    const directText = clean(directNode?.innerText || directNode?.textContent);
    const content = directText && !relationPattern.test(directText) && directText !== title
      ? directText
      : lines.find((line) => !control.test(line) && !dateLine.test(line) && !relationPattern.test(line) && line !== title) || "";

    const hrefValues = anchors.flatMap((anchor) => [anchor.href, anchor.getAttribute("href")]).filter(Boolean);
    const commentId = hrefValues.map((value) => extractParam(value, "lc")).find(Boolean) || "";
    const source = hrefValues.map(sourceInfo).find((entry) => entry.key) || {key:"",url:null,type:null,id:""};
    const rowText = clean(card.innerText || card.textContent || wrapper.innerText || wrapper.textContent);
    const button = [...wrapper.querySelectorAll('button[jslog^="114566"],button,[role="button"]')]
      .find((candidate) => isVisible(candidate) && looksLikeDeleteButton(candidate)) || null;

    return {
      commentId,
      title,
      content,
      rowText,
      rowTextNorm:norm(rowText),
      rowTextLoose:loose(rowText),
      source,
      button,
      signature:commentId || `${source.key}|${loose(content)}|${loose(title)}`,
    };
  };

  const visibleItems = () => wrappers().map(parseItem).filter((item) => item.content && item.button);

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

    if (wantedContent && wantedContent === itemContent) { value += 260; strong = true; }
    else if (wantedContentLoose.length >= 2 && wantedContentLoose === itemContentLoose) { value += 240; strong = true; }
    else if (wantedContent && item.rowTextNorm.includes(wantedContent)) { value += 190; strong = true; }
    else if (wantedContentLoose.length >= 3 && item.rowTextLoose.includes(wantedContentLoose)) { value += 170; strong = true; }

    if (target.sourceKey && item.source.key && target.sourceKey === item.source.key) value += 110;
    if (wantedTitle && norm(item.title) === wantedTitle) value += 90;
    else if (wantedTitleLoose.length >= 3 && item.rowTextLoose.includes(wantedTitleLoose)) value += 70;

    return {value,strong};
  };

  const bestFor = (target, items) => {
    const ranked = items.map((item) => ({item,...score(target,item)})).sort((left,right) => right.value - left.value);
    const best = ranked[0];
    if (!best || best.value < 170 || !best.strong) return null;
    const second = ranked[1];
    if (second && second.value === best.value && best.value < 1000) return null;
    return best.item;
  };

  const isDocumentRoot = (element) => [document.scrollingElement,document.documentElement,document.body].includes(element);
  const pickScrollRoot = () => {
    const buttons = visibleDeleteButtons();
    const candidates = [document.scrollingElement,document.documentElement,document.body,...document.querySelectorAll("body *")]
      .filter(Boolean)
      .filter((element) => {
        const rect = element.getBoundingClientRect?.() || {height:0};
        const style = getComputedStyle(element);
        return rect.height >= 220 && element.scrollHeight > element.clientHeight + 60
          && (isDocumentRoot(element) || /(auto|scroll)/.test(style.overflowY || ""));
      });
    return [...new Set(candidates)].map((element) => ({
      element,
      score:buttons.filter((button) => isDocumentRoot(element) || element.contains(button)).length * 1000000
        + Math.max(0,element.scrollHeight - element.clientHeight),
    })).sort((left,right) => right.score - left.score)[0]?.element || document.scrollingElement || document.documentElement;
  };

  let root = pickScrollRoot();
  const currentTop = () => isDocumentRoot(root) ? (window.scrollY || root.scrollTop || 0) : root.scrollTop;
  const maxTop = () => Math.max(0,root.scrollHeight - root.clientHeight);
  const setTop = async (top) => {
    const next = Math.max(0,Math.min(Number(top) || 0,maxTop()));
    if (isDocumentRoot(root)) window.scrollTo(0,next);
    root.scrollTop = next;
    root.dispatchEvent(new Event("scroll",{bubbles:true}));
    await sleep(280);
  };

  let mutationVersion = 0;
  const observer = new MutationObserver(() => { mutationVersion += 1; });
  observer.observe(document.documentElement,{subtree:true,childList:true});

  const collected = new Map();
  const foundIds = new Set();
  let stableBottom = 0;
  let previousBottom = "";
  let complete = false;

  try {
    await setTop(0);
    for (let step = 0; step < 2000 && collected.size < 5000; step += 1) {
      if (step > 0 && step % 20 === 0) {
        const nextRoot = pickScrollRoot();
        if (nextRoot && nextRoot !== root && nextRoot.scrollHeight - nextRoot.clientHeight > root.scrollHeight - root.clientHeight) root = nextRoot;
      }
      const current = visibleItems();
      current.forEach((item) => collected.set(item.signature,item));
      for (const target of targets) {
        if (!foundIds.has(target.id) && bestFor(target,current)) foundIds.add(target.id);
      }
      const max = maxTop();
      const top = currentTop();
      const atBottom = max <= 3 || top >= max - 6;
      const signature = `${top}|${root.scrollHeight}|${collected.size}|${mutationVersion}`;
      stableBottom = atBottom && signature === previousBottom ? stableBottom + 1 : 0;
      previousBottom = signature;
      if (atBottom && stableBottom >= 8) { complete = true; break; }
      const viewport = Math.max(500,root.clientHeight || innerHeight || 800);
      await setTop(Math.min(max,top + Math.max(420,Math.floor(viewport * 0.65))));
    }
  } finally {
    observer.disconnect();
  }

  const items = [...collected.values()].map((entry) => ({
    external_id:`youtube-${kind}-${fnv(`${page}|${entry.source.key}|${entry.title}|${entry.content}|${entry.signature}`)}`,
    activity_type:"comment",
    title:kind === "live_chat" ? `[실시간 채팅] ${entry.title}` : entry.title,
    content:entry.content,
    source_url:entry.source.url,
    occurred_at:null,
    metadata:{
      captured_from:location.href,
      page_title:document.title,
      ownership_scope:"self_activity",
      ownership_verified:true,
      extractor_version:"1.8.0",
      youtube_activity_kind:kind,
      my_activity_page:page,
      comment_id:entry.commentId || null,
      source_type:entry.source.type,
      source_id:entry.source.id || null,
      video_id:entry.source.type === "video" ? entry.source.id : null,
      post_id:entry.source.type === "post" ? entry.source.id : null,
    },
  }));

  return {
    complete,
    foundIds:[...foundIds],
    scannedUnique:collected.size,
    extraction:{
      platform:"youtube",
      source_url:location.href,
      scan_scope:kind,
      status:complete ? "success" : "partial",
      snapshot_complete:complete,
      message:complete
        ? items.length ? `YouTube ${label} ${items.length}개를 끝까지 확인했습니다.` : `YouTube ${label} 기록이 없습니다. 끝까지 확인했습니다.`
        : `YouTube ${label} ${items.length}개를 확인했지만 끝까지 확인하지 못했습니다.`,
      account_label:null,
      items,
    },
    progress:{found:foundIds.size,total:targets.length,collected:items.length},
  };
};