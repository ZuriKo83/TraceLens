import test from 'node:test';
import assert from 'node:assert/strict';
import {deleteYouTubeComments} from '../youtube_delete.mjs';
import {createController} from '../controller.mjs';

function fixture({clicked = ['1'], found = [], complete = true, syncError = false} = {}) {
  const requests = [];
  let closed = 0;
  const collector = {
    tabs: {create: async () => ({id: 5}), update: async () => {}, remove: async () => {closed++;}},
    processYouTubePage: async (_tab, _targets, options) => options ? {clickedIds: clicked} : {foundIds: found, complete},
  };
  const transport = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({url, body});
    if (url.endsWith('delete-targets')) return {ok: true, json: async () => ({ok: true,
      targets: body.activity_ids.map(id => ({id: String(id), commentId: `comment-${id}`, strictMatch: true})), receipt: 'signed'})};
    if (syncError) throw Error('offline');
    return {ok: true, json: async () => ({ok: true, removed_ids: body.activity_ids})};
  };
  return {collector, transport, requests, closed: () => closed};
}

test('only clicked and absent targets are reconciled; unmatched rows remain', async () => {
  const f = fixture({clicked: ['1', '2'], found: ['2']});
  const result = await deleteYouTubeComments(f.collector, f.transport, 'token', [1, 2, 3]);
  assert.deepEqual(result.deleted_ids, [1]);
  assert.deepEqual(result.failed, [2, 3]);
  assert.deepEqual(f.requests[1].body.activity_ids, [1]);
  assert.equal(f.requests[1].body.verification_complete, true);
  assert.equal(f.closed(), 1);
});

test('a complete empty history without a successful click never removes saved rows', async () => {
  const f = fixture({clicked: []});
  const result = await deleteYouTubeComments(f.collector, f.transport, 'token', [1]);
  assert.deepEqual(result.deleted_ids, []);
  assert.equal(f.requests.length, 1);
  assert.equal(f.closed(), 1);
});

test('incomplete verification cannot claim deletion or reconcile the database', async () => {
  const f = fixture({complete: false});
  const result = await deleteYouTubeComments(f.collector, f.transport, 'token', [1]);
  assert.deepEqual(result.deleted_ids, []);
  assert.equal(f.requests.length, 1);
});

test('successful site deletion remains explicit when server synchronization fails', async () => {
  const f = fixture({syncError: true});
  const result = await deleteYouTubeComments(f.collector, f.transport, 'token', [1]);
  assert.equal(result.sync_pending, true);
  assert.deepEqual(result.deleted_ids, [1]);
  assert.deepEqual(result.removed_ids, []);
  assert.equal(f.closed(), 1);
});

test('invalid selections cannot contact the server or open a browser', async () => {
  const f = fixture();
  for (const ids of [[], [0], ['1'], Array(101).fill(1)]) {
    await assert.rejects(deleteYouTubeComments(f.collector, f.transport, 'token', ids));
  }
  assert.equal(f.requests.length, 0);
});

test('deletion rejects commands from other pages and shares the collection lock', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const page = {mainFrame: () => frame};
  const frame = {url: () => 'http://localhost:8021/app'};
  const source = {page, frame};
  const control = createController({}, {scan: async () => {await gate; return {lines: []};}}, {transport: async () => ({ok: true})});
  const token = 'a'.repeat(40);
  const scan = control(source, {type: 'START_SCAN', sites: ['youtube'], token});
  await assert.rejects(control(source, {type: 'DELETE_YOUTUBE', activityIds: [1], token}), /진행 중/);
  await assert.rejects(control({...source, frame: {url: () => 'https://x.com/'}}, {type: 'DELETE_YOUTUBE', activityIds: [1], token}));
  release();
  await scan;
});
