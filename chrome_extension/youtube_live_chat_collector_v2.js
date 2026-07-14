(() => {
  const previousRunExtractor = runExtractor;

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    if (platform !== "youtube" || activityType !== "live_chat") {
      return previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    }

    const results = await chrome.scripting.executeScript({
      target: {tabId, allFrames: true},
      func: collectYouTubeLiveChatDeep,
      args: [accountContext?.accountLabel || null]
    });
    const payloads = (results || []).map((entry) => entry.result).filter(Boolean);
    if (!payloads.length) {
      throw new Error("YouTube 실시간 채팅 활동 페이지에서 조회 결과를 받지 못했습니다.");
    }

    const items = [];
    const seen = new Set();
    let maxScrollSteps = 0;
    for (const payload of payloads) {
      maxScrollSteps = Math.max(maxScrollSteps, Number(payload.scroll_steps || 0));
      for (const item of payload.items || []) {
        if (!item.external_id || seen.has(item.external_id)) continue;
        seen.add(item.external_id);
        items.push(item);
      }
    }

    const primary = payloads.find((payload) => payload.items?.length) || payloads[0];
    const linkedCount = items.filter((item) => Boolean(item.source_url)).length;
    const unlinkedCount = Math.max(0, items.length - linkedCount);
    return {
      platform: "youtube",
      source_url: primary.source_url,
      scan_scope: "live_chat",
      status: items.length ? "success" : primary.status || "partial",
      message: items.length
        ? `YouTube 실시간 스트리밍 채팅 메시지 ${items.length}개를 확인했습니다. 원문 링크 ${linkedCount}개 확인${unlinkedCount ? `, ${unlinkedCount}개 미노출` : ""}. 깊은 스크롤 ${maxScrollSteps}회.`
        : primary.message || "YouTube 실시간 스트리밍 채팅 메시지를 찾지 못했습니다.",
      account_label: accountContext?.accountLabel || null,
      items: items.slice(0, 5000)
    };
  };

  async function collectYouTubeLiveChatDeep(accountLabel) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const clip = (value, max) => clean(value).slice(0, max);
    const fnv = (value) => {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    };

    const page = new URL(location.href).searchParams.get("page") || "";
    if (location.hostname !== "myactivity.google.com" || page !== "youtube_live_chat") {
      return {
        platform: "youtube",
        source_url: location.href,
        status: "partial",
        message: "Google 내 활동의 youtube_live_chat 페이지가 아닙니다.",
        scroll_steps: 0,
        items: []
      };
    }

    const decodeHtml = (value) => {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = String(value || "");
      return textarea.value;
    };
    const decodeCandidates = (value) => {
      const queue = [String(value || "")];
      const output = [];
      const seen = new Set();
      while (queue.length && output.length < 48) {
        const current = queue.shift()?.trim();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        output.push(current);
        const unescaped = current
          .replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&")
          .replace(/\\u003f/gi, "?").replace(/\\u002f/gi, "/")
          .replace(/\\u0025/gi, "%").replace(/\\x3d/gi, "=")
          .replace(/\\x26/gi, "&").replace(/\\x3f/gi, "?")
          .replace(/\\x2f/gi, "/").replace(/\\\//g, "/");
        for (const variant of [decodeHtml(current), unescaped]) {
          if (variant && !seen.has(variant)) queue.push(variant);
          try {
            const decoded = decodeURIComponent(variant);
            if (decoded && !seen.has(decoded)) queue.push(decoded);
          } catch {
            // Serialized Google attributes may contain incomplete percent encoding.
          }
        }
      }
      return output;
    };
    const validVideoId = (value) => {
      const candidate = clean(value).replace(/^["']|["']$/g, "");
      return /^[A-Za-z0-9_-]{6,20}$/.test(candidate) ? candidate : "";
    };
    const validPostId = (value) => {
      const candidate = clean(value).replace(/^["']|["']$/g, "");
      return /^[A-Za-z0-9_-]{10,160}$/.test(candidate) ? candidate : "";
    };
    const canonicalYouTubeUrl = (rawValue) => {
      if (!rawValue) return null;
      const queue = decodeCandidates(rawValue);
      const visited = new Set();
      const nestedKeys = ["url", "q", "continue", "redirect", "target", "u", "dest", "destination", "link", "href"];

      while (queue.length && visited.size < 96) {
        let candidate = queue.shift();
        if (!candidate) continue;
        candidate = candidate.trim().replace(/^["'`]+|["'`,;]+$/g, "");
        if (!candidate || visited.has(candidate)) continue;
        visited.add(candidate);

        const embedded = candidate.match(/(?:^|[\s"'=])((?:\/|https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/)(?:watch\?[^"'<>\s]*|shorts\/[A-Za-z0-9_-]+|live\/[A-Za-z0-9_-]+|embed\/[A-Za-z0-9_-]+|post\/[A-Za-z0-9_-]+))/i);
        if (embedded && embedded[1] !== candidate) queue.unshift(embedded[1]);

        let parsed;
        try {
          const relative = /^\/(?:watch|shorts\/|live\/|embed\/|v\/|post\/)/i.test(candidate);
          parsed = new URL(candidate, relative ? "https://www.youtube.com" : location.href);
        } catch {
          continue;
        }

        const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
        if (host === "youtu.be") {
          const id = validVideoId(parsed.pathname.split("/").filter(Boolean)[0] || "");
          if (id) return `https://www.youtube.com/watch?v=${id}`;
        }
        if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
          const postId = validPostId(parsed.pathname.match(/^\/post\/([^/?#]+)/i)?.[1] || "");
          if (postId) return `https://www.youtube.com/post/${postId}`;
          const queryId = validVideoId(parsed.searchParams.get("v") || "");
          if (queryId) return `https://www.youtube.com/watch?v=${queryId}`;
          const pathMatch = parsed.pathname.match(/^\/(shorts|live|embed|v)\/([^/?#]+)/i);
          const pathId = validVideoId(pathMatch?.[2] || "");
          if (pathId) {
            return pathMatch[1].toLowerCase() === "shorts"
              ? `https://www.youtube.com/shorts/${pathId}`
              : `https://www.youtube.com/watch?v=${pathId}`;
          }
        }
        for (const key of nestedKeys) {
          const nested = parsed.searchParams.get(key);
          if (nested) queue.push(...decodeCandidates(nested));
        }
      }
      return null;
    };
    const sourceIdentity = (url) => {
      if (!url) return {kind: null, id: "", key: ""};
      try {
        const parsed = new URL(url);
        const postId = validPostId(parsed.pathname.match(/^\/post\/([^/?#]+)/i)?.[1] || "");
        if (postId) return {kind: "post", id: postId, key: `post:${postId}`};
        const videoId = validVideoId(parsed.searchParams.get("v") || "");
        if (videoId) return {kind: "video", id: videoId, key: videoId};
        const pathId = validVideoId(parsed.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i)?.[1] || "");
        if (pathId) return {kind: "video", id: pathId, key: pathId};
      } catch {
        // Ignore malformed candidate URLs.
      }
      return {kind: null, id: "", key: ""};
    };

    const deleteButtons = () => [...document.querySelectorAll("button,[role='button']")].filter((button) => {
      const label = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
      const text = clean(button.innerText || button.textContent);
      return /삭제|delete|remove|활동 삭제/i.test(label) || ["×", "✕", "X"].includes(text);
    });
    const rowForButton = (button) => {
      const direct = button.closest("[role='listitem'],article,li,div[data-id]");
      if (direct) return direct;
      let node = button.parentElement;
      for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
        const text = clean(node.innerText || node.textContent);
        if (text.length >= 3 && text.length <= 10000 && /YouTube/i.test(text)) return node;
      }
      return null;
    };
    const originalLinkFromRow = (row) => {
      const candidates = [];
      const add = (value, node, source, priority) => {
        const raw = String(value || "").trim();
        if (raw) candidates.push({value: raw, node, source, priority});
      };
      for (const anchor of row.querySelectorAll("a")) {
        add(anchor.href, anchor, "anchor.href", 120);
        add(anchor.getAttribute("href"), anchor, "anchor[href]", 115);
        for (const attr of ["data-url", "data-href", "data-link", "data-target-url", "jsdata", "data-ved"]) {
          add(anchor.getAttribute(attr), anchor, `anchor[${attr}]`, 100);
        }
      }
      for (const node of [row, ...row.querySelectorAll("*")]) {
        for (const attr of node.getAttributeNames?.() || []) {
          const value = node.getAttribute(attr);
          if (!value || !/(?:youtu\.be|youtube\.com|watch(?:%3f|\?)|shorts(?:%2f|\/)|live(?:%2f|\/)|embed(?:%2f|\/)|post(?:%2f|\/)|attribution_link)/i.test(value)) continue;
          add(value, node, `${node.tagName.toLowerCase()}[${attr}]`, 70);
        }
      }
      add(row.outerHTML || row.innerHTML, null, "row.html", 20);
      const resolved = candidates
        .map((candidate) => {
          const url = canonicalYouTubeUrl(candidate.value);
          if (!url) return null;
          const displayNode = candidate.node?.closest?.("a") || candidate.node;
          const textBonus = clean(displayNode?.innerText || displayNode?.textContent) ? 8 : 0;
          return {...candidate, url, node: displayNode, score: candidate.priority + textBonus};
        })
        .filter(Boolean)
        .sort((left, right) => right.score - left.score);
      return resolved.length
        ? {url: resolved[0].url, node: resolved[0].node, source: resolved[0].source}
        : {url: null, node: null, source: null};
    };

    const parseRow = (row, button) => {
      const rawLines = String(row.innerText || row.textContent || "")
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean);
      if (!rawLines.length) return null;

      const original = originalLinkFromRow(row);
      const identity = sourceIdentity(original.url);
      const linkTitle = clean(original.node?.innerText || original.node?.textContent);
      const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM)$/i;
      const relation = /에서\s*메시지를\s*전송함|sent a message/i;
      const candidateLines = rawLines.filter((line) => !control.test(line));
      const content = candidateLines.find((line) => (
        !relation.test(line)
        && line !== linkTitle
        && !/^YouTube$/i.test(line)
      )) || "";
      if (!content) return null;

      let title = linkTitle;
      if (!title || title === content || /^(YouTube|동영상|video)$/i.test(title)) {
        const relationLine = candidateLines.find((line) => relation.test(line));
        title = relationLine ? relationLine.replace(relation, "").trim() : "";
      }
      if (!title) title = "YouTube 실시간 스트리밍";

      const rowText = clean(row.innerText || row.textContent);
      const rowId = String(
        row.getAttribute("data-id")
        || row.getAttribute("jsdata")
        || row.getAttribute("data-ved")
        || row.getAttribute("data-key")
        || ""
      );
      const rowInstance = rowId || fnv(`${rowText}|${original.url || ""}`);
      const semantic = `youtube_live_chat|${identity.key}|${title}|${content}|${rowInstance}`;
      const externalId = `youtube-live_chat-${fnv(semantic)}`;
      const videoId = identity.kind === "video" ? identity.id : "";
      const postId = identity.kind === "post" ? identity.id : "";

      return {
        external_id: externalId,
        activity_type: "comment",
        title: clip(`[실시간 채팅] ${title}`, 2000),
        content: clip(content, 20000),
        source_url: original.url,
        occurred_at: null,
        metadata: {
          captured_from: location.href,
          page_title: document.title,
          ownership_scope: "self_activity",
          ownership_verified: true,
          extractor_version: "1.3.0-live-chat-deep",
          account_label: accountLabel,
          youtube_activity_kind: "live_chat",
          my_activity_page: "youtube_live_chat",
          comment_id: externalId,
          youtube_comment_id: externalId,
          original_url: original.url,
          original_link_resolved: Boolean(original.url),
          original_link_status: original.url ? "resolved" : "not_exposed",
          original_link_source: original.source,
          source_type: identity.kind,
          source_id: identity.id || null,
          video_id: videoId || null,
          post_id: postId || null,
          youtube_post_id: postId || null,
          deletion_locator: {
            version: 2,
            page: "youtube_live_chat",
            row_data_id: row.getAttribute("data-id") || null,
            row_jsdata: row.getAttribute("jsdata") || null,
            row_data_ved: row.getAttribute("data-ved") || null,
            row_text_hash: fnv(rowText),
            semantic_hash: fnv(`youtube_live_chat|${identity.key}|${title}|${content}`),
            button_tag: button.tagName,
            button_role: button.getAttribute("role") || null,
            button_aria_label: button.getAttribute("aria-label") || null,
            button_title: button.getAttribute("title") || null,
            title,
            content,
            source_type: identity.kind,
            source_id: identity.id || null,
            source_url: original.url,
            video_id: videoId || null,
            video_url: videoId ? original.url : null,
            post_id: postId || null,
            post_url: postId ? original.url : null
          }
        }
      };
    };

    const collected = new Map();
    const collectVisible = () => {
      let added = 0;
      for (const button of deleteButtons()) {
        const row = rowForButton(button);
        if (!row) continue;
        const item = parseRow(row, button);
        if (!item || collected.has(item.external_id)) continue;
        collected.set(item.external_id, item);
        added += 1;
      }
      return added;
    };
    const scrollers = () => {
      const candidates = [
        document.scrollingElement,
        document.documentElement,
        document.body,
        ...document.querySelectorAll("body *")
      ]
        .filter(Boolean)
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect?.() || {height: 0};
          return rect.height >= 220
            && element.scrollHeight > element.clientHeight + 80
            && /(auto|scroll)/.test(style.overflowY || "");
        });
      return [...new Set(candidates)].sort((left, right) => (
        (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight)
      ));
    };
    const resetScroll = () => {
      window.scrollTo(0, 0);
      for (const scroller of scrollers().slice(0, 4)) scroller.scrollTop = 0;
    };

    resetScroll();
    await sleep(700);
    let noGrowthCycles = 0;
    let bottomCycles = 0;
    let scrollSteps = 0;

    for (let step = 0; step < 1400 && collected.size < 5000; step += 1) {
      scrollSteps = step + 1;
      const added = collectVisible();
      noGrowthCycles = added > 0 ? 0 : noGrowthCycles + 1;

      const active = scrollers().slice(0, 4);
      let moved = false;
      let atBottom = active.length > 0;
      for (const scroller of active) {
        const before = scroller.scrollTop;
        const remaining = scroller.scrollHeight - scroller.clientHeight - before;
        if (remaining > 3) atBottom = false;
        const amount = Math.max(360, Math.floor((scroller.clientHeight || innerHeight) * 0.62));
        scroller.scrollTop = Math.min(scroller.scrollHeight, before + amount);
        scroller.dispatchEvent(new Event("scroll", {bubbles: true}));
        if (scroller.scrollTop !== before) moved = true;
      }
      if (!active.length) {
        const before = window.scrollY;
        window.scrollBy(0, Math.max(420, innerHeight * 0.62));
        moved = window.scrollY !== before;
        atBottom = !moved;
      }

      if (atBottom || !moved) {
        bottomCycles += 1;
        const primary = active[0] || document.scrollingElement;
        if (primary && bottomCycles % 3 === 0) {
          const bottom = Math.max(0, primary.scrollHeight - primary.clientHeight);
          primary.scrollTop = Math.max(0, bottom - Math.max(120, primary.clientHeight * 0.18));
          primary.dispatchEvent(new Event("scroll", {bubbles: true}));
          await sleep(180);
          primary.scrollTop = bottom;
          primary.dispatchEvent(new Event("scroll", {bubbles: true}));
        }
        await sleep(850);
      } else {
        bottomCycles = 0;
        await sleep(320);
      }

      collectVisible();
      if (noGrowthCycles >= 70 && bottomCycles >= 12) break;
    }

    collectVisible();
    resetScroll();
    const items = [...collected.values()];
    const linkedCount = items.filter((item) => Boolean(item.source_url)).length;
    return {
      platform: "youtube",
      source_url: location.href,
      status: items.length ? "success" : "partial",
      message: items.length
        ? `YouTube 실시간 스트리밍 채팅 메시지 ${items.length}개를 확인했습니다. 원문 링크 ${linkedCount}개 확인.`
        : "YouTube 실시간 스트리밍 채팅 메시지를 찾지 못했습니다.",
      scroll_steps: scrollSteps,
      items
    };
  }
})();
