(() => {
  const originalRunExtractor = runExtractor;
  const originalAssertOwnedTaskUrl = assertOwnedTaskUrl;

  if (!SITE_TASKS.youtube.some((task) => task.activityType === "live_chat")) {
    SITE_TASKS.youtube.push({
      platform: "youtube",
      label: "YouTube 실시간 스트리밍 채팅 메시지",
      activityType: "live_chat",
      url: "https://myactivity.google.com/page?page=youtube_live_chat&hl=ko"
    });
  }

  assertOwnedTaskUrl = async function(tabId, task) {
    if (task?.platform === "youtube" && task?.activityType === "live_chat") {
      const tab = await chrome.tabs.get(tabId);
      const current = new URL(tab.url || "about:blank");
      const valid = current.hostname === "myactivity.google.com"
        && current.pathname.replace(/\/$/, "") === "/page"
        && current.searchParams.get("page") === "youtube_live_chat";
      if (!valid) throw new Error(`본인 실시간 채팅 활동 페이지 확인에 실패했습니다. 이동된 주소: ${current.href}`);
      return;
    }
    return originalAssertOwnedTaskUrl(tabId, task);
  };

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    if (platform !== "youtube") {
      return originalRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    }

    const results = await chrome.scripting.executeScript({
      target: {tabId, allFrames: true},
      func: collectYouTubeActivityPage,
      args: [activityType, accountContext?.accountLabel || null]
    });
    const payloads = (results || []).map((entry) => entry.result).filter(Boolean);
    if (!payloads.length) throw new Error("YouTube 활동 페이지에서 조회 결과를 받지 못했습니다.");

    const items = [];
    const seen = new Set();
    for (const payload of payloads) {
      for (const item of payload.items || []) {
        if (!item.external_id || seen.has(item.external_id)) continue;
        seen.add(item.external_id);
        items.push(item);
      }
    }
    const primary = payloads.find((payload) => payload.items?.length) || payloads[0];
    const label = activityType === "live_chat" ? "실시간 스트리밍 채팅 메시지" : "댓글";
    return {
      platform: "youtube",
      source_url: primary.source_url,
      scan_scope: activityType,
      status: items.length ? "success" : primary.status || "partial",
      message: items.length
        ? `YouTube ${label} ${items.length}개를 확인했습니다.`
        : primary.message || `YouTube ${label}을 찾지 못했습니다.`,
      account_label: accountContext?.accountLabel || null,
      items: items.slice(0, 5000)
    };
  };

  async function collectYouTubeActivityPage(activityType, accountLabel) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const clip = (value, max) => clean(value).slice(0, max);
    const fnv = (value) => {
      let hash = 2166136261;
      for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    };

    const page = new URL(location.href).searchParams.get("page") || "";
    const expectedPage = activityType === "live_chat" ? "youtube_live_chat" : "youtube_comments";
    if (location.hostname !== "myactivity.google.com" || page !== expectedPage) {
      return {
        platform: "youtube",
        source_url: location.href,
        status: "partial",
        message: `Google 내 활동의 ${expectedPage} 페이지가 아닙니다.`,
        items: []
      };
    }

    const decodeCandidates = (value) => {
      const output = [];
      let current = String(value || "");
      for (let i = 0; i < 4 && current; i += 1) {
        output.push(current);
        try {
          const decoded = decodeURIComponent(current);
          if (decoded === current) break;
          current = decoded;
        } catch {
          break;
        }
      }
      return output;
    };

    const canonicalYouTubeUrl = (rawValue) => {
      if (!rawValue) return null;
      const queue = decodeCandidates(rawValue);
      const visited = new Set();
      while (queue.length) {
        const candidate = queue.shift();
        if (!candidate || visited.has(candidate)) continue;
        visited.add(candidate);
        let parsed;
        try { parsed = new URL(candidate, location.href); } catch { continue; }
        const host = parsed.hostname.toLowerCase();
        if (host === "youtu.be") {
          const id = parsed.pathname.split("/").filter(Boolean)[0] || "";
          if (id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
        }
        if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
          const id = parsed.searchParams.get("v");
          if (id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
          const shorts = parsed.pathname.match(/^\/shorts\/([^/?#]+)/);
          if (shorts) return `https://www.youtube.com/shorts/${encodeURIComponent(shorts[1])}`;
          const live = parsed.pathname.match(/^\/live\/([^/?#]+)/);
          if (live) return `https://www.youtube.com/watch?v=${encodeURIComponent(live[1])}`;
        }
        for (const key of ["url", "q", "continue", "redirect", "target", "u", "dest", "destination"]) {
          const nested = parsed.searchParams.get(key);
          if (nested) queue.push(...decodeCandidates(nested));
        }
      }
      const text = decodeCandidates(rawValue).join(" ");
      const match = text.match(/https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?[^\s"'<>]*v=|shorts\/|live\/)[A-Za-z0-9_-]+[^\s"'<>]*/i)
        || text.match(/https?:\/\/youtu\.be\/[A-Za-z0-9_-]+[^\s"'<>]*/i);
      return match ? canonicalYouTubeUrl(match[0]) : null;
    };

    const deleteButtons = () => [...document.querySelectorAll("button,[role='button']")].filter((button) => {
      const label = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
      const text = clean(button.innerText || button.textContent);
      return /삭제|delete|remove|활동 삭제/i.test(label) || ["×", "✕", "X"].includes(text);
    });

    const rowForButton = (button) => {
      let row = button.closest("[role='listitem'],article,li,div[data-id]");
      if (row) return row;
      let node = button.parentElement;
      for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
        const text = clean(node.innerText || node.textContent);
        if (text.length >= 3 && text.length <= 9000 && /YouTube/i.test(text)) return node;
      }
      return null;
    };

    const originalLinkFromRow = (row) => {
      const values = [];
      for (const node of row.querySelectorAll("a[href],[data-url],[data-href],[jsdata],[data-ved]")) {
        for (const attr of ["href", "data-url", "data-href", "jsdata", "data-ved"]) {
          const value = node.getAttribute?.(attr);
          if (value) values.push({value, node});
        }
        if (node.href) values.push({value: node.href, node});
      }
      values.push({value: row.innerHTML || "", node: null});
      for (const candidate of values) {
        const url = canonicalYouTubeUrl(candidate.value);
        if (url) return {url, node: candidate.node};
      }
      return {url: null, node: null};
    };

    const parseRow = (row, button, ordinal) => {
      const rawLines = String(row.innerText || row.textContent || "").split(/\r?\n/).map(clean).filter(Boolean);
      if (!rawLines.length) return null;
      const original = originalLinkFromRow(row);
      const linkTitle = clean(original.node?.innerText || original.node?.textContent);
      const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM)$/i;
      const relation = /에\s*남긴\s*댓글|에\s*작성한\s*댓글|에서\s*메시지를\s*전송함|commented on|sent a message/i;
      const candidateLines = rawLines.filter((line) => !control.test(line));

      let content = "";
      if (activityType === "live_chat") {
        content = candidateLines.find((line) => !relation.test(line) && line !== linkTitle && !/^YouTube$/i.test(line)) || "";
      } else {
        content = candidateLines.find((line) => !relation.test(line) && line !== linkTitle && !/^YouTube$/i.test(line)) || "";
      }
      if (!content) return null;

      let title = linkTitle;
      if (!title || title === content || /^(YouTube|동영상|video)$/i.test(title)) {
        const relationLine = candidateLines.find((line) => relation.test(line));
        title = relationLine ? relationLine.replace(relation, "").trim() : "";
      }
      if (!title) title = activityType === "live_chat" ? "YouTube 실시간 스트리밍" : "YouTube 동영상";

      let videoId = "";
      try { videoId = original.url ? new URL(original.url).searchParams.get("v") || "" : ""; } catch {}
      const rowText = clean(row.innerText || row.textContent);
      const rowId = row.getAttribute("data-id") || row.getAttribute("jsdata") || row.getAttribute("data-ved") || "";
      const semantic = `${expectedPage}|${videoId}|${title}|${content}|${rowId || ordinal}`;
      const externalId = `youtube-${activityType}-${fnv(semantic)}`;

      return {
        external_id: externalId,
        activity_type: "comment",
        title: clip(activityType === "live_chat" ? `[실시간 채팅] ${title}` : title, 2000),
        content: clip(content, 20000),
        source_url: original.url,
        occurred_at: null,
        metadata: {
          captured_from: location.href,
          page_title: document.title,
          ownership_scope: "self_activity",
          ownership_verified: true,
          extractor_version: "1.1.0",
          account_label: accountLabel,
          youtube_activity_kind: activityType,
          my_activity_page: expectedPage,
          original_url: original.url,
          original_link_resolved: Boolean(original.url),
          video_id: videoId || null,
          deletion_locator: {
            version: 1,
            page: expectedPage,
            row_data_id: row.getAttribute("data-id") || null,
            row_jsdata: row.getAttribute("jsdata") || null,
            row_data_ved: row.getAttribute("data-ved") || null,
            row_text_hash: fnv(rowText),
            semantic_hash: fnv(`${expectedPage}|${videoId}|${title}|${content}`),
            button_tag: button.tagName,
            button_role: button.getAttribute("role") || null,
            button_aria_label: button.getAttribute("aria-label") || null,
            button_title: button.getAttribute("title") || null,
            title,
            content,
            video_id: videoId || null,
            video_url: original.url
          }
        }
      };
    };

    const collected = new Map();
    const seenRowNodes = new WeakSet();
    const collectVisible = () => {
      let ordinal = collected.size;
      for (const button of deleteButtons()) {
        const row = rowForButton(button);
        if (!row || seenRowNodes.has(row)) continue;
        seenRowNodes.add(row);
        const item = parseRow(row, button, ordinal++);
        if (!item) continue;
        let id = item.external_id;
        let suffix = 1;
        while (collected.has(id)) id = `${item.external_id}-${suffix++}`;
        item.external_id = id;
        collected.set(id, item);
      }
    };

    const scrollers = () => {
      const candidates = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll("body *")]
        .filter(Boolean)
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect?.() || {height: 0};
          return rect.height >= 250
            && element.scrollHeight > element.clientHeight + 100
            && /(auto|scroll)/.test(style.overflowY || "");
        });
      return [...new Set(candidates)].sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    };

    let stable = 0;
    let previousSignature = "";
    for (let step = 0; step < 650 && collected.size < 5000; step += 1) {
      collectVisible();
      const activeScrollers = scrollers().slice(0, 4);
      const signature = `${collected.size}|${document.documentElement.scrollHeight}|${activeScrollers.map((s) => `${s.scrollTop}:${s.scrollHeight}`).join(",")}`;
      stable = signature === previousSignature ? stable + 1 : 0;
      previousSignature = signature;
      if (stable >= 18) break;

      let moved = false;
      for (const scroller of activeScrollers) {
        const before = scroller.scrollTop;
        const amount = Math.max(600, Math.floor((scroller.clientHeight || innerHeight) * 0.85));
        scroller.scrollTop = Math.min(scroller.scrollHeight, before + amount);
        if (scroller.scrollTop !== before) moved = true;
      }
      if (!moved) window.scrollBy(0, Math.max(700, innerHeight * 0.85));
      await sleep(500);
    }
    collectVisible();
    window.scrollTo(0, 0);
    for (const scroller of scrollers().slice(0, 4)) scroller.scrollTop = 0;

    const label = activityType === "live_chat" ? "실시간 스트리밍 채팅 메시지" : "댓글";
    return {
      platform: "youtube",
      source_url: location.href,
      status: collected.size ? "success" : "partial",
      message: collected.size
        ? `YouTube ${label} ${collected.size}개를 확인했습니다.`
        : `YouTube ${label}을 찾지 못했습니다.`,
      items: [...collected.values()]
    };
  }
})();
