import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

export const GOOGLE_LOGIN_URL = 'https://myactivity.google.com/page?page=youtube_comments';

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

export async function runGoogleLogin(browserName, profile, {launch = spawn, executable = browserExecutable(browserName)} = {}) {
  if (!['edge', 'chrome'].includes(browserName)) throw new Error('Google 로그인은 Edge 또는 Chrome에서만 시도할 수 있습니다.');
  // Launch without Playwright or a remote debugging switch. The managed collector
  // must have closed before this profile can be opened by a regular browser.
  const child = launch(executable, [`--user-data-dir=${profile}`, '--new-window', GOOGLE_LOGIN_URL], {
    stdio: 'ignore', windowsHide: false,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`브라우저가 종료되었습니다 (${signal || code}).`)));
  });
}
