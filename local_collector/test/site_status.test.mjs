import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {backgroundPage} from '../cdp.mjs';
import {probeSite, checkSites} from '../site_status.mjs';

const pageFor = (finalUrl, detail = {}) => ({
  goto: async () => {}, waitForTimeout: async () => {}, url: () => finalUrl,
  evaluate: async () => ({hasPassword: false, profileUrls: [], xProfile: null, securityScreen: false, ...detail}),
});

test('site status does not report a feed, sign-in, or security screen as accessible', async () => {
  assert.equal((await probeSite(pageFor('https://x.com/home'), 'x')).state, 'profile_required');
  assert.equal((await probeSite(pageFor('https://www.instagram.com/accounts/login/'), 'instagram')).state, 'login_required');
  assert.equal((await probeSite(pageFor('https://www.threads.com/', {
    profileUrls: ['https://www.threads.com/@one', 'https://www.threads.com/@two'],
  }), 'threads')).state, 'profile_required');
  assert.equal((await probeSite(pageFor('https://blog.naver.com/MyBlog.naver', {
    securityScreen: true,
  }), 'naver_blog')).state, 'security_required');
});

test('site status confirms identifiable own activity and profile pages', async () => {
  assert.equal((await probeSite(pageFor('https://myactivity.google.com/page?page=youtube_comments'), 'youtube')).state, 'accessible');
  assert.equal((await probeSite(pageFor('https://www.threads.com/', {
    profileUrls: ['https://www.threads.com/@mine'],
  }), 'threads')).state, 'accessible');
  assert.equal((await probeSite(pageFor('https://x.com/home', {
    xProfile: 'https://x.com/myhandle',
  }), 'x')).state, 'accessible');
});

test('automatic checks inspect distinct background pages and close them', {timeout: 30000}, async t => {
  try { await access(chromium.executablePath()); }
  catch { return t.skip('Playwright Chromium is not installed locally'); }
  const profile = await mkdtemp(join(tmpdir(), 'tracelens-status-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {headless: true});
    await context.route('https://myactivity.google.com/**', route => route.fulfill({contentType: 'text/html', body: '<main>comments</main>'}));
    await context.route('https://www.threads.com/**', route => route.fulfill({contentType: 'text/html', body: '<nav><a href="/@mine" aria-label="Profile">Profile</a></nav>'}));
    await context.route('https://x.com/**', route => route.fulfill({contentType: 'text/html', body: '<nav><a data-testid="AppTabBar_Profile_Link" href="/mine">Profile</a></nav>'}));
    const initial = context.pages().length;
    const result = await checkSites(() => backgroundPage(context.browser(), context, {hidden: true}), ['youtube', 'threads', 'x']);
    assert.deepEqual(result.map(item => item.state), ['accessible', 'accessible', 'accessible']);
    assert.equal(context.pages().length, initial);
  } finally { await context?.close(); await rm(profile, {recursive: true, force: true}); }
});
