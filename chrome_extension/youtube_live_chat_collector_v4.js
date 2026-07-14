(() => {
  const previousRunExtractor = runExtractor;

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    if (platform !== "youtube" || activityType !== "live_chat") {
      return previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    }

    await chrome.tabs.update(tabId, {active: true}).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const results = await chrome.scripting.executeScript({
      target: {tabId},
      func: collectLiveChatWithDocumentScroller,
      args: [accountContext?.accountLabel || null]
    });
    const payload = results?.[0]?.result;
    if (!payload) {
      throw new Error("YouTube 실시간 채팅 활동 페이지에서 조회 결과를 받지 못했습니다.");
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    const linkedCount = items.filter((item) => Boolean(item.source_url)).length;
    const unlinkedCount = Math.max(0, items.length - linkedCount);
    return {
      platform: "youtube",
      source_url: payload.source_url,
      scan_scope: "live_chat",
      status: items.length ? "success" : payload.status || "partial",
      message: items.length
        ? `YouTube 실시간 스트리밍 채팅 메시지 ${items.length}개를 확인했습니다. 원문 링크 ${linkedCount}개 확인${unlinkedCount ? `, ${unlinkedCount}개 미노출` : ""}. 문서 스크롤 ${payload.scroll_steps || 0}회.`
        : payload.message || "YouTube 실시간 스트리밍 채팅 메시지를 찾지 못했습니다.",
      account_label: accountContext?.accountLabel || null,
      items: items.slice(0, 5000)
    };
  };

  async function collectLiveChatWithDocumentScroller(accountLabel) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };

    const currentUrl = new URL(location.href);
    const currentPage = currentUrl.searchParams.get("page") || "";
    if (location.hostname !== "myactivity.google.com" || currentPage !== "youtube_live_chat") {
      return {
        platform: "youtube",
        source_url: location.href,
        status: "partial",
        message: `Google 내 활동의 youtube_live_chat 페이지가 아닙니다. 현재 주소: ${location.href}`,
        scroll_steps: 0,
        items: []
      };
    }

    const decodeValues = (raw) => {
      const queue = [String(raw || "")];
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
        if (!seen.has(unescaped)) queue.push(unescaped);
        try {
          const decoded = decodeURIComponent(unescaped);
          if (decoded && !seen.has(decoded)) queue.push(decoded);
        } catch {
          // Google serializes some attributes with incomplete percent encoding.
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
    const canonicalUrl = (raw) => {
      if (!raw) return null;
      const queue = decodeValues(raw);
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
          if (nested) queue.push(...decodeValues(nested));
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
        // Ignore malformed candidate URL.
      }
      return {kind: null, id: "", key: ""};
    };

    const deleteControls = () => [...document.querySelectorAll("button,[role='button'],[aria-label],[title]")].filter((node) => {
      if (!visible(node)) return false;
      const label = clean(`${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`);
      const text = clean(node.innerText || node.textContent);
      return /삭제|delete|remove|활동 삭제/i.test(label) || ["×", "✕", "X"].includes(text);
    });
    const rowForControl = (control) => {
      const direct = control.closest("[role='listitem'],article,li,div[data-id]");
      if (direct) return direct;
      let node = control.parentElement;
      for (let depth = 0; node && depth < 16; depth += 1, node = node.parentElement) {
        const text = clean(node.innerText || node.textContent);
        if (text.length >= 3 && text.length <= 12000 && /YouTube/i.test(text)) return node;
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
      const resolved = candidates
        .map((candidate) => {
          const url = canonicalUrl(candidate.value);
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
    const parseRow = (row, control) => {
      const rawLines = String(row.innerText || row.textContent || "")
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean);
      if (!rawLines.length) return null;

      const original = originalLinkFromRow(row);
      const identity = sourceIdentity(original.url);
      const linkTitle = clean(original.node?.innerText || original.node?.textContent);
      const relation = /에서\s*메시지를\s*전송함|sent a message/i;
      const controlLine = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM)$/i;
      const candidates = rawLines.filter((line) => !controlLine.test(line));
      const content = candidates.find((line) => (
        !relation.test(line)
        && line !== linkTitle
        && !/^YouTube$/i.test(line)
      )) || "";
      if (!content) return null;

      let title = linkTitle;
      if (!title || title === content || /^(YouTube|동영상|video)$/i.test(title)) {
        const relationLine = candidates.find((line) => relation.test(line));
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
      const uniqueRow = rowId || fnv(`${rowText}|${original.url || ""}`);
      const externalId = `youtube-live_chat-${fnv(`youtube_live_chat|${identity.key}|${title}|${content}|${uniqueRow}`)}`;
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
          extractor_version: "1.4.0-live-chat-document-scroll",
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
            version: 3,
            page: "youtube_live_chat",
            row_data_id: row.getAttribute("data-id") || null,
            row_jsdata: row.getAttribute("jsdata") || null,
            row_data_ved: row.getAttribute("data-ved") || null,
            row_text_hash: fnv(rowText),
            semantic_hash: fnv(`youtube_live_chat|${identity.key}|${title}|${content}`),
            button_tag: control.tagName,
            button_role: control.getAttribute("role") || null,
            button_aria_label: control.getAttribute("aria-label") || null,
            button_title: control.getAttribute("title") || null,
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
      for (const control of deleteControls()) {
        const row = rowForControl(control);
        if (!row) continue;
        const item = parseRow(row, control);
        if (!item || collected.has(item.external_id)) continue;
        collected.set(item.external_id, item);
        added += 1;
      }
      return added;
    };

    const scrollCandidates = () => {
      const base = [document.scrollingElement, document.documentElement, document.body];
      const elements = [...document.querySelectorAll("main,c-wiz,section,div")]
        .filter((element) => element.scrollHeight > element.clientHeight + 30);
      return [...new Set([...base, ...elements].filter(Boolean))]
        .sort((left, right) => (
          (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight)
        ));
    };
    const scrollSignature = () => {
      const candidates = scrollCandidates().slice(0, 8);
      const heights = candidates.map((element) => `${element.scrollTop}:${element.clientHeight}:${element.scrollHeight}`).join("|");
      return `${collected.size}|${document.documentElement.scrollHeight}|${document.body?.scrollHeight || 0}|${heights}`;
    };
    const resetTop = async () => {
      const doc = document.scrollingElement || document.documentElement;
      doc.scrollTop = 0;
      window.scrollTo(0, 0);
      for (const element of scrollCandidates().slice(0, 8)) element.scrollTop = 0;
      await nextFrame();
    };
    const moveDown = async () => {
      const amount = Math.max(420, Math.floor(innerHeight * 0.68));
      const doc = document.scrollingElement || document.documentElement;
      const candidates = scrollCandidates().slice(0, 8);
      let moved = false;
      let atBottom = true;

      const docBefore = doc.scrollTop;
      const docBottom = Math.max(0, doc.scrollHeight - doc.clientHeight);
      doc.scrollTop = Math.min(docBottom, docBefore + amount);
      window.scrollTo(0, doc.scrollTop);
      if (doc.scrollTop !== docBefore) moved = true;
      if (docBottom - doc.scrollTop > 4) atBottom = false;

      for (const element of candidates) {
        if (element === doc || element === document.documentElement || element === document.body) continue;
        const before = element.scrollTop;
        const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop = Math.min(bottom, before + Math.max(320, Math.floor(element.clientHeight * 0.65)));
        element.dispatchEvent(new Event("scroll", {bubbles: true}));
        if (element.scrollTop !== before) moved = true;
        if (bottom - element.scrollTop > 4) atBottom = false;
      }

      await nextFrame();
      return {moved, atBottom};
    };

    await resetTop();
    for (let attempt = 0; attempt < 40 && deleteControls().length === 0; attempt += 1) {
      await sleep(500);
    }

    let stableBottom = 0;
    let unchanged = 0;
    let previous = "";
    let scrollSteps = 0;

    for (let step = 0; step < 1600 && collected.size < 5000; step += 1) {
      scrollSteps = step + 1;
      collectVisible();
      const beforeSignature = scrollSignature();
      const movement = await moveDown();
      await sleep(movement.atBottom || !movement.moved ? 850 : 320);
      collectVisible();
      const afterSignature = scrollSignature();

      if (afterSignature === previous || afterSignature === beforeSignature) unchanged += 1;
      else unchanged = 0;
      previous = afterSignature;

      if (movement.atBottom || !movement.moved) stableBottom += 1;
      else stableBottom = 0;

      if (stableBottom >= 3) {
        const doc = document.scrollingElement || document.documentElement;
        const bottom = Math.max(0, doc.scrollHeight - doc.clientHeight);
        doc.scrollTop = Math.max(0, bottom - Math.max(140, innerHeight * 0.18));
        window.scrollTo(0, doc.scrollTop);
        await sleep(180);
        doc.scrollTop = bottom;
        window.scrollTo(0, bottom);
        await sleep(650);
        collectVisible();
      }

      if (stableBottom >= 18 && unchanged >= 24) break;
    }

    collectVisible();
    const finalCandidates = scrollCandidates().slice(0, 8).map((element) => ({
      tag: element.tagName || "document",
      top: Math.round(element.scrollTop || 0),
      client: Math.round(element.clientHeight || 0),
      height: Math.round(element.scrollHeight || 0),
      overflow: getComputedStyle(element).overflowY || ""
    }));
    await resetTop();

    const items = [...collected.values()];
    const pageText = clean(document.body?.innerText || "").slice(0, 700);
    return {
      platform: "youtube",
      source_url: location.href,
      status: items.length ? "success" : "partial",
      message: items.length
        ? `YouTube 실시간 스트리밍 채팅 메시지 ${items.length}개를 확인했습니다.`
        : `YouTube 실시간 스트리밍 채팅 메시지를 찾지 못했습니다. 화면 요약: ${pageText}. 스크롤 후보: ${JSON.stringify(finalCandidates)}`,
      scroll_steps: scrollSteps,
      items
    };
  }
})();
