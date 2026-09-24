import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedApi, allowedPage, dashboardSource, selectedSites} from '../policy.mjs';
import {createController} from '../controller.mjs';
const source = (url = 'http://localhost:8021/app', child = false) => {
  const frame = {url: () => url}; return {frame, page: {mainFrame: () => child ? {} : frame}};
};
test('only the top-level local dashboard may command the collector', () => {
  assert.equal(dashboardSource(source()), true);
  for (const url of ['https://x.com/app', 'http://localhost:8021.evil/app', 'http://localhost:8021/login', 'http://127.0.0.1:8021/app']) assert.equal(dashboardSource(source(url)), false);
  assert.equal(dashboardSource(source(undefined, true)), false);
});
test('navigation and result uploads cannot target arbitrary hosts', () => {
  assert.equal(allowedPage('https://blog.naver.com/MyBlog.naver'), true);
  for (const url of ['file:///etc/passwd', 'http://localhost:8000', 'https://x.com.evil/', 'https://x.com:8443/', 'https://me@x.com/']) assert.equal(allowedPage(url), false);
  assert.equal(allowedApi('http://localhost:8021/api/collector/jobs/123-abc'), true);
  for (const url of ['https://example.com/api/collector/import', 'http://localhost:8021/api/admin', 'http://localhost:8021/api/collector/import?next=https://evil/']) assert.equal(allowedApi(url), false);
  assert.throws(() => selectedSites(['__proto__']));
  assert.deepEqual(selectedSites(['x', 'x']), ['x']);
});
test('untrusted pages and invalid sessions cannot collect', async () => {
  let scans = 0;
  const fn = createController({}, {scan: async () => {scans++;}}, {transport: async () => ({ok: false})});
  await assert.rejects(fn(source('https://x.com/'), {type: 'PING'}));
  await assert.rejects(fn(source(), {type: 'START_SCAN', sites: ['x'], token: 'a'.repeat(40)}));
  assert.equal(scans, 0);
});
test('concurrent scans are rejected and lock released after failure', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  let scans = 0;
  const fn = createController({}, {scan: async () => {scans++; await gate; throw Error('scan failure');}}, {transport: async () => ({ok: true})});
  const command = {type: 'START_SCAN', sites: ['x'], token: 'a'.repeat(40)};
  const first = fn(source(), command);
  await assert.rejects(fn(source(), command), /진행 중/);
  release();
  await assert.rejects(first, /scan failure/);
  await assert.rejects(fn(source(), command), /scan failure/);
  assert.equal(scans, 2);
});
