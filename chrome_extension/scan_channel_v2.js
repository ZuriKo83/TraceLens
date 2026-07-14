(() => {
  const SCAN_PORT_NAME = "tracelens-scan-v2";

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== SCAN_PORT_NAME) return;

    let running = false;
    let disconnected = false;

    const post = (message) => {
      if (disconnected) return;
      try {
        port.postMessage(message);
      } catch {
        disconnected = true;
      }
    };

    port.onDisconnect.addListener(() => {
      disconnected = true;
    });

    port.onMessage.addListener((message) => {
      if (message?.type === "PING") {
        post({type: "PONG", at: Date.now(), running});
        return;
      }

      if (message?.type !== "START_SCAN") return;
      if (running) {
        post({type: "SCAN_RESULT", result: {ok: false, error: "이미 조회가 진행 중입니다."}});
        return;
      }

      const sites = Array.isArray(message.sites) ? message.sites : [];
      if (!sites.length) {
        post({type: "SCAN_RESULT", result: {ok: false, error: "조회할 사이트를 하나 이상 선택하세요."}});
        return;
      }

      running = true;
      post({type: "SCAN_ACCEPTED", sites, at: Date.now()});

      resolveCollectorConfig(message.config)
        .then((config) => scanSites(sites, config))
        .then((result) => post({type: "SCAN_RESULT", result}))
        .catch((error) => post({
          type: "SCAN_RESULT",
          result: {ok: false, error: String(error?.message || error)},
        }))
        .finally(() => {
          running = false;
        });
    });
  });
})();
