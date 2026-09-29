import {createServer} from 'node:http';
import * as playwright from 'playwright';
import {createCollector} from './adapter.mjs';
import {backgroundPage} from './cdp.mjs';
import {SERVER, selectedSites} from './policy.mjs';

const host = '127.0.0.1';
const port = Number(process.env.TRACELENS_HELPER_PORT || 8765);
const endpoint = process.env.TRACELENS_CDP_ENDPOINT || 'http://127.0.0.1:9222';
let browser;
let collector;
let busy = false;

function respond(res, status, value) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': SERVER, 'Vary': 'Origin', 'Access-Control-Allow-Private-Network': 'true'});
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new Error('요청 크기가 너무 큽니다.');
  }
  return JSON.parse(text || '{}');
}

async function connect() {
  if (browser?.isConnected() && collector) return;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('디버깅 주소는 로컬 주소만 허용합니다.');
  browser = await playwright.chromium.connectOverCDP(endpoint, {timeout: 5000});
  const context = browser.contexts()[0];
  if (!context) throw new Error('브라우저 프로필을 찾지 못했습니다.');
  collector = await createCollector(context, {newPage: () => backgroundPage(browser, context), backgroundOnly: true});
  browser.on('disconnected', () => { collector = null; browser = null; });
}

const server = createServer(async (req, res) => {
  if (req.headers.origin !== SERVER) return respond(res, 403, {error: 'TraceLens 대시보드에서만 요청할 수 있습니다.'});
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {'Access-Control-Allow-Origin': SERVER, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true', 'Vary': 'Origin'});
    return res.end();
  }
  try {
    if (req.method === 'GET' && req.url === '/health') {
      await connect();
      return respond(res, 200, {ok: true});
    }
    if (req.method !== 'POST' || req.url !== '/scan') return respond(res, 404, {error: '지원하지 않는 요청입니다.'});
    if (busy) return respond(res, 409, {error: '이미 조회가 진행 중입니다.'});
    busy = true;
    try {
      const body = await readBody(req);
      const sites = selectedSites(body.sites);
      const token = body.token;
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error('TraceLens에 다시 로그인하세요.');
      const auth = await fetch(`${SERVER}/api/collector/status`, {headers: {Authorization: `Bearer ${token}`},
        signal: AbortSignal.timeout(10000), redirect: 'error'});
      if (!auth.ok) throw new Error('TraceLens 로그인 상태가 만료되었습니다.');
      await connect();
      const result = await collector.scan(sites, {serverUrl: SERVER, collectorToken: token});
      const failed = result.lines.filter(line => line.startsWith('✕')).length;
      return respond(res, 200, {...result, completed: result.lines.length - failed, failed});
    } finally { busy = false; }
  } catch (error) { return respond(res, 503, {error: error.message}); }
});

server.listen(port, host, () => {
  console.log(`TraceLens 로컬 수집기: http://${host}:${port}`);
  console.log(`사용 중인 브라우저 연결: ${endpoint}`);
});
