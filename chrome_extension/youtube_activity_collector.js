(() => {
  const originalRunExtractor = runExtractor;
  const originalAssertOwnedTaskUrl = assertOwnedTaskUrl;

  if (!SITE_TASKS.youtube.some((task) => task.activityType === "live_chat")) {
    SITE_TASKS.youtube.push({
      platform: "youtube",
      label: "YouTube 실시간 스트리밍 채팅 메시지",
      activityType: "live_chat",
      url: "https://myactivity.google.com/page?page=youtube_live_chat&hl=ko",
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
      func: collectYouTubeActivityPageV2,
      args: [activityType, accountContext?.accountLabel || null],
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

    const primary = payloads.find((payload) => payload.complete || payload.items?.length) || payloads[0];
    const complete = payloads.some((payload) => payload.complete === true) && items.length < 5000;
    const label = activityType === "live_chat" ? "실시간 채팅" : "댓글";
    const linkedCount = items.filter((item) => Boolean(item.source_url)).length;
    const unlinkedCount = Math.max(0, items.length - linkedCount);
    const completionText = complete ? "끝까지 확인했습니다." : "끝까지 확인하지 못해 부분 결과로 저장했습니다.";

    return {
      platform: "youtube",
      source_url: primary.source_url,
      scan_scope: activityType,
      status: complete ? "success" : "partial",
      snapshot_complete: complete,
      message: items.length
        ? `YouTube ${label} ${items.length}개를 확인했습니다. 원문 링크 ${linkedCount}개 확인${unlinkedCount ? `, ${unlinkedCount}개 미노출` : ""}. ${completionText}`
        : complete
          ? `YouTube ${label} 기록이 없습니다. 끝까지 확인했습니다.`
          : primary.message || `YouTube ${label} 기록을 끝까지 확인하지 못했습니다.`,
      account_label: accountContext?.accountLabel || null,
      items: items.slice(0, 5000),
    };
  };

  async function collectYouTubeActivityPageV2(activityType, accountLabel) {
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

    const expectedPage = activityType === "live_chat" ? "youtube_live_chat" : "youtube_comments";
    const page = new URL(location.href).searchParams.get("page") || "";
    if (location.hostname !== "myactivity.google.com" || page !== expectedPage) {
      return {
        platform: "youtube",
        source_url: location.href,
        status: "partial",
        complete: false,
        message: `Google 내 활동의 ${expectedPage} 페이지가 아닙니다.`,
        items: [],
      };
    }

    const decodeValue = (value) => {
      const output = new Set();
      const queue = [String(value || "")];
      while (queue.length && output.size < 24) {
        const current = queue.shift()?.trim();
        if (!current || output.has(current)) continue;
        output.add(current);
        const unescaped = current
          .replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&").replace(/\\u002f/gi, "/")
          .replace(/\\x3d/gi, "=").replace(/\\x26/gi, "&").replace(/\\x2f/gi, "/")
          .replace(/\\\//g, "/");
        if (!output.has(unescaped)) queue.push(unescaped);
        try {
          const decoded = decodeURIComponent(unescaped);
          if (!output.has(decoded)) queue.push(decoded);
        } catch {}
      }
      return [...output];
    };

    const canonicalYouTubeUrl = (rawValue) => {
      if (!rawValue) return null;
      const queue = decodeValue(rawValue);
      const visited = new Set();
      while (queue.length && visited.size < 64) {
        const candidate = queue.shift()?.trim().replace(/^["'`]+|["'`,;]+$/g, "");
        if (!candidate || visited.has(candidate)) continue;
        visited.add(candidate);
        let parsed;
        try {
          const relative = /^\/(?:watch|shorts\/|live\/|embed\/|v\/|post\/)/i.test(candidate);
          parsed = new URL(candidate, relative ? "https://www.youtube.com" : location.href);
        } catch {
          const embedded = candidate.match(/(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/[A-Za-z0-9_?&=/%.-]+/i)?.[0];
          if (embedded) queue.push(embedded);
          continue;
        }

        const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
        if (host === "youtu.be") {
          const videoId = parsed.pathname.split("/").filter(Boolean)[0];
          if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
        }
        if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
          const postId = parsed.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
          if (postId) return `https://www.youtube.com/post/${postId}`;
          const videoId = parsed.searchParams.get("v") || parsed.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i)?.[1];
          if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
        }
        for (const key of ["url", "q", "continue", "redirect", "target", "u", "dest", "href"]) {
          const nested = parsed.searchParams.get(key);
          if (nested) queue.push(...decodeValue(nested));
        }
      }
      return null;
    };

    const sourceIdentity = (url) => {
      if (!url) return {kind: null, id: "", key: ""};
      try {
        const parsed = new URL(url);
        const postId = parsed.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
        if (postId) return {kind: "post", id: postId, key: `post:${postId}`};
        const videoId = parsed.searchParams.get("v") || "";
        return videoId ? {kind: "video", id: videoId, key: videoId} : {kind: null, id: "", key: ""};
      } catch {
        return {kind: null, id: "", key: ""};
      }
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
        if (text.length >= 3 && text.length <= 12000 && /YouTube/i.test(text)) return node;
      }
      return null;
    };

    const originalLinkFromRow = (row) => {
      const candidates = [];
      const add = (value, node, priority) => {
        const raw = String(value || "").trim();
        if (raw) candidates.push({raw, node, priority});
      };
      for (const anchor of row.querySelectorAll("a")) {
        add(anchor.href, anchor, 120);
        add(anchor.getAttribute("href"), anchor, 115);
        for (const attr of ["data-url", "data-href", "data-link", "data-target-url", "jsdata", "data-ved"]) {
          add(anchor.getAttribute(attr), anchor, 95);
        }
      }
      for (const node of [row, ...row.querySelectorAll("*")]) {
        for (const attr of node.getAttributeNames?.() || []) {
          const value = node.getAttribute(attr);
          if (value && /youtube|youtu\.be|watch|shorts|live|post|attribution_link/i.test(value)) add(value, node, 60);
        }
      }
      add(row.outerHTML, null, 10);
      const resolved = candidates.map((candidate) => {
        const url = canonicalYouTubeUrl(candidate.raw);
        if (!url) return null;
        const textBonus = clean(candidate.node?.innerText || candidate.node?.textContent) ? 8 : 0;
        return {...candidate, url, score: candidate.priority + textBonus};
      }).filter(Boolean).sort((left, right) => right.score - left.score);
      return resolved[0] || {url: null, node: null};
    };

    const parseRow = (row, button) => {
      const rawLines = String(row.innerText || row.textContent || "").split(/\r?\n/).map(clean).filter(Boolean);
      if (!rawLines.length) return null;
      const original = originalLinkFromRow(row);
      const identity = sourceIdentity(original.url);
      const linkTitle = clean(original.node?.innerText || original.node?.textContent);
      const control = /^(YouTube|세부정보|Details|삭제|Delete|Remove|오전|오후|AM|PM)$/i;
      const relation = /에\s*남긴\s*댓글|에\s*작성한\s*댓글|에서\s*메시지를\s*전송함|commented on|sent a message/i;
      const dateLine = /^(?:\d{4}[.\-/]\s*)?\d{1,2}[.\-/]\s*\d{1,2}|\d{1,2}:\d{2}|오늘|어제|today|yesterday/i;
      const candidates = rawLines.filter((line) => !control.test(line));
      const content = candidates.find((line) => !relation.test(line) && !dateLine.test(line) && line !== linkTitle && !/^YouTube$/i.test(line)) || "";
      if (!content) return null;
      let title = linkTitle;
      if (!title || title === content || /^(YouTube|동영상|video)$/i.test(title)) {
        const relationLine = candidates.find((line) => relation.test(line));
        title = relationLine ? relationLine.replace(relation, "").trim() : "";
      }
      if (!title) title = identity.kind === "post" ? "YouTube 게시물" : (activityType === "live_chat" ? "YouTube 실시간 스트리밍" : "YouTube 동영상");

      const rowText = clean(row.innerText || row.textContent);
      const stableAttributes = ["data-id", "jsdata", "data-ved", "data-item-id"]
        .map((name) => `${name}:${row.getAttribute(name) || ""}`).join("|");
      const dateToken = candidates.find((line) => dateLine.test(line)) || "";
      const semanticKey = `${expectedPage}|${identity.key}|${title}|${content}|${dateToken}|${stableAttributes}`;
      const externalId = `youtube-${activityType}-${fnv(semanticKey)}`;
      const videoId = identity.kind === "video" ? identity.id : "";
      const postId = identity.kind === "post" ? identity.id : "";

      return {
        key: semanticKey,
        item: {
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
            extractor_version: "1.3.0",
            account_label: accountLabel,
            youtube_activity_kind: activityType,
            my_activity_page: expectedPage,
            original_url: original.url,
            original_link_resolved: Boolean(original.url),
            original_link_status: original.url ? "resolved" : "not_exposed",
            source_type: identity.kind,
            source_id: identity.id || null,
            video_id: videoId || null,
            post_id: postId || null,
            youtube_post_id: postId || null,
            deletion_locator: {
              version: 2,
              page: expectedPage,
              row_data_id: row.getAttribute("data-id") || null,
              row_jsdata: row.getAttribute("jsdata") || null,
              row_data_ved: row.getAttribute("data-ved") || null,
              row_text_hash: fnv(rowText),
              semantic_hash: fnv(`${expectedPage}|${identity.key}|${title}|${content}`),
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
              post_url: postId ? original.url : null,
            },
          },
        },
      };
    };

    const collected = new Map();
    const collectVisible = () => {
      let added = 0;
      for (const button of deleteButtons()) {
        const row = rowForButton(button);
        if (!row) continue;
        const parsed = parseRow(row, button);
        if (!parsed || collected.has(parsed.key)) continue;
        collected.set(parsed.key, parsed.item);
        added += 1;
      }
      return added;
    };

    const scrollCandidates = () => {
      const buttons = deleteButtons();
      const candidates = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll("body *")]
        .filter(Boolean).filter((element) => {
          const rect = element.getBoundingClientRect?.() || {height: 0};
          const style = getComputedStyle(element);
          return rect.height >= 240 && element.scrollHeight > element.clientHeight + 80
            && (element === document.scrollingElement || /(auto|scroll)/.test(style.overflowY || ""));
        });
      return [...new Set(candidates)].map((element) => {
        const containedButtons = buttons.filter((button) => element === document.scrollingElement || element.contains(button)).length;
        const range = Math.max(0, element.scrollHeight - element.clientHeight);
        return {element, score: containedButtons * 1_000_000 + range};
      }).sort((left, right) => right.score - left.score);
    };

    let mutationVersion = 0;
    const observer = new MutationObserver(() => { mutationVersion += 1; });
    observer.observe(document.documentElement, {subtree: true, childList: true});

    let root = scrollCandidates()[0]?.element || document.scrollingElement || document.documentElement;
    root.scrollTop = 0;
    window.scrollTo(0, 0);
    await sleep(500);

    let bottomStable = 0;
    let previousBottomSignature = "";
    let complete = false;
    let stopReason = "step_limit";

    try {
      for (let step = 0; step < 1200 && collected.size < 5000; step += 1) {
        const beforeCount = collected.size;
        collectVisible();

        if (step > 0 && step % 25 === 0) {
          const nextRoot = scrollCandidates()[0]?.element;
          if (nextRoot && nextRoot !== root && nextRoot.scrollHeight - nextRoot.clientHeight > root.scrollHeight - root.clientHeight) {
            root = nextRoot;
          }
        }

        const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
        const atBottom = maxScroll <= 2 || root.scrollTop >= maxScroll - 3;
        if (atBottom) {
          await sleep(550);
          collectVisible();
          const signature = `${collected.size}|${root.scrollTop}|${root.scrollHeight}|${mutationVersion}`;
          bottomStable = signature === previousBottomSignature ? bottomStable + 1 : 0;
          previousBottomSignature = signature;
          if (bottomStable >= 12) {
            complete = true;
            stopReason = "stable_bottom";
            break;
          }
          root.scrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
          root.dispatchEvent(new Event("scroll", {bubbles: true}));
          continue;
        }

        bottomStable = 0;
        previousBottomSignature = "";
        const viewport = root.clientHeight || innerHeight || 800;
        const nextTop = Math.min(maxScroll, root.scrollTop + Math.max(320, Math.floor(viewport * 0.62)));
        root.scrollTop = nextTop;
        if (root === document.scrollingElement || root === document.documentElement || root === document.body) window.scrollTo(0, nextTop);
        root.dispatchEvent(new Event("scroll", {bubbles: true}));
        await sleep(collected.size === beforeCount ? 420 : 300);
        collectVisible();
      }
      if (collected.size >= 5000) stopReason = "item_limit";
    } finally {
      observer.disconnect();
      root.scrollTop = 0;
      window.scrollTo(0, 0);
    }

    const items = [...collected.values()];
    const label = activityType === "live_chat" ? "실시간 채팅" : "댓글";
    const linkedCount = items.filter((item) => Boolean(item.source_url)).length;
    return {
      platform: "youtube",
      source_url: location.href,
      status: complete ? "success" : "partial",
      complete,
      stop_reason: stopReason,
      message: items.length
        ? `YouTube ${label} ${items.length}개를 확인했습니다. 원문 링크 ${linkedCount}개 확인. ${complete ? "끝까지 확인했습니다." : "수집이 끝까지 완료되지 않았습니다."}`
        : complete
          ? `YouTube ${label} 기록이 없습니다. 끝까지 확인했습니다.`
          : `YouTube ${label} 기록을 끝까지 확인하지 못했습니다.`,
      items,
    };
  }
})();