# VK Dating MCP

An unofficial local MCP server for VK Dating using a dedicated persistent Playwright browser profile. No VK API credentials or model API keys are required.

## Setup

Requires Node.js 22.13+, npm and installed Google Chrome. Live sessions use the same installed Chrome binary in visible and headless modes. Playwright Chromium is used for offline fixture tests.

```sh
npm ci
npm run login
```

The login command opens the dedicated visible browser. Stop other MCP servers using the same profile first, sign in manually, then press Enter in the terminal. From ChatGPT, `vk_login` opens that window without rerunning an installer. An expired sign-in opens a visible window; after authentication, the same session is retained rather than immediately restarting headlessly. Browser sessions have no default idle shutdown and close when explicitly requested or the MCP server exits.

## Conservative activity controls

Security warnings, blocked-account pages and verification challenges persistently pause browser activity in `data/activity-control.json`. `vk_security` with `action: "status"` reads this state locally. Only after the user manually resolves the restriction may `action: "resume", confirmResolved: true` clear it. Recorded `notBefore` unlock times are enforced; expiry never automatically resumes activity. No user-specific account lock or date is shipped in this repository.

Inbox snapshots are cached for 60 seconds and returned with freshness/security labels. During a pause, only a cached inbox may be returned; `vk_context` and `vk_tracking_stats` remain local-only. `refresh: true` requests a fresh overview subject to the same guard. Profiles are off by default. `vk_profile` explicitly reads one exact matched profile; `includeProfiles: true` on inbox opts into at most one missing/stale profile and may mark its chat read. Failed refreshes retain prior data.

Local budgets are five seconds between browser operations, 30 operations per hour, one executed send per minute and ten executed sends per day. Attempted writes count even if their outcome is uncertain. These are conservative application budgets, not VK-published thresholds or guarantees against restrictions. Bulk sends, multi-chat batch reads and automated swiping are disabled. A cross-process operation lock prevents concurrent access from duplicate MCP registrations; configure just one server registration.

Verification checks are completed manually. The plugin does not bypass them, disguise browser identity, or retry uncertain writes automatically. Using consistent sessions and lower activity does not guarantee VK will permit automation or establish the cause of any warning.

## MCP client configuration

Copy `mcp-config.example.json`, replacing `/absolute/path/to/vk-dating-mcp` with your checkout path. Use an absolute Node executable if necessary. This is a local stdio server, not a hosted HTTP endpoint. stdout is reserved for JSON-RPC.

## Default tools

| Tool | Purpose |
| --- | --- |
| `vk_inbox` | Cached/fresh overview, scan coverage and visibility changes. Profiles are opt-in. |
| `vk_context` | Cached messages, profile, preview, state and prior actions for one person. |
| `vk_history` | Explicit history read; opens one chat and may mark it read. |
| `vk_profile` | Explicitly read and cache one matched person's bio and visible profile fields. |
| `vk_tracking_stats` | Active/historical counts and observed metrics with coverage limits. |
| `vk_login` | Open the dedicated visible sign-in window. |
| `vk_security` | Local pause status and explicit manual resume after resolving a restriction. |
| `vk_send` | Preview locally; execute one explicitly authorized message with recipient checks. |
| `vk_unmatch` | Preview locally; guarded Delete Like requires authorization and explicit confirmation. |

Use inbox → context → send. Read full history when needed for the requested assessment. Previews can omit/truncate text, IDs, direction and timestamps; they are never counted as verified messages. Context reports omissions and cannot guarantee a model never overlooks a detail. `VK_DATING_TOOLSET=advanced` exposes legacy diagnostics and tracking administration; conservative activity controls still apply.

## Conversation visibility and profiles

Inbox traversal accumulates rows across scrolling. A completed scan means stable traversal of the rendered overview, not server verification. Two completed scans missing a known chat make it inactive with availability `not_visible`, preserving its history and previous state. Partial, filtered, failed and bounded scans cannot deactivate chats. Reappearance restores the prior state. A plugin unmatch verified in the current view is separately recorded as `unmatched_by_me`; unexplained absence never gets that attribution. Statistics separate active and historical conversations.

Profile extraction uses the observed chat-header profile panel, verifies chat/profile names after selecting the exact person, and caches bios for seven days. Missing, empty and failed bios remain distinct. Source, observation time and truncation flags accompany the profile. Ordinary inbox and history reads do not automatically browse profiles. The user may explicitly request a profile refresh. Unknown profile UI layouts fail safely rather than selecting another person or guessing a destructive control.

## Reading conversation history

`vk_get_conversations` waits for the opened conversation's loader to disappear and its messages to settle before reading. A blank panel is not considered a loaded empty chat. A visible retry control or an initial loading timeout reports an error rather than an empty conversation.

```json
{"userIds":["42"],"messageLimit":50}
```

For the preceding page, use the returned `history.nextBeforeMessageId`:

```json
{"userIds":["42"],"beforeMessageId":"previous-page-oldest-message-id","messageLimit":50,"maxScrolls":20,"timeoutMs":15000}
```

The cursor is exclusive and requires exactly one user ID. Reads reopen the chat and load backward to find the cursor; no persistent cache is used. Messages remain in chronological DOM order and are deduplicated by opaque message ID, including when the UI virtualizes rows.

Each conversation includes `ready`, `loading`, and a `history` object:

| Field | Meaning |
| --- | --- |
| `hasMore: true` / `status: "more_available"` | At least one older message was observed beyond the returned page. |
| `hasMore: false` / `status: "beginning_reached"` | An explicit beginning/empty UI marker was observed and no earlier observed messages are omitted. |
| `hasMore: null` / `status: "unknown"` | Completeness is unconfirmed. A nonmoving scrollbar does not prove history is exhausted. |
| `nextBeforeMessageId` | Oldest returned ID for the next older page, or null at a confirmed beginning. |
| `stopReason` | Message limit, explicit beginning, scroll/time/observation limit, no progress, or no usable scroll container. |

`messageLimit` defaults to 50 (1–500), `maxScrolls` to 20 (0–100), and `timeoutMs` to 15000 (1000–60000 per conversation, after navigation). Navigation has its own timeouts. A read may collect one extra older message to establish `hasMore`. If older loading stalls, already settled messages are returned with incomplete history; check `ready` and `loading` before using them to draft. Missing cursors produce an explicit error rather than silently returning the wrong page.

Only recognized UI markers establish a confirmed beginning. If VK does not expose one, even a short chat may have `hasMore: null`. Attachments without supported text extraction appear with `text: null`; this is not a full multimedia transcript.

## Local tracking and statistics

Tracking uses Node's built-in SQLite module; no external database service or model API is called. `vk_get_conversations` persists verified messages and their actual timestamps when exposed by the page. `vk_sync_overview` persists preview observations and observed match/chat relationships. Existing chats establish that a relationship exists, but never supply an invented match time. Both record when data was first observed separately from any actual occurrence time.

The event stream preserves message revisions, tracking corrections and sanitized action outcomes. Current conversation records contain `stage`, `invitation_response`, `waiting_on`, `telegram_status`, `next_action`, `next_action_due_at`, `inactive_reason`, and `date_outcome`. Each classified field retains confidence and its source. Only basic state such as waiting on the sender is derived from verified message direction; there is no automatic language classifier that guesses whether a date was agreed.

Use `vk_record_tracking` with `kind` and a stable `recordId`:

| Kind | Values |
| --- | --- |
| `invitation` | `message_id`, `proposed_day`, `proposed_time`, `timezone`, `location`, `wording_variant`, `response_category` |
| `telegram_exchange` | `handle`, `shared_by` (`me`, `them`, `both`), `exchanged_at` |
| `date` | `agreed_day`, `agreed_time`, `timezone`, `location`, `confirmation_status` (`tentative`, `confirmed`, `cancelled`), `outcome` |

Every inferred record/state update requires `confidence` (0–1) and either a stored `sourceMessageId` or a `sourcePreviewEventId` returned by the overview. Preview evidence remains labeled as preview evidence. Set `manual: true` for a user-specified correction without a source; automatic updates do not overwrite manual corrections. `vk_update_conversation` accepts a patch in `values` with the current-state fields. Interest or an alternative date suggestion must not be classified as a confirmed date. Observed timestamps do not imply a match/message/exchange happened at that time.

```json
{"userId":"42","values":{"invitation_response":"alternative_proposed","next_action":"offer_time"},"sourcePreviewEventId":"event-id-from-overview","confidence":0.8}
```

`vk_get_tracking` filters by `userIds`, `stage`, and `waitingOn`. `vk_get_cached_conversation` returns stored messages and records without a browser, including `last_checked_at`, `last_messages_checked_at`, and `history_status`. Cached `has_more_stored` only describes additional locally stored messages. A complete stored history requires a connected chain of fetched pages from the latest page to an explicit beginning; an isolated oldest page never establishes completeness. Preview changes make a previously complete history partial until refreshed.

`vk_tracking_stats` calculates counts, observed date conversion, invitation replies and response times from source records. Response timing requires actual sent timestamps and complete cached history, and only associates replies before the next recorded invitation. Missing timestamps are excluded; pending replies are right-censored, not confirmed failures. Conversion rates reflect recorded observations, not all activity on VK. No percentages are stored as primary records. Legacy JSONL files are not automatically imported or reinterpreted as verified messages.

## Local data and logging

- `.browser-profile/`: persistent login cookies and browser storage.
- `logs/YYYY-MM-DD.jsonl`: correlated JSON event records, including observed message text, attempted sends, and old/new text for edits. Logging is enabled by default and has no automatic retention limit.
- `captures/`: snapshots that can contain private conversations.
- `data/conversations.sqlite`: messages, preview text, names, Telegram handles, tracking records, and event history.

These paths and SQLite sidecars are ignored by Git. SQLite files use mode 0600 and newly created data directories use 0700; the database is not encrypted at rest. There is no automatic retention period. `vk_clear_tracking` previews deletion by default; `execute: true` clears selected people or all SQLite data, while separate JSONL files and browser login remain unchanged.

`diagnostics/` contains bounded private failure snapshots and screenshots. `data/` also holds activity controls and inbox cache. These paths are ignored by Git. Never commit or share them. Delete logs/captures manually when no longer needed. To remove the saved login, stop the server and delete its dedicated profile.

`VK_DATING_PROFILE_DIR`, `VK_DATING_LOG_DIR`, and `VK_DATING_DB_PATH` override the profile directory, JSONL directory, and SQLite file respectively. Defaults are relative to the source directory, independent of the client's working directory. Use absolute overrides and keep them outside any repository. Event files use restricted permissions; actions fail before starting when required audit logging is unavailable. An outcome logging failure may happen after an action, so inspect state before deciding what to do next.

## Development

```sh
npm ci
npm run browser:install
npm test
```

Tests use local fixtures and mocks, not your VK account. CI runs on Linux with Node 22 and 24. `npm start` opens the legacy inspection CLI after login; it does not expose the full MCP messaging interface.

Unofficial project, unaffiliated with VK. Use only with an account you control and follow the service's rules.

## Reply context packs

After refreshing overview previews, call `vk_get_reply_context` with `userId` to retrieve cached messages (200 by default, maximum 500), latest preview, state and evidence, all recorded invitations, dates/Telegram records, and up to 100 recent send events in one response. Coverage flags distinguish missing actual history from cached messages omitted by the limit. Older cached pages remain available through `vk_get_cached_conversation`. This is context retrieval, not a guarantee that a model will never overlook a detail.

Bio text comes from explicit observed profile reads or `vk_record_profile`, with source and observation time. Missing/unavailable bios remain null; stale cached data is retained after a failed refresh. Before sending, check existing invitations and uncertain dispatches; identical wording is not the only way to repeat an invitation.

## Responsible automation

No request frequency is guaranteed safe from platform restrictions. Keep browser operations sequential, avoid unsolicited bulk messaging and swiping, use overview/cache reads instead of repeated full-history loading, and stop on authentication challenges, throttling, or account warnings. Do not automatically retry uncertain sends. This server has serialized calls, explicit execution and process-local duplicate suppression; it does not yet provide a global rate limit or automatic challenge/throttle circuit breaker. Browser headlessness does not make activity undetectable. Follow the service's current terms; this project does not bypass bot detection or CAPTCHAs.

Unmatching uses the observed Delete Like action. It requires an exact user ID, expected name, unique request ID, `execute: true`, and `confirmUnmatch: true` after user authorization. Unknown follow-up confirmations or uncertain outcomes are never retried automatically.
