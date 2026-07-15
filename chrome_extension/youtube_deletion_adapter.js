(() => {
  const TASK_URL = "https://myactivity.google.com/page?hl=ko&utm_medium=web&utm_source=youtube&page=youtube_comments";
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

  function canonicalYouTubeUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, "https://www.youtube.com");
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
    } catch {
      return null;
    }
  }

  function sourceIdentity(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url);
      const postId = parsed.pathname.match(/^\/post\/([^/?#]+)/i)?.[1];
      return postId ? `post:${postId}` : (parsed.searchParams.get("v") || "");
    } catch {
      return "";
    }
  }

  function normalizeTargets(rawTargets) {
    const output = [];
    const seen = new Set();
    for (const raw of Array.isArray(rawTargets) ? rawTargets : []) {
      const title = clean(raw?.title);
      const content = clean(raw?.content);
      const sourceUrl = canonicalYouTubeUrl(raw?.sourceUrl || raw?.source_url || "");
      if (!title && !content && !sourceUrl) continue;
      const id = clean(raw?.id) || `target-${output.length + 1}`;
      if (seen.has(id)) continue;
      seen.add(id);
      output.push({
        id,
        title,
        content,
        sourceUrl,
        sourceKey: sourceIdentity(sourceUrl),
        locator: raw?.locator && typeof raw.locator === "object" ? raw.locator : {},
      });
    }
    return output;
  }

  function isTaskUrl(value) {
    try {
      const url = new URL(value);
      return url.hostname === "myactivity.google.com"
        && url.pathname.replace(/\/$/, "") === "/page"
        && url.searchParams.get("page") === "youtube_comments";
    } catch {
      return false;
    }
  }

  TraceLensDeletionEngine.registerAdapter("youtube", {
    label: "YouTube 댓글",
    itemLabel: "YouTube 댓글",
    taskUrl: TASK_URL,
    maxTargets: 100,
    batchSize: 20,
    batchPauseMs: 800,
    retry: true,
    normalizeTargets,
    isTaskUrl,
    deletePageFunction: traceLensDeleteYouTubeTargetsInPage,
    verifyPageFunction: traceLensVerifyYouTubeTargetsInPage,
    syncSites: ["youtube"],
    isSyncSuccessful(lines) {
      return lines.some((line) => /YouTube 댓글/.test(line) && line.startsWith("✓"));
    },
    openingMessage: "Google 내 활동의 YouTube 댓글 페이지를 여는 중입니다.",
    discoveryMessage(count) {
      return `${count}개 댓글을 전체 기록에서 한 번 탐색한 뒤 아래쪽부터 삭제합니다.`;
    },
    syncError: "YouTube 삭제 후 TraceLens 보관함 동기화에 실패했습니다. YouTube 조회를 다시 실행하세요.",
  });
})();