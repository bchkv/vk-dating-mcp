import {getStore, personId} from './store.mjs';

function oneDraft(args, store) {
  personId(args.userId);
  if (typeof args.expectedName !== 'string' || !args.expectedName.trim() || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 1000) {
    throw Error('Provide expectedName and 1–1000 characters of message text');
  }
  const cached = store.get(args.userId, {messageLimit: 0});
  if (cached?.display_name && cached.display_name !== args.expectedName.trim()) throw Error('Cached recipient name does not match expectedName');
  return {dryRun: true, userId: args.userId, expectedName: args.expectedName, text: args.text,
    recipientValidation: cached?.display_name ? 'cached_name_only' : 'unchecked', liveRecipientVerified: false,
    openedChats: 0, note: 'Local draft only. No chat was opened or message sent. Explicit execution verifies the recipient in VK before sending.'};
}
export function previewMessages(name, args, store = getStore()) {
  if (name === 'vk_send_message') return oneDraft(args, store);
  return {dryRun: true, messages: args.messages.map(message => ({...oneDraft(message, store), requestId: message.requestId})), openedChats: 0};
}
