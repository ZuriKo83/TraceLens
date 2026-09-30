import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createCollector} from '../adapter.mjs';
import {deleteYouTubeComments} from '../youtube_delete.mjs';

test('PC deletion clicks only the exact comment ID and verifies after navigation', {timeout: 60000}, async t => {
  try { await access(chromium.executablePath()); }
  catch { return t.skip('Playwright Chromium is not installed locally'); }
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    await context.route('https://myactivity.google.com/**', route => route.fulfill({contentType: 'text/html; charset=utf-8', body: `
      <html><body><main id="comments"></main><script>
      for (const id of ['Ugx-wanted', 'Ugx-other']) {
        if (localStorage.getItem(id)) continue;
        const card = document.createElement('c-wiz');
        card.setAttribute('jsname', 'Ttx95'); card.style.display = 'block';
        card.innerHTML = '<div role="listitem" aria-label="YouTube"><a href="https://www.youtube.com/watch?v=video&amp;lc=' + id + '">A video 에 남긴 댓글</a><div class="QTGV3c" jsname="r4nke">Identical comment text</div><button jslog="114566" aria-label="삭제">삭제</button></div>';
        card.querySelector('button').onclick = () => { localStorage.setItem(id, 'deleted'); card.remove(); };
        document.getElementById('comments').append(card);
      }
      </script></body></html>`}));
    const collector = await createCollector(context);
    let synchronized;
    const transport = async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('delete-targets')) return {ok: true, json: async () => ({ok: true, receipt: 'signed', targets: [
        {id: '1', commentId: 'Ugx-wanted', activityKind: 'comment', strictMatch: true, content: 'Identical comment text'},
      ]})};
      synchronized = body.activity_ids;
      return {ok: true, json: async () => ({ok: true, removed_ids: body.activity_ids})};
    };
    const result = await deleteYouTubeComments(collector, transport, 'token', [1]);
    assert.deepEqual(result.deleted_ids, [1]);
    assert.deepEqual(synchronized, [1]);
    const verify = await context.newPage();
    await verify.goto('https://myactivity.google.com/page?page=youtube_comments');
    assert.equal(await verify.locator('a[href*="Ugx-wanted"]').count(), 0);
    assert.equal(await verify.locator('a[href*="Ugx-other"]').count(), 1);
    await collector.close();
    await context.close();
  } finally { await browser.close(); }
});
