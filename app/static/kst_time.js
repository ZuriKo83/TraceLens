(() => {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const selector = 'time, [data-server-time]';

  function convertText(element) {
    if (!element || element.dataset.kstConverted === '1') return;
    const text = String(element.textContent || '');
    const match = text.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return;

    const [, year, month, day, hour, minute, second = '00'] = match;
    const utcMillis = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    const kst = new Date(utcMillis + KST_OFFSET_MS);
    const pad = (value) => String(value).padStart(2, '0');
    const converted = `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}${match[6] ? `:${pad(kst.getUTCSeconds())}` : ''}`;

    element.textContent = text.replace(match[0], converted);
    element.dataset.kstConverted = '1';
    if (!element.title) element.title = '한국 표준시(KST)';
  }

  function convertAll(root = document) {
    if (root.matches?.(selector)) convertText(root);
    root.querySelectorAll?.(selector).forEach(convertText);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => convertAll());
  } else {
    convertAll();
  }

  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) convertAll(node);
      }
    }
  }).observe(document.documentElement, {childList: true, subtree: true});
})();
