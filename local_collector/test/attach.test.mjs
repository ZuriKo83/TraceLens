import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

test('PC bridge accepts commands only from the configured dashboard', async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../attach.mjs', import.meta.url))], {
    env: {...process.env, TRACELENS_HELPER_PORT: String(port), TRACELENS_CDP_ENDPOINT: 'http://127.0.0.1:1'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => { throw new Error('PC 수집기가 시작되지 않았습니다.'); }),
    ]);
    const base = `http://127.0.0.1:${port}`;
    const blocked = await fetch(`${base}/scan`, {method: 'POST', headers: {Origin: 'https://other.example', 'Content-Type': 'application/json'}, body: '{}'});
    assert.equal(blocked.status, 403);
    const preflight = await fetch(`${base}/scan`, {method: 'OPTIONS', headers: {Origin: 'http://localhost:8021', 'Access-Control-Request-Private-Network': 'true'}});
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:8021');
    const invalid = await fetch(`${base}/scan`, {method: 'POST', headers: {Origin: 'http://localhost:8021', 'Content-Type': 'application/json'}, body: JSON.stringify({sites: ['youtube'], token: 'bad'})});
    assert.equal(invalid.status, 503);
    assert.match((await invalid.json()).error, /다시 로그인/);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
  }
});
