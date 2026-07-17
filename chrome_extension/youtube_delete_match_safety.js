(() => {
  const originalProcess = globalThis.traceLensProcessYouTubeActivityPage;
  if (typeof originalProcess !== "function") {
    throw new Error("YouTube 활동 공통 처리 함수를 찾지 못했습니다.");
  }

  const clean = (value) => String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const meaningfulCharacters = (value) => clean(value).match(/[\p{L}\p{N}]/gu)?.length || 0;

  function targetWithSafeFallback(target) {
    const locator = target?.locator && typeof target.locator === "object" ? target.locator : {};
    const originalContent = clean(target?.content || locator.content);
    const title = clean(target?.title || locator.title).replace(/^\[실시간 채팅\]\s*/, "");
    const sourceKey = clean(target?.sourceKey);

    // 한두 글자 구두점·이모지는 일반 텍스트 점수만으로 특정하기 어렵다.
    // 영상 ID와 충분히 긴 제목이 함께 있을 때만 제목을 보조 매칭 키로 사용한다.
    const needsFallback = originalContent.length > 0
      && meaningfulCharacters(originalContent) === 0
      && sourceKey.length > 0
      && title.length >= 8
      && !/^YouTube (?:동영상|실시간 스트리밍)$/i.test(title);

    if (!needsFallback) return target;

    return {
      ...target,
      content: title,
      locator: {
        ...locator,
        content: title,
        title,
        original_short_content: originalContent,
      },
      shortContentFallback: true,
    };
  }

  async function safeProcess(targets, options = null) {
    const preparedTargets = (Array.isArray(targets) ? targets : []).map(targetWithSafeFallback);
    const result = await originalProcess(preparedTargets, options);
    const isDeletePass = options && typeof options === "object";
    const unmatchedIds = Array.isArray(result?.unmatchedIds) ? result.unmatchedIds : [];

    if (isDeletePass && unmatchedIds.length > 0) {
      // 탐색 완료와 대상 부재는 같은 뜻이 아니다. 매칭 실패 행은 서버 동기화 대상에서 제외한다.
      result.discoveryComplete = false;
      result.unmatchedConfirmedAbsent = false;
      result.unmatchedReason = "Google 내 활동에서 대상을 정확히 특정하지 못해 TraceLens 목록에 유지합니다.";

      const banner = document.getElementById("tracelens-delete-banner");
      if (banner && !(result.attemptedIds || []).length) {
        banner.textContent = "선택 대상을 정확히 특정하지 못했습니다. 안전을 위해 TraceLens 목록에 그대로 유지합니다.";
      }
    }

    return result;
  }

  globalThis.traceLensProcessYouTubeActivityPage = safeProcess;
  globalThis.traceLensDeleteYouTubeTargetsInPage = safeProcess;
})();