globalThis.traceLensDeleteYouTubeTargetsInPage = async function(targets, options = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const norm = (value) => clean(value).toLowerCase();
  const batchSize = Math.max(1, Math.min(20, Number(options.batchSize) || 20));
  const batchPauseMs = Math.max(500, Number(options.batchPauseMs) || 800);
  const expectedPage = "youtube_comments";
  const validPage = () => location.hostname === "myactivity.google.com" && new URL(location.href).searchParams.get("page") === expectedPage;
  if (!validPage()) throw new Error("Google 내 활동의 YouTube 댓글 페이지가 아닙니다.");

  const fnv = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };

  const canonical = (value) => {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
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
    } catch {
      return null;
    }
  };

  const sourceKey = (value) => {
    if (!value) return "";
    try {
      const url = new URL(value);
      const postId = url.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
      return postId ? `post:${postId}` : (url.searchParams.get("v") || "");
    } catch {
      return "";
    }
  };

  const elementLabel = (element) => clean([
    element?.getAttribute?.("aria-label"),
    element?.getAttribute?.("title"),
    element?.getAttribute?.("data-tooltip"),
    element?.getAttribute?.("data-tooltip-text"),
    element?.innerText,
    element?.textContent,
  ].filter(Boolean).join(" "));

  const isVisible = (element) => {
    if (!element?.isConnected) return false;
    if (element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  };

  const DELETE_PATTERN = /(활동\s*삭제|삭제하기|삭제|delete\s*activity|delete|remove\s*activity|remove)/i;
  const MENU_PATTERN = /(더보기|옵션|메뉴|작업|more|options|actions|overflow)/i;
  const CONFIRM_PATTERN = /^(활동\s*삭제|삭제하기|삭제|확인|delete\s*activity|delete|remove\s*activity|remove|confirm|ok)$/i;
  const allControls = (root = document) => [...root.querySelectorAll("button,[role='button'],[role='menuitem'],[role='option']")].filter(isVisible);

  const isDeleteControl = (element) => {
    const label = elementLabel(element);
    if (DELETE_PATTERN.test(label)) return true;
    const text = clean(element.innerText || element.textContent);
    const aria = clean(`${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`);
    return ["×", "✕", "X"].includes(text) && DELETE_PATTERN.test(aria);
  };

  const isMenuControl = (element) => {
    const label = elementLabel(element);
    const popup = element.getAttribute("aria-haspopup");
    return MENU_PATTERN.test(label) || popup === "menu" || popup === "true";
  };

  const rowFor = (control) => {
    const direct = control.closest("[role='listitem'],article,li,div[data-id],div[jsdata],div[data-ved]");
    if (direct) {
      const text = clean(direct.innerText || direct.textContent);
      if (text.length >= 3 && text.length <= 12000) return direct;
    }
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
    const resolved = anchors.map((anchor) => ({anchor, url: canonical(anchor.href || anchor.getAttribute("href"))})).filter((entry) => entry.url);
    const sourceUrl = resolved[0]?.url || null;
    const link = resolved.find((entry) => entry.url === sourceUrl)?.anchor || null;
    const linkTitle = clean(link?.innerText || link?.textContent);
    const lines = String(row.innerText || row.textContent || "").split(/\r?\n/).map(clean).filter(Boolean);
    const controlLine = /^(YouTube|세부정보|Details|삭제|삭제하기|Delete|Remove|더보기|옵션|오전|오후|AM|PM)$/i;
    const relationLine = /에\s*남긴\s*댓글|에\s*작성한\s*댓글|commented on/i;
    const dateLine = /^(?:\d{4}[.\-/]\s*)?\d{1,2}[.\-/]\s*\d{1,2}|\d{1,2}:\d{2}|오늘|어제|today|yesterday/i;
    const candidates = lines.filter((line) => !controlLine.test(line));
    const content = candidates.find((line) => !relationLine.test(line) && !dateLine.test(line) && line !== linkTitle && !/^YouTube$/i.test(line)) || "";
    let title = linkTitle;
    if (!title || title === content || /^(YouTube|동영상|video)$/i.test(title)) {
      const relation = candidates.find((line) => relationLine.test(line));
      title = relation ? relation.replace(relationLine, "").trim() : "";
    }
    const fullText = clean(row.innerText || row.textContent);
    const key = sourceKey(sourceUrl);
    return {
      row,
      title: clean(title),
      content: clean(content),
      fullText,
      fullTextNorm: norm(fullText),
      sourceKey: key,
      rowDataId: row.getAttribute("data-id") || "",
      rowJsdata: row.getAttribute("jsdata") || "",
      rowDataVed: row.getAttribute("data-ved") || "",
      rowTextHash: fnv(fullText),
      semanticHash: fnv(`${expectedPage}|${key}|${clean(title)}|${clean(content)}`),
      signature: `${row.getAttribute("data-id") || ""}|${key}|${fnv(fullText)}`,
      viewportTop: row.getBoundingClientRect?.().top || 0,
    };
  };

  const candidateRows = () => {
    const controls = allControls().filter((control) => isDeleteControl(control) || isMenuControl(control));
    const seen = new Set();
    const rows = [];
    for (const control of controls) {
      const row = rowFor(control);
      if (!row || seen.has(row)) continue;
      seen.add(row);
      rows.push(parseRow(row));
    }
    return rows;
  };

  const score = (target, row) => {
    const locator = target.locator || {};
    let value = 0;
    let strong = false;
    const exact = (left, right, weight) => {
      if (left && right && String(left) === String(right)) {
        value += weight;
        strong = true;
      }
    };
    exact(locator.semantic_hash, row.semanticHash, 140);
    exact(locator.row_data_id, row.rowDataId, 125);
    exact(locator.row_jsdata, row.rowJsdata, 110);
    exact(locator.row_data_ved, row.rowDataVed, 100);
    exact(locator.row_text_hash, row.rowTextHash, 85);
    const targetTitle = norm(target.title || locator.title);
    const targetContent = norm(target.content || locator.content);
    const rowTitle = norm(row.title);
    const rowContent = norm(row.content);
    const sameSource = Boolean(target.sourceKey && row.sourceKey && target.sourceKey === row.sourceKey);
    const exactContent = Boolean(targetContent && rowContent && targetContent === rowContent);
    const contentInRow = Boolean(targetContent && row.fullTextNorm.includes(targetContent));
    const exactTitle = Boolean(targetTitle && rowTitle && targetTitle === rowTitle);
    const titleInRow = Boolean(targetTitle && row.fullTextNorm.includes(targetTitle));
    if (sameSource) value += 52;
    if (exactContent) {
      value += 72;
      strong = true;
    } else if (contentInRow) {
      value += 58;
      if (sameSource || exactTitle || titleInRow) strong = true;
    } else if (targetContent && rowContent && (targetContent.includes(rowContent) || rowContent.includes(targetContent))) {
      value += 34;
    }
    if (exactTitle) value += 28;
    else if (titleInRow) value += 18;
    return {value, strong};
  };

  const bestFor = (target, rows) => {
    const ranked = rows.map((row) => ({row, ...score(target, row)})).sort((left, right) => right.value - left.value);
    const best = ranked[0];
    if (!best || best.value < 72) return null;
    const second = ranked[1]?.value || 0;
    if (!best.strong && (best.value < 100 || (second && best.value - second < 14))) return null;
    if (second && best.value === second && best.value < 140) return null;
    return best;
  };

  const assign = (pendingTargets, rows) => {
    const ranked = pendingTargets.map((target) => {
      const best = bestFor(target, rows);
      return best ? {target, ...best} : null;
    }).filter(Boolean).sort((left, right) => Number(right.strong) - Number(left.strong) || right.value - left.value);
    const usedRows = new Set();
    const usedTargets = new Set();
    const matches = [];
    for (const match of ranked) {
      if (usedRows.has(match.row.row) || usedTargets.has(match.target.id)) continue;
      usedRows.add(match.row.row);
      usedTargets.add(match.target.id);
      matches.push(match);
    }
    return matches;
  };

  const scrollers = () => {
    const elements = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll("body *")].filter(Boolean).filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect?.() || {height: 0};
      return rect.height >= 250 && element.scrollHeight > element.clientHeight + 100 && (element === document.scrollingElement || /(auto|scroll)/.test(style.overflowY || ""));
    });
    return [...new Set(elements)].sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
  };

  const position = () => {
    const active = scrollers().slice(0, 4);
    const tops = active.map((element) => element.scrollTop || 0);
    const windowY = window.scrollY || 0;
    return {tops, windowY, rank: windowY + tops.reduce((sum, value) => sum + value, 0)};
  };

  const restore = async (saved) => {
    window.scrollTo(0, Math.max(0, saved?.windowY || 0));
    scrollers().slice(0, 4).forEach((element, index) => {
      element.scrollTop = Math.max(0, Math.min(saved?.tops?.[index] || 0, Math.max(0, element.scrollHeight - element.clientHeight)));
      element.dispatchEvent(new Event("scroll", {bubbles: true}));
    });
    await sleep(320);
  };

  const clickControl = async (element) => {
    if (!isVisible(element)) return false;
    element.scrollIntoView({block: "center", behavior: "auto"});
    await sleep(120);
    element.focus?.({preventScroll: true});
    element.click();
    await sleep(220);
    return true;
  };

  const exactLocatorButton = (row, target) => {
    const locator = target.locator || {};
    const wantedAria = clean(locator.button_aria_label);
    const wantedTitle = clean(locator.button_title);
    const wantedRole = clean(locator.button_role);
    const wantedTag = clean(locator.button_tag).toLowerCase();
    return allControls(row).find((control) => {
      if (wantedTag && control.tagName.toLowerCase() !== wantedTag) return false;
      if (wantedRole && clean(control.getAttribute("role")) !== wantedRole) return false;
      if (wantedAria && clean(control.getAttribute("aria-label")) !== wantedAria) return false;
      if (wantedTitle && clean(control.getAttribute("title")) !== wantedTitle) return false;
      return Boolean(wantedAria || wantedTitle || wantedRole || wantedTag) && (isDeleteControl(control) || isMenuControl(control));
    }) || null;
  };

  const findGlobalDeleteChoice = () => {
    const containers = [...document.querySelectorAll("[role='menu'],[role='listbox'],[role='dialog'],dialog,[aria-modal='true']")].filter(isVisible);
    const roots = containers.length ? containers : [document];
    for (const root of roots) {
      const choice = allControls(root).find((control) => DELETE_PATTERN.test(elementLabel(control)));
      if (choice) return choice;
    }
    return null;
  };

  const chooseDeleteAction = async (rowInfo, target) => {
    const row = rowInfo.row;
    const exact = exactLocatorButton(row, target);
    if (exact && isDeleteControl(exact)) return {control: exact, path: "locator-direct", label: elementLabel(exact)};
    const direct = allControls(row).find(isDeleteControl);
    if (direct) return {control: direct, path: "row-direct", label: elementLabel(direct)};
    const menu = exact && isMenuControl(exact) ? exact : allControls(row).find(isMenuControl);
    if (!menu) return {control: null, path: "missing", label: ""};
    await clickControl(menu);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const choice = findGlobalDeleteChoice();
      if (choice) return {control: choice, path: "menu-delete", label: elementLabel(choice)};
      await sleep(120);
    }
    return {control: null, path: "menu-no-delete", label: elementLabel(menu)};
  };

  const confirmDialog = async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const dialogs = [...document.querySelectorAll("[role='dialog'],dialog,[aria-modal='true']")].filter(isVisible);
      for (const dialog of dialogs) {
        const confirm = allControls(dialog).find((button) => CONFIRM_PATTERN.test(elementLabel(button)));
        if (confirm) {
          const label = elementLabel(confirm);
          await clickControl(confirm);
          return {clicked: true, label};
        }
      }
      await sleep(120);
    }
    return {clicked: false, label: ""};
  };

  const waitRemoved = async (row, beforeText, target) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!row.isConnected) return true;
      const currentText = clean(row.innerText || row.textContent);
      if (currentText !== beforeText) {
        const currentScore = score(target, parseRow(row));
        if (!currentScore.strong || currentScore.value < 72) return true;
      }
      await sleep(160);
    }
    return false;
  };

  let banner = document.getElementById("tracelens-delete-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "tracelens-delete-banner";
    Object.assign(banner.style, {position: "fixed", top: "0", left: "0", right: "0", zIndex: "2147483647", padding: "12px", background: "#8b1e1e", color: "white", font: "600 14px sans-serif", textAlign: "center"});
    document.documentElement.appendChild(banner);
  }
  banner.textContent = "TraceLens가 전체 기록을 탐색 중입니다. 이 탭을 닫거나 주소를 변경하지 마세요.";

  const discovered = new Map();
  const scanned = new Set();
  let stable = 0;
  let previous = "";
  let discoveryComplete = false;
  window.scrollTo(0, 0);
  scrollers().slice(0, 4).forEach((element) => { element.scrollTop = 0; });
  await sleep(450);

  for (let step = 0; step < 800; step += 1) {
    if (!validPage()) throw new Error("삭제 작업 중 페이지 주소가 변경되었습니다.");
    const rows = candidateRows();
    rows.forEach((row) => scanned.add(row.signature));
    const saved = position();
    for (const target of targets) {
      const best = bestFor(target, rows);
      const old = discovered.get(target.id);
      if (best && (!old || best.value > old.score)) discovered.set(target.id, {score: best.value, saved: {...saved}});
    }
    if (discovered.size === targets.length) {
      discoveryComplete = true;
      break;
    }
    const active = scrollers().slice(0, 4);
    const signature = [discovered.size, document.documentElement.scrollHeight, active.map((element) => `${element.scrollTop}:${element.scrollHeight}`).join(",")].join("|");
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    if (stable >= 16) {
      discoveryComplete = true;
      break;
    }
    let moved = false;
    for (const element of active) {
      const before = element.scrollTop;
      const max = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.min(max, before + Math.max(520, Math.floor((element.clientHeight || innerHeight) * 0.68)));
      element.dispatchEvent(new Event("scroll", {bubbles: true}));
      if (element.scrollTop !== before) moved = true;
    }
    if (!moved) window.scrollBy(0, Math.max(600, innerHeight * 0.68));
    await sleep(420);
  }

  const targetMap = new Map(targets.map((target) => [target.id, target]));
  const pending = new Set(discovered.keys());
  const clickedIds = [];
  const failed = [];
  const unmatchedIds = targets.filter((target) => !discovered.has(target.id)).map((target) => target.id);
  const diagnostics = [];
  let batchClicks = 0;
  banner.textContent = "TraceLens가 아래쪽 댓글부터 삭제 중입니다.";

  while (pending.size) {
    const ordered = [...pending].sort((left, right) => (discovered.get(right)?.saved?.rank || 0) - (discovered.get(left)?.saved?.rank || 0));
    const anchorId = ordered[0];
    await restore(discovered.get(anchorId)?.saved);
    const rows = candidateRows();
    rows.forEach((row) => scanned.add(row.signature));
    const matches = assign([...pending].map((id) => targetMap.get(id)).filter(Boolean), rows).sort((left, right) => right.row.viewportTop - left.row.viewportTop);
    let progressed = false;

    for (const match of matches) {
      if (!pending.has(match.target.id) || batchClicks >= batchSize || !match.row.row.isConnected) continue;
      const current = parseRow(match.row.row);
      const currentScore = score(match.target, current);
      if (currentScore.value < 72 || (!currentScore.strong && currentScore.value < 100)) continue;
      current.row.scrollIntoView({block: "center", behavior: "auto"});
      await sleep(150);
      const beforeText = clean(current.row.innerText || current.row.textContent);

      try {
        const action = await chooseDeleteAction(current, match.target);
        if (!action.control) {
          failed.push({id: match.target.id, reason: action.path === "menu-no-delete" ? "더보기 메뉴를 열었지만 삭제 항목을 찾지 못했습니다." : "대상 행에서 삭제 버튼이나 더보기 메뉴를 찾지 못했습니다."});
          diagnostics.push({id: match.target.id, stage: action.path, label: action.label});
        } else {
          await clickControl(action.control);
          const dialog = await confirmDialog();
          const removed = await waitRemoved(current.row, beforeText, match.target);
          diagnostics.push({id: match.target.id, stage: removed ? "removed" : "not-removed", actionPath: action.path, actionLabel: action.label, confirmClicked: dialog.clicked, confirmLabel: dialog.label});
          if (removed) clickedIds.push(match.target.id);
          else failed.push({id: match.target.id, reason: dialog.clicked ? "삭제 확인까지 눌렀지만 댓글 행이 사라지지 않았습니다." : "삭제 버튼을 눌렀지만 확인 버튼을 찾지 못했거나 댓글 행이 사라지지 않았습니다."});
        }
      } catch (error) {
        failed.push({id: match.target.id, reason: error.message || String(error)});
        diagnostics.push({id: match.target.id, stage: "exception", error: error.message || String(error)});
      }

      pending.delete(match.target.id);
      progressed = true;
      batchClicks += 1;
      await sleep(240);
    }

    if (!progressed) {
      pending.delete(anchorId);
      unmatchedIds.push(anchorId);
      failed.push({id: anchorId, reason: "저장된 위치로 이동했지만 대상 댓글을 다시 찾지 못했습니다."});
    }
    if (batchClicks >= batchSize && pending.size) {
      banner.textContent = `${clickedIds.length}개 삭제 요청 완료. 페이지 안정화를 기다리는 중입니다.`;
      await sleep(batchPauseMs);
      batchClicks = 0;
    }
  }

  if (batchClicks) await sleep(600);
  banner.textContent = clickedIds.length ? `${clickedIds.length}개 삭제 요청을 완료했습니다. 전체 결과를 다시 확인합니다.` : "삭제된 댓글이 없습니다. 실패 원인을 TraceLens에 전달합니다.";
  return {
    clickedIds,
    failed,
    unmatchedIds: [...new Set(unmatchedIds)],
    scannedUnique: scanned.size,
    discoveryComplete,
    batchSize,
    diagnostics,
    progress: {clicked: clickedIds.length, unmatched: [...new Set(unmatchedIds)].length, failed: failed.length},
  };
};
