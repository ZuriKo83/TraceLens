import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createCollector} from '../adapter.mjs';

test('Naver blog collection excludes help, neighbor and deceptive post links', {timeout: 30000}, async t => {
  try { await access(chromium.executablePath()); }
  catch { return t.skip('Playwright Chromium is not installed locally'); }
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    await context.route('https://blog.naver.com/**', route => route.fulfill({contentType: 'text/html; charset=utf-8', body: `
      <main><li><a href="https://blog.naver.com/blogpeople/150109857428">프롤로그에 등록 도움말</a><a class="title" href="https://blog.naver.com/mine/123456">내가 작성한 글</a></li>
      <li><a href="/PostView.naver?blogId=mine&amp;logNo=789">내 두 번째 글</a></li>
      <li><a href="/PostView.naver?logNo=111&amp;blogId=other">다른 사람 글</a></li>
      <li><a href="https://evil.example/blog.naver.com/mine/456">가짜 블로그 링크</a></li>
      <li><a href="/PostView.naver?blogId=mine&amp;blogId=other&amp;logNo=987">중복 계정 파라미터</a></li></main>`}));
    const collector = await createCollector(context);
    const tab = await collector.tabs.create({url: 'https://blog.naver.com/PostList.naver?blogId=mine'});
    const result = await collector.runExtractor(tab.id, 'naver_blog', 'post', 'self_activity', {accountLabel: 'mine'});
    assert.deepEqual(result.items.map(item => item.source_url).sort(), ['https://blog.naver.com/mine/123456', 'https://blog.naver.com/mine/789']);
    assert.deepEqual(result.items.map(item => item.title).sort(), ['내 두 번째 글', '내가 작성한 글'].sort());
    await assert.rejects(collector.runExtractor(tab.id, 'naver_blog', 'post', 'self_activity', null), /블로그 ID/);
    await collector.close();
    await context.close();
  } finally { await browser.close(); }
});

test('Naver blog resolver never takes ownership from help or neighbor links', {timeout: 30000}, async t => {
  try { await access(chromium.executablePath()); }
  catch { return t.skip('Playwright Chromium is not installed locally'); }
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    await context.route('https://blog.naver.com/**', route => route.fulfill({contentType: 'text/html; charset=utf-8', body: `
      <a href="https://blog.naver.com/blogpeople/150109857428">도움말</a>
      <a href="https://blog.naver.com/other">이웃 블로그</a>`}));
    const collector = await createCollector(context);
    const unknown = await collector.tabs.create({url: 'https://blog.naver.com/MyBlog.naver'});
    await assert.rejects(collector.resolveTaskTarget(unknown.id, 'naver_blog_posts'), /블로그 ID/);
    const owned = await collector.tabs.create({url: 'https://blog.naver.com/mine'});
    assert.equal((await collector.resolveTaskTarget(owned.id, 'naver_blog_posts')).accountLabel, 'mine');
    assert.equal(new URL((await collector.tabs.get(owned.id)).url).searchParams.get('blogId'), 'mine');
    await collector.close();
    await context.close();
  } finally { await browser.close(); }
});
