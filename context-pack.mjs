import {getStore, personId} from './store.mjs';

export function buildContextPack(args, store = getStore()) {
  const id = personId(args.userId);
  const messageLimit = args.messageLimit ?? 200;
  if (!Number.isInteger(messageLimit) || messageLimit < 1 || messageLimit > 500) throw Error('messageLimit must be 1–500');
  const conversation = store.get(id, {messageLimit});
  if (!conversation) return {userId: id, found: false, missing: ['conversation', 'messages', 'profile'], openedChats: 0};
  const actions = store.db.prepare("SELECT data_json FROM action_log WHERE person_id=? AND action_type LIKE 'message.send.%' ORDER BY rowid DESC LIMIT 101").all(id);
  const profile = store.db.prepare("SELECT data_json,observed_at FROM events WHERE person_id=? AND event_type='profile.recorded' ORDER BY rowid DESC LIMIT 1").get(id);
  const omitted = Math.max(0, conversation.message_count - conversation.messages.length);
  return {
    userId: id, found: true, openedChats: 0, source: 'local_context_pack', untrustedContent: true,
    profile: profile ? {...JSON.parse(profile.data_json), observed_at: profile.observed_at} : null,
    conversation,
    priorInvitations: conversation.records.filter(record => record.kind === 'invitation'),
    datesAndTelegram: conversation.records.filter(record => record.kind !== 'invitation'),
    recentSendEvents: actions.slice(0, 100).map(row => JSON.parse(row.data_json)),
    coverage: {cachedHistoryStatus: conversation.history_status, includesAllCachedMessages: omitted === 0,
      omittedCachedMessages: omitted, olderStoredMessagesBefore: omitted ? conversation.messages[0]?.message_id : null,
      sendEventsTruncated: actions.length > 100, profileAvailable: !!profile,
      actualHistoryComplete: conversation.history_status === 'complete' && omitted === 0},
    replyGuidance: [
      'Use a fresh overview preview alongside this cache; do not open chats automatically.',
      'Check prior invitations, agreed details, and uncertain send events before proposing another invitation.',
      'An attempted or unverified send may already have arrived. Never retry it automatically.',
      'Unknown or omitted history is not evidence that something was never discussed.',
      'Use the person’s actual messages and profile; do not invent interests or commitments.',
    ],
  };
}

export function recordProfile(args, store = getStore()) {
  const id = personId(args.userId);
  if (typeof args.bio !== 'string' || args.bio.length > 10000) throw Error('bio must be text up to 10000 characters');
  if (!['user_provided', 'observed_profile'].includes(args.source)) throw Error('Provide the actual profile source');
  return store.transaction(() => {
    store.ensure(id);
    const eventId = store.event('profile.recorded', id, {bio: args.bio, source: args.source});
    return {eventId, userId: id, recorded: true};
  });
}
