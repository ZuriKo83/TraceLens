import {SERVER, SITES, dashboardSource, selectedSites} from './policy.mjs';
import {localFetch} from './adapter.mjs';
import {deleteYouTubeComments} from './youtube_delete.mjs';

export function createController(context, collector, {transport = localFetch, browserName = 'edge'} = {}) {
  let busy = false;
  const loginPages = new Map();
  return async (source, message) => {
    if (!dashboardSource(source)) throw new Error('TraceLens 대시보드에서만 실행할 수 있습니다.');
    if (new URL(source.frame.url()).pathname === '/delete-credits/purchase'
        && !['PING', 'DELETE_YOUTUBE'].includes(message?.type)) throw new Error('삭제 페이지에서는 댓글 삭제만 실행할 수 있습니다.');
    if (message?.type === 'PING') return {ok: true, browserName};
    if (!['OPEN_SITE', 'START_SCAN', 'GOOGLE_LOGIN', 'NORMAL_LOGIN', 'DELETE_YOUTUBE'].includes(message?.type)) throw new Error('지원하지 않는 요청입니다.');
    const sites = ['GOOGLE_LOGIN', 'DELETE_YOUTUBE'].includes(message.type) ? [] : selectedSites(message.sites);
    if (message.type === 'NORMAL_LOGIN' && (sites.length !== 1 || sites[0] !== 'x')) throw new Error('지원하지 않는 로그인 사이트입니다.');
    if (message.type === 'OPEN_SITE' && sites.length !== 1) throw new Error('한 사이트씩 연결하세요.');
    const token = message.token;
    if (typeof token !== 'string' || token.length < 20 || token.length > 256) throw new Error('TraceLens에 다시 로그인하세요.');
    if (busy) throw new Error('조회 또는 삭제가 진행 중입니다. 완료 후 다시 시도하세요.');
    // Lock before the first await so double clicks cannot start two collections.
    busy = true;
    try {
      const auth = await transport(`${SERVER}/api/collector/status`, {headers: {Authorization: `Bearer ${token}`}});
      if (!auth.ok) throw new Error('TraceLens 로그인 상태가 만료되었습니다. 대시보드를 새로고침하세요.');
      if (!dashboardSource(source)) throw new Error('대시보드가 닫혔습니다.');
      if (message.type === 'DELETE_YOUTUBE') {
        return await deleteYouTubeComments(collector, transport, token, message.activityIds, text => {
          source.page.evaluate(text => window.dispatchEvent(new CustomEvent('TRACELENS_PC_EVENT',
            {detail: {type: 'DELETE_PROGRESS', text}})), text).catch(() => {});
        });
      }
      if (message.type === 'GOOGLE_LOGIN' || message.type === 'NORMAL_LOGIN') {
        if (!['edge', 'chrome'].includes(browserName)) throw new Error('Edge 또는 Chrome에서만 Google 로그인을 시도할 수 있습니다.');
        return {ok: true};
      }
      if (message.type === 'OPEN_SITE') {
        let page = loginPages.get(sites[0]);
        if (!page || page.isClosed()) {
          page = await context.newPage();
          loginPages.set(sites[0], page);
          await page.goto(SITES[sites[0]], {waitUntil: 'domcontentloaded', timeout: 35000});
        }
        await page.bringToFront();
        return {ok: true};
      }
      const result = await collector.scan(sites, {serverUrl: SERVER, collectorToken: token});
      const failed = result.lines.filter(line => line.startsWith('✕')).length;
      return {...result, completed: result.lines.length - failed, failed};
    } finally { busy = false; }
  };
}
