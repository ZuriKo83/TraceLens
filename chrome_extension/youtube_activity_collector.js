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
      if (!valid) {
        throw new Error(`본인 실시간 채팅 활동 페이지 확인에 실패했습니다. 이동된 주소: ${current.href}`);
      }
      return;
    }
    return originalAssertOwnedTaskUrl(tabId, task);
  };

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    if (platform !== "youtube") {
      return originalRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    }

    const scanner = globalThis.traceLensProcessYouTubeActivityPage;
    if (typeof scanner !== "function") {
      throw new Error("YouTube 공통 전수조사 함수를 불러오지 못했습니다. 확장 프로그램을 새로고침하세요.");
    }

    // 기존 별도 수집기를 사용하지 않는다. 공통 검증 함수를 verify 모드로
    // 실행하기 위해 실제 항목과 절대 일치하지 않는 종류 식별용 대상만 전달한다.
    const probeTarget = {
      id: `__tracelens_full_scan_${activityType}__`,
      activityKind: activityType === "live_chat" ? "live_chat" : "comment",
      title: "",
      content: "",
      commentId: "",
      sourceKey: "",
      locator: {},
    };

    const results = await chrome.scripting.executeScript({
      target: {tabId, allFrames: true},
      func: scanner,
      args: [[probeTarget], null],
    });

    const payloads = (results || [])
      .map((entry) => entry.result?.extraction || entry.result)
      .filter(Boolean);
    if (!payloads.length) {
      throw new Error("YouTube 활동 페이지에서 전수조사 결과를 받지 못했습니다.");
    }

    const items = [];
    const seen = new Set();
    for (const payload of payloads) {
      for (const item of payload.items || []) {
        if (!item?.external_id || seen.has(item.external_id)) continue;
        seen.add(item.external_id);
        items.push({
          ...item,
          metadata: {
            ...(item.metadata || {}),
            account_label: accountContext?.accountLabel || null,
            ownership_scope: ownershipScope,
            ownership_verified: true,
            extractor_version: "2.0.0-shared",
          },
        });
      }
    }

    const primary = payloads.find((payload) => payload.snapshot_complete || payload.items?.length) || payloads[0];
    const complete = payloads.some((payload) => payload.snapshot_complete === true) && items.length < 5000;
    const label = activityType === "live_chat" ? "실시간 채팅" : "댓글";
    const linkedCount = items.filter((item) => Boolean(item.source_url)).length;
    const unlinkedCount = Math.max(0, items.length - linkedCount);

    return {
      platform: "youtube",
      source_url: primary.source_url || (await chrome.tabs.get(tabId)).url,
      scan_scope: activityType,
      status: complete ? "success" : "partial",
      snapshot_complete: complete,
      message: items.length
        ? `YouTube ${label} ${items.length}개를 공통 전수조사기로 확인했습니다. 원문 링크 ${linkedCount}개 확인${unlinkedCount ? `, ${unlinkedCount}개 미노출` : ""}. ${complete ? "끝까지 확인했습니다." : "끝까지 확인하지 못해 부분 결과로 저장했습니다."}`
        : complete
          ? `YouTube ${label} 기록이 없습니다. 끝까지 확인했습니다.`
          : primary.message || `YouTube ${label} 기록을 끝까지 확인하지 못했습니다.`,
      account_label: accountContext?.accountLabel || null,
      items: items.slice(0, 5000),
    };
  };
})();