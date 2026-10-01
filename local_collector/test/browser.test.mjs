import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createCollector} from '../adapter.mjs';
import {createController} from '../controller.mjs';

for (const [name, engine] of Object.entries({chromium})) {
  test(`${name}: authenticated collection and persistent login`, {timeout: 90000}, async t => {
    try { await access(engine.executablePath()); }
    catch { return t.skip('Playwright Chromium is not installed locally'); }
    const uploads = [];
    const server = createServer(async (req, res) => {
      if (req.url === '/app') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><title>TraceLens collector fixture</title>');
      } else if (req.url === '/api/collector/status' && req.headers.authorization === 'Bearer test-token-abcdefghijklmnopqrstuvwxyz') {
        res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}');
      } else if (req.url === '/api/collector/import') {
        let body = ''; for await (const part of req) body += part;
        assert.equal(req.headers.authorization, 'Bearer test-token-abcdefghijklmnopqrstuvwxyz');
        uploads.push(JSON.parse(body));
        res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"found":1,"imported":1}');
      } else {res.statusCode = 404; res.end();}
    });
    await new Promise(resolve => server.listen(8021, '0.0.0.0', resolve));
    const profile = await mkdtemp(join(tmpdir(), 'tracelens-'));
    let context;
    try {
      context = await engine.launchPersistentContext(profile, {headless: true});
      await context.route('https://blog.naver.com/**', route => route.fulfill({contentType: 'text/html; charset=utf-8', body: `<html><head><meta charset="utf-8"><meta property="og:url" content="https://blog.naver.com/localtest"></head><body><a href="https://blog.naver.com/localtest">내 블로그</a><main><li><a class="title" href="https://blog.naver.com/localtest/123456">로컬에서 작성한 테스트 게시글</a><p>${'본인 블로그 내용입니다. '.repeat(15)}</p></li></main></body></html>`}));
      await context.addCookies([{name:'session', value:'fixture-only', domain:'blog.naver.com', path:'/', expires:Math.floor(Date.now()/1000)+3600, secure:true}]);
      const collector = await createCollector(context);
      await context.exposeBinding('traceLensLocal', createController(context, collector, {browserName:name}));
      const dashboard = await context.newPage();
      await dashboard.goto('http://localhost:8021/app');
      assert.equal((await dashboard.evaluate(() => traceLensLocal({type: 'PING'}))).ok, true);
      await dashboard.evaluate(() => traceLensLocal({type: 'OPEN_SITE', sites: ['naver_blog'],
        token: 'test-token-abcdefghijklmnopqrstuvwxyz'}));
      const loginPage = context.pages().find(page => page.url().startsWith('https://blog.naver.com/'));
      assert.ok(loginPage, 'The site connection should open a Naver page');
      assert.equal(await loginPage.locator('a[href="https://blog.naver.com/localtest"]').count(), 1);
      const probe = await collector.tabs.create({url:'https://blog.naver.com/MyBlog.naver'});
      const probeResult = await collector.scripting.executeScript({target:{tabId:probe.id}, func:() => ({url:location.href, ready:document.readyState, href:document.querySelector('a[href]')?.href})});
      assert.equal(probeResult[0]?.result?.href, 'https://blog.naver.com/localtest', JSON.stringify(probeResult));
      await collector.tabs.remove(probe.id);
      const result = await dashboard.evaluate(() => traceLensLocal({type: 'START_SCAN', sites: ['naver_blog'],
        token: 'test-token-abcdefghijklmnopqrstuvwxyz'}));
      assert.equal(result.failed, 0, JSON.stringify(result));
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0].platform, 'naver_blog');
      assert.equal(uploads[0].items[0].title, '로컬에서 작성한 테스트 게시글');
      assert.equal(uploads[0].account_label, 'localtest');
      const foreign = await context.newPage();
      await foreign.goto('https://blog.naver.com/localtest');
      assert.equal(await foreign.evaluate(async () => {try {await traceLensLocal({type:'PING'}); return false;} catch {return true;}}), true);
      await context.close();
      context = await engine.launchPersistentContext(profile, {headless:true});
      assert.ok((await context.cookies('https://blog.naver.com')).some(c => c.name === 'session' && c.value === 'fixture-only'));
    } finally {
      await context?.close();
      await new Promise(resolve => server.close(resolve));
      await rm(profile, {recursive:true, force:true});
    }
  });
}
