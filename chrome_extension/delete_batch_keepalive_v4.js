(() => {
  const PORT_NAME = "tracelens-delete-batch-v3";

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;

    port.onMessage.addListener((message) => {
      if (message?.type !== "DELETE_BATCH_PING") return;

      // Incoming port messages wake/reset the MV3 service-worker idle timer.
      // Touching a Chrome API as well makes the keepalive explicit while a
      // long Google My Activity scan is running in the injected page.
      chrome.runtime.getPlatformInfo()
        .then(() => {
          try {
            port.postMessage({
              type: "DELETE_BATCH_PONG",
              at: Date.now(),
              jobId: message.jobId || null,
            });
          } catch {
            // The UI-side disconnect handler performs job cancellation/refund.
          }
        })
        .catch(() => {
          try {
            port.postMessage({
              type: "DELETE_BATCH_PONG",
              at: Date.now(),
              jobId: message.jobId || null,
            });
          } catch {
            // Ignore a port that has already disconnected.
          }
        });
    });
  });
})();
