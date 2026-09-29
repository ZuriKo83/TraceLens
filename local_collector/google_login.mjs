import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

export const GOOGLE_LOGIN_URL = 'https://myactivity.google.com/page?page=youtube_comments';
const NORMAL_LOGIN_URLS = Object.freeze({youtube: GOOGLE_LOGIN_URL, x: 'https://x.com/i/flow/login'});

export function browserExecutable(browserName, env = process.env, platform = process.platform) {
  if (env.TRACELENS_BROWSER_EXECUTABLE) return env.TRACELENS_BROWSER_EXECUTABLE;
  if (platform !== 'win32') return browserName === 'edge' ? 'microsoft-edge' : 'google-chrome';
  const executable = browserName === 'edge' ? 'msedge.exe' : 'chrome.exe';
  const folder = browserName === 'edge' ? join('Microsoft', 'Edge', 'Application') : join('Google', 'Chrome', 'Application');
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  const candidate = roots.map(root => join(root, folder, executable)).find(existsSync);
  if (!candidate) throw new Error(`${browserName === 'edge' ? 'Edge' : 'Chrome'} 실행 파일을 찾지 못했습니다.`);
  return candidate;
}

export function selectInstalledBrowser(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return 'edge';
  for (const browser of ['edge', 'chrome']) {
    try { browserExecutable(browser, env, platform); return browser; }
    catch {}
  }
  throw new Error('Microsoft Edge 또는 Google Chrome을 설치한 뒤 다시 실행하세요.');
}

export async function runNormalLogin(browserName, profile, site, {launch = spawn, executable = browserExecutable(browserName)} = {}) {
  if (!['edge', 'chrome'].includes(browserName)) throw new Error('Google 로그인은 Edge 또는 Chrome에서만 시도할 수 있습니다.');
  if (!Object.hasOwn(NORMAL_LOGIN_URLS, site)) throw new Error('지원하지 않는 로그인 사이트입니다.');
  // Launch without Playwright or a remote debugging switch. The managed collector
  // must have closed before this profile can be opened by a regular browser.
  const child = launch(executable, [`--user-data-dir=${profile}`, '--new-window', NORMAL_LOGIN_URLS[site]], {
    stdio: 'ignore', windowsHide: false,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`브라우저가 종료되었습니다 (${signal || code}).`)));
  });
}

export const runGoogleLogin = (browserName, profile, options) => runNormalLogin(browserName, profile, 'youtube', options);
