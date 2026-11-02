import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, lstatSync, symlinkSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationStore} from '../store.mjs';
import {callTrackingTool} from '../tracking-tools.mjs';
import {callTool, validate, toolDefinitions} from '../mcp-tools.mjs';

const observedAt = '2026-11-02T10:00:00.000Z';
const firstTime = '2026-10-01T12:00:00.000Z';
const replyTime = '2026-10-01T13:00:00.000Z';
const message = (id, outgoing, text, sentAt = null) => ({messageId: id, outgoing, text, sentAt});
function conversation(messages, {hasMore = false, loading = false, ready = true} = {}) {
  return {userId: '42', name: 'Test', messages, loading, ready,
    history: {hasMore, oldestMessageId: messages[0]?.messageId ?? null, newestMessageId: messages.at(-1)?.messageId ?? null}};
}
function fixture() { return new ConversationStore(':memory:', {now: () => observedAt}); }

test('newly discovered old matches preserve actual vs observation time and deduplicate first sight', () => {
  const store = fixture();
  try {
    store.observeMatch('42', {matchedAt: firstTime});
    store.observeMatch('42');
    const match = store.get('42').match;
    assert.equal(match.matched_at, firstTime);
    assert.equal(match.first_seen_at, observedAt);
    assert.equal(store.events().filter(e => e.event_type === 'match.observed').length, 1);
    store.observeMatch('43');
    assert.equal(store.get('43').match.matched_at, null);
  } finally { store.close(); }
});

test('verified messages deduplicate; edited text retains old content without invented edit time', () => {
  const store = fixture();
  try {
    const initial = conversation([message('a', true, 'Original', firstTime), message('b', false, 'Reply', replyTime)]);
    store.observeConversation(initial); store.observeConversation(initial);
    assert.equal(store.stats().messages, 2);
    store.observeConversation(conversation([message('a', true, 'Edited', firstTime), message('b', false, 'Reply', replyTime)]));
    const edited = store.get('42').messages[0];
    assert.equal(edited.text, 'Edited');
    assert.equal(edited.edited_at, null);
    assert.equal(edited.first_seen_at, observedAt);
    assert.equal(edited.sent_at, firstTime);
    const event = store.events().find(e => e.event_type === 'message.changed');
    assert.equal(event.data.previous.text, 'Original');
    assert.equal(event.occurred_at, null);
  } finally { store.close(); }
});

test('previews are a separate observation stream, even with one unread; they never count as messages', () => {
  const store = fixture();
  try {
    const preview = {userId: '42', name: 'Test', previewText: 'A possibly truncated reply', unreadCount: 1, displayTime: 'Yesterday'};
    const first = store.observePreview(preview);
    const again = store.observePreview({...preview, displayTime: 'Two days ago'});
    assert.equal(first.singleUnreadCandidate, true);
    assert.equal(first.canUseAsVerifiedMessage, false);
    assert.equal(again.previewChanged, false);
    assert.equal(store.stats().messages, 0);
    assert.equal(store.events().filter(e => e.event_type === 'preview.observed').length, 1);
    assert.equal(store.get('42').state.waiting_on, 'neither');
  } finally { store.close(); }
});

test('complete history requires a connected chain of pages from the newest messages', () => {
  const store = fixture();
  try {
    store.observeConversation(conversation([message('c', false, 'c'), message('d', false, 'd')], {hasMore: true}));
    assert.equal(store.get('42').history_status, 'partial');
    store.observeConversation(conversation([message('a', true, 'a'), message('b', false, 'b')]), {beforeMessageId: 'c'});
    const cached = store.get('42');
    assert.deepEqual(cached.messages.map(m => m.message_id), ['a', 'b', 'c', 'd']);
    assert.equal(cached.history_status, 'complete');
    const older = store.get('42', {beforeMessageId: 'c', messageLimit: 1});
    assert.equal(older.messages[0].message_id, 'b');
    assert.equal(older.has_more_stored, true);
  } finally { store.close(); }
});

test('an oldest page in isolation or an unknown boundary never implies complete history', () => {
  const store = fixture();
  try {
    store.observeConversation(conversation([message('a', true, 'a')]), {beforeMessageId: 'b'});
    assert.equal(store.get('42').history_status, 'partial');
    store.observeConversation(conversation([message('c', false, 'c')], {hasMore: null}));
    assert.equal(store.get('42').history_status, 'partial');
    store.markLoading('42', 'Test');
    assert.equal(store.get('42').history_status, 'loading');
    assert.equal(store.stats().observed_reply_rate, null);
  } finally { store.close(); }
});

test('older pages cannot reverse who is waiting; manual corrections survive automatic refresh', () => {
  const store = fixture();
  try {
    store.observeConversation(conversation([message('c', false, 'Question')], {hasMore: true}));
    assert.equal(store.get('42').state.waiting_on, 'me');
    store.observeConversation(conversation([message('a', true, 'Old invitation')]), {beforeMessageId: 'c'});
    assert.equal(store.get('42').state.waiting_on, 'me');
    store.updateState({userId: '42', values: {waiting_on: 'neither', inactive_reason: 'my_choice', stage: 'inactive'}, manual: true, confidence: 1});
    store.observeConversation(conversation([message('c', false, 'Question')]));
    assert.equal(store.get('42').state.waiting_on, 'neither');
    assert.equal(store.get('42').state.stage, 'inactive');
  } finally { store.close(); }
});

test('classifications require real source evidence and retain source/confidence across corrections', () => {
  const store = fixture();
  try {
    assert.throws(() => store.updateState({userId: '42', values: {stage: 'chatting'}, confidence: 0.8}), /sourceMessageId/);
    store.observeConversation(conversation([message('a', false, 'Maybe next week')]));
    const base = {userId: '42', sourceMessageId: 'a', confidence: 0.6};
    store.updateState({...base, values: {invitation_response: 'unclear'}});
    store.updateState({...base, values: {invitation_response: 'alternative_proposed'}, confidence: 1, manual: true});
    assert.equal(store.get('42').field_evidence.invitation_response.source_message_id, 'a');
    assert.equal(store.events().filter(e => e.event_type === 'conversation.classified').length, 2);
    assert.equal(store.get('42').state.stage, 'chatting');
    assert.throws(() => store.updateState({...base, confidence: 2, values: {stage: 'date_confirmed'}}));
    assert.throws(() => store.updateState({...base, sourceMessageId: 'missing', values: {stage: 'chatting'}}));
    assert.throws(() => store.updateState({...base, values: {password: 'not permitted'}}));
  } finally { store.close(); }
});

test('invitation, Telegram and date records project current state with explicit evidence', () => {
  const store = fixture();
  try {
    store.observeConversation(conversation([message('a', true, 'Coffee?', firstTime), message('b', false, 'A tentative answer', replyTime)]));
    const base = {userId: '42', sourceMessageId: 'a', confidence: 1};
    store.record({...base, kind: 'invitation', recordId: 'invite-1', values: {wording_variant: 'coffee-v1', timezone: 'Europe/Moscow', response_category: 'pending'}});
    store.record({...base, sourceMessageId: 'b', kind: 'invitation', recordId: 'invite-1', values: {response_category: 'alternative_proposed'}});
    store.record({...base, kind: 'telegram_exchange', recordId: 'telegram-me', values: {handle: '@example_me', shared_by: 'me'}});
    store.record({...base, sourceMessageId: 'b', kind: 'telegram_exchange', recordId: 'telegram-them', values: {handle: '@example_them', shared_by: 'them'}});
    store.record({...base, kind: 'date', recordId: 'date-1', values: {agreed_day: '2026-11-10', agreed_time: '19:00', confirmation_status: 'tentative'}});
    assert.equal(store.get('42').state.stage, 'invited');
    store.record({...base, sourceMessageId: 'b', kind: 'date', recordId: 'date-1', values: {confirmation_status: 'confirmed'}});
    const data = store.get('42');
    assert.equal(data.state.stage, 'date_confirmed');
    assert.equal(data.state.telegram_status, 'both_shared');
    assert.equal(data.state.invitation_response, 'alternative_proposed');
    assert.equal(data.records.find(r => r.kind === 'invitation').values.message_id, 'a');
    assert.equal(data.records.find(r => r.kind === 'telegram_exchange').occurred_at, null);
  } finally { store.close(); }
});

test('manual record corrections cannot be overwritten by subsequent inferred updates', () => {
  const store = fixture();
  try {
    store.observeConversation(conversation([message('a', false, 'Reply')]));
    const args = {userId: '42', sourceMessageId: 'a', confidence: 1, kind: 'date', recordId: 'one'};
    store.record({...args, manual: true, values: {confirmation_status: 'tentative'}});
    assert.throws(() => store.record({...args, values: {confirmation_status: 'confirmed'}}), /manual/);
    assert.equal(store.get('42').state.stage, 'chatting');
  } finally { store.close(); }
});

test('statistics exclude previews, incomplete histories and unknown actual timestamps', () => {
  const store = fixture();
  try {
    store.observeConversation(conversation([message('a', true, 'Coffee?', firstTime), message('b', false, 'Yes', replyTime)]));
    store.record({userId: '42', kind: 'invitation', recordId: 'one', values: {message_id: 'a'}, sourceMessageId: 'a', confidence: 1});
    let stats = store.stats();
    assert.equal(stats.eligible_invitations, 1);
    assert.equal(stats.responses_observed, 1);
    assert.equal(stats.average_response_ms, 3600000);
    store.observePreview({userId: '42', previewText: 'A new unverified preview', unreadCount: 1});
    stats = store.stats();
    assert.equal(stats.eligible_invitations, 0);
    assert.equal(stats.observed_reply_rate, null);
    assert.equal(stats.messages, 2);
    store.observeConversation(conversation([message('a', true, 'Coffee?'), message('b', false, 'Yes')]));
    // A missing refreshed timestamp does not erase previously observed actual time.
    assert.equal(store.get('42').messages[0].sent_at, firstTime);
  } finally { store.close(); }
});

test('unknown timestamps stay null rather than acquiring first_seen time', () => {
  const store = fixture();
  try {
    store.observeConversation(conversation([message('a', true, 'Coffee?'), message('b', false, 'Yes')]));
    const record = {userId: '42', kind: 'invitation', recordId: 'one', sourceMessageId: 'a', confidence: 1};
    assert.throws(() => store.record({...record, values: {}}), /nonempty/);
    store.record({...record, values: {message_id: 'a'}});
    assert.equal(store.get('42').messages[0].sent_at, null);
    assert.equal(store.stats().average_response_ms, null);
  } finally { store.close(); }
});

test('tracking is durable, privately permissioned, and refuses symlink destinations', () => {
  const root = mkdtempSync(join(tmpdir(), 'vk-store-test-'));
  const path = join(root, 'private', 'state.sqlite');
  try {
    let store = new ConversationStore(path);
    store.observeMatch('42'); store.close();
    store = new ConversationStore(path);
    assert.equal(store.get('42').person_id, '42'); store.close();
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(root, 'private')).mode & 0o777, 0o700);
    const target = join(root, 'outside'); writeFileSync(target, 'untouched');
    const link = join(root, 'linked.sqlite'); symlinkSync(target, link);
    assert.throws(() => new ConversationStore(link));
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('action log retains correlation and outcome; stats are computed, not stored percentages', () => {
  const store = fixture();
  try {
    store.recordAction({event: 'message.send.attempted', timestamp: observedAt, userId: '42', requestKey: 'hashed-key', operationId: 'op-1', outcome: 'attempted'});
    store.recordAction({event: 'message.send.result', timestamp: observedAt, userId: '42', requestKey: 'hashed-key', operationId: 'op-1', outcome: 'unverified'});
    assert.equal(store.stats().actions, 2);
    assert.equal(store.events({userId: '42'})[0].data.outcome, 'unverified');
    assert.equal(store.stats().observed_reply_rate, null);
  } finally { store.close(); }
});

test('local reads need no browser and state edits do not pretend a VK refresh occurred', async () => {
  const store = fixture();
  try {
    const names = ['vk_get_tracking', 'vk_get_cached_conversation', 'vk_record_tracking', 'vk_update_conversation', 'vk_tracking_events', 'vk_tracking_stats', 'vk_clear_tracking', 'vk_sync_overview'];
    for (const name of names) assert.ok(toolDefinitions.some(tool => tool.name === name));
    const update = {userId: '42', values: {stage: 'inactive', inactive_reason: 'my_choice'}, manual: true, confidence: 1};
    validate('vk_update_conversation', update);
    callTrackingTool('vk_update_conversation', update, store);
    assert.equal(store.get('42').last_checked_at, null);
    assert.equal(store.get('42').last_messages_checked_at, null);
    assert.equal(callTrackingTool('vk_get_tracking', {stage: 'inactive'}, store).conversations.length, 1);
    const result = await callTool({start() {throw Error('must not launch browser');}}, 'vk_get_tracking', {userIds: ['999999']});
    assert.deepEqual(result.conversations, []);
  } finally { store.close(); }
});

test('clearing is a preview by default and cascades selected records without removing other people', () => {
  const store = fixture();
  try {
    store.observeConversation(conversation([message('a', false, 'private fixture')]));
    store.observeMatch('43');
    assert.equal(store.clear({userIds: ['42']}).dryRun, true);
    assert.ok(store.get('42'));
    store.clear({userIds: ['42'], execute: true});
    assert.equal(store.get('42'), null);
    assert.ok(store.get('43'));
    assert.equal(store.events({userId: '42'}).length, 0);
    store.clear({execute: true});
    assert.equal(store.stats().conversations, 0);
  } finally { store.close(); }
});

test('one reply is not double attributed to two sequential invitations', () => {
  const store = fixture();
  try {
    store.observeConversation(conversation([
      message('a', true, 'First invitation', firstTime),
      message('b', true, 'Second invitation', '2026-10-01T12:30:00.000Z'),
      message('c', false, 'Response', replyTime),
    ]));
    for (const id of ['a', 'b']) store.record({userId: '42', kind: 'invitation', recordId: id, values: {message_id: id}, sourceMessageId: id, confidence: 1});
    const stats = store.stats();
    assert.equal(stats.eligible_invitations, 2);
    assert.equal(stats.responses_observed, 1);
    assert.equal(stats.average_response_ms, 1800000);
    assert.throws(() => store.record({userId: '42', kind: 'invitation', recordId: 'duplicate', values: {message_id: 'a'}, sourceMessageId: 'a', confidence: 1}), /already has a record/);
  } finally { store.close(); }
});

test('a rejected patch rolls back events and leaves current records unchanged', () => {
  const store = fixture();
  try {
    store.observeConversation(conversation([message('a', true, 'Invitation')]));
    const args = {userId: '42', sourceMessageId: 'a', confidence: 1, kind: 'invitation', recordId: 'one'};
    store.record({...args, values: {message_id: 'a'}});
    const before = store.events().length;
    assert.throws(() => store.record({...args, values: {message_id: 'missing'}}), /stored message/);
    assert.equal(store.events().length, before);
    assert.equal(store.get('42').records[0].values.message_id, 'a');
    assert.throws(() => store.updateState({...args, values: {next_action_due_at: 'Friday'}}), /ISO/);
  } finally { store.close(); }
});

test('preview evidence can classify a conversation without opening or fabricating a verified message', () => {
  const store = fixture();
  try {
    const preview = store.observePreview({userId: '42', previewText: 'Maybe next week', unreadCount: 1});
    store.updateState({userId: '42', values: {invitation_response: 'alternative_proposed', next_action: 'offer_time'}, sourcePreviewEventId: preview.previewEventId, confidence: 0.8});
    assert.equal(store.stats().messages, 0);
    assert.equal(store.get('42').field_evidence.next_action.source_preview_event_id, preview.previewEventId);
    assert.equal(store.get('42').state.stage, 'new_match');
    assert.equal(store.observePreview({userId: '42', previewText: 'Maybe next week', unreadCount: 1}).previewEventId, preview.previewEventId);
    assert.throws(() => store.updateState({userId: '43', values: {stage: 'chatting'}, sourcePreviewEventId: preview.previewEventId, confidence: 0.9}), /not stored for this person/);
    const event = store.events().find(e => e.event_type === 'conversation.classified');
    assert.equal(event.data.source_preview_event_id, preview.previewEventId);
  } finally { store.close(); }
});
