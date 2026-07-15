globalThis.traceLensVerifyYouTubeTargetsInPage = async function(targets) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
  const norm = (v) => clean(v).toLowerCase();
  const expectedPage = "youtube_comments";
  if (location.hostname !== "myactivity.google.com" || new URL(location.href).searchParams.get("page") !== expectedPage) {
    throw new Error("Google 내 활동의 YouTube 댓글 페이지가 아닙니다.");
  }
  const fnv = (value) => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const canonical = (value) => {
    if (!value) return null;
    try {
      const u = new URL(value, location.href); const host = u.hostname.toLowerCase().replace(/^www\./, "");
      if (host === "youtu.be") { const id = u.pathname.split("/").filter(Boolean)[0]; return id ? `https://www.youtube.com/watch?v=${id}` : null; }
      if (!["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) return null;
      const post = u.pathname.match(/^\/post\/([^/?#]+)/i)?.[1]; if (post) return `https://www.youtube.com/post/${post}`;
      const video = u.searchParams.get("v") || u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i)?.[1];
      return video ? `https://www.youtube.com/watch?v=${video}` : null;
    } catch { return null; }
  };
  const sourceKey = (value) => {
    if (!value) return "";
    try { const u = new URL(value); const post = u.pathname.match(/^\/post\/([^/?#]+)/i)?.[1]; return post ? `post:${post}` : (u.searchParams.get("v") || ""); }
    catch { return ""; }
  };
  const isVisible = (element) => {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  };
  const controlLabel = (element) => clean(`${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.innerText || element.textContent || ""}`);
  const controls = () => [...document.querySelectorAll("button,[role='button'],[role='menuitem']")].filter((element) => {
    if (!isVisible(element)) return false;
    const label = controlLabel(element);
    return /(삭제|삭제하기|delete|remove|더보기|옵션|메뉴|more|options|actions)/i.test(label) || element.getAttribute("aria-haspopup") === "menu";
  });
  const rowFor = (control) => {
    const direct = control.closest("[role='listitem'],article,li,div[data-id],div[jsdata],div[data-ved]");
    if (direct) return direct;
    let node = control.parentElement;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      const text = clean(node.innerText || node.textContent);
      const hasYouTubeLink = [...node.querySelectorAll("a[href]")].some((anchor) => Boolean(canonical(anchor.href)));
      if (text.length >= 3 && text.length <= 12000 && (hasYouTubeLink || /YouTube|남긴 댓글|작성한 댓글|commented on/i.test(text))) return node;
    }
    return null;
  };
  const parseRow = (row) => {
    const anchors = [...row.querySelectorAll("a[href]")];
    const urls = anchors.map((a) => canonical(a.href || a.getAttribute("href"))).filter(Boolean);
    const url = urls[0] || null;
    const link = anchors.find((a) => canonical(a.href || a.getAttribute("href")) === url);
    const linkTitle = clean(link?.innerText || link?.textContent);
    const lines = String(row.innerText || row.textContent || "").split(/\r?\n/).map(clean).filter(Boolean);
    const control = /^(YouTube|세부정보|Details|삭제|삭제하기|Delete|Remove|더보기|옵션|오전|오후|AM|PM)$/i;
    const relation = /에\s*남긴\s*댓글|에\s*작성한\s*댓글|commented on/i;
    const dateLine = /^(?:\d{4}[.\-/]\s*)?\d{1,2}[.\-/]\s*\d{1,2}|\d{1,2}:\d{2}|오늘|어제|today|yesterday/i;
    const candidates = lines.filter((line) => !control.test(line));
    const content = candidates.find((line) => !relation.test(line) && !dateLine.test(line) && line !== linkTitle && !/^YouTube$/i.test(line)) || "";
    let title = linkTitle;
    if (!title || title === content || /^(YouTube|동영상|video)$/i.test(title)) {
      const relationLine = candidates.find((line) => relation.test(line));
      title = relationLine ? relationLine.replace(relation, "").trim() : "";
    }
    const body = clean(content); const key = sourceKey(url); const text = clean(row.innerText || row.textContent);
    return {title: clean(title), content: body, fullText: norm(text), sourceKey: key, rowDataId: row.getAttribute("data-id") || "", rowJsdata: row.getAttribute("jsdata") || "", rowDataVed: row.getAttribute("data-ved") || "", rowTextHash: fnv(text), semanticHash: fnv(`${expectedPage}|${key}|${clean(title)}|${body}`), signature: `${row.getAttribute("data-id") || ""}|${key}|${fnv(text)}`};
  };
  const score = (target, row) => {
    const locator = target.locator || {}; let value = 0; let strong = false;
    const exact = (a, b, weight) => { if (a && b && String(a) === String(b)) { value += weight; strong = true; } };
    exact(locator.semantic_hash, row.semanticHash, 140); exact(locator.row_data_id, row.rowDataId, 125); exact(locator.row_jsdata, row.rowJsdata, 110); exact(locator.row_data_ved, row.rowDataVed, 100); exact(locator.row_text_hash, row.rowTextHash, 85);
    const tt = norm(target.title || locator.title); const tc = norm(target.content || locator.content); const rt = norm(row.title); const rc = norm(row.content);
    const sameSource = Boolean(target.sourceKey && row.sourceKey && target.sourceKey === row.sourceKey);
    const sameContent = Boolean(tc && rc && tc === rc); const contentInRow = Boolean(tc && row.fullText.includes(tc)); const sameTitle = Boolean(tt && rt && tt === rt); const titleInRow = Boolean(tt && row.fullText.includes(tt));
    if (sameSource) value += 52;
    if (sameContent) { value += 72; strong = true; }
    else if (contentInRow) { value += 58; if (sameSource || sameTitle || titleInRow) strong = true; }
    else if (tc && rc && (tc.includes(rc) || rc.includes(tc))) value += 34;
    if (sameTitle) value += 28; else if (titleInRow) value += 18;
    return value >= 72 && (strong || value >= 100);
  };
  const scrollers = () => {
    const list = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll("body *")].filter(Boolean).filter((el) => {
      const style = getComputedStyle(el); const rect = el.getBoundingClientRect?.() || {height: 0};
      return rect.height >= 250 && el.scrollHeight > el.clientHeight + 100 && (el === document.scrollingElement || /(auto|scroll)/.test(style.overflowY || ""));
    });
    return [...new Set(list)].sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  };

  const foundIds = new Set(); const scanned = new Set(); let stable = 0; let previous = "";
  window.scrollTo(0, 0); scrollers().slice(0, 4).forEach((el) => { el.scrollTop = 0; }); await sleep(420);
  for (let step = 0; step < 800; step += 1) {
    const seen = new Set(); const rows = [];
    for (const control of controls()) {
      const node = rowFor(control);
      if (!node || seen.has(node)) continue;
      seen.add(node); const row = parseRow(node); rows.push(row); scanned.add(row.signature);
    }
    for (const target of targets) {
      if (!foundIds.has(target.id) && rows.some((row) => score(target, row))) foundIds.add(target.id);
    }
    const active = scrollers().slice(0, 4);
    const signature = `${foundIds.size}|${document.documentElement.scrollHeight}|${active.map((el) => `${el.scrollTop}:${el.scrollHeight}`).join(",")}`;
    stable = signature === previous ? stable + 1 : 0; previous = signature;
    if (foundIds.size === targets.length || stable >= 16) break;
    let moved = false;
    for (const el of active) {
      const before = el.scrollTop; const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.min(max, before + Math.max(520, Math.floor((el.clientHeight || innerHeight) * 0.68)));
      el.dispatchEvent(new Event("scroll", {bubbles: true}));
      if (el.scrollTop !== before) moved = true;
    }
    if (!moved) window.scrollBy(0, Math.max(600, innerHeight * 0.68));
    await sleep(420);
  }
  return {complete: foundIds.size === targets.length || stable >= 16, foundIds: [...foundIds], scannedUnique: scanned.size, progress: {found: foundIds.size, total: targets.length}};
};
