import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionSaver} from '../session.mjs';

test('session persistence writes only changed session cookies and retries failed writes', async () => {
  let cookies = [{name: 'login', value: 'a', expires: -1}, {name: 'persistent', value: 'a', expires: 999}];
  const writes = [];
  let fail = false;
  const save = createSessionSaver({cookies: async () => cookies}, 'session.json', {
    write: async (_path, content) => {
      if (fail) throw Error('disk failure');
      writes.push(JSON.parse(content));
    },
  });
  await save();
  await save();
  cookies[1].value = 'b';
  await save();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], [cookies[0]]);
  cookies[0].value = 'b';
  fail = true;
  await assert.rejects(save(), /disk failure/);
  fail = false;
  await save();
  assert.equal(writes.length, 2);
  assert.equal(writes[1][0].value, 'b');
  cookies = [];
  await save();
  assert.deepEqual(writes[2], []);
});

test('overlapping session checkpoints share one read and write', async () => {
  let release;
  let reads = 0;
  let writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const save = createSessionSaver({cookies: async () => { reads++; await gate; return []; }}, 'session.json', {
    write: async () => { writes++; },
  });
  const first = save();
  const second = save();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
});

test('atomic session files can be restored after a cookie change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tracelens-session-'));
  try {
    const path = join(directory, 'session.json');
    const cookie = {name: 'login', value: 'a', expires: -1};
    const save = createSessionSaver({cookies: async () => [cookie]}, path);
    await save();
    cookie.value = 'b';
    await save();
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [cookie]);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
