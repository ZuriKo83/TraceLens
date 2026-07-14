(() => {
  const originalWindowsCreate = chrome.windows.create.bind(chrome.windows);

  function isYouTubeDeletionPage(url) {
    try {
      const parsed = new URL(String(url || ""));
      return parsed.hostname === "myactivity.google.com"
        && parsed.pathname.replace(/\/$/, "") === "/page"
        && ["youtube_comments", "youtube_live_chat"].includes(parsed.searchParams.get("page"));
    } catch {
      return false;
    }
  }

  chrome.windows.create = async function(createData, callback) {
    if (!isYouTubeDeletionPage(createData?.url)) {
      const created = await originalWindowsCreate(createData);
      if (typeof callback === "function") callback(created);
      return created;
    }

    const sourceWindow = await chrome.windows.getLastFocused().catch(() => null);
    const width = 360;
    const height = 280;
    const left = sourceWindow
      ? Math.max(0, Number(sourceWindow.left || 0) + Number(sourceWindow.width || width) - width - 16)
      : undefined;
    const top = sourceWindow
      ? Math.max(0, Number(sourceWindow.top || 0) + Number(sourceWindow.height || height) - height - 48)
      : undefined;

    const created = await originalWindowsCreate({
      ...createData,
      type: "popup",
      focused: true,
      width,
      height,
      ...(Number.isFinite(left) ? {left} : {}),
      ...(Number.isFinite(top) ? {top} : {}),
    });

    const tab = created.tabs?.[0]
      || (await chrome.tabs.query({windowId: created.id, active: true}))[0];

    if (tab?.id) {
      // A 25% zoom keeps the desktop My Activity layout available inside the
      // physically small popup, so row matching and virtual scrolling still work.
      await chrome.tabs.setZoom(tab.id, 0.25).catch(() => undefined);
    }

    if (typeof callback === "function") callback(created);
    return created;
  };
})();
