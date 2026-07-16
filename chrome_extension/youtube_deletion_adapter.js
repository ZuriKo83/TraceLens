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
        const title = clean(raw?.title || originalLocator.title);
        const content = clean(raw?.content || originalLocator.content);
        const sourceUrl = canonicalYouTubeUrl(rawSourceUrl);
        if (!title && !content && !sourceUrl && !urlCommentId) continue;
        const id = clean(raw?.id) || `target-${output.length + 1}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const parsedActivityId = Number(raw?.activityId || raw?.activity_id || 0);
        const locator = {
          ...originalLocator,
          comment_id: urlCommentId || null,
          activity_token: null,
          legacy_activity_token: clean(originalLocator.activity_token || originalLocator.comment_id) || null,
        };
        output.push({
          id,
          activityId: Number.isInteger(parsedActivityId) && parsedActivityId > 0 ? parsedActivityId : null,
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

  async function confirmDeletedTargets(targets, config, activityKind) {
    const activityIds = [...new Set((targets || [])
      .map((target) => Number(target?.activityId || 0))
      .filter((value) => Number.isInteger(value) && value > 0))];
    if (!activityIds.length) {
      return {ok: false, deleted: 0, deleted_ids: [], error: "TraceLens 활동 ID를 확인하지 못했습니다."};
    }

    const server = String(config?.serverUrl || "").replace(/\/+$/, "");
    const token = String(config?.collectorToken || "");
    if (!server || !token) throw new Error("TraceLens 서버 연결 정보가 없습니다.");

    const response = await fetch(`${server}/api/delete-credits/confirm-deleted`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({activity_ids: activityIds, activity_kind: activityKind}),
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.detail || payload?.error || `TraceLens 삭제 목록 동기화 실패 (${response.status})`);
    }
    return payload;
  }

  function registerYouTubeAdapter({key, kind, label, page, taskUrl}) {
    TraceLensDeletionEngine.registerAdapter(key, {
      label: `YouTube ${label}`,
      itemLabel: `YouTube ${label}`,
      taskUrl,
      maxTargets: 100,
      batchSize: 20,
      batchPauseMs: 650,
      verificationDelayMs: 2500,
      retry: true,
      normalizeTargets: makeNormalizeTargets(kind),
      isTaskUrl(value) { return taskUrlMatches(value, page); },
      deletePageFunction: traceLensDeleteYouTubeTargetsInPage,
      verifyPageFunction: traceLensVerifyYouTubeActivityTargetsInPage,
      confirmDeletedTargets(targets, config) { return confirmDeletedTargets(targets, config, kind); },
      openingMessage: `Google 내 활동의 YouTube ${label} 페이지를 앞에 여는 중입니다.`,
      discoveryMessage(count) { return `${count}개 ${label}을 동일한 공통 삭제 로직으로 찾아 아래쪽부터 처리합니다.`; },
      syncError: `${label} 삭제는 확인했지만 TraceLens 목록 동기화에 실패했습니다.`,
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