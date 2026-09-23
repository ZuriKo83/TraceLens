(() => {
  const RELOAD_KEY = "tracelens:extension-context-reload";
  const RELOAD_WINDOW_MS = 15_000;

  function isInvalidatedContext(message) {
    return /extension context invalidated/i.test(String(message || ""));
  }

  function recover() {
    const now = Date.now();
    const previous = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Number.isFinite(previous) && now - previous < RELOAD_WINDOW_MS) return;
    sessionStorage.setItem(RELOAD_KEY, String(now));
    location.reload();
  }

  window.addEventListener("error", (event) => {
    const message = event?.error?.message || event?.message || "";
    if (!isInvalidatedContext(message)) return;
    event.preventDefault();
    recover();
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    const message = event?.reason?.message || event?.reason || "";
    if (!isInvalidatedContext(message)) return;
    event.preventDefault();
    recover();
  }, true);

  window.addEventListener("pageshow", () => {
    const previous = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Number.isFinite(previous) && Date.now() - previous >= RELOAD_WINDOW_MS) {
      sessionStorage.removeItem(RELOAD_KEY);
    }
  }, {once: true});
})();
