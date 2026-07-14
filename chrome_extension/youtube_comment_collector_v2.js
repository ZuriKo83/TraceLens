(() => {
  const previousRunExtractor = runExtractor;

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    if (platform !== "youtube" || activityType !== "comment") {
      return previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    }

    const injected = await chrome.scripting.executeScript({
      target: {tabId},
      func: collectYouTubeCommentsStable,
      args: [accountContext?.accountLabel || null],
    });
    const result = injected?.[0]?.result;
    if (!result) {
      throw new Error("YouTube 댓글 활동 페이지에서 조회 결과를 받지 못했습니다.");
    }

    const items = Array.isArray(result.items) ? result.items.slice(0, 5000) : [];
    const linkedCount = items.filter((item) => Boolean(item.source_url)).length;
    const unlinkedCount = Math.max(0, items.length - linkedCount);
    const completeText = result.snapshot_complete ? "전체 목록 확인 완료." : "일부 목록만 확인됨.";
    return {
      platform: "youtube",
      source_url: result.source_url || "https://myactivity.google.com/page?page=youtube_comments&hl=ko",
      scan_scope: "comment",
      snapshot_complete: Boolean(result.snapshot_complete),
      status: items.length || result.snapshot_complete ? "success" : "partial",
      message: items.length
        ? `YouTube 댓글 ${items.length}개를 확인했습니다. 원문 링크 ${linkedCount}개 확인${unlinkedCount ? `, ${unlinkedCount}개 미노출` : ""}. ${completeText}`
        : result.message || "YouTube 댓글을 찾지 못했습니다.",
      account_label: accountContext?.accountLabel || null,
      items,
    };
  };

  async function collectYouTubeCommentsStable(accountLabel) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    if (location.hostname !== "myactivity.google.com" || current.searchParams.get("page") !== "youtube_comments") {
      return {
        source_url: location.href,
        snapshot_complete: false,
        message: `Google 내 활동의 youtube_comments 페이지가 아닙니다. 현재 주소: ${location.href}`,
        items: [],
      };
    }

    const decodeHtml = (value) => {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = String(value || "");
      return textarea.value;
    };
    const decodeCandidates = (raw) => {
      const queue = [String(raw || "")];
      const output = [];
      const seen = new Set();
      while (queue.length && output.length < 48) {
        const value = queue.shift()?.trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        output.push(value);
        const unescaped = decodeHtml(value)
          .replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&")
          .replace(/\\u003f/gi, "?").replace(/\\u002f/gi, "/")
          .replace(/\\x3d/gi, "=").replace(/\\x26/gi, "&")
          .replace(/\\x2f/gi, "/").replace(/\\\//g, "/");
        if (!seen.has(unescaped)) queue.push(unescaped);
        try {
          const decoded = decodeURIComponent(unescaped);
          if (!seen.has(decoded)) queue.push(decoded);
        } catch {
          // Google attributes can contain partial percent encoding.
        }
      }
      return output;
    };
    const validVideoId = (value) => {
      const id = clean(value).replace(/^["']|["']$/g, "");
      return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : "";
    };
    const validPostId = (value) => {
      const id = clean(value).replace(/^["']|["']$/g, "");
      return /^[A-Za-z0-9_-]{10,160}$/.test(id) ? id : "";
    };
    const canonicalUrl = (raw) => {
      const queue = decodeCandidates(raw);
      const visited = new Set();
      while (queue.length && visited.size < 96) {
        let value = queue.shift();
        if (!value) continue;
        value = value.trim().replace(/^["'`]+|["'`,;]+$/g, "");
        if (!value || visited.has(value)) continue;
        visited.add(value);
        let parsed;
        try {
          parsed = new URL(value, /^\/(?:watch|shorts|live|embed|v|post)\b/i.test(value)
            ? "https://www.youtube.com"
            : location.href);
        } catch {
          continue;
        }
        for (const key of ["url", "q", "continue", "redirect", "target", "u", "dest", "destination", "link", "href"]) {
          const nested = parsed.searchParams.get(key);
          if (nested) queue.push(...decodeCandidates(nested));
        }
        const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
        if (host === "youtu.be") {
          const videoId = validVideoId(parsed.pathname.split("/").filter(Boolean)[0] || "");
          if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
        }
        if (!["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) continue;
        const postId = validPostId(parsed.pathname.match(/^\/post\/([^/?#]+)/i)?.[1] || "");
        if (postId) return `https://www.youtube.com/post/${postId}`;
        const videoId = validVideoId(
          parsed.searchParams.get("v")
          || parsed.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i)?.[1]
          || ""
        );
        if (videoId) {
          const commentId = clean(parsed.searchParams.get("lc") || "");
          const url = new URL("https://www.youtube.com/watch");
          url.searchParams.set("v", videoId);
          if (/^[A-Za-z0-9_-]{6,200}$/.test(commentId)) url.searchParams.set("lc", commentId);
          return url.href;
        }
      }
      return null;
    };
    const identity = (url) => {
      if (!url) return {kind: null, id: "", key: "", commentId: ""};
      try {
        const parsed = new URL(url);
        const postId = validPostId(parsed.pathname.match(/^\/post\/([^/?#]+)/i)?.[1] || "");
        if (postId) return {kind: "post", id: postId, key: `post:${postId}`, commentId: ""};
        const videoId = validVideoId(parsed.searchParams.get("v") || "");
        const commentId = clean(parsed.searchParams.get("lc") || "");
        if (videoId) return {kind: "video", id: videoId, key: `video:${videoId}`, commentId};
      } catch {
        // Ignore malformed source URLs.
      }
      return {kind: null, id: "", key: "", commentId: ""};
    };

    const deleteButtons = () => [...document.querySelectorAll("button,[role='button']")].filter((button) => {
      if (!visible(button)) return false;
      const label = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
      const text = clean(button.innerText || button.textContent);
      return /삭제|delete|remove|활동 삭제/i.test(label) || ["×", "✕", "X"].includes(text);
    });
    const rowFor = (button) => {
      const direct = button.closest("[role='listitem'],article,li,div[data-id]");
      if (direct) return direct;
      let node = button.parentElement;
      for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
        const text = clean(node.innerText || node.textContent);
        if (text.length >= 3 && text.length <= 12000 && /YouTube/i.test(text)) return node;
      }
      return null;
    };
    const originalLink = (row) => {
      const values = [];
      for (const anchor of row.querySelectorAll("a")) {
        values.push({value: anchor.href, node: anchor, score: 120});
        values.push({value: anchor.getAttribute("href"), node: anchor, score: 115});
        for (const attr of ["data-url", "data-href", "data-link", "data-target-url", "jsdata", "data-ved"]) {
          values.push({value: anchor.getAttribute(attr), node: anchor, score: 100});
        }
      }
      for (const node of [row, ...row.querySelectorAll("*")]) {
        for (const attr of node.getAttributeNames?.() || []) {
          const value = node.getAttribute(attr);
          if (value && /youtube|youtu\.be|watch|shorts|live|post|attribution_link/i.test(value)) {
            values.push({value, node, score: 70});
          }
        }
      }
      values.push({value: row.outerHTML || "", node: null, score: 20});
      const resolved = values.map((candidate) => {
        const url = canonicalUrl(candidate.value);
        if (!url) return null;
        const displayNode = candidate.node?.closest?.("a") || candidate.node;
        return {
          url,
          node: displayNode,
          score: candidate.score + (clean(displayNode?.textContent) ? 8 : 0),
        };
      }).filter(Boolean).sort((left, right) => right.score - left.score);
      return resolved[0] || {url: null, node: null};
    };

    const parseRow = (row, button) => {
      const rawLines = String(row.innerText || row.textContent || "")
        .split(/\r?\n/).map(clean).filter(Boolean);
      if (!rawLines.length) return null;
      const original = originalLink(row);
      const source = identity(original.url);
      const linkTitle = clean(original.node?.innerText || original.node?.textContent);
      const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM)$/i;
      const relation = /에\s*남긴\s*댓글|에\s*작성한\s*댓글|commented on/i;
      const timestamp = rawLines.find((line) => (
        /(?:오전|오후)\s*\d{1,2}:\d{2}/.test(line)
        || /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(line)
        || /^\d{4}[.\-/]\s*\d{1,2}[.\-/]\s*\d{1,2}/.test(line)
      )) || "";
      const candidateLines = rawLines.filter((line) => !control.test(line));
      const content = candidateLines.find((line) => (
        !relation.test(line)
        && line !== linkTitle
        && line !== timestamp
        && !/^YouTube$/i.test(line)
        && !/세부정보|Details/i.test(line)
      )) || "";
      if (!content) return null;

      let title = linkTitle;
      if (!title || title === content || /^(YouTube|동영상|video)$/i.test(title)) {
        const relationLine = candidateLines.find((line) => relation.test(line));
        title = relationLine ? relationLine.replace(relation, "").trim() : "";
      }
      if (!title) title = source.kind === "post" ? "YouTube 게시물" : "YouTube 동영상";

      const semantic = `youtube_comments|${source.key}|${title}|${content}|${timestamp}`;
      const semanticHash = fnv(semantic);
      const externalId = source.commentId
        ? `youtube-comment-${source.commentId}`
        : `youtube-comment-${semanticHash}`;
      const rowText = clean(row.innerText || row.textContent);
      return {
        external_id: externalId,
        activity_type: "comment",
        title: clip(title, 2000),
        content: clip(content, 20000),
        source_url: original.url,
        occurred_at: null,
        metadata: {
          captured_from: location.href,
          page_title: document.title,
          ownership_scope: "self_activity",
          ownership_verified: true,
          extractor_version: "2.0.0-comment-stable",
          account_label: accountLabel,
          youtube_activity_kind: "comment",
          my_activity_page: "youtube_comments",
          comment_id: source.commentId || externalId,
          youtube_comment_id: source.commentId || externalId,
          original_url: original.url,
          original_link_resolved: Boolean(original.url),
          original_link_status: original.url ? "resolved" : "not_exposed",
          source_type: source.kind,
          source_id: source.id || null,
          video_id: source.kind === "video" ? source.id : null,
          post_id: source.kind === "post" ? source.id : null,
          youtube_post_id: source.kind === "post" ? source.id : null,
          deletion_locator: {
            version: 3,
            page: "youtube_comments",
            record_key_hash: semanticHash,
            row_data_id: row.getAttribute("data-id") || null,
            row_jsdata: row.getAttribute("jsdata") || null,
            row_data_ved: row.getAttribute("data-ved") || null,
            row_text_hash: fnv(rowText),
            semantic_hash: semanticHash,
            button_tag: button.tagName,
            button_role: button.getAttribute("role") || null,
            button_aria_label: button.getAttribute("aria-label") || null,
            button_title: button.getAttribute("title") || null,
            title,
            content,
            timestamp: timestamp || null,
            source_type: source.kind,
            source_id: source.id || null,
            source_url: original.url,
            video_id: source.kind === "video" ? source.id : null,
            video_url: source.kind === "video" ? original.url : null,
            post_id: source.kind === "post" ? source.id : null,
            post_url: source.kind === "post" ? original.url : null,
          },
        },
      };
    };

    const collected = new Map();
    const nodeKeys = new WeakMap();
    let recycledRows = 0;
    const collectVisible = () => {
      for (const button of deleteButtons()) {
        const row = rowFor(button);
        if (!row) continue;
        const item = parseRow(row, button);
        if (!item) continue;
        const previous = nodeKeys.get(row);
        if (previous && previous !== item.external_id) recycledRows += 1;
        nodeKeys.set(row, item.external_id);
        if (!collected.has(item.external_id)) collected.set(item.external_id, item);
      }
    };

    const scrollCandidates = () => {
      const doc = document.scrollingElement || document.documentElement;
      return [doc, document.documentElement, document.body, ...document.querySelectorAll("main,c-wiz,section,div")]
        .filter(Boolean)
        .filter((node, index, all) => all.indexOf(node) === index)
        .filter((node) => {
          if (node === doc) return node.scrollHeight > node.clientHeight + 30;
          const style = getComputedStyle(node);
          return visible(node)
            && node.scrollHeight > node.clientHeight + 80
            && /(auto|scroll)/.test(style.overflowY || "");
        })
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
    };
    const resetTop = () => {
      const doc = document.scrollingElement || document.documentElement;
      window.scrollTo(0, 0);
      doc.scrollTop = 0;
      for (const node of scrollCandidates().slice(0, 4)) node.scrollTop = 0;
    };
    const endMarkerVisible = () => {
      const pattern = /더 이상 표시할 콘텐츠가 없습니다|no more content/i;
      return [...document.querySelectorAll("body *")].some((node) => {
        if (!visible(node)) return false;
        const text = clean(node.textContent || "");
        return text.length <= 100 && pattern.test(text);
      });
    };

    resetTop();
    await wait(550);
    let endSeen = 0;
    let stable = 0;
    let previousSignature = "";
    let snapshotComplete = false;

    for (let step = 0; step < 1200 && collected.size < 5000; step += 1) {
      collectVisible();
      if (endMarkerVisible()) {
        endSeen += 1;
        if (endSeen >= 2) {
          snapshotComplete = true;
          break;
        }
      } else {
        endSeen = 0;
      }

      const target = scrollCandidates()[0] || document.scrollingElement || document.documentElement;
      const before = target.scrollTop || 0;
      const bottom = Math.max(0, target.scrollHeight - target.clientHeight);
      const amount = Math.max(520, Math.floor((target.clientHeight || innerHeight) * 0.72));
      target.scrollTop = Math.min(bottom, before + amount);
      target.dispatchEvent(new Event("scroll", {bubbles: true}));
      if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
        window.scrollTo(0, target.scrollTop || 0);
      }
      const moved = (target.scrollTop || 0) !== before;
      await wait(moved ? 360 : 850);
      collectVisible();

      const signature = `${collected.size}|${Math.round(target.scrollTop || 0)}|${Math.round(target.scrollHeight || 0)}|${endSeen}`;
      stable = signature === previousSignature ? stable + 1 : 0;
      previousSignature = signature;
      if (!moved && stable >= 20) break;
    }

    collectVisible();
    resetTop();
    return {
      source_url: location.href,
      snapshot_complete: snapshotComplete,
      message: snapshotComplete
        ? "YouTube 댓글 전체 목록 확인을 마쳤습니다."
        : "YouTube 댓글 페이지의 끝을 확인하지 못해 일부 목록으로 처리했습니다.",
      virtualized_rows_seen: recycledRows,
      items: [...collected.values()],
    };
  }
})();
