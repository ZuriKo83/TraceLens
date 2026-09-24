import {createServer} from 'node:http';
import {mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import * as playwright from 'playwright';
import {createCollector} from './adapter.mjs';
import {SERVER, SITES, allowedPage, selectedSites} from './policy.mjs';

const engineName = process.env.TRACELENS_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const profileRoot = process.env.BROWSER_PROFILE_DIR || fileURLToPath(new URL('../browser_profiles/', import.meta.url));
const listenHost = process.env.TRACELENS_COLLECTOR_HOST || '127.0.0.1';
const listenPort = Number(process.env.TRACELENS_COLLECTOR_PORT || 3080);
const sessions = new Map();
const idleMs = 30 * 60 * 1000;
const maxSessions = 8;
const pending = new Map();
const identities = new Map();

function reply(res, status, value) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(value));
}

function externalHttps(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (host === 'web' || host === 'collector' || host === 'db' || host === 'redis') return false;
    if (/^(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(host)) return false;
    if (host.startsWith('[') || host.includes(':')) return false;
    return true;
  } catch { return false; }
}

async function bodyOf(req) {
  let body = '';
  for await (const part of req) {
    body += part;
    if (body.length > 8192) throw new Error('요청 크기가 너무 큽니다.');
  }
  return JSON.parse(body || '{}');
}

async function authenticate(req) {
  const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,256})$/)?.[1];
  if (!token) throw new Error('로그인이 필요합니다.');
  const cached = identities.get(token);
  if (cached && cached.expiresAt > Date.now()) return {token, userId: cached.userId};
  const response = await fetch(`${SERVER}/api/collector/status`, {
    headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  if (!response.ok) throw new Error('로그인 상태가 만료되었습니다.');
  const identity = await response.json();
  if (!Number.isSafeInteger(identity.user_id) || identity.user_id < 1) throw new Error('계정을 확인할 수 없습니다.');
  if (identities.size > 256) identities.clear();
  identities.set(token, {userId: identity.user_id, expiresAt: Date.now() + 10000});
  return {token, userId: identity.user_id};
}

async function sessionFor(userId) {
  let session = sessions.get(userId);
  if (session) { session.usedAt = Date.now(); return session; }
  if (pending.has(userId)) return pending.get(userId);
  if (sessions.size + pending.size >= maxSessions) throw new Error('서버의 브라우저가 모두 사용 중입니다. 잠시 후 다시 시도하세요.');
  const creation = createSession(userId);
  pending.set(userId, creation);
  try { return await creation; }
  finally { pending.delete(userId); }
}

async function createSession(userId) {
  const profile = join(profileRoot, String(userId));
  await mkdir(profile, {recursive: true, mode: 0o700});
  const context = await playwright[engineName].launchPersistentContext(profile, {
    headless: true, viewport: {width: 1280, height: 800}, acceptDownloads: false,
  });
  try {
    // Keep server-only addresses inaccessible from third-party pages.
    await context.route('**/*', route => {
      const request = route.request();
      const url = request.url();
      if (!externalHttps(url)) return route.abort();
      if (request.isNavigationRequest()) {
        try {
          if (request.frame() === request.frame().page().mainFrame() && !allowedPage(url)) return route.abort();
        } catch { return route.abort(); }
      }
      return route.continue();
    });
    const collector = await createCollector(context);
    const session = {context, collector, pages: new Map(), usedAt: Date.now(), busy: false};
    sessions.set(userId, session);
    context.once('close', () => sessions.delete(userId));
    return session;
  } catch (error) { await context.close().catch(() => {}); throw error; }
}

async function sitePage(session, site) {
  let page = session.pages.get(site);
  if (page && !page.isClosed()) return page;
  page = await session.context.newPage();
  session.pages.set(site, page);
  try { await page.goto(SITES[site], {waitUntil: 'domcontentloaded', timeout: 35000}); }
  catch (error) { session.pages.delete(site); await page.close(); throw error; }
  return page;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, {ok: true});
    const {userId, token} = await authenticate(req);
    if (req.method !== 'POST') return reply(res, 405, {error: '지원하지 않는 요청입니다.'});
    const body = await bodyOf(req);
    if (req.url === '/purge') {
      const existing = sessions.get(userId);
      if (existing?.busy || pending.has(userId)) return reply(res, 409, {error: '조회가 진행 중입니다.'});
      if (existing) await existing.context.close();
      sessions.delete(userId);
      identities.delete(token);
      await rm(join(profileRoot, String(userId)), {recursive: true, force: true});
      return reply(res, 200, {ok: true});
    }
    const site = body.site;
    if (!['/open', '/frame', '/input', '/scan'].includes(req.url)) return reply(res, 404, {error: '요청을 찾지 못했습니다.'});
    if (req.url !== '/scan') selectedSites([site]);
    const session = await sessionFor(userId);
    session.usedAt = Date.now();
    if (req.url === '/scan') {
      if (session.busy) return reply(res, 409, {error: '조회가 진행 중입니다.'});
      const sites = selectedSites(body.sites);
      session.busy = true;
      try {
        const result = await session.collector.scan(sites, {serverUrl: SERVER, collectorToken: token});
        const failed = result.lines.filter(line => line.startsWith('✕')).length;
        return reply(res, 200, {...result, completed: result.lines.length - failed, failed});
      } finally { session.busy = false; }
    }
    const page = await sitePage(session, site);
    if (req.url === '/open') return reply(res, 200, {ok: true});
    if (req.url === '/frame') {
      const screenshot = await page.screenshot({type: 'jpeg', quality: 62, timeout: 10000});
      const revision = createHash('sha1').update(screenshot).digest('hex');
      if (body.revision === revision) {
        res.writeHead(204, {'X-Frame-Revision': revision, 'Cache-Control': 'no-store'});
        return res.end();
      }
      res.writeHead(200, {'Content-Type': 'image/jpeg', 'X-Frame-Revision': revision, 'Cache-Control': 'no-store'});
      return res.end(screenshot);
    }
    if (body.action === 'click' && Number.isFinite(body.x) && Number.isFinite(body.y)) {
      await page.mouse.click(Math.min(1279, Math.max(0, body.x)), Math.min(799, Math.max(0, body.y)));
    } else if (body.action === 'text' && typeof body.text === 'string' && body.text.length <= 1000) {
      await page.keyboard.insertText(body.text);
    } else if (body.action === 'key' && ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'ControlOrMeta+A'].includes(body.key)) {
      await page.keyboard.press(body.key);
    } else if (body.action === 'scroll' && Number.isFinite(body.y)) {
      await page.mouse.wheel(0, Math.min(1200, Math.max(-1200, body.y)));
    } else throw new Error('입력 형식이 올바르지 않습니다.');
    return reply(res, 200, {ok: true});
  } catch (error) {
    console.error('Collector request:', error.message);
    return reply(res, 400, {error: error.message});
  }
});

setInterval(async () => {
  for (const [id, session] of sessions) {
    if (!session.busy && Date.now() - session.usedAt > idleMs) {
      sessions.delete(id);
      await session.context.close().catch(() => {});
    }
  }
}, 60000).unref();
server.listen(listenPort, listenHost, () => console.log(`TraceLens server collector (${engineName}) ready on ${listenHost}:${listenPort}`));
