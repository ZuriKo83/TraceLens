(() => {
  const COMMENT_TASK_URL = "https://myactivity.google.com/page?hl=ko&utm_medium=web&utm_source=youtube&page=youtube_comments";
  const LIVE_CHAT_TASK_URL = "https://myactivity.google.com/page?hl=ko&utm_medium=web&utm_source=youtube&page=youtube_live_chat";
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

  function parseUrl(value) {
    try { return value ? new URL(value, "https://www.youtube.com") : null; } catch { return null; }
  }

  function canonicalYouTubeUrl(value) {
    const url = parseUrl(value);
    if (!url) return null;
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
  }

  function sourceIdentity(value) {
    const url = parseUrl(value);
    if (!url) return "";
    const postId = url.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
    return postId ? `post:${postId}` : (url.searchParams.get("v") || "");
  }

  function normalizeTargets(rawTargets) {
    const output = [];
    const seen = new Set();
    for (const raw of Array.isArray(rawTargets) ? rawTargets : []) {
      const locator = raw?.locator && typeof raw.locator === "object" ? raw.locator : {};
      const title = clean(locator.title || raw?.title);
      const content = clean(raw?.content || locator.content);
      const rawSourceUrl = raw?.sourceUrl || raw?.source_url || locator.source_url || "";
      const commentId = clean(raw?.commentId || raw?.comment_id || locator.comment_id || locator.activity_token || parseUrl(rawSourceUrl)?.searchParams.get("lc"));
      const sourceUrl = canonicalYouTubeUrl(rawSourceUrl);
      if (!title && !content && !sourceUrl && !commentId) continue;
      const id = clean(raw?.id) || `target-${output.length + 1}`;
      if (seen.has(id)) continue;
      seen.add(id);
      output.push({id, title, content, commentId, sourceUrl, sourceKey: sourceIdentity(sourceUrl), locator});
    }
    return output;
  }

  function taskUrlMatches(value, expectedPage) {
    try {
      const url = new URL(value);
      return url.hostname === "myactivity.google.com"
        && url.pathname.replace(/\/$/, "") === "/page"
        && url.searchParams.get("page") === expectedPage;
    } catch {
      return false;
    }
  }

  function makeSyncFromVerification(label) {
    return async function syncFromVerification(verification, config) {
      const extraction = verification?.extraction;
      const complete = verification?.complete === true && extraction?.status === "success" && extraction?.snapshot_complete === true;
      if (!complete) {
        return {synced: false, lines: [`YouTube ${label} verification snapshot was incomplete.`], raw: {verification}};
      }
      const response = await postExtraction(config, extraction);
      const synced = response?.ok !== false;
      const found = Number(response?.found ?? extraction.items?.length ?? 0);
      const imported = Number(response?.imported ?? 0);
      return {
        synced,
        lines: [synced ? `✓ YouTube ${label}: ${found}개 확인, ${imported}개 신규` : `✕ YouTube ${label}: TraceLens 보관함 동기화 실패`],
        raw: {verification, response},
      };
    };
  }

  TraceLensDeletionEngine.registerAdapter("youtube", {
    label: "YouTube 댓글",
    itemLabel: "YouTube 댓글",
    taskUrl: COMMENT_TASK_URL,
    maxTargets: 100,
    batchSize: 20,
    batchPauseMs: 500,
    verificationDelayMs: 1800,
    retry: false,
    normalizeTargets,
    isTaskUrl(value) { return taskUrlMatches(value, "youtube_comments"); },
    deletePageFunction: traceLensDeleteYouTubeTargetsInPage,
    verifyPageFunction: traceLensVerifyYouTubeTargetsInPage,
    syncFromVerification: makeSyncFromVerification("댓글"),
    openingMessage: "Google 내 활동의 YouTube 댓글 페이지를 앞에 여는 중입니다.",
    discoveryMessage(count) { return `${count}개 댓글을 실제 댓글 ID와 본문으로 찾아 아래쪽부터 처리합니다.`; },
    syncError: "댓글 처리는 확인했지만 TraceLens 보관함 동기화에 실패했습니다.",
  });

  TraceLensDeletionEngine.registerAdapter("youtube_live_chat", {
    label: "YouTube 실시간 채팅",
    itemLabel: "YouTube 실시간 채팅",
    taskUrl: LIVE_CHAT_TASK_URL,
    maxTargets: 100,
    batchSize: 20,
    batchPauseMs: 500,
    verificationDelayMs: 1800,
    retry: false,
    normalizeTargets,
    isTaskUrl(value) { return taskUrlMatches(value, "youtube_live_chat"); },
    deletePageFunction: traceLensDeleteYouTubeLiveChatTargetsInPage,
    verifyPageFunction: traceLensVerifyYouTubeLiveChatTargetsInPage,
    syncFromVerification: makeSyncFromVerification("실시간 채팅"),
    openingMessage: "Google 내 활동의 YouTube 실시간 채팅 페이지를 앞에 여는 중입니다.",
    discoveryMessage(count) { return `${count}개 실시간 채팅을 저장된 위치 정보와 본문으로 찾아 아래쪽부터 처리합니다.`; },
    syncError: "실시간 채팅 처리는 확인했지만 TraceLens 보관함 동기화에 실패했습니다.",
  });
})();