import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runGoogleLogin} from '../google_login.mjs';

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
