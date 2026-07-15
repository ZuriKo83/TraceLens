globalThis.traceLensVerifyYouTubeTargetsInPage = async function(targets) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const norm = (value) => clean(value).toLowerCase();
  const expectedPage = "youtube_comments";
  if (location.hostname !== "myactivity.google.com"
    || new URL(location.href).searchParams.get("page") !== expectedPage) {
    throw new Error("Google 내 활동의 YouTube 댓글 페이지가 아닙니다.");
  }

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

  const canonicalSourceUrl = (value) => {
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
    if (!url) return {kind: null, id: "", key: ""};
    const postId = url.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
    if (postId) return {kind: "post", id: postId, key: `post:${postId}`};
    const videoId = url.searchParams.get("v") || "";
    return videoId ? {kind: "video", id: videoId, key: videoId} : {kind: null, id: "", key: ""};
  };

  const itemWrappers = () => [...document.querySelectorAll(
    'c-wiz[jsname="Ttx95"][data-token], c-wiz[data-show-delete-individual="true"][data-token]'
  )].filter((wrapper) => wrapper.querySelector('[role="listitem"][aria-label*="YouTube"], [role="listitem"]'));

  const parseItem = (wrapper) => {
    const card = wrapper.querySelector('[role="listitem"][aria-label*="YouTube"]')
      || wrapper.querySelector('[role="listitem"]')
      || wrapper;
    const commentAnchor = wrapper.querySelector('a[jsname="BLHFSc"][href*="lc="], a[href*="lc="]');
    const rawSourceUrl = commentAnchor?.href || commentAnchor?.getAttribute("href") || "";
    const sourceUrl = canonicalSourceUrl(rawSourceUrl);
    const commentId = clean(wrapper.getAttribute("data-token"))
      || parseUrl(rawSourceUrl)?.searchParams.get("lc")
      || "";
    const contentNode = wrapper.querySelector('.QTGV3c[jsname="r4nke"], [jsname="r4nke"], .QTGV3c');
    const titleNode = commentAnchor?.querySelector(".hFYxqd") || commentAnchor;
    const content = clean(contentNode?.innerText || contentNode?.textContent);
    const title = clean(titleNode?.innerText || titleNode?.textContent)
      || "YouTube 동영상";
    const rowText = clean(card.innerText || card.textContent);
    const identity = sourceIdentity(sourceUrl);
    const lines = String(card.innerText || card.textContent || "").split(/\r?\n/).map(clean).filter(Boolean);
    const datePattern = /^(?:\d{4}[.\-/]\s*)?\d{1,2}[.\-/]\s*\d{1,2}|\d{1,2}:\d{2}|오늘|어제|today|yesterday|오전|오후/i;
    const dateToken = lines.find((line) => datePattern.test(line)) || "";
    const stableAttributes = ["data-id", "jsdata", "data-ved", "data-item-id"]
      .map((name) => `${name}:${card.getAttribute(name) || ""}`).join("|");
    const semanticKey = `${expectedPage}|${identity.key}|${title}|${content}|${dateToken}|${stableAttributes}`;
    const button = wrapper.querySelector('button[jslog^="114566"]')
      || [...wrapper.querySelectorAll("button,[role='button']")].find((control) => /(삭제|delete|remove)/i.test(clean(control.getAttribute("aria-label"))));
    const semanticHash = fnv(`${expectedPage}|${identity.key}|${title}|${content}`);
    const rowTextHash = fnv(rowText);
    const externalId = `youtube-comment-${fnv(semanticKey)}`;
    const metadata = {
      captured_from: location.href,
      page_title: document.title,
      ownership_scope: "self_activity",
      ownership_verified: true,
      extractor_version: "1.4.1",
      youtube_activity_kind: "comment",
      my_activity_page: expectedPage,
      original_url: sourceUrl,
      original_link_resolved: Boolean(sourceUrl),
      original_link_status: sourceUrl ? "resolved" : "not_exposed",
      source_type: identity.kind,
      source_id: identity.id || null,
      video_id: identity.kind === "video" ? identity.id : null,
      post_id: identity.kind === "post" ? identity.id : null,
      youtube_post_id: identity.kind === "post" ? identity.id : null,
      deletion_locator: {
        version: 3,
        page: expectedPage,
        activity_token: commentId || null,
        comment_id: commentId || null,
        row_text_hash: rowTextHash,
        semantic_hash: semanticHash,
        button_tag: button?.tagName || null,
        button_role: button?.getAttribute("role") || null,
        button_aria_label: button?.getAttribute("aria-label") || null,
        button_title: button?.getAttribute("title") || null,
        button_jslog: button?.getAttribute("jslog") || null,
        title,
        content,
        source_type: identity.kind,
        source_id: identity.id || null,
        source_url: sourceUrl,
        video_id: identity.kind === "video" ? identity.id : null,
        video_url: identity.kind === "video" ? sourceUrl : null,
        post_id: identity.kind === "post" ? identity.id : null,
        post_url: identity.kind === "post" ? sourceUrl : null,
      },
    };
    return {
      commentId,
      title,
      content,
      fullTextNorm: norm(rowText),
      sourceKey: identity.key,
      semanticHash,
      rowTextHash,
      signature: commentId || `${identity.key}|${rowTextHash}`,
      item: {
        external_id: externalId,
        activity_type: "comment",
        title,
        content,
        source_url: sourceUrl,
        occurred_at: null,
        metadata,
      },
    };
  };

  const matchesTarget = (target, item) => {
    const locator = target.locator || {};
    const targetCommentId = clean(target.commentId || locator.comment_id || locator.activity_token);
    if (targetCommentId) return Boolean(item.commentId && targetCommentId === item.commentId);

    if (locator.semantic_hash && locator.semantic_hash === item.semanticHash) return true;
    const targetContent = norm(target.content || locator.content);
    const targetTitle = norm(target.title || locator.title);
    const exactContent = Boolean(targetContent && targetContent === norm(item.content));
    const contentInItem = Boolean(targetContent && item.fullTextNorm.includes(targetContent));
    const sameSource = Boolean(target.sourceKey && item.sourceKey && target.sourceKey === item.sourceKey);
    const genericTitle = /^(youtube\s*(동영상|게시물)|동영상|게시물|video|post)$/i.test(targetTitle);
    const sameSpecificTitle = Boolean(!genericTitle && targetTitle && targetTitle === norm(item.title));
    return (exactContent || contentInItem) && (sameSource || sameSpecificTitle);
  };

  const root = document.scrollingElement || document.documentElement;
  const collected = new Map();
  const foundIds = new Set();
  let bottomStable = 0;
  let previousBottom = "";
  let complete = false;

  window.scrollTo(0, 0);
  root.scrollTop = 0;
  root.dispatchEvent(new Event("scroll", {bubbles: true}));
  await sleep(180);

  for (let step = 0; step < 900 && collected.size < 5000; step += 1) {
    const currentItems = itemWrappers().map(parseItem).filter((item) => item.content);
    for (const item of currentItems) collected.set(item.signature, item);
    for (const target of targets) {
      if (!foundIds.has(target.id) && currentItems.some((item) => matchesTarget(target, item))) foundIds.add(target.id);
    }

    const max = Math.max(0, root.scrollHeight - root.clientHeight);
    const atBottom = root.scrollTop >= max - 8;
    const signature = `${root.scrollTop}|${root.scrollHeight}|${collected.size}`;
    bottomStable = atBottom && signature === previousBottom ? bottomStable + 1 : 0;
    previousBottom = signature;
    if (atBottom && bottomStable >= 5) {
      complete = true;
      break;
    }

    const before = root.scrollTop;
    root.scrollTop = Math.min(max, before + Math.max(700, Math.floor((root.clientHeight || innerHeight) * 0.92)));
    root.dispatchEvent(new Event("scroll", {bubbles: true}));
    if (root.scrollTop === before && !atBottom) window.scrollBy(0, Math.max(700, innerHeight * 0.92));
    await sleep(200);
  }

  const items = [...collected.values()].map((entry) => entry.item);
  const extraction = {
    platform: "youtube",
    source_url: location.href,
    scan_scope: "comment",
    status: complete ? "success" : "partial",
    snapshot_complete: complete,
    message: complete
      ? `YouTube 댓글 ${items.length}개를 한 번의 재검증으로 끝까지 확인했습니다.`
      : `YouTube 댓글 ${items.length}개를 확인했지만 끝까지 확인하지 못했습니다.`,
    account_label: null,
    items,
  };

  return {
    complete,
    foundIds: [...foundIds],
    scannedUnique: collected.size,
    extraction,
    progress: {found: foundIds.size, total: targets.length, collected: items.length},
  };
};