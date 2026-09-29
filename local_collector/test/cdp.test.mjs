import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {backgroundPage} from '../cdp.mjs';

test('collection creates a background tab in the existing browser profile', async t => {
  try { await access(chromium.executablePath()); }
  catch { return t.skip('Playwright Chromium is not installed locally'); }
  const profile = await mkdtemp(join(tmpdir(), 'tracelens-cdp-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {headless: true});
    const page = await backgroundPage(context.browser(), context);
    assert.equal(page.url(), 'about:blank');
    await page.goto('data:text/html,<p>collection tab</p>');
    assert.equal(await page.textContent('p'), 'collection tab');
    await page.close();
  } finally {
    await context?.close();
    await rm(profile, {recursive: true, force: true});
  }
});
