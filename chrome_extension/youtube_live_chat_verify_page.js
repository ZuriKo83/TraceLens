globalThis.traceLensVerifyYouTubeLiveChatTargetsInPage = async function(targets) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const norm = (value) => clean(value).toLowerCase();
  const fnv = (value) => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const page = new URL(location.href).searchParams.get("page");
  if (location.hostname !== "myactivity.google.com" || page !== "youtube_live_chat") {
    throw new Error("Google 내 활동의 YouTube 실시간 채팅 페이지가 아닙니다.");
  }
  const visible = (element) => {
    if (!element?.isConnected || element.disabled) return false;
    const rect = element.getBoundingClientRect?.();
    const style = getComputedStyle(element);
    return Boolean(rect && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden");
  };
  const buttons = () => [...document.querySelectorAll('button[jslog^="114566"],button,[role="button"]')].filter(visible).filter((button) => {
    const label = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
    const text = clean(button.innerText || button.textContent);
    return button.matches('button[jslog^="114566"]') || /삭제|delete|remove/i.test(label) || ["×", "✕", "X"].includes(text);
  });
  const rowFor = (button) => button.closest('c-wiz[data-token],[role="listitem"],article,li,div[data-id]');
  const parseUrl = (value) => { try { return value ? new URL(value, location.href) : null; } catch { return null; } };
  const canonicalUrl = (value) => {
    const url = parseUrl(value);
    if (!url) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : null;
    }
    if (!["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) return null;
    const post = url.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
    if (post) return `https://www.youtube.com/post/${post}`;
    const video = url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i)?.[1];
    return video ? `https://www.youtube.com/watch?v=${video}` : null;
  };
  const identity = (value) => {
    const url = parseUrl(value);
    if (!url) return {kind:null,id:"",key:""};
    const post = url.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
    if (post) return {kind:"post",id:post,key:`post:${post}`};
    const video = url.searchParams.get("v") || "";
    return video ? {kind:"video",id:video,key:video} : {kind:null,id:"",key:""};
  };
  const parse = (row, button) => {
    const rawUrl = row.querySelector('a[href*="youtube.com"],a[href*="youtu.be"]')?.href || "";
    const sourceUrl = canonicalUrl(rawUrl);
    const source = identity(sourceUrl);
    const titleLink = row.querySelector('a[href*="youtube.com"],a[href*="youtu.be"]');
    const title = clean(titleLink?.innerText || titleLink?.textContent) || "YouTube 실시간 스트리밍";
    const rowText = clean(row.innerText || row.textContent);
    const lines = String(row.innerText || row.textContent || "").split(/\r?\n/).map(clean).filter(Boolean);
    const relation = /에서\s*메시지를\s*전송함|sent a message/i;
    const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM|×|✕|X)$/i;
    const dateLine = /^(?:\d{4}[.\-/]\s*)?\d{1,2}[.\-/]\s*\d{1,2}|\d{1,2}:\d{2}|오늘|어제|today|yesterday/i;
    const content = lines.find((line) => !control.test(line) && !relation.test(line) && !dateLine.test(line) && line !== title) || "";
    const token = clean(row.getAttribute("data-token") || row.closest("c-wiz[data-token]")?.getAttribute("data-token") || parseUrl(rawUrl)?.searchParams.get("lc"));
    const semanticHash = fnv(`youtube_live_chat|${source.key}|${title}|${content}`);
    const rowTextHash = fnv(rowText);
    const dateToken = lines.find((line) => dateLine.test(line)) || "";
    const externalId = `youtube-live_chat-${fnv(`youtube_live_chat|${source.key}|${title}|${content}|${dateToken}`)}`;
    return {
      token, title, content, rowText, rowTextNorm: norm(rowText), sourceUrl, sourceKey: source.key, semanticHash, rowTextHash,
      signature: token || `${source.key}|${rowTextHash}`,
      item: {
        external_id: externalId,
        activity_type: "comment",
        title: `[실시간 채팅] ${title}`,
        content,
        source_url: sourceUrl,
        occurred_at: null,
        metadata: {
          captured_from: location.href,
          page_title: document.title,
          ownership_scope: "self_activity",
          ownership_verified: true,
          extractor_version: "1.5.0",
          youtube_activity_kind: "live_chat",
          my_activity_page: "youtube_live_chat",
          comment_id: token || null,
          original_url: sourceUrl,
          original_link_resolved: Boolean(sourceUrl),
          original_link_status: sourceUrl ? "resolved" : "not_exposed",
          source_type: source.kind,
          source_id: source.id || null,
          video_id: source.kind === "video" ? source.id : null,
          post_id: source.kind === "post" ? source.id : null,
          youtube_post_id: source.kind === "post" ? source.id : null,
          deletion_locator: {
            version: 4,
            page: "youtube_live_chat",
            activity_token: token || null,
            comment_id: token || null,
            row_text_hash: rowTextHash,
            semantic_hash: semanticHash,
            button_tag: button?.tagName || null,
            button_role: button?.getAttribute("role") || null,
            button_aria_label: button?.getAttribute("aria-label") || null,
            button_title: button?.getAttribute("title") || null,
            button_jslog: button?.getAttribute("jslog") || null,
            title,
            content,
            source_type: source.kind,
            source_id: source.id || null,
            source_url: sourceUrl,
            video_id: source.kind === "video" ? source.id : null,
            video_url: source.kind === "video" ? sourceUrl : null,
            post_id: source.kind === "post" ? source.id : null,
            post_url: source.kind === "post" ? sourceUrl : null
          }
        }
      }
    };
  };
  const items = () => buttons().map((button) => ({button,row:rowFor(button)})).filter((entry) => entry.row).map((entry) => parse(entry.row, entry.button)).filter((entry) => entry.content);
  const matches = (target, item) => {
    const locator = target.locator || {};
    const token = clean(target.commentId || locator.comment_id || locator.activity_token);
    if (token) return Boolean(item.token && token === item.token);
    if (locator.semantic_hash && locator.semantic_hash === item.semanticHash) return true;
    if (locator.row_text_hash && locator.row_text_hash === item.rowTextHash) return true;
    const content = norm(target.content || locator.content);
    const title = norm(locator.title || target.title).replace(/^\[실시간 채팅\]\s*/, "");
    const sameContent = Boolean(content && (content === norm(item.content) || item.rowTextNorm.includes(content)));
    const sameSource = Boolean(target.sourceKey && item.sourceKey && target.sourceKey === item.sourceKey);
    const sameTitle = Boolean(title && title === norm(item.title));
    return sameContent && (sameSource || sameTitle);
  };
  const root = document.scrollingElement || document.documentElement;
  root.scrollTop = 0; window.scrollTo(0,0); root.dispatchEvent(new Event("scroll", {bubbles:true})); await sleep(220);
  const collected = new Map();
  const foundIds = new Set();
  let stable = 0, previous = "", complete = false;
  for (let step = 0; step < 1200 && collected.size < 5000; step += 1) {
    const current = items();
    current.forEach((entry) => collected.set(entry.signature, entry));
    for (const target of targets) if (!foundIds.has(target.id) && current.some((entry) => matches(target, entry))) foundIds.add(target.id);
    const max = Math.max(0, root.scrollHeight - root.clientHeight);
    const atBottom = max <= 2 || root.scrollTop >= max - 5;
    const signature = `${root.scrollTop}|${root.scrollHeight}|${collected.size}`;
    stable = atBottom && signature === previous ? stable + 1 : 0; previous = signature;
    if (atBottom && stable >= 8) { complete = true; break; }
    root.scrollTop = Math.min(max, root.scrollTop + Math.max(500, Math.floor((root.clientHeight || innerHeight || 800) * 0.72)));
    window.scrollTo(0, root.scrollTop); root.dispatchEvent(new Event("scroll", {bubbles:true})); await sleep(240);
  }
  const extracted = [...collected.values()].map((entry) => entry.item);
  return {
    complete,
    foundIds: [...foundIds],
    scannedUnique: collected.size,
    extraction: {
      platform: "youtube",
      source_url: location.href,
      scan_scope: "live_chat",
      status: complete ? "success" : "partial",
      snapshot_complete: complete,
      message: complete
        ? `YouTube 실시간 채팅 ${extracted.length}개를 끝까지 확인했습니다.`
        : `YouTube 실시간 채팅 ${extracted.length}개를 확인했지만 끝까지 확인하지 못했습니다.`,
      account_label: null,
      items: extracted
    },
    progress: {found: foundIds.size, total: targets.length, collected: extracted.length}
  };
};