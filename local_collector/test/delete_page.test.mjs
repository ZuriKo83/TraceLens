import test from 'node:test';
import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const template = await readFile(new URL('../../app/templates/delete_credit_purchase.html', import.meta.url), 'utf8');
const ui = template.match(/<script>([\s\S]*?)<\/script>/)[1];
const bridge = await readFile(new URL('../../app/static/pc_youtube_delete.js', import.meta.url), 'utf8');

test('the deletion page selects supported comments and waits for explicit confirmation', {timeout: 30000}, async t => {
  try { await access(chromium.executablePath()); }
  catch { return t.skip('Playwright Chromium is not installed locally'); }
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    const commands = [];
    await context.exposeBinding('traceLensLocal', async (_source, command) => {
      commands.push(command);
      return command.type === 'PING' ? {ok: true} : {ok: true, deleted_ids: [1], removed_ids: [1], failed: [], lines: ['1개 삭제 확인']};
    });
    const page = await context.newPage();
    await page.route('http://localhost:8021/delete-credits/purchase', route => route.fulfill({contentType: 'text/html; charset=utf-8', body: `
      <meta name="tracelens-extension-token" content="test-token-abcdefghijklmnopqrstuvwxyz">
      <p id="delete-operation-status" hidden></p>
      <input id="delete-search"><select id="delete-platform-filter"><option value="">All</option></select><select id="delete-type-filter"><option value="">All</option></select>
      <span id="visible-count"></span><span id="selected-count"></span><b id="youtube-selection-title"></b>
      <button class="youtube-kind-filter" data-kind="comment">댓글</button>
      <button id="select-visible">선택</button><button id="clear-selected">해제</button><button id="reset-delete-filters">초기화</button><button id="selected-delete-button" disabled>삭제</button>
      <div id="activity-delete-list">
      <label class="delete-activity-row" data-activity-id="1" data-platform="youtube" data-youtube-kind="comment" data-type="comment" data-search="my comment" data-supported="1"><input class="delete-activity-checkbox" value="1" type="checkbox"><h3>Video</h3><p>My comment</p></label>
      <label class="delete-activity-row" data-activity-id="2" data-platform="youtube" data-youtube-kind="comment" data-type="comment" data-search="missing id" data-supported="0"><input class="delete-activity-checkbox" value="2" type="checkbox" disabled><h3>Missing ID</h3></label>
      </div>
      <dialog id="youtube-delete-dialog"><ul id="youtube-delete-preview"></ul><p id="youtube-delete-summary"></p><button id="youtube-confirm-delete">삭제하기</button></dialog>
      <script>${ui}</script><script>${bridge}</script>`}));
    await page.goto('http://localhost:8021/delete-credits/purchase');
    await page.waitForFunction(() => document.querySelector('#delete-operation-status').textContent.includes('연결됨'));
    await page.locator('#select-visible').click();
    assert.equal(await page.locator('#selected-count').textContent(), '1');
    await page.locator('#selected-delete-button').click();
    assert.equal(await page.locator('#youtube-delete-dialog').isVisible(), true);
    assert.deepEqual(commands.map(command => command.type), ['PING']);
    await page.locator('#youtube-confirm-delete').click();
    await page.waitForFunction(() => document.querySelector('#delete-operation-status').textContent === '1개 삭제 확인');
    assert.deepEqual(commands[1].activityIds, [1]);
    assert.equal(commands[1].type, 'DELETE_YOUTUBE');
    assert.equal(await page.locator('[data-activity-id="1"]').count(), 0);
    assert.equal(await page.locator('[data-activity-id="2"]').count(), 1);
    assert.equal(await page.locator('#selected-count').textContent(), '0');
    await context.close();
  } finally { await browser.close(); }
});
