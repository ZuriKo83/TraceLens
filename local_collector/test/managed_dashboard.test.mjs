import test from 'node:test';
import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const template = await readFile(new URL('../../app/templates/user_dashboard.html', import.meta.url), 'utf8');
const script = template.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'The dashboard script must be present');

test('managed browser opens site login and scans without a debugging port', {timeout: 30000}, async t => {
  try { await access(chromium.executablePath()); }
  catch { return t.skip('Playwright Chromium is not installed locally'); }
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    const commands = [];
    await context.exposeBinding('traceLensLocal', async (_source, command) => {
      commands.push(command);
      if (command.type === 'START_SCAN') return {ok: true, failed: 1, completed: 0, lines: ['로그인 확인']};
      return {ok: true};
    });
    const page = await context.newPage();
    await page.route('http://localhost:8021/app', route => route.fulfill({contentType: 'text/html; charset=utf-8', body: `
      <meta name="tracelens-extension-token" content="test-token-abcdefghijklmnopqrstuvwxyz">
      <section id="extension-status-card"><b id="extension-status-title"></b><small id="extension-status-text"></small></section>
      <section id="local-site-logins" hidden><button data-local-login="naver_blog">네이버 블로그 열기</button><p id="local-login-status"></p></section>
      <button id="google-login-setup"></button><button id="x-normal-login"></button>
      <small id="google-login-status" data-site-status="youtube"></small>
      <small data-site-status="instagram"></small><small data-site-status="x"></small>
      <div id="web-site-grid"><input type="checkbox" value="youtube"><input type="checkbox" value="naver_blog" checked></div>
      <button id="select-all-sites"></button><button id="clear-all-sites"></button><span id="web-selection-count"></span>
      <button id="web-start-scan" disabled></button>
      <section id="web-scan-progress" hidden><b id="web-progress-title"></b><span id="web-progress-state"></span><div id="web-progress-bar"></div><pre id="web-scan-log"></pre></section>
      <script>${script}</script>`}));
    await page.goto('http://localhost:8021/app');
    await page.waitForFunction(() => document.getElementById('web-start-scan').disabled === false);
    assert.equal(await page.locator('#local-site-logins').isVisible(), true);
    assert.equal(await page.locator('input[value="youtube"]').isEnabled(), true);
    await page.locator('[data-local-login="naver_blog"]').click();
    await page.locator('#web-start-scan').click();
    await page.waitForFunction(() => document.querySelector('#web-scan-log').textContent === '로그인 확인');
    assert.deepEqual(commands.map(command => command.type), ['PING', 'OPEN_SITE', 'START_SCAN']);
    assert.deepEqual(commands[2].sites, ['naver_blog']);
    await context.close();
  } finally { await browser.close(); }
});
