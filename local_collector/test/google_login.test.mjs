import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runGoogleLogin, selectInstalledBrowser} from '../google_login.mjs';
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
