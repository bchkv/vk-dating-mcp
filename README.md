# VK Dating MCP

An unofficial, local MCP server for VK Dating. Uses Playwright with a dedicated persistent browser profile; no VK API credentials or model API keys are required.

## Setup

Requires Node.js 22.13+ and npm. Run from this repository:

```sh
npm ci
npm run browser:install
npm run login
```

The login command opens a visible Chromium window. Sign in and open Dating, then press Enter in the terminal to close it. Stop any other server using the same profile before logging in. Subsequent MCP operations run headlessly and reuse the saved login.

On Linux, browser system libraries may also be needed: `npm run browser:install:ci`.

## Expired login

If a VK sign-in page is detected while opening the app, the server closes the headless browser and opens a visible browser using the same dedicated profile. Complete authentication manually, including any security checks. The interrupted operation returns `authenticationRequired: true` and is not retried. Call the tool again after sign-in; the server then returns to headless operation. The login window is not closed by the idle timer.

Visible login uses bundled Chromium, or installed Google Chrome when only Headless Shell is available. If neither can start, the error explains how to install the full browser and run `npm run login`. Other app loading/layout failures do not automatically open a login window.

## MCP client configuration

Copy `mcp-config.example.json` into your client's MCP configuration, replacing `/absolute/path/to/vk-dating-mcp` with your checkout path. Use an absolute Node executable path if your desktop client cannot find `node`.

```json
{
  "mcpServers": {
    "vk-dating": {
      "command": "node",
      "args": ["/absolute/path/to/vk-dating-mcp/mcp.mjs"]
    }
  }
}
```

This is a local stdio server, not a hosted HTTP endpoint. Your client must support local MCP processes. stdout is reserved for JSON-RPC messages.

## Default interface

Four task-focused tools are exposed by default. Browser startup, reuse, and local persistence are automatic.

| Tool | Purpose |
| --- | --- |
| `vk_inbox` | Compact overview previews and attention flags; no individual chat clicks. |
| `vk_context` | One person’s cached messages, preview, profile if recorded, state, invitations and uncertain sends. |
| `vk_history` | Explicit full/older-history read; opens the chat and may mark it read. |
| `vk_send` | Local preview by default; `execute: true` verifies and sends one message. |

Use inbox → context → send. Fetch history only when needed and opening the chat is acceptable. Context is bounded and reports omissions; it does not guarantee a model cannot overlook a detail. Unmatch is unavailable until its UI action and confirmation have been inspected.

Set `VK_DATING_TOOLSET=advanced` in the MCP process environment and restart to expose the legacy diagnostics, tracking administration, editing, reactions, and batch operations alongside the four core tools. Legacy tools are rejected in core mode, not merely omitted from the list. The sections below document these advanced operations and the underlying storage model.

## Preparing replies without opening chats

Start with `vk_sync_overview`. It waits for the chat list to load, reads the visible previews and any explicit unread counts, and returns up to 20 cached messages per person by default. It never clicks a conversation row. `changedOnly: true` limits the returned rows to changed previews or positive unread counts; `includeCachedContext: false` omits the cached context and `cachedMessageLimit` accepts 1–100.

```json
{"changedOnly":true,"includeCachedContext":true,"cachedMessageLimit":20}
```

Prepare a draft from the fresh preview and cached context. Do not automatically open a changed conversation: opening it may send a read receipt. `vk_send_message` and `vk_send_messages` with `execute` omitted or false return local drafts with `liveRecipientVerified: false`; only explicit execution opens chats and checks live recipient names before sending.

Overview previews stay separate from verified message records. They may be truncated, omit direction or time, repeat an older message, or lack unread counts. Even an unread badge of one does not prove exactly one complete new message. Missing counts/direction are null/unknown. The cache does not infer that absent chat rows are unmatched, deleted, or inactive. A full-history read remains available when context is insufficient and marking the conversation read is acceptable.

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

These paths are ignored by Git. Never commit or share them. Delete logs/captures manually when no longer needed. To remove the saved login, stop the server and delete its dedicated profile.

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

Bio text is included only when explicitly recorded through `vk_record_profile`, with its source and observation time. Automatic profile extraction is not implemented. A missing bio stays null. Before sending, check existing invitations and uncertain dispatches; identical wording is not the only way to repeat an invitation.

## Responsible automation

No request frequency is guaranteed safe from platform restrictions. Keep browser operations sequential, avoid unsolicited bulk messaging and swiping, use overview/cache reads instead of repeated full-history loading, and stop on authentication challenges, throttling, or account warnings. Do not automatically retry uncertain sends. This server has serialized calls, explicit execution and process-local duplicate suppression; it does not yet provide a global rate limit or automatic challenge/throttle circuit breaker. Browser headlessness does not make activity undetectable. Follow the service's current terms; this project does not bypass bot detection or CAPTCHAs.

Unmatching is not implemented: the available DOM fixtures do not include an identified unmatch action and confirmation dialog.
