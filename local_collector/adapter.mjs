import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {allowedApi, allowedPage} from './policy.mjs';

export async function localFetch(url, options = {}) {
  if (!allowedApi(String(url))) throw new Error('허용되지 않은 저장 서버 주소입니다.');
  return fetch(url, {...options, redirect: 'error', signal: AbortSignal.timeout(30000)});
}

// Implements only the collection APIs used by the existing audited extractors.
// No extension is installed in the browser; page execution is done by Playwright.
export async function createCollector(context, {transport = localFetch} = {}) {
  const tabs = new Map();
  const listeners = new Set();
  let nextId = 1;
  function pageFor(id) {
    const page = tabs.get(id);
    if (!page || page.isClosed()) throw new Error('조회 탭이 닫혔습니다.');
    return page;
  }
  const info = (id) => ({id, url: pageFor(id).url(), status: 'complete'});
  async function navigate(id, url) {
    if (!allowedPage(url)) throw new Error('지원하지 않는 사이트 주소입니다.');
    await pageFor(id).goto(url, {waitUntil: 'domcontentloaded', timeout: 35000});
    for (const listener of listeners) listener(id, {status: 'complete'}, info(id));
    return info(id);
  }
  const chrome = {
    runtime: {onMessage: {addListener() {}}},
    storage: {local: {get: async () => ({}), set: async () => {}}},
    tabs: {
      async create({url, active}) {
        const id = nextId++;
        const page = await context.newPage();
        tabs.set(id, page);
        try {
          await navigate(id, url);
          if (active) await page.bringToFront();
          return info(id);
        } catch (error) { tabs.delete(id); await page.close().catch(() => {}); throw error; }
      },
      async get(id) { return info(id); },
      async update(id, {url}) { return navigate(id, url); },
      async remove(id) { const page = tabs.get(id); tabs.delete(id); await page?.close().catch(() => {}); },
      onUpdated: {addListener: f => listeners.add(f), removeListener: f => listeners.delete(f)},
    },
    scripting: {
      async executeScript({target, func, args = []}) {
        const page = pageFor(target.tabId);
        const frames = target.allFrames ? page.frames() : [page.mainFrame()];
        const results = [];
        // Evaluate a trusted repository function, never source supplied by a webpage.
        const expression = `args => (${func.toString()})(...args)`;
        for (const frame of frames) {
          if (!allowedPage(frame.url())) {
            if (frame === page.mainFrame()) throw new Error(`지원하지 않는 조회 페이지: ${frame.url()}`);
            continue;
          }
          try { results.push({result: await frame.evaluate(expression, args)}); }
          catch (error) { if (frame === page.mainFrame()) throw new Error(`스크립트 실행 실패 (${frame.url()}): ${error.message}`); }
        }
        return results;
      },
    },
  };
  const sandbox = vm.createContext({chrome, URL, fetch: transport, setTimeout, clearTimeout, console});
  for (const name of ['background.js', 'youtube_delete_page.js', 'youtube_activity_collector.js']) {
    const path = fileURLToPath(new URL(`../chrome_extension/${name}`, import.meta.url));
    vm.runInContext(await readFile(path, 'utf8'), sandbox, {filename: name});
  }
  return {
    scan: (sites, config) => sandbox.scanSites(sites, config),
    // Exposed to local tests, never to the browser binding.
    runExtractor: (...args) => sandbox.runExtractor(...args),
    assertOwnedTaskUrl: (...args) => sandbox.assertOwnedTaskUrl(...args),
    tabs: chrome.tabs,
    scripting: chrome.scripting,
    async close() { await Promise.all([...tabs.keys()].map(id => chrome.tabs.remove(id))); },
  };
}
