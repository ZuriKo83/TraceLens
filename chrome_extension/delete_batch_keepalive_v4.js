(() => {
  const PORT_NAME = "tracelens-delete-batch-v3";
  const PULSE_MS = 5000;

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;

    let pulseTimer = null;
    let activeJobId = null;

    const sendPong = async () => {
      try {
        // Calling an extension API resets the MV3 service-worker idle timer.
        await chrome.runtime.getPlatformInfo();
      } catch {
        // Still try to answer through the open port.
      }

      try {
        port.postMessage({
          type: "DELETE_BATCH_PONG",
          at: Date.now(),
          jobId: activeJobId,
        });
      } catch {
        // The UI-side disconnect handler owns cancellation/refund.
      }
    };

    const stopPulse = () => {
      if (pulseTimer) clearInterval(pulseTimer);
      pulseTimer = null;
      activeJobId = null;
    };

    const startPulse = (jobId) => {
      stopPulse();
      activeJobId = jobId || null;
      void sendPong();
      pulseTimer = setInterval(() => {
        void sendPong();
      }, PULSE_MS);
    };

    port.onMessage.addListener((message) => {
      if (message?.type === "START_DELETE_BATCH") {
        startPulse(message.job?.job_id || null);
        return;
      }

      if (message?.type === "DELETE_BATCH_PING") {
        activeJobId = message.jobId || activeJobId;
        void sendPong();
      }
    });

    port.onDisconnect.addListener(() => {
      stopPulse();
    });
  });
})();
