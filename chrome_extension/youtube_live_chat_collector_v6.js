(() => {
  const previousRunExtractor = runExtractor;

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    if (platform !== "youtube" || activityType !== "live_chat") {
      return previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    }

    const originalExecuteScript = chrome.scripting.executeScript;
    let terminalMarkerSeen = false;

    chrome.scripting.executeScript = async function(details) {
      const results = await originalExecuteScript.call(chrome.scripting, details);
      if (details?.func?.name !== "collectAndScrollLiveChatStep") return results;

      for (const entry of results || []) {
        const result = entry?.result;
        if (!result?.end_reached) continue;
        terminalMarkerSeen = true;

        // Google can keep changing scroll metrics slightly after the terminal
        // marker is rendered. Freeze the signature so the collector confirms
        // the same terminal state on its next pass.
        result.signature = "TRACELENS_LIVE_CHAT_END";
        result.moved = false;
        result.diagnostics = {
          ...(result.diagnostics || {}),
          terminal_marker_confirmed: true,
        };
      }
      return results;
    };

    try {
      const result = await previousRunExtractor(
        tabId,
        platform,
        activityType,
        ownershipScope,
        accountContext
      );
      const suffix = terminalMarkerSeen ? " 전체 목록 확인 완료." : " 일부 목록만 확인됨.";
      return {
        ...result,
        snapshot_complete: terminalMarkerSeen,
        message: `${String(result?.message || "").replace(/\s+(전체 목록 확인 완료\.|일부 목록만 확인됨\.)$/u, "")}${suffix}`.trim(),
      };
    } finally {
      chrome.scripting.executeScript = originalExecuteScript;
    }
  };
})();
