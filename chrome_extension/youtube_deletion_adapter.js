(() => {
  const COMMENT_TASK_URL = "https://myactivity.google.com/page?hl=ko&utm_medium=web&utm_source=youtube&page=youtube_comments";
  const LIVE_CHAT_TASK_URL = "https://myactivity.google.com/page?hl=ko&utm_medium=web&utm_source=youtube&page=youtube_live_chat";
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

        const idFallback = Number(id.match(/youtube-activity-(\d+)$/)?.[1] || 0);
        const parsedActivityId = Number(raw?.activityId || raw?.activity_id || idFallback || 0);
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

  function positiveIds(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0))];
  }

  function normalizeConfirmedPayload(payload, activityIds) {
    const requestedIds = positiveIds(activityIds);
    const returnedIds = positiveIds([
      ...(payload?.deleted_ids || []),
      ...(payload?.resolved_ids || []),
    ]);
    const returnedSet = new Set(returnedIds);
    const idsCoverRequest = requestedIds.length > 0 && requestedIds.every((id) => returnedSet.has(id));
    const notDeletedIds = positiveIds(payload?.not_deleted_ids || []);
    const deletedCount = Number(payload?.deleted || 0);
    const requestedCount = Number(payload?.requested || 0);
    const countConfirmsAll = payload?.ok === true
      && notDeletedIds.length === 0
      && (deletedCount >= requestedIds.length || requestedCount === requestedIds.length);
    const resolvedIds = idsCoverRequest
      ? returnedIds
      : (countConfirmsAll ? requestedIds : returnedIds);

    return {
      ...(payload || {}),
      deleted: resolvedIds.length || deletedCount,
      deleted_ids: resolvedIds,
      resolved_ids: resolvedIds,
    };
  }

  async function requestConfirmedIds(activityIds, config, activityKind) {
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
    return normalizeConfirmedPayload(payload, activityIds);
  }

  async function confirmDeletedTargets(targets, config, activityKind) {
    const activityIds = positiveIds((targets || []).map((target) => {
      const fallback = String(target?.id || "").match(/youtube-activity-(\d+)$/)?.[1];
      return target?.activityId || fallback || 0;
    }));
    if (!activityIds.length) {
      return {ok: false, deleted: 0, deleted_ids: [], not_deleted_ids: [], error: "TraceLens 활동 ID를 확인하지 못했습니다."};
    }

    const resolved = new Set();
    const attempts = [];

    const mergeResponse = (payload, requestedIds, round) => {
      const responseIds = positiveIds([
        ...(payload?.deleted_ids || []),
        ...(payload?.resolved_ids || []),
      ]);
      responseIds.forEach((id) => resolved.add(id));
      attempts.push({round, requested_ids: requestedIds, resolved_ids: responseIds});
    };

    const first = await requestConfirmedIds(activityIds, config, activityKind);
    mergeResponse(first, activityIds, 1);

    // 1차 응답에서 빠진 ID는 묶어서 다시 보내지 않고 하나씩 재요청한다.
    // 특정 행 하나가 문제여도 나머지 성공 행의 동기화가 막히지 않는다.
    for (let round = 2; round <= 3; round += 1) {
      const missingIds = activityIds.filter((id) => !resolved.has(id));
      if (!missingIds.length) break;
      await sleep(1200);
      for (const id of missingIds) {
        try {
          const retried = await requestConfirmedIds([id], config, activityKind);
          mergeResponse(retried, [id], round);
        } catch (error) {
          attempts.push({round, requested_ids: [id], resolved_ids: [], error: error.message || String(error)});
        }
      }
    }

    const resolvedIds = activityIds.filter((id) => resolved.has(id));
    const notDeletedIds = activityIds.filter((id) => !resolved.has(id));

    // 마지막 Google 삭제 네트워크 반영과 TraceLens DB commit이 끝난 뒤 작업창을 닫는다.
    await sleep(2500);
    return {
      ok: notDeletedIds.length === 0,
      requested: activityIds.length,
      deleted: resolvedIds.length,
      deleted_ids: resolvedIds,
      resolved_ids: resolvedIds,
      not_deleted_ids: notDeletedIds,
      sync_attempts: attempts,
    };
  }

  function registerYouTubeAdapter({key, kind, label, page, taskUrl}) {
    TraceLensDeletionEngine.registerAdapter(key, {
      label: `YouTube ${label}`,
      itemLabel: `YouTube ${label}`,
      taskUrl,
      maxTargets: 100,
      batchSize: 20,
      batchPauseMs: 800,
      verificationDelayMs: 7000,
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