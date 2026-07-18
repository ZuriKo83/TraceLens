(() => {
  const originalRunExtractor = runExtractor;
  const originalAssertOwnedTaskUrl = assertOwnedTaskUrl;

  if (!SITE_TASKS.youtube.some((task) => task.activityType === "live_chat")) {
    SITE_TASKS.youtube.push({
      platform: "youtube",
      label: "YouTube 실시간 채팅",
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
        throw new Error("YouTube 실시간 채팅 페이지를 확인하지 못했습니다. Google 계정을 확인한 뒤 다시 시도해 주세요.");
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
      throw new Error("YouTube 조회 기능을 불러오지 못했습니다. 확장 프로그램을 새로고침한 뒤 다시 시도해 주세요.");
    }

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
      target: {tabId},
      func: scanner,
      args: [[probeTarget], null],
    });

    const payloads = (results || [])
      .map((entry) => entry.result?.extraction || entry.result)
      .filter(Boolean);
    if (!payloads.length) {
      throw new Error("YouTube 활동을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
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
    const unlinkedCount = items.filter((item) => !item.source_url).length;

    let message;
    if (items.length && complete) {
      message = `YouTube ${label} ${items.length}개를 확인했습니다.${unlinkedCount ? ` 원문을 바로 열 수 없는 항목 ${unlinkedCount}개가 포함되어 있습니다.` : ""}`;
    } else if (items.length) {
      message = `YouTube ${label} ${items.length}개를 확인했습니다. 일부 기록은 확인하지 못했으므로 잠시 후 다시 조회해 주세요.`;
    } else if (complete) {
      message = `YouTube ${label} 기록이 없습니다.`;
    } else {
      message = primary.message || `YouTube ${label}을 모두 확인하지 못했습니다. 잠시 후 다시 조회해 주세요.`;
    }

    return {
      platform: "youtube",
      source_url: primary.source_url || (await chrome.tabs.get(tabId)).url,
      scan_scope: activityType,
      status: complete ? "success" : "partial",
      snapshot_complete: complete,
      message,
      account_label: accountContext?.accountLabel || null,
      items: items.slice(0, 5000),
    };
  };
})();