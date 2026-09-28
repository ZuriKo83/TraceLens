import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {SERVER, SITES} from './policy.mjs';
import {createCollector} from './adapter.mjs';
import {createController} from './controller.mjs';
import {installBridge} from './bridge.mjs';

const profile = process.env.TRACELENS_NATIVE_PROFILE || fileURLToPath(new URL('../.local-browser/native/', import.meta.url));

function executable() {
  if (process.env.TRACELENS_BROWSER_PATH) {
    if (!existsSync(process.env.TRACELENS_BROWSER_PATH)) throw new Error('지정한 브라우저 파일을 찾지 못했습니다.');
    return process.env.TRACELENS_BROWSER_PATH;
  }
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = process.platform === 'win32'
    ? roots.flatMap(root => [join(root, 'Microsoft/Edge/Application/msedge.exe'), join(root, 'Google/Chrome/Application/chrome.exe')])
    : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Edge 또는 Chrome을 찾지 못했습니다.');
  return found;
}

function pageHtml(secret) {
  const links = Object.entries(SITES).map(([site, url]) =>
    `<a href="${url.replaceAll('&', '&amp;')}" target="_blank" rel="noreferrer noopener">${({youtube:'YouTube', instagram:'Instagram', facebook:'Facebook', threads:'Threads', x:'X', naver_blog:'네이버 블로그', naver_kin:'네이버 지식iN'})[site]}</a>`).join(' ');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>TraceLens 연결</title>
    <style>body{font:17px system-ui;max-width:680px;margin:10vh auto;padding:20px;line-height:1.6}a{display:inline-block;margin:8px;padding:9px;border:1px solid #aaa;border-radius:8px}button{padding:14px;font:inherit;cursor:pointer}</style>
    <h1>사이트에 로그인하세요</h1><p>아래 사이트를 일반 브라우저 탭에서 열어 직접 로그인하세요. 필요한 2차 인증도 사이트에서 완료합니다.</p>
    <nav>${links}</nav><p>로그인을 마쳤으면 아래 버튼을 누르세요. 수집기가 이 브라우저에 연결한 뒤 TraceLens 대시보드를 엽니다.</p>
    <form method="post" action="/${secret}/connect"><button>로그인 완료 · TraceLens 열기</button></form>
    <p>사이트별 로그인 상태는 조회 결과로 확인합니다. 로그인 정보를 TraceLens에 입력하지 마세요.</p></html>`;
}

async function debuggingPort(directory, child) {
  const path = join(directory, 'DevToolsActivePort');
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('브라우저가 시작되지 않았습니다. 다른 창을 닫고 다시 실행하세요.');
    try {
      const port = Number((await readFile(path, 'utf8')).split('\n')[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch {}
    await delay(100);
  }
  throw new Error('브라우저의 연결 포트를 확인하지 못했습니다.');
}

export async function startInteractive({browserPath = executable(), profileDir = profile, headless = false} = {}) {
  const health = await fetch(`${SERVER}/health`, {signal: AbortSignal.timeout(5000)});
  if (!health.ok) throw new Error('TraceLens 서버가 실행 중인지 확인하세요.');
  await mkdir(profileDir, {recursive: true, mode: 0o700});
  await rm(join(profileDir, 'DevToolsActivePort'), {force:true});
  const secret = randomBytes(24).toString('hex');
  let browser;
  let connected = false;
  const helper = createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${helper.address().port}`) {res.writeHead(403).end(); return;}
    if (req.method === 'GET' && req.url === `/${secret}`) {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer'});
      res.end(pageHtml(secret));
      return;
    }
    if (req.method === 'POST' && req.url === `/${secret}/connect`) {
      if (connected) {res.writeHead(409).end('이미 연결 중입니다.'); return;}
      connected = true;
      try {
        const port = await debuggingPort(profileDir, child);
        console.log('TraceLens: 기존 브라우저에 연결 중');
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const context = browser.contexts()[0];
        if (!context) throw new Error('브라우저 프로필에 연결하지 못했습니다.');
        const collector = await createCollector(context);
        await context.exposeBinding('traceLensLocal', createController(context, collector, {browserName:'edge/chrome'}));
        await context.addInitScript(installBridge, {server:SERVER});
        const dashboard = await context.newPage();
        console.log('TraceLens: 대시보드 열기');
        await dashboard.goto(`${SERVER}/app`, {waitUntil:'domcontentloaded'});
        res.writeHead(303, {Location:SERVER + '/app'}).end();
        await dashboard.bringToFront();
      } catch (error) {
        console.error(`TraceLens 연결 실패: ${error.message}`);
        connected = false;
        res.writeHead(500, {'Content-Type':'text/plain; charset=utf-8'}).end(`연결 실패: ${error.message}`);
      }
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => helper.listen(0, '127.0.0.1', resolve));
  const helperUrl = `http://127.0.0.1:${helper.address().port}/${secret}`;
  const args = ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--new-window', ...(headless ? ['--headless=new', '--no-sandbox'] : []), helperUrl];
  const child = spawn(browserPath, args, {stdio:'ignore'});
  child.on('error', error => console.error(`브라우저 시작 실패: ${error.message}`));
  child.once('exit', () => {browser?.close().catch(() => {}); helper.close();});
  console.log(`TraceLens 로그인 안내: ${helperUrl}`);
  return {helperUrl, child, context: () => browser?.contexts()[0], async close() {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      child.kill();
      await exited;
    }
    helper.close();
  }};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startInteractive().catch(error => {console.error(`실행 실패: ${error.message}`); process.exitCode = 1;});
}
