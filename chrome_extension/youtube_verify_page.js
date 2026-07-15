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
  const buttons = () => [...document.querySelectorAll("button,[role='button']")].filter((button) => {
    const label = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`); const text = clean(button.innerText || button.textContent);
    return /삭제|delete|remove|활동 삭제/i.test(label) || ["×", "✕", "X"].includes(text);
  });
  const rowFor = (button) => {
    const direct = button.closest("[role='listitem'],article,li,div[data-id]"); if (direct) return direct;
    let node = button.parentElement;
    for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
      const text = clean(node.innerText || node.textContent); if (text.length >= 3 && text.length <= 9000 && /YouTube/i.test(text)) return node;
    }
    return null;
  };
  const parseRow = (row) => {
    const anchors = [...row.querySelectorAll("a[href]")]; const urls = anchors.map((a) => canonical(a.href || a.getAttribute("href"))).filter(Boolean);
    const url = urls[0] || null; const link = anchors.find((a) => canonical(a.href || a.getAttribute("href")) === url); const linkTitle = clean(link?.innerText || link?.textContent);
    const lines = String(row.innerText || row.textContent || "").split(/\r?\n/).map(clean).filter(Boolean);
    const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM)$/i; const relation = /에\s*남긴\s*댓글|에\s*작성한\s*댓글|commented on/i;
    const candidates = lines.filter((line) => !control.test(line)); const content = candidates.find((line) => !relation.test(line) && line !== linkTitle && !/^YouTube$/i.test(line)) || "";
    let title = linkTitle;
    if (!title || title === content || /^(YouTube|동영상|video)$/i.test(title)) { const relationLine = candidates.find((line) => relation.test(line)); title = relationLine ? relationLine.replace(relation, "").trim() : ""; }
    title = clean(title); const body = clean(content); const key = sourceKey(url); const text = clean(row.innerText || row.textContent);
    return {title, content: body, sourceKey: key, rowDataId: row.getAttribute("data-id") || "", rowJsdata: row.getAttribute("jsdata") || "", rowDataVed: row.getAttribute("data-ved") || "", rowTextHash: fnv(text), semanticHash: fnv(`${expectedPage}|${key}|${title}|${body}`), signature: `${row.getAttribute("data-id") || ""}|${key}|${fnv(text)}`};
  };
  const score = (target, row) => {
    const locator = target.locator || {}; let value = 0; let strong = false;
    const exact = (a, b, weight) => { if (a && b && String(a) === String(b)) { value += weight; strong = true; } };
    exact(locator.semantic_hash, row.semanticHash, 130); exact(locator.row_data_id, row.rowDataId, 120); exact(locator.row_jsdata, row.rowJsdata, 105); exact(locator.row_data_ved, row.rowDataVed, 95); exact(locator.row_text_hash, row.rowTextHash, 80);
    const tt = norm(target.title), tc = norm(target.content), rt = norm(row.title), rc = norm(row.content);
    const sameSource = Boolean(target.sourceKey && row.sourceKey && target.sourceKey === row.sourceKey); const sameContent = Boolean(tc && rc && tc === rc); const sameTitle = Boolean(tt && rt && tt === rt);
    if (sameSource) value += 48; if (sameContent) { value += 58; if (sameSource || sameTitle) strong = true; } else if (tc && rc && (tc.includes(rc) || rc.includes(tc))) value += 30;
    if (sameTitle) value += 26; else if (tt && rt && (tt.includes(rt) || rt.includes(tt))) value += 12;
    return value >= 72 && (strong || value >= 95);
  };
  const scrollers = () => {
    const list = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll("body *")].filter(Boolean).filter((el) => {
      const style = getComputedStyle(el); const rect = el.getBoundingClientRect?.() || {height: 0};
      return rect.height >= 250 && el.scrollHeight > el.clientHeight + 100 && /(auto|scroll)/.test(style.overflowY || "");
    });
    return [...new Set(list)].sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  };

  const foundIds = new Set(); const scanned = new Set(); let stable = 0; let previous = "";
  window.scrollTo(0, 0); scrollers().slice(0, 4).forEach((el) => { el.scrollTop = 0; }); await sleep(320);
  for (let step = 0; step < 650; step += 1) {
    const seen = new Set(); const rows = [];
    for (const button of buttons()) { const node = rowFor(button); if (!node || seen.has(node)) continue; seen.add(node); const row = parseRow(node); rows.push(row); scanned.add(row.signature); }
    for (const target of targets) { if (!foundIds.has(target.id) && rows.some((row) => score(target, row))) foundIds.add(target.id); }
    const active = scrollers().slice(0, 4); const signature = `${foundIds.size}|${document.documentElement.scrollHeight}|${active.map((el) => `${el.scrollTop}:${el.scrollHeight}`).join(",")}`;
    stable = signature === previous ? stable + 1 : 0; previous = signature;
    if (foundIds.size === targets.length || stable >= 14) break;
    let moved = false;
    for (const el of active) { const before = el.scrollTop; el.scrollTop = Math.min(el.scrollHeight, before + Math.max(650, Math.floor((el.clientHeight || innerHeight) * .88))); if (el.scrollTop !== before) moved = true; }
    if (!moved) window.scrollBy(0, Math.max(750, innerHeight * .88)); await sleep(380);
  }
  return {complete: foundIds.size === targets.length || stable >= 14, foundIds: [...foundIds], scannedUnique: scanned.size, progress: {found: foundIds.size, total: targets.length}};
};