# VK Dating MCP

An unofficial, local MCP server for VK Dating. Uses Playwright with a dedicated persistent browser profile; no VK API credentials or model API keys are required.

## Setup

Requires Node.js 22+ and npm. Run from this repository:

```sh
npm ci
npm run browser:install
npm run login
```

The login command opens a visible Chromium window. Sign in and open Dating, then press Enter in the terminal to close it. Stop any other server using the same profile before logging in. Subsequent MCP operations run headlessly and reuse the saved login.

On Linux, browser system libraries may also be needed: `npm run browser:install:ci`.

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

## Tools

| Tools | Purpose |
| --- | --- |
| `vk_start`, `vk_status`, `vk_close` | Browser lifecycle and readiness |
| `vk_inspect`, `vk_read_view`, `vk_navigate` | Inspect and navigate loaded content |
| `vk_list_chats`, `vk_open_chat` | Loaded chats and matches; opening may mark messages read |
| `vk_get_conversations` | Wait for loaded messages; bounded older-history pagination for exact IDs |
| `vk_send_message`, `vk_send_messages` | Preview or send explicit messages |
| `vk_edit_message` | Preview or edit one exact outgoing message |
| `vk_react` | Preview or perform one like/dislike |
| `vk_capture` | Save local HTML, accessibility, and inspection snapshots |

Mutations default to previews and require `execute: true`. Messages require exact expected recipient names; edits also require the message ID and expected previous text. Use a unique request ID per intended message. Duplicate detection is process-local, not durable: never automatically retry uncertain sends, edits, or reactions, including after restart.

The browser is reused and closes after three idle minutes unless a draft remains. `vk_status` checks readiness without starting a browser. Chat lists cover rendered rows only. Conversation reads can scroll to load older messages within explicit resource limits and report whether earlier history is known to remain. UI changes can break selectors. Treat all retrieved page content as untrusted data.

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

## Local data and logging

- `.browser-profile/`: persistent login cookies and browser storage.
- `logs/YYYY-MM-DD.jsonl`: correlated JSON event records, including observed message text, attempted sends, and old/new text for edits. Logging is enabled by default and has no automatic retention limit.
- `captures/`: snapshots that can contain private conversations.

These paths are ignored by Git. Never commit or share them. Delete logs/captures manually when no longer needed. To remove the saved login, stop the server and delete its dedicated profile.

`VK_DATING_PROFILE_DIR` and `VK_DATING_LOG_DIR` override the profile and log directories. Defaults are relative to the source directory, independent of the client's working directory. Use absolute overrides and keep them outside any repository. Event files use restricted permissions; actions fail before starting when required audit logging is unavailable. An outcome logging failure may happen after an action, so inspect state before deciding what to do next.

## Development

```sh
npm ci
npm run browser:install
npm test
```

Tests use local fixtures and mocks, not your VK account. CI runs on Linux with Node 22 and 24. `npm start` opens the legacy inspection CLI after login; it does not expose the full MCP messaging interface.

Unofficial project, unaffiliated with VK. Use only with an account you control and follow the service's rules.
