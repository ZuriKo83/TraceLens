import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createCollector} from '../adapter.mjs';

test('Threads resolves the signed-in navigation profile, never a feed author', {timeout: 60000}, async t => {
  try { await access(chromium.executablePath()); }
  catch { return t.skip('Playwright Chromium is not installed locally'); }
  const profile = await mkdtemp(join(tmpdir(), 'tracelens-threads-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {headless: true});
    await context.route('https://www.threads.com/**', route => route.fulfill({contentType: 'text/html; charset=utf-8', body: `
      <nav><a href="/@mine" aria-label="프로필">프로필</a></nav>
      <main><a href="/@other" aria-label="Profile">Profile</a><a href="/@other/post/abc">다른 사람 글</a></main>`}));
    const collector = await createCollector(context);
    const tab = await collector.tabs.create({url: 'https://www.threads.com/'});
    const pageState = await collector.scripting.executeScript({target: {tabId: tab.id}, func: () => ({
      url: location.href,
      links: [...document.querySelectorAll("nav a[href], [role='navigation'] a[href]")]
        .map(a => ({href: a.href, label: a.getAttribute('aria-label'), text: a.textContent})),
    })});
    assert.deepEqual(pageState[0].result.links, [{href: 'https://www.threads.com/@mine', label: '프로필', text: '프로필'}], JSON.stringify(pageState));
    const owner = await collector.resolveTaskTarget(tab.id, 'threads_posts');
    assert.equal(owner.threadsUsername, 'mine');
    assert.equal(owner.threadsIdentityVerified, true);
    assert.equal((await collector.tabs.get(tab.id)).url, 'https://www.threads.com/@mine');
    await collector.tabs.remove(tab.id);
  } finally { await context?.close(); await rm(profile, {recursive: true, force: true}); }
});

test('Threads refuses to infer ownership from feed and suggestion links', {timeout: 60000}, async t => {
  try { await access(chromium.executablePath()); }
  catch { return t.skip('Playwright Chromium is not installed locally'); }
  const profile = await mkdtemp(join(tmpdir(), 'tracelens-threads-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {headless: true});
    await context.route('https://www.threads.com/**', route => route.fulfill({contentType: 'text/html; charset=utf-8', body: `
      <main><a href="/@other" aria-label="Profile">Profile</a><a href="/@other/post/abc">다른 사람 글</a></main>`}));
    const collector = await createCollector(context);
    const tab = await collector.tabs.create({url: 'https://www.threads.com/'});
    await assert.rejects(collector.resolveTaskTarget(tab.id, 'threads_posts'), /내 프로필 주소/);
    await collector.tabs.remove(tab.id);
  } finally { await context?.close(); await rm(profile, {recursive: true, force: true}); }
});
