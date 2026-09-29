import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import * as playwright from 'playwright';
import {BROWSERS, SERVER} from './policy.mjs';
import {createCollector} from './adapter.mjs';
import {createController} from './controller.mjs';
import {backgroundPage} from './cdp.mjs';
import {runNormalLogin, selectInstalledBrowser} from './google_login.mjs';

const {values} = parseArgs({options: {browser: {type: 'string', default: 'auto'}}});
const browserName = values.browser === 'auto' ? selectInstalledBrowser() : values.browser;
if (!Object.hasOwn(BROWSERS, browserName)) throw new Error('browser: auto, edge, chrome 중 선택하세요.');
const selection = BROWSERS[browserName];
const profile = process.env.TRACELENS_PROFILE_DIR || (process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'TraceLens', 'collector-profile', browserName)
  : fileURLToPath(new URL(`../.local-browser/${browserName}/`, import.meta.url)));
let context;
try {
  console.log('TraceLens 서버 시작을 기다립니다...');
  let ready = false;
  for (let i = 0; i < 15; i++) {
    try { const response = await fetch(`${SERVER}/health`, {signal: AbortSignal.timeout(1500), redirect: 'error'}); ready = response.ok; } catch {}
    if (ready) break;
    await delay(1000);
  }
  if (!ready) throw new Error(`TraceLens 서버(${SERVER})에 연결되지 않습니다. 서버를 먼저 실행하세요.`);
  await mkdir(profile, {recursive: true, mode: 0o700});
  console.log(`사용 브라우저: ${browserName === 'edge' ? 'Microsoft Edge' : 'Google Chrome'}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { context?.close().catch(() => {}); });
  for (;;) {
    let normalLoginSite = null;
    context = await playwright[selection.engine].launchPersistentContext(profile, {
      channel: selection.channel, headless: false, viewport: null, acceptDownloads: false,
    });
    const collector = await createCollector(context, {
      newPage: () => backgroundPage(context.browser(), context), backgroundOnly: true,
    });
    const controller = createController(context, collector, {browserName,
      probePage: () => backgroundPage(context.browser(), context, {hidden: true})});
    await context.exposeBinding('traceLensLocal', async (source, message) => {
      const result = await controller(source, message);
      if (message?.type === 'GOOGLE_LOGIN' || message?.type === 'NORMAL_LOGIN') {
        // Let the binding response reach the dashboard before closing its tab.
        setTimeout(() => { normalLoginSite = message.type === 'NORMAL_LOGIN' ? 'x' : 'youtube'; context.close().catch(() => {}); }, 500);
      }
      return result;
    });
    const page = await context.newPage();
    await page.goto(`${SERVER}/app`);
    console.log('TraceLens에 로그인한 뒤 대시보드의 사이트 연결 버튼으로 각 사이트에 로그인하세요.');
    await new Promise(resolve => context.once('close', resolve));
    if (!normalLoginSite) break;
    console.log('일반 브라우저에서 로그인하세요. 완료 후 해당 브라우저 창을 모두 닫으면 TraceLens가 다시 열립니다.');
    try { await runNormalLogin(browserName, profile, normalLoginSite); }
    catch (error) { console.error(`로그인 창 오류: ${error.message}`); }
  }
} catch (error) {
  console.error(`실행 실패: ${error.message}`);
  console.error('선택한 브라우저가 설치되어 있는지 확인하세요. 기본값은 Microsoft Edge입니다.');
  await context?.close().catch(() => {});
  process.exitCode = 1;
}
