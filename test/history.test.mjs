import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectHistory, historyOptions} from '../history.mjs';
import {getConversations, validateBatch} from '../conversations.mjs';
import {validate} from '../mcp-tools.mjs';

const row = (id, text = id) => ({messageId: id, outgoing: false, text});
const state = (ids, extra = {}) => ({messages: ids.map(id => row(id)), loading: false, loadError: false, empty: false, beginningReached: false, draftPresent: false, ...extra});
function fixture(initial, older = []) {
  let clock = 0, phase = -1, scrollAt = 0;
  const port = {
    now: () => clock,
    sleep: async ms => { clock += ms; },
    snapshot: async () => {
      const value = phase < 0 ? initial : older[phase];
      return typeof value === 'function' ? value(clock - scrollAt, clock) : value;
    },
    scrollOlder: async () => {
      if (phase + 1 >= older.length) return {scrolled: false, reason: 'no_scroll_container'};
      phase++; scrollAt = clock;
      return {scrolled: true};
    },
  };
  return {port, clock: () => clock};
}

test('waits through delayed first messages and loader disappearance', async () => {
  const f = fixture((_elapsed, now) => now < 900 ? state([], {loading: true}) : state(['a', 'b']));
  const result = await collectHistory(f.port, {maxScrolls: 0});
  assert.ok(f.clock() >= 1400);
  assert.equal(result.ready, true);
  assert.deepEqual(result.messages.map(m => m.messageId), ['a', 'b']);
});

test('does not mistake a blank panel or perpetual loader for an empty history', async () => {
  for (const initial of [state([]), state(['a'], {loading: true})]) {
    await assert.rejects(collectHistory(fixture(initial).port, {timeoutMs: 1000}), /did not finish loading/);
  }
});

test('visible retry fails instead of returning a ready conversation', async () => {
  await assert.rejects(collectHistory(fixture(state(['a'], {loadError: true})).port), /loading failed/);
});

test('hidden loader state is ready and draft presence is preserved', async () => {
  const result = await collectHistory(fixture(state(['a'], {draftPresent: true})).port, {maxScrolls: 0});
  assert.equal(result.draftPresent, true);
  assert.equal(result.loading, false);
});

test('only explicit empty/beginning evidence establishes no more history', async () => {
  const empty = await collectHistory(fixture(state([], {empty: true, beginningReached: true})).port);
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.history.hasMore, false);
  assert.equal(empty.history.nextBeforeMessageId, null);
  const unknown = await collectHistory(fixture(state(['a'])).port);
  assert.equal(unknown.history.hasMore, null);
  assert.equal(unknown.history.complete, false);
});

test('paginates past a delayed spinner, deduplicates overlapping IDs, and updates edits', async () => {
  const f = fixture(state(['c', 'd']), [elapsed => elapsed < 1000
    ? state(['c', 'd'], {loading: elapsed >= 200})
    : state(['a', 'b', 'c'], {messages: [row('a'), row('b'), row('c', 'edited')]})]);
  const result = await collectHistory(f.port, {messageLimit: 3});
  assert.deepEqual(result.messages.map(m => m.messageId), ['b', 'c', 'd']);
  assert.equal(result.messages[1].text, 'edited');
  assert.equal(result.history.hasMore, true);
  assert.equal(result.history.nextBeforeMessageId, 'b');
  assert.equal(result.history.scrolls, 1);
});

test('exclusive cursor finds older pages even across disjoint virtualized snapshots', async () => {
  const f = fixture(state(['e', 'f']), [state(['c', 'd']), state(['a', 'b'], {beginningReached: true})]);
  const result = await collectHistory(f.port, {messageLimit: 2, beforeMessageId: 'c'});
  assert.deepEqual(result.messages.map(m => m.messageId), ['a', 'b']);
  assert.equal(result.history.hasMore, false);
  assert.equal(result.history.status, 'beginning_reached');
});

test('lookahead indicates more even when the underlying beginning has been reached', async () => {
  const result = await collectHistory(fixture(state(['a', 'b', 'c'], {beginningReached: true})).port, {messageLimit: 2});
  assert.deepEqual(result.messages.map(m => m.messageId), ['b', 'c']);
  assert.equal(result.history.hasMore, true);
});

test('no-growth scroll is unknown, never an inferred end', async () => {
  const f = fixture(state(['a']), [state(['a'])]);
  const result = await collectHistory(f.port);
  assert.equal(result.history.hasMore, null);
  assert.equal(result.history.stopReason, 'no_progress');
  assert.ok(f.clock() >= 2100);
});

test('stuck older loader returns marked partial data; recent messages remain available', async () => {
  const result = await collectHistory(fixture(state(['c', 'd']), [state(['c', 'd'], {loading: true})]).port, {timeoutMs: 2000});
  assert.deepEqual(result.messages.map(m => m.messageId), ['c', 'd']);
  assert.equal(result.ready, false);
  assert.equal(result.loading, true);
  assert.equal(result.history.hasMore, null);
  assert.equal(result.history.stopReason, 'timeout');
});

test('limits and cursor failures are explicit; IDs are never numerically ordered', async () => {
  const result = await collectHistory(fixture(state(['z', 'a', 'm'])).port, {messageLimit: 2, maxScrolls: 0});
  assert.deepEqual(result.messages.map(m => m.messageId), ['a', 'm']);
  assert.equal(result.history.hasMore, true);
  await assert.rejects(collectHistory(fixture(state(['z'])).port, {beforeMessageId: 'missing', maxScrolls: 0}), /cursor was not found/);
});

test('validates resource budgets and prevents sharing one cursor among several recipients', () => {
  for (const invalid of [{messageLimit: 0}, {messageLimit: 501}, {messageLimit: 1.5}, {maxScrolls: -1}, {maxScrolls: Infinity}, {timeoutMs: 999}, {timeoutMs: 60001}, {beforeMessageId: ''}, {beforeMessageId: ' '.repeat(2)}]) {
    assert.throws(() => historyOptions(invalid));
    assert.throws(() => validate('vk_get_conversations', {userIds: ['42'], ...invalid}));
  }
  assert.throws(() => validateBatch('vk_get_conversations', {userIds: ['42', '43'], beforeMessageId: 'a'}), /exactly one/);
  validate('vk_get_conversations', {userIds: ['42'], messageLimit: 100, maxScrolls: 5, timeoutMs: 30000, beforeMessageId: 'opaque.id'});
});

test('batch reader forwards pagination options and stops before the next chat on load failure', async () => {
  const calls = [];
  const read = async (_frame, userId, options) => { calls.push({userId, options}); throw Error('loading failed'); };
  const result = await getConversations(null, {userIds: ['42', '43'], messageLimit: 80, maxScrolls: 3}, read);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.messageLimit, 80);
  assert.equal(result.stoppedAt, '42');
});
