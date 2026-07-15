globalThis.traceLensDeleteYouTubeLiveChatTargetsInPage = async function(targets, options = {}) {
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
  const batchSize = Math.max(1, Math.min(20, Number(options.batchSize) || 20));
  const batchPauseMs = Math.max(250, Number(options.batchPauseMs) || 500);
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
  const sourceUrl = (row) => row.querySelector('a[href*="youtube.com"],a[href*="youtu.be"]')?.href || "";
  const sourceKey = (value) => {
    try {
      const url = new URL(value);
      const post = url.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
      return post ? `post:${post}` : (url.searchParams.get("v") || "");
    } catch { return ""; }
  };
  const parse = (row, button) => {
    const text = clean(row.innerText || row.textContent);
    const lines = String(row.innerText || row.textContent || "").split(/\r?\n/).map(clean).filter(Boolean);
    const relation = /에서\s*메시지를\s*전송함|sent a message/i;
    const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM|×|✕|X)$/i;
    const dateLine = /^(?:\d{4}[.\-/]\s*)?\d{1,2}[.\-/]\s*\d{1,2}|\d{1,2}:\d{2}|오늘|어제|today|yesterday/i;
    const link = sourceUrl(row);
    const title = clean(row.querySelector('a[href*="youtube.com"],a[href*="youtu.be"]')?.innerText) || "YouTube 실시간 스트리밍";
    const content = lines.find((line) => !control.test(line) && !relation.test(line) && !dateLine.test(line) && line !== title) || "";
    const token = clean(row.getAttribute("data-token") || row.closest("c-wiz[data-token]")?.getAttribute("data-token"));
    const key = sourceKey(link);
    return {row, button, title, content, text, textNorm: norm(text), token, sourceKey: key,
      semanticHash: fnv(`youtube_live_chat|${key}|${title}|${content}`), rowTextHash: fnv(text), signature: token || `${key}|${fnv(text)}`};
  };
  const items = () => buttons().map((button) => ({button, row: rowFor(button)})).filter((entry) => entry.row).map((entry) => parse(entry.row, entry.button));
  const score = (target, item) => {
    const locator = target.locator || {};
    const token = clean(target.commentId || locator.comment_id || locator.activity_token);
    if (token) return token === item.token ? 500 : 0;
    let value = 0;
    if (locator.semantic_hash === item.semanticHash) value += 180;
    if (locator.row_text_hash === item.rowTextHash) value += 130;
    const content = norm(target.content || locator.content);
    const title = norm(locator.title || target.title).replace(/^\[실시간 채팅\]\s*/, "");
    if (content && content === norm(item.content)) value += 130;
    else if (content && item.textNorm.includes(content)) value += 95;
    if (target.sourceKey && target.sourceKey === item.sourceKey) value += 55;
    if (title && title === norm(item.title)) value += 35;
    return value;
  };
  const best = (target, current) => {
    const ranked = current.map((item) => ({item, value: score(target, item)})).sort((a, b) => b.value - a.value);
    if (!ranked[0] || ranked[0].value < 95) return null;
    if (ranked[1]?.value === ranked[0].value && ranked[0].value < 500) return null;
    return ranked[0].item;
  };
  const root = document.scrollingElement || document.documentElement;
  const move = async (top) => { root.scrollTop = Math.max(0, top); window.scrollTo(0, root.scrollTop); root.dispatchEvent(new Event("scroll", {bubbles: true})); await sleep(240); };
  let banner = document.getElementById("tracelens-delete-banner");
  if (!banner) { banner = document.createElement("div"); banner.id = "tracelens-delete-banner"; Object.assign(banner.style, {position:"fixed",top:"0",left:"0",right:"0",zIndex:"2147483647",padding:"12px",background:"#8b1e1e",color:"white",font:"600 14px sans-serif",textAlign:"center"}); document.documentElement.appendChild(banner); }
  banner.textContent = "TraceLens가 선택한 실시간 채팅 위치를 찾고 있습니다.";
  await move(0);
  const found = new Map();
  const scanned = new Set();
  let stable = 0;
  let previous = "";
  for (let step = 0; step < 1000; step += 1) {
    const current = items().filter((item) => item.content);
    current.forEach((item) => scanned.add(item.signature));
    for (const target of targets) if (!found.has(target.id)) { const match = best(target, current); if (match) found.set(target.id, {top: root.scrollTop, item: match}); }
    if (found.size === targets.length) break;
    const max = Math.max(0, root.scrollHeight - root.clientHeight);
    const atBottom = max <= 2 || root.scrollTop >= max - 5;
    const signature = `${root.scrollTop}|${root.scrollHeight}|${current.length}|${found.size}`;
    stable = atBottom && signature === previous ? stable + 1 : 0; previous = signature;
    if (atBottom && stable >= 6) break;
    await move(Math.min(max, root.scrollTop + Math.max(500, Math.floor((root.clientHeight || innerHeight || 800) * 0.75))));
  }
  const pending = targets.filter((target) => found.has(target.id)).sort((a, b) => found.get(b.id).top - found.get(a.id).top);
  const attemptedIds = [], clickedIds = [], failed = [];
  const unmatchedIds = targets.filter((target) => !found.has(target.id)).map((target) => target.id);

  const waitRemoved = async (item, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!item.row.isConnected) return true;
      if (item.token && !items().some((current) => current.token === item.token)) return true;
      await sleep(90);
    }
    return false;
  };

  const clickConfirmIfPresent = async () => {
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
      const dialogs = [...document.querySelectorAll("[role='dialog'],dialog,[aria-modal='true']")].filter(visible);
      for (const dialog of dialogs) {
        const confirm = [...dialog.querySelectorAll("button,[role='button']")].filter(visible).find((button) => {
          const label = clean(`${button.getAttribute("aria-label") || ""} ${button.innerText || button.textContent || ""}`);
          return /^(활동\s*삭제|삭제하기|삭제|확인|delete\s*activity|delete|remove|confirm|ok)$/i.test(label);
        });
        if (confirm) {
          confirm.focus?.({preventScroll: true});
          confirm.click();
          return true;
        }
      }
      await sleep(90);
    }
    return false;
  };

  for (const target of pending) {
    await move(found.get(target.id).top);
    let current = best(target, items().filter((item) => item.content));
    if (!current) { failed.push({id: target.id, reason: "저장한 위치에서 실시간 채팅을 다시 찾지 못했습니다."}); continue; }
    current.row.scrollIntoView({block:"center"}); await sleep(100);
    current = best(target, items().filter((item) => item.content)) || current;
    try {
      current.button.focus?.({preventScroll: true});
      current.button.click();
      attemptedIds.push(target.id);
      let removed = await waitRemoved(current, 900);
      if (!removed) {
        const confirmed = await clickConfirmIfPresent();
        if (confirmed) removed = await waitRemoved(current, 1800);
      }
      if (removed) clickedIds.push(target.id);
      else failed.push({id: target.id, reason: "X 삭제 버튼을 눌렀지만 확인 후에도 실시간 채팅 항목이 즉시 사라지지 않았습니다."});
    } catch (error) { failed.push({id: target.id, reason: error.message || String(error)}); }
    if (attemptedIds.length % batchSize === 0) await sleep(batchPauseMs); else await sleep(120);
  }
  banner.textContent = attemptedIds.length ? `${attemptedIds.length}개 삭제 요청 완료 · 새로고침 후 확인합니다.` : "삭제 요청된 실시간 채팅이 없습니다.";
  return {clickedIds, attemptedIds, failed, unmatchedIds, scannedUnique: scanned.size, discoveryComplete: unmatchedIds.length === 0,
    progress: {clicked: clickedIds.length, attempted: attemptedIds.length, unmatched: unmatchedIds.length, failed: failed.length}};
};