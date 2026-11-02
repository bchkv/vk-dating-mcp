import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConversationStore} from '../store.mjs';
import {previewMessages} from '../drafts.mjs';
import {callTool} from '../mcp-tools.mjs';

test('single and batch previews prepare drafts entirely locally, with no browser start', async () => {
  const session = {start() {throw Error('must not launch browser');}, frame() {throw Error('must not open chats');}};
  const message = {userId: '987654', expectedName: 'Synthetic', text: 'A draft', requestId: 'draft-only'};
  const single = await callTool(session, 'vk_send_message', message);
  assert.equal(single.openedChats, 0);
  assert.equal(single.liveRecipientVerified, false);
  assert.equal(single.dryRun, true);
  const batch = await callTool(session, 'vk_send_messages', {messages: [message]});
  assert.equal(batch.openedChats, 0);
  assert.equal(batch.messages[0].text, 'A draft');
});

test('a locally known name mismatch and invalid draft text are rejected', () => {
  const store = new ConversationStore(':memory:');
  try {
    store.observePreview({userId: '42', name: 'Test', previewText: 'A reply'});
    assert.throws(() => previewMessages('vk_send_message', {userId: '42', expectedName: 'Other', text: 'Draft'}, store), /name/);
    assert.throws(() => previewMessages('vk_send_message', {userId: '42', expectedName: 'Test', text: ' '.repeat(3)}, store), /characters/);
    const draft = previewMessages('vk_send_message', {userId: '42', expectedName: 'Test', text: 'Draft'}, store);
    assert.equal(draft.recipientValidation, 'cached_name_only');
    assert.equal(store.stats().messages, 0);
  } finally { store.close(); }
});
