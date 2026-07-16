(() => {
  const STORAGE_KEY = "tracelens:last-delete-result:v7";
  const FAILURE_TEXTS = [
    "댓글 삭제는 확인했지만 TraceLens 목록 동기화에 실패했습니다.",
    "실시간 채팅 삭제는 확인했지만 TraceLens 목록 동기화에 실패했습니다.",
    "TraceLens 목록 동기화에 실패했습니다.",
  ];

  if (location.pathname !== "/delete-credits/purchase") return;

  function uniquePositiveIds(values) {
    return new Set((Array.isArray(values) ? values : [])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0));
  }

  function stripFalseSyncWarning(message) {
    let output = String(message || "");
    for (const text of FAILURE_TEXTS) {
      output = output
        .replace(` · ${text}`, "")
        .replace(text, "")
        .replace(/\s+·\s*$/, "")
        .trim();
    }
    return output;
  }

  function reconcile() {
    let stored;
    try {
      stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      return;
    }
    if (!stored?.result) return;

    const deleted = Number(stored.result.deleted || 0);
    const alreadyMissing = Number(stored.result.alreadyMissing || 0);
    const resolved = deleted + alreadyMissing;
    const removedIds = uniquePositiveIds(stored.result.deletedActivityIds);
    if (resolved <= 0 || removedIds.size < resolved) return;

    const oldMessage = String(stored.message || "");
    const newMessage = stripFalseSyncWarning(oldMessage);
    const correctedResult = {
      ...stored.result,
      synced: true,
      syncDeferred: false,
      warning: null,
    };

    if (newMessage !== oldMessage || stored.result.synced === false || stored.result.warning) {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
          ...stored,
          message: newMessage,
          result: correctedResult,
        }));
      } catch {}
    }

    const status = document.getElementById("delete-operation-status");
    if (status && FAILURE_TEXTS.some((text) => status.textContent?.includes(text))) {
      status.textContent = stripFalseSyncWarning(status.textContent);
    }
  }

  const observer = new MutationObserver(reconcile);
  observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true});
  reconcile();
  setTimeout(reconcile, 250);
  setTimeout(reconcile, 1000);
})();