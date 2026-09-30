import {setTimeout as delay} from 'node:timers/promises';

export async function backgroundPage(browser, context, {hidden = false} = {}) {
  const session = await browser.newBrowserCDPSession();
  let targetId;
  try { ({targetId} = await session.send('Target.createTarget', {url: 'about:blank', background: true, hidden})); }
  catch (error) { await session.detach().catch(() => {}); throw error; }
  // Hidden targets exist only while their creating CDP session remains attached.
  if (!hidden) await session.detach();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    for (const page of context.pages()) {
      if (page.isClosed() || page.url() !== 'about:blank') continue;
      const pageSession = await context.newCDPSession(page).catch(() => null);
      if (!pageSession) continue;
      try {
        const info = await pageSession.send('Target.getTargetInfo');
        if (info.targetInfo?.targetId === targetId) {
          if (hidden) page.once('close', () => { session.detach().catch(() => {}); });
          return page;
        }
      } finally { await pageSession.detach().catch(() => {}); }
    }
    await delay(100);
  }
  if (hidden) await session.detach().catch(() => {});
  throw new Error('백그라운드 조회 탭을 찾지 못했습니다.');
}
