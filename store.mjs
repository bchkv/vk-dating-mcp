import {DatabaseSync} from 'node:sqlite';
import {randomUUID, createHash} from 'node:crypto';
import {mkdirSync, lstatSync, openSync, closeSync, chmodSync, constants} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const stages = ['new_match', 'chatting', 'invited', 'scheduling', 'date_confirmed', 'inactive'];
const responses = ['pending', 'accepted', 'alternative_proposed', 'chat_first', 'declined', 'unclear'];
const outcomes = ['pending', 'attended', 'cancelled_by_me', 'cancelled_by_them', 'no_show_me', 'no_show_them'];
export const stateEnums = {
  stage: stages, invitation_response: responses, waiting_on: ['me', 'them', 'neither'],
  telegram_status: ['not_exchanged', 'mine_shared', 'theirs_shared', 'both_shared'],
  next_action: ['reply', 'offer_time', 'confirm_details', 'follow_up', 'none'],
  inactive_reason: ['declined', 'no_response', 'incompatible', 'my_choice', 'no_longer_visible'], date_outcome: outcomes,
};
const defaults = {stage: 'new_match', invitation_response: 'pending', waiting_on: 'neither', telegram_status: 'not_exchanged', next_action: 'none', next_action_due_at: null, inactive_reason: null, date_outcome: 'pending'};
const recordFields = {
  invitation: ['message_id', 'proposed_day', 'proposed_time', 'timezone', 'location', 'wording_variant', 'response_category'],
  telegram_exchange: ['handle', 'shared_by', 'exchanged_at'],
  date: ['agreed_day', 'agreed_time', 'timezone', 'location', 'confirmation_status', 'outcome'],
};
export function personId(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw Error('userId must be numeric');
  return value;
}
function text(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`Invalid ${label}`);
  return value;
}
export function timestamp(value, label = 'timestamp') {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw Error(`${label} must be an ISO timestamp with a timezone or null`);
  }
  return new Date(value).toISOString();
}
const json = value => JSON.stringify(value);
const decode = value => JSON.parse(value);
const same = (a, b) => json(a) === json(b);
const hash = value => createHash('sha256').update(json(value)).digest('hex');

export class ConversationStore {
  constructor(path, {now = () => new Date().toISOString()} = {}) {
    this.now = now;
    this.path = path;
    if (path !== ':memory:') {
      path = resolve(path); this.path = path;
      mkdirSync(dirname(path), {recursive: true, mode: 0o700});
      const directory = lstatSync(dirname(path));
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Unsafe database directory');
      // Refuse symlinks before SQLite follows the path; create with private permissions.
      const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      closeSync(fd); chmodSync(path, 0o600);
      for (const suffix of ['-journal', '-wal', '-shm']) {
        try { if (lstatSync(path + suffix).isSymbolicLink()) throw Error('Unsafe database sidecar'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, person_id TEXT, occurred_at TEXT,
        observed_at TEXT NOT NULL, source_message_id TEXT, confidence REAL, manual INTEGER NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_person ON events(person_id, observed_at);
      CREATE TABLE IF NOT EXISTS conversations (
        person_id TEXT PRIMARY KEY, display_name TEXT, first_seen_at TEXT NOT NULL, last_checked_at TEXT,
        history_status TEXT NOT NULL DEFAULT 'partial', state_json TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '{}',
        preview_json TEXT, preview_fingerprint TEXT
      );
      CREATE TABLE IF NOT EXISTS matches (
        person_id TEXT PRIMARY KEY REFERENCES conversations(person_id) ON DELETE CASCADE,
        match_id TEXT, first_seen_at TEXT NOT NULL, matched_at TEXT, last_checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        person_id TEXT NOT NULL REFERENCES conversations(person_id) ON DELETE CASCADE, message_id TEXT NOT NULL,
        direction TEXT NOT NULL, text TEXT, sent_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        edited_at TEXT, reply_to_id TEXT, position INTEGER NOT NULL,
        PRIMARY KEY(person_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS history_pages (
        person_id TEXT NOT NULL REFERENCES conversations(person_id) ON DELETE CASCADE, cursor TEXT NOT NULL,
        oldest_id TEXT, newest_id TEXT, has_more INTEGER, loading INTEGER NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(person_id, cursor)
      );
      CREATE TABLE IF NOT EXISTS records (
        person_id TEXT NOT NULL REFERENCES conversations(person_id) ON DELETE CASCADE, kind TEXT NOT NULL,
        record_id TEXT NOT NULL, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL, occurred_at TEXT,
        source_message_id TEXT, confidence REAL NOT NULL, manual INTEGER NOT NULL, values_json TEXT NOT NULL,
        PRIMARY KEY(person_id, kind, record_id)
      );
      CREATE TABLE IF NOT EXISTS action_log (
        action_id TEXT PRIMARY KEY, person_id TEXT, action_type TEXT NOT NULL, timestamp TEXT NOT NULL,
        request_key TEXT, outcome TEXT, operation_id TEXT, data_json TEXT NOT NULL
      );`);
    const version = this.db.prepare('SELECT version FROM schema_version').get().version;
    if (version > 2) throw Error('Unsupported tracking database version');
    if (!this.db.prepare('PRAGMA table_info(records)').all().some(column => column.name === 'source_event_id')) {
      this.db.exec('ALTER TABLE records ADD COLUMN source_event_id TEXT');
    }
    this.db.prepare('UPDATE schema_version SET version=2').run();
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversation_presence (
      person_id TEXT PRIMARY KEY REFERENCES conversations(person_id) ON DELETE CASCADE,
      status TEXT NOT NULL, missing_scans INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, checked_at TEXT, reason TEXT
    ); CREATE TABLE IF NOT EXISTS overview_scans (scan_id TEXT PRIMARY KEY,observed_at TEXT NOT NULL,complete INTEGER NOT NULL,reason TEXT);`);

  }
  close() { this.db.close(); }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(type, id, data, evidence = {}) {
    const eventId = randomUUID();
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      eventId, type, id, evidence.occurredAt ?? null, this.now(), evidence.sourceMessageId ?? null,
      evidence.confidence ?? null, evidence.manual ? 1 : 0, json({...data, ...(evidence.sourcePreviewEventId ? {source_preview_event_id: evidence.sourcePreviewEventId} : {})}));
    return eventId;
  }
  ensure(id, name = null, checked = false) {
    personId(id);
    const now = this.now();
    this.db.prepare(`INSERT INTO conversations(person_id, display_name, first_seen_at, last_checked_at, state_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET display_name=COALESCE(excluded.display_name, display_name), last_checked_at=COALESCE(excluded.last_checked_at,last_checked_at)`).run(id, name, now, checked ? now : null, json(defaults));
  }
  state(id) {
    const row = this.db.prepare('SELECT * FROM conversations WHERE person_id=?').get(id);
    return row ? {...row, state: decode(row.state_json), evidence: decode(row.evidence_json), preview: row.preview_json ? decode(row.preview_json) : null} : null;
  }
  automatic(id, patch, evidence) {
    const row = this.state(id);
    for (const key of Object.keys(patch)) {
      if (row.evidence[key]?.manual) continue;
      row.state[key] = patch[key]; row.evidence[key] = evidence;
    }
    this.db.prepare('UPDATE conversations SET state_json=?, evidence_json=? WHERE person_id=?').run(json(row.state), json(row.evidence), id);
  }
  availability(id) {
    const row=this.db.prepare('SELECT * FROM conversation_presence WHERE person_id=?').get(id);
    return row?{status:row.status,active:!['not_visible','unmatched_by_me'].includes(row.status),missingScans:row.missing_scans,lastSeenAt:row.last_seen_at,lastCheckedAt:row.checked_at,reason:row.reason}: {status:'unknown',active:true,missingScans:0};
  }
  present(id,source='live_observation') {
    const old=this.availability(id),now=this.now();
    this.db.prepare(`INSERT INTO conversation_presence(person_id,status,missing_scans,last_seen_at,checked_at,reason) VALUES (?,'present',0,?,? ,?)
      ON CONFLICT(person_id) DO UPDATE SET status='present',missing_scans=0,last_seen_at=excluded.last_seen_at,checked_at=excluded.checked_at,reason=excluded.reason`).run(id,now,now,source);
    if(['possibly_missing','not_visible','unmatched_by_me'].includes(old.status))this.event('conversation.reappeared',id,{previous:old.status,source});
  }
  markUnmatched(id) {
    personId(id);
    return this.transaction(()=>{
      this.ensure(id);
      this.db.prepare(`INSERT INTO conversation_presence(person_id,status,missing_scans,checked_at,reason) VALUES (?,'unmatched_by_me',0,?,'plugin_unmatch_verified_in_view')
       ON CONFLICT(person_id) DO UPDATE SET status='unmatched_by_me',checked_at=excluded.checked_at,reason=excluded.reason`).run(id,this.now());
      return this.availability(id);
    });
  }
  reconcileOverview(ids,{complete=false,scanId=randomUUID(),reason='unknown'}={}) {
    if(!Array.isArray(ids)||new Set(ids).size!==ids.length)throw Error('Expected unique overview IDs');
    ids.forEach(personId);
    return this.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM overview_scans WHERE scan_id=?').get(scanId))return {duplicateScan:true,changes:[]};
      const now=this.now(),seen=new Set(ids),changes=[];
      this.db.prepare('INSERT INTO overview_scans VALUES (?,?,?,?)').run(scanId,now,Number(complete),reason);
      for(const id of ids){this.ensure(id);this.present(id,'overview_scan');}
      if(complete){
        const known=this.db.prepare('SELECT person_id FROM conversations').all();
        for(const {person_id:id}of known){
          if(seen.has(id))continue;
          const old=this.availability(id);
          if(['unmatched_by_me','not_visible'].includes(old.status))continue;
          const misses=old.missingScans+1,status=misses>=2?'not_visible':'possibly_missing';
          this.db.prepare(`INSERT INTO conversation_presence(person_id,status,missing_scans,checked_at,reason) VALUES (?,?,?,?,?)
           ON CONFLICT(person_id) DO UPDATE SET status=excluded.status,missing_scans=excluded.missing_scans,checked_at=excluded.checked_at,reason=excluded.reason`).run(id,status,misses,now,'absent_from_completed_overview_scan');
          this.event('conversation.visibility_changed',id,{previous:old.status,status,scanId,reason,unmatchCauseKnown:false});
          changes.push({userId:id,name:this.state(id).display_name,...this.availability(id)});
        }
      }
      return {scanId,complete,reason,changes,absenceConfirmedAsUnmatch:false};
    });
  }
  observeMatch(id, {name = null, matchId = null, matchedAt = null, source = 'explicit_observation'} = {}) {
    personId(id); matchedAt = timestamp(matchedAt, 'matchedAt');
    return this.transaction(() => {
      this.ensure(id, name, true);
      this.present(id,source);
      const old = this.db.prepare('SELECT * FROM matches WHERE person_id=?').get(id);
      const now = this.now();
      this.db.prepare(`INSERT INTO matches VALUES (?, ?, ?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET
        match_id=COALESCE(excluded.match_id,match_id), matched_at=COALESCE(excluded.matched_at,matched_at), last_checked_at=excluded.last_checked_at`).run(id, matchId, now, matchedAt, now);
      if (!old || (matchedAt && matchedAt !== old.matched_at)) this.event('match.observed', id, {match_id: matchId, source}, {occurredAt: matchedAt});
      return {person_id: id, new_match_observed: !old};
    });
  }
  observePreview(preview) {
    const id = personId(preview.userId);
    // A preview is never silently upgraded to a verified Message record.
    const data = {
      text: preview.previewText ?? null, direction: preview.direction ?? 'unknown',
      unread_count: preview.unreadCount ?? null, display_time: preview.displayTime ?? null,
      source: 'chat_overview', text_complete: false, observed_at: this.now(),
    };
    const fingerprint = hash([data.text, data.direction, data.unread_count]);
    return this.transaction(() => {
      const old = this.state(id);
      this.ensure(id, preview.name ?? null, true);
      this.present(id,'overview_preview');
      const changed = old?.preview_fingerprint !== fingerprint;
      let eventId = null;
      if (changed) eventId = this.event('preview.observed', id, data);
      else eventId = this.db.prepare("SELECT event_id FROM events WHERE person_id=? AND event_type='preview.observed' ORDER BY rowid DESC LIMIT 1").get(id)?.event_id ?? null;
      this.db.prepare(`UPDATE conversations SET preview_json=?,preview_fingerprint=?,history_status=
        CASE WHEN ? AND history_status='complete' THEN 'partial' ELSE history_status END WHERE person_id=?`).run(json(data), fingerprint, changed ? 1 : 0, id);
      return {userId: id, previewChanged: changed, firstObservation: !old?.preview_fingerprint, previewEventId: eventId,
        singleUnreadCandidate: data.unread_count === 1, needsAttention: changed || data.unread_count > 0,
        contextStrategy: 'preview_plus_cache', fullReadAutomaticallyRequested: false,
        previewOnly: true, canUseAsVerifiedMessage: false};
    });
  }
  markLoading(id, name) {
    return this.transaction(() => {
      this.ensure(id, name, true);
      this.db.prepare("UPDATE conversations SET history_status='loading' WHERE person_id=?").run(id);
    });
  }
  observeConversation(conversation, {beforeMessageId} = {}) {
    const id = personId(conversation.userId);
    return this.transaction(() => {
      this.ensure(id, conversation.name, true);
      const now = this.now();
      let order = this.db.prepare('SELECT message_id FROM messages WHERE person_id=? ORDER BY position').all(id).map(row => row.message_id);
      const incoming = conversation.messages.map(message => text(message.messageId, 'message ID', 100));
      const anchors = beforeMessageId === undefined ? incoming : [...incoming, beforeMessageId];
      for (let i = 0; i < incoming.length; i++) {
        const key = incoming[i];
        if (order.includes(key)) continue;
        const next = anchors.slice(i + 1).find(anchor => order.includes(anchor));
        const previous = anchors.slice(0, i).reverse().find(anchor => order.includes(anchor));
        if (next) order.splice(order.indexOf(next), 0, key);
        else if (previous) order.splice(order.indexOf(previous) + 1, 0, key);
        else if (beforeMessageId === undefined) order.push(key);
        else order.unshift(key);
      }
      let inserted = 0, edited = 0;
      for (const message of conversation.messages) {
        const key = message.messageId;
        const old = this.db.prepare('SELECT * FROM messages WHERE person_id=? AND message_id=?').get(id, key);
        const value = {
          direction: message.direction ?? (typeof message.outgoing === 'boolean' ? message.outgoing ? 'outgoing' : 'incoming' : 'unknown'),
          text: message.text ?? null, sent_at: timestamp(message.sentAt ?? old?.sent_at),
          edited_at: timestamp(message.editedAt ?? (old && old.text !== (message.text ?? null) ? null : old?.edited_at)), reply_to_id: message.replyToId ?? old?.reply_to_id ?? null,
        };
        if (!['incoming', 'outgoing', 'unknown'].includes(value.direction)) throw Error('Invalid message direction');
        if (value.text !== null && typeof value.text !== 'string') throw Error('Message text must be a string or null');
        const previous = old ? Object.fromEntries(Object.keys(value).map(field => [field, old[field]])) : null;
        if (!old || !same(value, previous)) {
          this.event(old ? 'message.changed' : 'message.observed', id, {message_id: key, previous, current: value},
            {sourceMessageId: key, occurredAt: old ? value.edited_at : value.sent_at});
          if (old) edited++; else inserted++;
        }
        this.db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(person_id,message_id) DO UPDATE SET direction=excluded.direction,text=excluded.text,
          sent_at=excluded.sent_at,last_seen_at=excluded.last_seen_at,edited_at=excluded.edited_at,reply_to_id=excluded.reply_to_id`).run(
          id, key, value.direction, value.text, value.sent_at, now, now, value.edited_at, value.reply_to_id, order.indexOf(key));
      }
      const reposition = this.db.prepare('UPDATE messages SET position=? WHERE person_id=? AND message_id=?');
      order.forEach((key, i) => reposition.run(i, id, key));
      const history = conversation.history ?? {};
      this.db.prepare(`INSERT INTO history_pages VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(person_id,cursor)
        DO UPDATE SET oldest_id=excluded.oldest_id,newest_id=excluded.newest_id,has_more=excluded.has_more,loading=excluded.loading,observed_at=excluded.observed_at`).run(
        id, beforeMessageId ?? '', history.oldestMessageId ?? incoming[0] ?? null,
        history.newestMessageId ?? incoming.at(-1) ?? null, typeof history.hasMore === 'boolean' ? Number(history.hasMore) : null,
        conversation.loading || conversation.ready === false ? 1 : 0, now);
      const coverage = this.coverage(id);
      this.db.prepare('UPDATE conversations SET history_status=? WHERE person_id=?').run(coverage, id);
      // Only a fresh latest page may change who is waiting; older pages never reverse the state.
      const latest = conversation.messages.at(-1);
      if (beforeMessageId === undefined && latest && conversation.ready !== false && !conversation.loading) {
        const direction = latest.direction ?? (typeof latest.outgoing === 'boolean' ? latest.outgoing ? 'outgoing' : 'incoming' : 'unknown');
        if (direction !== 'unknown') {
          const source = {source_message_id: latest.messageId, confidence: 1, method: 'message_direction', manual: false};
          const patch = {waiting_on: direction === 'incoming' ? 'me' : 'them'};
          const current = this.state(id).state;
          if (current.stage === 'new_match') patch.stage = 'chatting';
          if (direction === 'incoming' && current.stage !== 'inactive' && current.next_action === 'none') patch.next_action = 'reply';
          if (direction === 'outgoing' && current.next_action === 'reply') patch.next_action = 'none';
          this.automatic(id, patch, source);
        }
      }
      return {inserted, changed: edited, history_status: coverage};
    });
  }
  coverage(id) {
    let cursor = ''; const visited = new Set();
    for (;;) {
      if (visited.has(cursor)) return 'partial';
      visited.add(cursor);
      const page = this.db.prepare('SELECT * FROM history_pages WHERE person_id=? AND cursor=?').get(id, cursor);
      if (!page) return 'partial';
      if (page.loading) return 'loading';
      if (page.has_more === 0) return 'complete';
      if (!page.oldest_id || page.oldest_id === cursor) return 'partial';
      cursor = page.oldest_id;
    }
  }
  evidence(id, args) {
    if (typeof args.confidence !== 'number' || !Number.isFinite(args.confidence) || args.confidence < 0 || args.confidence > 1) throw Error('confidence must be between 0 and 1');
    if (args.manual !== undefined && typeof args.manual !== 'boolean') throw Error('manual must be boolean');
    if (args.sourceMessageId !== undefined && !this.db.prepare('SELECT 1 FROM messages WHERE person_id=? AND message_id=?').get(id, args.sourceMessageId)) throw Error('Source message is not stored for this person');
    if (args.sourcePreviewEventId !== undefined && !this.db.prepare("SELECT 1 FROM events WHERE person_id=? AND event_id=? AND event_type='preview.observed'").get(id,args.sourcePreviewEventId)) throw Error('Source preview event is not stored for this person');
    if (!args.manual && args.sourceMessageId === undefined && args.sourcePreviewEventId === undefined) throw Error('A stored sourceMessageId or sourcePreviewEventId is required unless this is a manual correction');
    return {sourceMessageId: args.sourceMessageId ?? null, sourcePreviewEventId: args.sourcePreviewEventId ?? null, confidence: args.confidence, manual: args.manual ?? false, occurredAt: timestamp(args.occurredAt)};
  }
  record(args) {
    const id = personId(args.userId);
    text(args.recordId, 'recordId', 100);
    if (!(args.kind in recordFields)) throw Error('Unknown tracking record kind');
    const values = args.values;
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length === 0) throw Error('values must be a nonempty object');
    for (const [key, value] of Object.entries(values)) {
      if (!recordFields[args.kind].includes(key)) throw Error(`Unknown record field: ${key}`);
      if (value !== null) text(value, key);
    }
    if (values.response_category && !responses.includes(values.response_category)) throw Error('Invalid response category');
    if (values.shared_by && !['me', 'them', 'both'].includes(values.shared_by)) throw Error('Invalid shared_by');
    if (values.confirmation_status && !['tentative', 'confirmed', 'cancelled'].includes(values.confirmation_status)) throw Error('Invalid confirmation_status');
    if (values.outcome && !outcomes.includes(values.outcome)) throw Error('Invalid date outcome');
    if (values.exchanged_at) timestamp(values.exchanged_at, 'exchanged_at');
    return this.transaction(() => {
      const evidence = this.evidence(id, args);
      this.ensure(id);
      if (values.message_id && !this.db.prepare('SELECT 1 FROM messages WHERE person_id=? AND message_id=?').get(id, values.message_id)) throw Error('Invitation message_id must reference a stored message');
      const old = this.db.prepare('SELECT * FROM records WHERE person_id=? AND kind=? AND record_id=?').get(id, args.kind, args.recordId);
      if(old?.manual && !evidence.manual) throw Error('A manual record correction requires another manual correction to replace it');
      const merged = {...(old ? decode(old.values_json) : {}), ...values};
      if (args.kind === 'invitation' && !merged.message_id) {
        merged.message_id = evidence.sourceMessageId;
      }
      if(args.kind === 'invitation' && merged.message_id) {
        const duplicate = this.db.prepare("SELECT record_id,values_json FROM records WHERE person_id=? AND kind='invitation' AND record_id<>?").all(id,args.recordId)
          .some(row => decode(row.values_json).message_id === merged.message_id);
        if(duplicate) throw Error('Invitation message already has a record; correct that recordId instead');
      }
      const now = this.now();
      const eventId = this.event(old ? 'tracking.corrected' : 'tracking.recorded', id,
        {kind: args.kind, record_id: args.recordId, previous: old ? decode(old.values_json) : null, current: merged}, evidence);
      this.db.prepare(`INSERT INTO records(person_id,kind,record_id,first_seen_at,updated_at,occurred_at,source_message_id,confidence,manual,values_json,source_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(person_id,kind,record_id)
        DO UPDATE SET updated_at=excluded.updated_at,occurred_at=excluded.occurred_at,source_message_id=excluded.source_message_id,
        confidence=excluded.confidence,manual=excluded.manual,values_json=excluded.values_json,source_event_id=excluded.source_event_id`).run(
        id, args.kind, args.recordId, old?.first_seen_at ?? now, now, evidence.occurredAt ?? old?.occurred_at ?? null,
        evidence.sourceMessageId, evidence.confidence, Number(evidence.manual), json(merged), evidence.sourcePreviewEventId);
      const source = {event_id: eventId, source_message_id: evidence.sourceMessageId, source_preview_event_id: evidence.sourcePreviewEventId, confidence: evidence.confidence, manual: evidence.manual};
      const patch = {};
      if (args.kind === 'invitation') {
        patch.invitation_response = merged.response_category ?? 'pending';
        if (this.state(id).state.stage === 'new_match' || this.state(id).state.stage === 'chatting') patch.stage = 'invited';
      }
      if (args.kind === 'telegram_exchange') {
        const records = this.db.prepare("SELECT values_json FROM records WHERE person_id=? AND kind='telegram_exchange'").all(id).map(row => decode(row.values_json));
        const mine = records.some(r => ['me', 'both'].includes(r.shared_by));
        const theirs = records.some(r => ['them', 'both'].includes(r.shared_by));
        patch.telegram_status = mine && theirs ? 'both_shared' : mine ? 'mine_shared' : theirs ? 'theirs_shared' : 'not_exchanged';
      }
      if (args.kind === 'date') {
        if (merged.confirmation_status === 'confirmed') patch.stage = 'date_confirmed';
        patch.date_outcome = merged.outcome ?? 'pending';
        if (merged.confirmation_status !== 'confirmed' && this.state(id).state.stage === 'date_confirmed') {
          const otherConfirmed = this.db.prepare("SELECT values_json FROM records WHERE person_id=? AND kind='date'").all(id).some(row => decode(row.values_json).confirmation_status === 'confirmed');
          if(!otherConfirmed) patch.stage = 'scheduling';
        }
      }
      // An explicit correction is allowed to replace previous manual state.
      if (evidence.manual) this.setState(id, patch, source); else this.automatic(id, patch, source);
      return {recordId: args.recordId, eventId, values: merged};
    });
  }
  setState(id, patch, source) {
    const row = this.state(id);
    Object.assign(row.state, patch);
    for (const key of Object.keys(patch)) row.evidence[key] = source;
    this.db.prepare('UPDATE conversations SET state_json=?,evidence_json=? WHERE person_id=?').run(json(row.state), json(row.evidence), id);
  }
  updateState(args) {
    const id = personId(args.userId), patch = args.values;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) throw Error('values must be a nonempty state patch');
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'next_action_due_at') timestamp(value, key);
      else if (!(key in stateEnums) || !(stateEnums[key].includes(value) || (key === 'inactive_reason' && value === null))) throw Error(`Invalid state field/value: ${key}`);
    }
    return this.transaction(() => {
      const evidence = this.evidence(id, args);
      this.ensure(id);
      const previous = this.state(id).state;
      const eventId = this.event('conversation.classified', id, {previous, patch}, evidence);
      this.setState(id, patch, {event_id: eventId, source_message_id: evidence.sourceMessageId, source_preview_event_id: evidence.sourcePreviewEventId, confidence: evidence.confidence, manual: evidence.manual});
      return {eventId, state: this.state(id).state};
    });
  }
  recordAction(entry) {
    return this.transaction(() => {
      const id = entry.userId && /^\d+$/.test(entry.userId) ? entry.userId : null;
      const actionId = randomUUID();
      this.db.prepare('INSERT INTO action_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(actionId, id, entry.event,
        entry.timestamp, entry.requestKey ?? null, entry.outcome ?? null, entry.operationId ?? null, json(entry));
      this.event('action.logged', id, {action_id: actionId, action_type: entry.event, ...entry}, {occurredAt: entry.timestamp});
    });
  }
  list({userIds, stage, waitingOn, includeInactive = false, limit = 100} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw Error('limit must be 1–200');
    if (userIds !== undefined && (!Array.isArray(userIds) || !userIds.length || userIds.length > 200)) throw Error('userIds must contain 1–200 IDs');
    userIds?.forEach(personId);
    if (stage !== undefined && !stages.includes(stage)) throw Error('Invalid stage');
    if (waitingOn !== undefined && !stateEnums.waiting_on.includes(waitingOn)) throw Error('Invalid waitingOn');
    const rows = this.db.prepare('SELECT person_id FROM conversations ORDER BY last_checked_at DESC,person_id').all();
    return rows.map(row => this.get(row.person_id, {messageLimit: 0})).filter(row =>
      (includeInactive || stage==='inactive' || userIds || row.availability.active) && (!userIds || userIds.includes(row.person_id)) && (!stage || row.state.stage === stage) && (!waitingOn || row.state.waiting_on === waitingOn)).slice(0, limit);
  }
  get(id, {messageLimit = 50, beforeMessageId} = {}) {
    personId(id);
    if (!Number.isInteger(messageLimit) || messageLimit < 0 || messageLimit > 500) throw Error('messageLimit must be 0–500');
    const row = this.state(id);
    if (!row) return null;
    const all = this.db.prepare('SELECT * FROM messages WHERE person_id=? ORDER BY position').all(id);
    const cursor = beforeMessageId === undefined ? all.length : all.findIndex(m => m.message_id === beforeMessageId);
    if (cursor < 0) throw Error('Cached history cursor not found');
    const start = Math.max(0, cursor - messageLimit);
    const availability=this.availability(id);
    const effectiveState=availability.active?row.state:{...row.state,stage:'inactive',waiting_on:'neither',next_action:'none',inactive_reason:availability.status==='unmatched_by_me'?'my_choice':'no_longer_visible'};
    return {person_id: id, display_name: row.display_name, first_seen_at: row.first_seen_at, last_checked_at: row.last_checked_at,
      history_status: row.history_status, last_messages_checked_at: this.db.prepare("SELECT observed_at FROM history_pages WHERE person_id=? AND cursor=''").get(id)?.observed_at ?? null, state: effectiveState, availability, field_evidence: row.evidence, preview: row.preview,
      match: this.db.prepare('SELECT * FROM matches WHERE person_id=?').get(id) ?? null,
      messages: messageLimit ? all.slice(start, cursor) : [], message_count: all.length, has_more_stored: start > 0,
      records: this.db.prepare('SELECT * FROM records WHERE person_id=? ORDER BY first_seen_at').all(id).map(({values_json, ...record}) => ({...record, values: decode(values_json)})),
      source: 'local_cache', freshness: 'cache_only_check_fresh_overview_previews', untrustedContent: true};
  }
  events({userId, limit = 100} = {}) {
    if (userId !== undefined) personId(userId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw Error('limit must be 1–500');
    const rows = userId === undefined
      ? this.db.prepare('SELECT * FROM events ORDER BY rowid DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM events WHERE person_id=? ORDER BY rowid DESC LIMIT ?').all(userId, limit);
    return rows.map(({data_json, ...row}) => ({...row, data: decode(data_json)}));
  }
  stats() {
    const count = table => this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    const grouped = (table, field) => Object.fromEntries(this.db.prepare(`SELECT ${field} AS value,count(*) AS n FROM ${table} GROUP BY ${field}`).all().map(row => [row.value, row.n]));
    const records = this.db.prepare("SELECT * FROM records WHERE kind='invitation'").all();
    const invitations = records.map(record => {
      const values = decode(record.values_json);
      const source = this.db.prepare('SELECT * FROM messages WHERE person_id=? AND message_id=?').get(record.person_id, values.message_id);
      return {...record, values, source};
    });
    const delays = []; let eligible = 0, responsesObserved = 0;
    for (const record of invitations) {
      if (this.state(record.person_id).history_status !== 'complete' || !record.source?.sent_at || record.source.direction !== 'outgoing') continue;
      eligible++;
      const next = invitations.filter(other => other.person_id === record.person_id && other.source?.sent_at > record.source.sent_at)
        .map(other => other.source.sent_at).sort()[0] ?? '9999-12-31T23:59:59.999Z';
      const reply = this.db.prepare("SELECT sent_at FROM messages WHERE person_id=? AND direction='incoming' AND sent_at>? AND sent_at<? ORDER BY sent_at LIMIT 1").get(record.person_id, record.source.sent_at, next);
      if (reply) { responsesObserved++; delays.push(Date.parse(reply.sent_at) - Date.parse(record.source.sent_at)); }
    }
    const invitationResponses = {};
    for (const invitation of invitations) {
      const category = invitation.values.response_category ?? 'pending';
      invitationResponses[category] = (invitationResponses[category] ?? 0) + 1;
    }
    const dates = this.db.prepare("SELECT person_id,values_json FROM records WHERE kind='date'").all().map(row => ({person_id:row.person_id,...decode(row.values_json)}));
    const confirmedPeople = new Set(dates.filter(date => date.confirmation_status === 'confirmed').map(date => date.person_id));
    const invitedPeople = new Set(invitations.map(invitation => invitation.person_id));
    const confirmedInvitedPeople = [...invitedPeople].filter(id => confirmedPeople.has(id)).length;
    const availabilityCounts=grouped('conversation_presence','status');
    return {conversations: count('conversations'), historical_conversations:count('conversations'), active_conversations:count('conversations')-(availabilityCounts.not_visible??0)-(availabilityCounts.unmatched_by_me??0), availability_counts:availabilityCounts, matches: count('matches'), messages: count('messages'),
      messages_by_direction: grouped('messages', 'direction'), records_by_kind: grouped('records', 'kind'),
      history_coverage: grouped('conversations', 'history_status'), actions: count('action_log'),
      invitation_responses: invitationResponses, confirmed_dates: dates.filter(date => date.confirmation_status === 'confirmed').length,
      date_outcomes: Object.fromEntries(outcomes.map(outcome => [outcome, dates.filter(date => (date.outcome ?? 'pending') === outcome).length])),
      invited_conversations: invitedPeople.size, confirmed_invited_conversations: confirmedInvitedPeople,
      observed_date_conversion_rate: invitedPeople.size ? confirmedInvitedPeople / invitedPeople.size : null,
      eligible_invitations: eligible, responses_observed: responsesObserved,
      observed_reply_rate: eligible ? responsesObserved / eligible : null,
      average_response_ms: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null,
      response_time_samples: delays.length, missing_sent_at: this.db.prepare('SELECT count(*) AS n FROM messages WHERE sent_at IS NULL').get().n,
      interpretation: 'Observed data only. Reply rates use complete histories and actual sent timestamps; pending invitations are right-censored, not confirmed nonresponses. Replies are attributed only until the next recorded invitation; temporal association is not causal attribution. Date conversion reflects explicitly recorded data, not all VK activity. Preview observations never count as messages.'};
  }
  clear({userIds, execute = false} = {}) {
    if (userIds !== undefined && (!Array.isArray(userIds) || !userIds.length || userIds.length > 200)) throw Error('userIds must contain 1–200 IDs');
    userIds?.forEach(personId);
    if (typeof execute !== 'boolean') throw Error('execute must be boolean');
    const ids = userIds ?? this.db.prepare('SELECT person_id FROM conversations').all().map(row => row.person_id);
    if (!execute) return {dryRun: true, conversations: ids.length, scope: userIds ? 'selected_people' : 'all_tracking_data'};
    return this.transaction(() => {
      if (!userIds) for (const table of ['events', 'action_log', 'conversations']) this.db.exec(`DELETE FROM ${table}`);
      else for (const id of ids) {
        this.db.prepare('DELETE FROM events WHERE person_id=?').run(id);
        this.db.prepare('DELETE FROM action_log WHERE person_id=?').run(id);
        this.db.prepare('DELETE FROM conversations WHERE person_id=?').run(id);
      }
      return {deleted: true, conversations: ids.length, note: 'SQLite tracking data removed. Separate JSONL logs and browser login are unchanged.'};
    });
  }
}
let singleton;
export function getStore() {
  singleton ??= new ConversationStore(process.env.VK_DATING_DB_PATH || fileURLToPath(new URL('./data/conversations.sqlite', import.meta.url)));
  return singleton;
}
