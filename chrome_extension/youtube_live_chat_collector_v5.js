(() => {
  const previousRunExtractor = runExtractor;

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    if (platform !== "youtube" || activityType !== "live_chat") {
      return previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    }

    const collected = new Map();
    let unchanged = 0;
    let endSeen = 0;
    let scrollSteps = 0;
    let lastSignature = "";
    let lastDiagnostics = null;

    for (let step = 0; step < 700 && collected.size < 5000; step += 1) {
      scrollSteps = step + 1;
      const injected = await chrome.scripting.executeScript({
        target: {tabId},
        func: collectAndScrollLiveChatStep,
        args: [accountContext?.accountLabel || null]
      });
      const result = injected?.[0]?.result;
      if (!result) {
        throw new Error("YouTube 실시간 채팅 활동 페이지에서 조회 결과를 받지 못했습니다.");
      }
      if (!result.ok) {
        return {
          platform: "youtube",
          source_url: result.source_url || "https://myactivity.google.com/page?page=youtube_live_chat&hl=ko",
          scan_scope: "live_chat",
          status: "partial",
          message: result.message || "YouTube 실시간 스트리밍 채팅 페이지를 확인하지 못했습니다.",
          account_label: accountContext?.accountLabel || null,
          items: []
        };
      }

      let added = 0;
      for (const item of result.items || []) {
        if (!item.external_id || collected.has(item.external_id)) continue;
        collected.set(item.external_id, item);
        added += 1;
      }

      lastDiagnostics = result.diagnostics || null;
      const signature = `${collected.size}|${result.signature || ""}`;
      unchanged = added > 0 || signature !== lastSignature ? 0 : unchanged + 1;
      lastSignature = signature;
      endSeen = result.end_reached ? endSeen + 1 : 0;

      if (endSeen >= 2 && unchanged >= 1) break;
      if (!result.moved && unchanged >= 10) break;
      await new Promise((resolve) => setTimeout(resolve, result.end_reached ? 700 : 260));
    }

    const items = [...collected.values()];
    const linkedCount = items.filter((item) => Boolean(item.source_url)).length;
    const unlinkedCount = Math.max(0, items.length - linkedCount);
    return {
      platform: "youtube",
      source_url: "https://myactivity.google.com/page?page=youtube_live_chat&hl=ko",
      scan_scope: "live_chat",
      status: items.length ? "success" : "partial",
      message: items.length
        ? `YouTube 실시간 스트리밍 채팅 메시지 ${items.length}개를 확인했습니다. 원문 링크 ${linkedCount}개 확인${unlinkedCount ? `, ${unlinkedCount}개 미노출` : ""}. 백그라운드 스크롤 ${scrollSteps}회.`
        : `YouTube 실시간 스트리밍 채팅 메시지를 찾지 못했습니다.${lastDiagnostics ? ` 진단: ${JSON.stringify(lastDiagnostics)}` : ""}`,
      account_label: accountContext?.accountLabel || null,
      items: items.slice(0, 5000)
    };
  };

  function collectAndScrollLiveChatStep(accountLabel) {
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

    const current = new URL(location.href);
    if (location.hostname !== "myactivity.google.com" || current.searchParams.get("page") !== "youtube_live_chat") {
      return {
        ok: false,
        source_url: location.href,
        message: `Google 내 활동의 youtube_live_chat 페이지가 아닙니다. 현재 주소: ${location.href}`,
        items: []
      };
    }

    const decodeValues = (raw) => {
      const queue = [String(raw || "")];
      const output = [];
      const seen = new Set();
      while (queue.length && output.length < 30) {
        const value = queue.shift()?.trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        output.push(value);
        const unescaped = value
          .replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&")
          .replace(/\\u003f/gi, "?").replace(/\\u002f/gi, "/")
          .replace(/\\x3d/gi, "=").replace(/\\x26/gi, "&")
          .replace(/\\x2f/gi, "/").replace(/\\\//g, "/");
        if (!seen.has(unescaped)) queue.push(unescaped);
        try {
          const decoded = decodeURIComponent(unescaped);
          if (!seen.has(decoded)) queue.push(decoded);
        } catch {
          // Ignore incomplete encoding from Google attributes.
        }
      }
      return output;
    };
    const canonicalUrl = (raw) => {
      for (const value of decodeValues(raw)) {
        let parsed;
        try {
          parsed = new URL(value, location.href);
        } catch {
          continue;
        }
        for (const key of ["url", "q", "continue", "redirect", "target", "u", "dest", "destination"]) {
          const nested = parsed.searchParams.get(key);
          if (nested) {
            const found = canonicalUrl(nested);
            if (found) return found;
          }
        }
        const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
        if (host === "youtu.be") {
          const id = parsed.pathname.split("/").filter(Boolean)[0] || "";
          if (/^[A-Za-z0-9_-]{6,20}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
        }
        if (!["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) continue;
        const post = parsed.pathname.match(/^\/post\/([A-Za-z0-9_-]{10,160})/i)?.[1];
        if (post) return `https://www.youtube.com/post/${post}`;
        const video = parsed.searchParams.get("v") || parsed.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{6,20})/i)?.[1];
        if (video) return parsed.pathname.startsWith("/shorts/")
          ? `https://www.youtube.com/shorts/${video}`
          : `https://www.youtube.com/watch?v=${video}`;
      }
      const text = decodeValues(raw).join(" ");
      const match = text.match(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s"'<>\\]+/i);
      return match ? canonicalUrl(match[0]) : null;
    };
    const identityFromUrl = (url) => {
      if (!url) return {type: null, id: "", key: ""};
      try {
        const parsed = new URL(url);
        const post = parsed.pathname.match(/^\/post\/([^/?#]+)/i)?.[1] || "";
        if (post) return {type: "post", id: post, key: `post:${post}`};
        const video = parsed.searchParams.get("v") || parsed.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i)?.[1] || "";
        if (video) return {type: "video", id: video, key: `video:${video}`};
      } catch {
        // Ignore malformed URL.
      }
      return {type: null, id: "", key: ""};
    };

    const controls = [...document.querySelectorAll("button,[role='button'],[aria-label],[title]")].filter((node) => {
      if (!visible(node)) return false;
      const label = clean(`${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`);
      const text = clean(node.innerText || node.textContent);
      return /삭제|delete|remove|활동 삭제/i.test(label) || ["×", "✕", "X"].includes(text);
    });
    const rowFor = (control) => {
      const direct = control.closest("[role='listitem'],article,li,div[data-id]");
      if (direct) return direct;
      let node = control.parentElement;
      for (let depth = 0; node && depth < 16; depth += 1, node = node.parentElement) {
        const text = clean(node.innerText || node.textContent);
        if (text.length >= 3 && text.length <= 12000 && /YouTube/i.test(text)) return node;
      }
      return null;
    };
    const linkFromRow = (row) => {
      const rawValues = [];
      for (const anchor of row.querySelectorAll("a")) {
        rawValues.push(anchor.href, anchor.getAttribute("href"));
        for (const attr of ["data-url", "data-href", "data-link", "data-target-url", "jsdata", "data-ved"]) {
          rawValues.push(anchor.getAttribute(attr));
        }
      }
      for (const node of [row, ...row.querySelectorAll("*")]) {
        for (const attr of node.getAttributeNames?.() || []) {
          const value = node.getAttribute(attr);
          if (value && /youtube|youtu\.be|watch|shorts|post|attribution_link/i.test(value)) rawValues.push(value);
        }
      }
      for (const raw of rawValues) {
        const url = canonicalUrl(raw);
        if (url) return url;
      }
      return null;
    };

    const items = [];
    const seen = new Set();
    for (const control of controls) {
      const row = rowFor(control);
      if (!row) continue;
      const rawLines = String(row.innerText || row.textContent || "").split(/\r?\n/).map(clean).filter(Boolean);
      const relation = /에서\s*메시지를\s*전송함|sent a message/i;
      const filtered = rawLines.filter((line) => !/^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM)$/i.test(line));
      const relationLine = filtered.find((line) => relation.test(line)) || "";
      const sourceUrl = linkFromRow(row);
      const identity = identityFromUrl(sourceUrl);
      const title = relationLine ? relationLine.replace(relation, "").trim() : "YouTube 실시간 스트리밍";
      const content = filtered.find((line) => line !== relationLine && line !== title && !/^YouTube$/i.test(line)) || "";
      if (!content) continue;

      const rowText = clean(row.innerText || row.textContent);
      const rowId = String(row.getAttribute("data-id") || row.getAttribute("jsdata") || row.getAttribute("data-ved") || row.getAttribute("data-key") || "");
      const unique = rowId || fnv(`${rowText}|${sourceUrl || ""}`);
      const externalId = `youtube-live_chat-${fnv(`youtube_live_chat|${identity.key}|${title}|${content}|${unique}`)}`;
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      const videoId = identity.type === "video" ? identity.id : null;
      const postId = identity.type === "post" ? identity.id : null;
      items.push({
        external_id: externalId,
        activity_type: "comment",
        title: clip(`[실시간 채팅] ${title}`, 2000),
        content: clip(content, 20000),
        source_url: sourceUrl,
        occurred_at: null,
        metadata: {
          captured_from: location.href,
          page_title: document.title,
          ownership_scope: "self_activity",
          ownership_verified: true,
          extractor_version: "1.5.0-live-chat-background",
          account_label: accountLabel,
          youtube_activity_kind: "live_chat",
          my_activity_page: "youtube_live_chat",
          comment_id: externalId,
          youtube_comment_id: externalId,
          original_url: sourceUrl,
          original_link_resolved: Boolean(sourceUrl),
          original_link_status: sourceUrl ? "resolved" : "not_exposed",
          source_type: identity.type,
          source_id: identity.id || null,
          video_id: videoId,
          post_id: postId,
          youtube_post_id: postId,
          deletion_locator: {
            version: 4,
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
            source_type: identity.type,
            source_id: identity.id || null,
            source_url: sourceUrl,
            video_id: videoId,
            video_url: videoId ? sourceUrl : null,
            post_id: postId,
            post_url: postId ? sourceUrl : null
          }
        }
      });
    }

    const pageText = clean(document.body?.innerText || "");
    const endReached = /더 이상 표시할 콘텐츠가 없습니다|no more content/i.test(pageText);
    const doc = document.scrollingElement || document.documentElement;
    const candidates = [doc, document.documentElement, document.body, ...document.querySelectorAll("main,c-wiz,section,div")]
      .filter(Boolean)
      .filter((element, index, all) => all.indexOf(element) === index)
      .filter((element) => element === doc || element.scrollHeight > element.clientHeight + 30)
      .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));

    let moved = false;
    const amount = Math.max(420, Math.floor(innerHeight * 0.68));
    for (const element of candidates.slice(0, 8)) {
      const before = element.scrollTop || 0;
      const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.min(bottom, before + Math.max(320, element === doc ? amount : Math.floor(element.clientHeight * 0.65)));
      element.dispatchEvent(new Event("scroll", {bubbles: true}));
      if ((element.scrollTop || 0) !== before) moved = true;
    }
    window.scrollTo(0, doc.scrollTop || 0);

    const signature = candidates.slice(0, 8)
      .map((element) => `${Math.round(element.scrollTop || 0)}:${Math.round(element.clientHeight || 0)}:${Math.round(element.scrollHeight || 0)}`)
      .join("|");
    return {
      ok: true,
      source_url: location.href,
      items,
      moved,
      end_reached: endReached,
      signature,
      diagnostics: {
        visible_items: items.length,
        controls: controls.length,
        end_reached: endReached,
        candidate_count: candidates.length,
        document_top: Math.round(doc.scrollTop || 0),
        document_height: Math.round(doc.scrollHeight || 0)
      }
    };
  }
})();
