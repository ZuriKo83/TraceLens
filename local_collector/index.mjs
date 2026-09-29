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

const {values} = parseArgs({options: {browser: {type: 'string', default: 'edge'}}});
if (!Object.hasOwn(BROWSERS, values.browser)) throw new Error('browser: chromium, chrome, edge, firefox 중 선택하세요.');
const selection = BROWSERS[values.browser];
const profile = process.env.TRACELENS_PROFILE_DIR || (process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'TraceLens', 'collector-profile', values.browser)
  : fileURLToPath(new URL(`../.local-browser/${values.browser}/`, import.meta.url)));
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
  context = await playwright[selection.engine].launchPersistentContext(profile, {
    channel: selection.channel, headless: false, viewport: null, acceptDownloads: false,
  });
  const collector = await createCollector(context, selection.engine === 'chromium' ? {
    newPage: () => backgroundPage(context.browser(), context), backgroundOnly: true,
  } : {});
  await context.exposeBinding('traceLensLocal', createController(context, collector, {browserName: values.browser}));
  const page = await context.newPage();
  await page.goto(`${SERVER}/app`);
  console.log('TraceLens에 로그인한 뒤 대시보드의 사이트 연결 버튼으로 각 사이트에 로그인하세요.');
  console.log('전용 브라우저 프로필의 로그인 상태는 다음 실행에도 유지됩니다.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { context.close().catch(() => {}); });
  await new Promise(resolve => context.once('close', resolve));
} catch (error) {
  console.error(`실행 실패: ${error.message}`);
  console.error('선택한 브라우저가 설치되어 있는지 확인하세요. 기본값은 Microsoft Edge입니다.');
  await context?.close().catch(() => {});
  process.exitCode = 1;
}
