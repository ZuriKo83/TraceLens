globalThis.traceLensDeleteYouTubeTargetsInPage = async function(targets, options = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
  const norm = (v) => clean(v).toLowerCase();
  const batchSize = Math.max(1, Math.min(20, Number(options.batchSize) || 20));
  const batchPauseMs = Math.max(500, Number(options.batchPauseMs) || 800);
  const expectedPage = "youtube_comments";
  const validPage = () => location.hostname === "myactivity.google.com" && new URL(location.href).searchParams.get("page") === expectedPage;
  if (!validPage()) throw new Error("Google 내 활동의 YouTube 댓글 페이지가 아닙니다.");

  const fnv = (value) => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const canonical = (value) => {
    if (!value) return null;
    try {
      const u = new URL(value, location.href);
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      if (host === "youtu.be") {
        const id = u.pathname.split("/").filter(Boolean)[0];
        return id ? `https://www.youtube.com/watch?v=${id}` : null;
      }
      if (!["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) return null;
      const post = u.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
      if (post) return `https://www.youtube.com/post/${post}`;
      const video = u.searchParams.get("v") || u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i)?.[1];
      return video ? `https://www.youtube.com/watch?v=${video}` : null;
    } catch { return null; }
  };
  const sourceKey = (value) => {
    if (!value) return "";
    try {
      const u = new URL(value);
      const post = u.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
      return post ? `post:${post}` : (u.searchParams.get("v") || "");
    } catch { return ""; }
  };
  const buttons = () => [...document.querySelectorAll("button,[role='button']")].filter((button) => {
    const label = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
    const text = clean(button.innerText || button.textContent);
    return /삭제|delete|remove|활동 삭제/i.test(label) || ["×", "✕", "X"].includes(text);
  });
  const rowFor = (button) => {
    const direct = button.closest("[role='listitem'],article,li,div[data-id]");
    if (direct) return direct;
    let node = button.parentElement;
    for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
      const text = clean(node.innerText || node.textContent);
      if (text.length >= 3 && text.length <= 9000 && /YouTube/i.test(text)) return node;
    }
    return null;
  };
  const scrollers = () => {
    const list = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll("body *")]
      .filter(Boolean).filter((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect?.() || {height: 0};
        return rect.height >= 250 && el.scrollHeight > el.clientHeight + 100 && /(auto|scroll)/.test(style.overflowY || "");
      });
    return [...new Set(list)].sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  };
  const parseRow = (row, button) => {
    const anchors = [...row.querySelectorAll("a[href]")];
    const urls = anchors.map((a) => canonical(a.href || a.getAttribute("href"))).filter(Boolean);
    const url = urls[0] || null;
    const link = anchors.find((a) => canonical(a.href || a.getAttribute("href")) === url);
    const linkTitle = clean(link?.innerText || link?.textContent);
    const lines = String(row.innerText || row.textContent || "").split(/\r?\n/).map(clean).filter(Boolean);
    const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM)$/i;
    const relation = /에\s*남긴\s*댓글|에\s*작성한\s*댓글|commented on/i;
    const candidates = lines.filter((line) => !control.test(line));
    const content = candidates.find((line) => !relation.test(line) && line !== linkTitle && !/^YouTube$/i.test(line)) || "";
    let title = linkTitle;
    if (!title || title === content || /^(YouTube|동영상|video)$/i.test(title)) {
      const relationLine = candidates.find((line) => relation.test(line));
      title = relationLine ? relationLine.replace(relation, "").trim() : "";
    }
    title = clean(title); const body = clean(content); const key = sourceKey(url); const text = clean(row.innerText || row.textContent);
    return {
      row, button, title, content: body, sourceKey: key,
      rowDataId: row.getAttribute("data-id") || "", rowJsdata: row.getAttribute("jsdata") || "", rowDataVed: row.getAttribute("data-ved") || "",
      rowTextHash: fnv(text), semanticHash: fnv(`${expectedPage}|${key}|${title}|${body}`),
      signature: `${row.getAttribute("data-id") || ""}|${key}|${fnv(text)}`,
      viewportTop: row.getBoundingClientRect?.().top || 0,
    };
  };
  const visibleRows = () => {
    const seen = new Set(); const rows = [];
    for (const button of buttons()) {
      const row = rowFor(button);
      if (!row || seen.has(row)) continue;
      seen.add(row); rows.push(parseRow(row, button));
    }
    return rows;
  };
  const score = (target, row) => {
    const locator = target.locator || {}; let value = 0; let strong = false;
    const exact = (a, b, weight) => { if (a && b && String(a) === String(b)) { value += weight; strong = true; } };
    exact(locator.semantic_hash, row.semanticHash, 130); exact(locator.row_data_id, row.rowDataId, 120);
    exact(locator.row_jsdata, row.rowJsdata, 105); exact(locator.row_data_ved, row.rowDataVed, 95); exact(locator.row_text_hash, row.rowTextHash, 80);
    const tt = norm(target.title), tc = norm(target.content), rt = norm(row.title), rc = norm(row.content);
    const sameSource = Boolean(target.sourceKey && row.sourceKey && target.sourceKey === row.sourceKey);
    const sameContent = Boolean(tc && rc && tc === rc); const sameTitle = Boolean(tt && rt && tt === rt);
    if (sameSource) value += 48;
    if (sameContent) { value += 58; if (sameSource || sameTitle) strong = true; }
    else if (tc && rc && (tc.includes(rc) || rc.includes(tc))) value += 30;
    if (sameTitle) value += 26; else if (tt && rt && (tt.includes(rt) || rt.includes(tt))) value += 12;
    return {value, strong};
  };
  const bestFor = (target, rows) => {
    const ranked = rows.map((row) => ({row, ...score(target, row)})).sort((a, b) => b.value - a.value);
    const best = ranked[0]; if (!best || best.value < 72) return null;
    const second = ranked[1]?.value || 0;
    if (!best.strong && (best.value < 95 || (second && best.value - second < 12))) return null;
    return best;
  };
  const assign = (pendingTargets, rows) => {
    const ranked = pendingTargets.map((target) => { const best = bestFor(target, rows); return best ? {target, ...best} : null; })
      .filter(Boolean).sort((a, b) => Number(b.strong) - Number(a.strong) || b.value - a.value);
    const usedRows = new Set(); const usedTargets = new Set(); const result = [];
    for (const match of ranked) {
      if (usedRows.has(match.row.row) || usedTargets.has(match.target.id)) continue;
      usedRows.add(match.row.row); usedTargets.add(match.target.id); result.push(match);
    }
    return result;
  };
  const position = () => {
    const active = scrollers().slice(0, 4); const tops = active.map((el) => el.scrollTop || 0); const windowY = window.scrollY || 0;
    return {tops, windowY, rank: windowY + tops.reduce((sum, n) => sum + n, 0)};
  };
  const restore = async (saved) => {
    window.scrollTo(0, Math.max(0, saved?.windowY || 0));
    scrollers().slice(0, 4).forEach((el, i) => { el.scrollTop = Math.max(0, Math.min(saved?.tops?.[i] || 0, el.scrollHeight)); });
    await sleep(260);
  };
  const confirmDialog = async () => {
    await sleep(180);
    for (const dialog of document.querySelectorAll("[role='dialog'],dialog")) {
      const confirm = [...dialog.querySelectorAll("button,[role='button']")]
        .find((button) => /^(삭제|delete|remove|확인|confirm)$/i.test(clean(button.innerText || button.textContent || button.getAttribute("aria-label"))));
      if (confirm && !confirm.disabled) { confirm.click(); await sleep(280); return; }
    }
  };
  const waitRemoved = async (row, before) => {
    for (let i = 0; i < 30; i += 1) { if (!row.isConnected || clean(row.innerText || row.textContent) !== before) return true; await sleep(160); }
    return false;
  };

  let banner = document.getElementById("tracelens-delete-banner");
  if (!banner) {
    banner = document.createElement("div"); banner.id = "tracelens-delete-banner";
    Object.assign(banner.style, {position: "fixed", top: "0", left: "0", right: "0", zIndex: "2147483647", padding: "12px", background: "#8b1e1e", color: "white", font: "600 14px sans-serif", textAlign: "center"});
    document.documentElement.appendChild(banner);
  }
  banner.textContent = "TraceLens가 전체 기록을 탐색 중입니다. 이 탭을 닫거나 주소를 변경하지 마세요.";

  const discovered = new Map(); const scanned = new Set(); let stable = 0; let previous = ""; let complete = false;
  window.scrollTo(0, 0); scrollers().slice(0, 4).forEach((el) => { el.scrollTop = 0; }); await sleep(320);
  for (let step = 0; step < 650; step += 1) {
    if (!validPage()) throw new Error("삭제 작업 중 페이지 주소가 변경되었습니다.");
    const rows = visibleRows(); rows.forEach((row) => scanned.add(row.signature)); const saved = position();
    for (const target of targets) {
      const best = bestFor(target, rows); const old = discovered.get(target.id);
      if (best && (!old || best.value > old.score)) discovered.set(target.id, {score: best.value, saved: {...saved}});
    }
    if (discovered.size === targets.length) { complete = true; break; }
    const active = scrollers().slice(0, 4);
    const signature = `${discovered.size}|${document.documentElement.scrollHeight}|${active.map((el) => `${el.scrollTop}:${el.scrollHeight}`).join(",")}`;
    stable = signature === previous ? stable + 1 : 0; previous = signature;
    if (stable >= 14) { complete = true; break; }
    let moved = false;
    for (const el of active) { const before = el.scrollTop; el.scrollTop = Math.min(el.scrollHeight, before + Math.max(650, Math.floor((el.clientHeight || innerHeight) * .88))); if (el.scrollTop !== before) moved = true; }
    if (!moved) window.scrollBy(0, Math.max(750, innerHeight * .88)); await sleep(380);
  }

  const targetMap = new Map(targets.map((target) => [target.id, target]));
  const pending = new Set([...discovered.keys()]); const clickedIds = []; const failed = [];
  const unmatchedIds = targets.filter((target) => !discovered.has(target.id)).map((target) => target.id);
  let batchClicks = 0;
  banner.textContent = "TraceLens가 아래쪽 댓글부터 삭제 중입니다.";
  while (pending.size) {
    const ordered = [...pending].sort((a, b) => (discovered.get(b)?.saved?.rank || 0) - (discovered.get(a)?.saved?.rank || 0));
    const anchorId = ordered[0]; await restore(discovered.get(anchorId).saved);
    const rows = visibleRows(); rows.forEach((row) => scanned.add(row.signature));
    const matches = assign([...pending].map((id) => targetMap.get(id)).filter(Boolean), rows).sort((a, b) => b.row.viewportTop - a.row.viewportTop);
    let progressed = false;
    for (const match of matches) {
      if (!pending.has(match.target.id) || batchClicks >= batchSize || !match.row.row.isConnected || !match.row.button.isConnected) continue;
      const current = parseRow(match.row.row, match.row.button); const check = score(match.target, current);
      if (check.value < 72 || (!check.strong && check.value < 95)) continue;
      current.row.scrollIntoView({block: "center", behavior: "auto"}); await sleep(100); const before = clean(current.row.innerText || current.row.textContent);
      try {
        current.button.click(); await confirmDialog();
        if (await waitRemoved(current.row, before)) clickedIds.push(match.target.id);
        else failed.push({id: match.target.id, reason: "삭제 버튼을 눌렀지만 행이 사라지지 않았습니다."});
      } catch (error) { failed.push({id: match.target.id, reason: error.message || String(error)}); }
      pending.delete(match.target.id); progressed = true; batchClicks += 1; await sleep(190);
    }
    if (!progressed) { pending.delete(anchorId); unmatchedIds.push(anchorId); }
    if (batchClicks >= batchSize && pending.size) {
      banner.textContent = `${clickedIds.length}개 삭제 요청 완료. 페이지 안정화를 기다리는 중입니다.`;
      await sleep(batchPauseMs); batchClicks = 0;
    }
  }
  if (batchClicks) await sleep(500);
  return {clickedIds, failed, unmatchedIds: [...new Set(unmatchedIds)], scannedUnique: scanned.size, discoveryComplete: complete, batchSize, progress: {clicked: clickedIds.length, unmatched: unmatchedIds.length, failed: failed.length}};
};