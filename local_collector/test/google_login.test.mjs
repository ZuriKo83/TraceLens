import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runGoogleLogin, runNormalLogin, selectInstalledBrowser} from '../google_login.mjs';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('Windows picks installed Edge before Chrome and falls back to Chrome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracelens-browsers-'));
  const env = {'ProgramFiles(x86)': root};
  try {
    await mkdir(join(root, 'Google', 'Chrome', 'Application'), {recursive: true});
    const {writeFile} = await import('node:fs/promises');
    await writeFile(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), '');
    assert.equal(selectInstalledBrowser(env, 'win32'), 'chrome');
    await mkdir(join(root, 'Microsoft', 'Edge', 'Application'), {recursive: true});
    await writeFile(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), '');
    assert.equal(selectInstalledBrowser(env, 'win32'), 'edge');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('regular Google login launches the saved profile without debugging switches', async () => {
  let invocation;
  const launch = (executable, args, options) => {
    invocation = {executable, args, options};
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  await runGoogleLogin('edge', 'C:\\collector profile', {launch, executable: 'msedge.exe'});
  assert.equal(invocation.executable, 'msedge.exe');
  assert.deepEqual(invocation.args, ['--user-data-dir=C:\\collector profile', '--new-window',
    'https://myactivity.google.com/page?page=youtube_comments']);
  assert.equal(invocation.args.some(arg => arg.startsWith('--remote-debugging')), false);
});

test('X sign-in uses the same saved profile and a fixed login address', async () => {
  let args;
  const launch = (_executable, values) => {
    args = values;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  await runNormalLogin('edge', 'C:\\collector profile', 'x', {launch, executable: 'msedge.exe'});
  assert.deepEqual(args, ['--user-data-dir=C:\\collector profile', '--new-window', 'https://x.com/i/flow/login']);
  await assert.rejects(runNormalLogin('edge', 'C:\\collector profile', 'example', {launch, executable: 'msedge.exe'}), /지원하지 않는/);
});
