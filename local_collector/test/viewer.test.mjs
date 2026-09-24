import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium, firefox} from 'playwright';

const template = await readFile(new URL('../../app/templates/browser_site.html', import.meta.url), 'utf8');
const script = template.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  .replace('{{ site|tojson }}', '"naver_blog"')
  .replace('{{ csrf_token|tojson }}', '"test-csrf"');
assert.ok(script);
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');

for (const [name, engine] of Object.entries({chromium, firefox})) {
  test(`${name}: clicking the remote field accepts direct keyboard input and reuses unchanged frames`, {timeout: 30000}, async () => {
    const browser = await engine.launch({headless: true});
    try {
      const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
      const inputs = [];
      let frameCount = 0;
      let revisionSeen = false;
      await page.route('http://localhost:8021/**', async route => {
        const request = route.request();
        if (request.url().includes('/app/site')) {
          return route.fulfill({contentType: 'text/html', body: `<p id="browser-message"></p><img id="browser-screen" style="display:block;width:1280px;height:800px" hidden><textarea id="browser-keyboard"></textarea><script>${script}</script>`});
        }
        const body = JSON.parse(request.postData() || '{}');
        if (request.url().endsWith('/open')) return route.fulfill({contentType:'application/json', body:'{"ok":true}'});
        if (request.url().endsWith('/frame')) {
          frameCount++;
          if (body.revision === 'frame-1') {
            revisionSeen = true;
            return route.fulfill({status:204, headers:{'X-Frame-Revision':'frame-1'}});
          }
          return route.fulfill({contentType:'image/png', headers:{'X-Frame-Revision':'frame-1'}, body:pixel});
        }
        if (request.url().endsWith('/input')) {
          inputs.push(body);
          return route.fulfill({contentType:'application/json', body:'{"ok":true}'});
        }
        return route.abort();
      });
      await page.goto('http://localhost:8021/app/site?site=naver_blog');
      await page.locator('#browser-screen').waitFor({state:'visible'});
      await page.locator('#browser-screen').click({position:{x:200,y:150}});
      await page.keyboard.insertText('alice@example.com');
      await page.keyboard.press('Enter');
      for (let attempt = 0; attempt < 30 && (!revisionSeen || inputs.length < 3); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(inputs.some(x => x.action === 'click' && x.x === 200 && x.y === 150));
      assert.ok(inputs.some(x => x.action === 'text' && x.text === 'alice@example.com'), JSON.stringify(inputs));
      assert.ok(inputs.some(x => x.action === 'key' && x.key === 'Enter'));
      assert.ok(frameCount >= 2 && revisionSeen);
      assert.equal(await page.locator('#browser-keyboard').inputValue(), '');
    } finally { await browser.close(); }
  });
}
