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

  function makeNormalizeTargets(activityKind) {
    return function normalizeTargets(rawTargets) {
      const output = [];
      const seen = new Set();
      for (const raw of Array.isArray(rawTargets) ? rawTargets : []) {
        const originalLocator = raw?.locator && typeof raw.locator === "object" ? raw.locator : {};
        const rawSourceUrl = raw?.sourceUrl || raw?.source_url || originalLocator.source_url || "";
        const urlCommentId = clean(parseUrl(rawSourceUrl)?.searchParams.get("lc"));
        const title = clean(originalLocator.title || raw?.title);
        const content = clean(raw?.content || originalLocator.content);
        const sourceUrl = canonicalYouTubeUrl(rawSourceUrl);
        if (!title && !content && !sourceUrl && !urlCommentId) continue;
        const id = clean(raw?.id) || `target-${output.length + 1}`;
        if (seen.has(id)) continue;
        seen.add(id);

        // Google data-token은 항상 실제 댓글 ID가 아니므로 정확 ID로 사용하지 않는다.
        // URL의 lc 값만 신뢰하고, 기존 토큰은 진단용으로만 보존한다.
        const locator = {
          ...originalLocator,
          comment_id: urlCommentId || null,
          activity_token: null,
          legacy_activity_token: clean(originalLocator.activity_token || originalLocator.comment_id) || null,
        };
        output.push({
          id,
          activityKind,
          title,
          content,
          commentId: urlCommentId,
          sourceUrl,
          sourceKey: sourceIdentity(sourceUrl),
          locator,
        });
      }
      return output;
    };
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

  function registerYouTubeAdapter({key, kind, label, page, taskUrl}) {
    TraceLensDeletionEngine.registerAdapter(key, {
      label: `YouTube ${label}`,
      itemLabel: `YouTube ${label}`,
      taskUrl,
      maxTargets: 100,
      batchSize: 20,
      batchPauseMs: 500,
      verificationDelayMs: 1800,
      retry: false,
      // Google 내 활동 카드가 사라져도 YouTube 실제 댓글 반영에는 시간이 걸릴 수 있다.
      // 삭제 직후 전체 스냅샷으로 서버 기록을 지우지 않고 다음 정상 조회까지 유지한다.
      deferArchiveSync: true,
      normalizeTargets: makeNormalizeTargets(kind),
      isTaskUrl(value) { return taskUrlMatches(value, page); },
      deletePageFunction: traceLensDeleteYouTubeTargetsInPage,
      verifyPageFunction: traceLensVerifyYouTubeActivityTargetsInPage,
      syncFromVerification: makeSyncFromVerification(label),
      openingMessage: `Google 내 활동의 YouTube ${label} 페이지를 앞에 여는 중입니다.`,
      discoveryMessage(count) { return `${count}개 ${label}을 동일한 공통 삭제 로직으로 찾아 아래쪽부터 처리합니다.`; },
      syncError: `${label} 처리는 확인했지만 TraceLens 보관함 동기화에 실패했습니다.`,
    });
  }

  registerYouTubeAdapter({
    key: "youtube",
    kind: "comment",
    label: "댓글",
    page: "youtube_comments",
    taskUrl: COMMENT_TASK_URL,
  });

  registerYouTubeAdapter({
    key: "youtube_live_chat",
    kind: "live_chat",
    label: "실시간 채팅",
    page: "youtube_live_chat",
    taskUrl: LIVE_CHAT_TASK_URL,
  });
})();