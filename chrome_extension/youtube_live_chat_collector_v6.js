(() => {
  const previousRunExtractor = runExtractor;

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    if (platform !== "youtube" || activityType !== "live_chat") {
      return previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    }

    const originalExecuteScript = chrome.scripting.executeScript;

    chrome.scripting.executeScript = async function(details) {
      const results = await originalExecuteScript.call(chrome.scripting, details);
      if (details?.func?.name !== "collectAndScrollLiveChatStep") return results;

      for (const entry of results || []) {
        const result = entry?.result;
        if (!result?.end_reached) continue;

        // Google renders a stable end marker, but scrollTop/scrollHeight can keep
        // changing slightly after that. Force a stable terminal signature so the
        // v5 collector exits on the next confirmation pass instead of scrolling
        // against the bottom forever.
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
      return await previousRunExtractor(
        tabId,
        platform,
        activityType,
        ownershipScope,
        accountContext
      );
    } finally {
      chrome.scripting.executeScript = originalExecuteScript;
    }
  };
})();
