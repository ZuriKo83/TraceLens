globalThis.traceLensVerifyYouTubeActivityTargetsInPage = async function(targets) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const norm = (value) => clean(value).toLowerCase();
  const kind = targets?.[0]?.activityKind === "live_chat" ? "live_chat" : "comment";
  const page = kind === "live_chat" ? "youtube_live_chat" : "youtube_comments";
  const label = kind === "live_chat" ? "실시간 채팅" : "댓글";
  if (location.hostname !== "myactivity.google.com" || new URL(location.href).searchParams.get("page") !== page) {
    throw new Error(`Google 내 활동의 YouTube ${label} 페이지가 아닙니다.`);
  }

  const fnv = (value) => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
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
    if (!url) return {type: null, id: "", key: ""};
    const post = url.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
    if (post) return {type: "post", id: post, key: `post:${post}`};
    const video = url.searchParams.get("v") || "";
    return video ? {type: "video", id: video, key: video} : {type: null, id: "", key: ""};
  };
  const visible = (node) => {
    if (!node?.isConnected || node.disabled) return false;
    const rect = node.getBoundingClientRect?.();
    const style = getComputedStyle(node);
    return Boolean(rect && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden");
  };
  const isDelete = (button) => {
    const text = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.innerText || button.textContent || ""}`);
    return button.matches?.('button[jslog^="114566"]') || /삭제|delete|remove|^[×✕X]$/i.test(text);
  };
  const wrappers = () => {
    const exact = [...document.querySelectorAll('c-wiz[jsname="Ttx95"][data-token],c-wiz[data-show-delete-individual="true"][data-token]')];
    const fallback = [...document.querySelectorAll('button[jslog^="114566"],button,[role="button"]')]
      .filter(visible).filter(isDelete)
      .map((button) => button.closest('c-wiz[data-token],[role="listitem"],article,li,div[data-id]')).filter(Boolean);
    return [...new Set([...exact, ...fallback])];
  };
  const contentFromLines = (row, title) => {
    const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM|×|✕|X)$/i;
    const relation = /에\s*남긴\s*댓글|에\s*작성한\s*댓글|에서\s*메시지를\s*전송함|commented on|sent a message/i;
    const date = /^(?:\d{4}[.\-/]\s*)?\d{1,2}[.\-/]\s*\d{1,2}|\d{1,2}:\d{2}|오늘|어제|today|yesterday/i;
    return String(row.innerText || row.textContent || "").split(/\r?\n/).map(clean).filter(Boolean)
      .find((line) => !control.test(line) && !relation.test(line) && !date.test(line) && line !== title) || "";
  };
  const parse = (wrapper) => {
    const row = wrapper.querySelector('[role="listitem"][aria-label*="YouTube"],[role="listitem"]') || wrapper;
    const anchor = wrapper.querySelector('a[jsname="BLHFSc"][href*="lc="],a[href*="lc="]')
      || wrapper.querySelector('a[jsname="BLHFSc"][href],a[href*="youtube.com"],a[href*="youtu.be"]');
    const rawUrl = anchor?.href || anchor?.getAttribute("href") || "";
    const sourceUrl = canonicalUrl(rawUrl);
    const source = identity(sourceUrl);
    const token = clean(wrapper.getAttribute("data-token") || wrapper.closest("c-wiz[data-token]")?.getAttribute("data-token") || parseUrl(rawUrl)?.searchParams.get("lc"));
    const title = clean(anchor?.querySelector?.(".hFYxqd")?.innerText || anchor?.innerText || anchor?.textContent)
      || (kind === "live_chat" ? "YouTube 실시간 스트리밍" : "YouTube 동영상");
    const direct = wrapper.querySelector('.QTGV3c[jsname="r4nke"],[jsname="r4nke"],.QTGV3c');
    const content = clean(direct?.innerText || direct?.textContent) || contentFromLines(row, title);
    const rowText = clean(row.innerText || row.textContent);
    const semanticHash = fnv(`${page}|${source.key}|${title}|${content}`);
    const rowTextHash = fnv(rowText);
    const button = [...wrapper.querySelectorAll('button[jslog^="114566"],button,[role="button"]')].find((item) => visible(item) && isDelete(item));
    return {token, title, content, rowTextNorm: norm(rowText), source, sourceUrl, semanticHash, rowTextHash,
      signature: token || `${source.key}|${rowTextHash}`, button};
  };
  const titleOf = (target, locator) => norm(target.title || locator.title).replace(/^\[실시간 채팅\]\s*/, "");
  const score = (target, item) => {
    const locator = target.locator || {};
    const token = clean(target.commentId || locator.comment_id || locator.activity_token);
    if (token) return token === item.token ? 500 : 0;
    if (locator.semantic_hash && locator.semantic_hash === item.semanticHash) return 400;
    if (locator.row_text_hash && locator.row_text_hash === item.rowTextHash) return 320;
    const content = norm(target.content || locator.content);
    const title = titleOf(target, locator);
    let value = content && content === norm(item.content) ? 130 : (content && item.rowTextNorm.includes(content) ? 95 : 0);
    if (target.sourceKey && target.sourceKey === item.source.key) value += 50;
    if (title && title === norm(item.title)) value += 35;
    return value;
  };
  const uniqueMatch = (target, items) => {
    const ranked = items.map((item) => score(target, item)).sort((a, b) => b - a);
    return Boolean(ranked[0] >= 95 && !(ranked[1] === ranked[0] && ranked[0] < 500));
  };

  const root = document.scrollingElement || document.documentElement;
  const collected = new Map();
  const foundIds = new Set();
  let stable = 0;
  let previous = "";
  let complete = false;
  root.scrollTop = 0; window.scrollTo(0, 0); root.dispatchEvent(new Event("scroll", {bubbles: true})); await sleep(180);
  for (let step = 0; step < 900 && collected.size < 5000; step += 1) {
    const current = wrappers().map(parse).filter((item) => item.content);
    current.forEach((item) => collected.set(item.signature, item));
    for (const target of targets) if (!foundIds.has(target.id) && uniqueMatch(target, current)) foundIds.add(target.id);
    const max = Math.max(0, root.scrollHeight - root.clientHeight);
    const atBottom = root.scrollTop >= max - 8;
    const signature = `${root.scrollTop}|${root.scrollHeight}|${collected.size}`;
    stable = atBottom && signature === previous ? stable + 1 : 0; previous = signature;
    if (atBottom && stable >= 5) { complete = true; break; }
    const before = root.scrollTop;
    root.scrollTop = Math.min(max, before + Math.max(700, Math.floor((root.clientHeight || innerHeight) * 0.92)));
    root.dispatchEvent(new Event("scroll", {bubbles: true}));
    if (root.scrollTop === before && !atBottom) window.scrollBy(0, Math.max(700, innerHeight * 0.92));
    await sleep(200);
  }

  const items = [...collected.values()].map((entry) => ({
    external_id: `youtube-${kind}-${fnv(`${page}|${entry.source.key}|${entry.title}|${entry.content}|${entry.rowTextHash}`)}`,
    activity_type: "comment",
    title: kind === "live_chat" ? `[실시간 채팅] ${entry.title}` : entry.title,
    content: entry.content,
    source_url: entry.sourceUrl,
    occurred_at: null,
    metadata: {
      captured_from: location.href, page_title: document.title, ownership_scope: "self_activity", ownership_verified: true,
      extractor_version: "1.6.0", youtube_activity_kind: kind, my_activity_page: page, comment_id: entry.token || null,
      original_url: entry.sourceUrl, original_link_resolved: Boolean(entry.sourceUrl), original_link_status: entry.sourceUrl ? "resolved" : "not_exposed",
      source_type: entry.source.type, source_id: entry.source.id || null,
      video_id: entry.source.type === "video" ? entry.source.id : null,
      post_id: entry.source.type === "post" ? entry.source.id : null,
      youtube_post_id: entry.source.type === "post" ? entry.source.id : null,
      deletion_locator: {
        version: 4, page, activity_token: entry.token || null, comment_id: entry.token || null,
        row_text_hash: entry.rowTextHash, semantic_hash: entry.semanticHash,
        button_tag: entry.button?.tagName || null, button_role: entry.button?.getAttribute("role") || null,
        button_aria_label: entry.button?.getAttribute("aria-label") || null, button_title: entry.button?.getAttribute("title") || null,
        button_jslog: entry.button?.getAttribute("jslog") || null, title: entry.title, content: entry.content,
        source_type: entry.source.type, source_id: entry.source.id || null, source_url: entry.sourceUrl,
        video_id: entry.source.type === "video" ? entry.source.id : null, video_url: entry.source.type === "video" ? entry.sourceUrl : null,
        post_id: entry.source.type === "post" ? entry.source.id : null, post_url: entry.source.type === "post" ? entry.sourceUrl : null
      }
    }
  }));
  return {
    complete,
    foundIds: [...foundIds],
    scannedUnique: collected.size,
    extraction: {
      platform: "youtube", source_url: location.href, scan_scope: kind,
      status: complete ? "success" : "partial", snapshot_complete: complete,
      message: complete ? `YouTube ${label} ${items.length}개를 한 번의 재검증으로 끝까지 확인했습니다.` : `YouTube ${label} ${items.length}개를 확인했지만 끝까지 확인하지 못했습니다.`,
      account_label: null, items
    },
    progress: {found: foundIds.size, total: targets.length, collected: items.length}
  };
};