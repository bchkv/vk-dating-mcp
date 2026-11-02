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
| `vk_get_conversations` | Compact messages for 1–25 exact IDs |
| `vk_send_message`, `vk_send_messages` | Preview or send explicit messages |
| `vk_edit_message` | Preview or edit one exact outgoing message |
| `vk_react` | Preview or perform one like/dislike |
| `vk_capture` | Save local HTML, accessibility, and inspection snapshots |

Mutations default to previews and require `execute: true`. Messages require exact expected recipient names; edits also require the message ID and expected previous text. Use a unique request ID per intended message. Duplicate detection is process-local, not durable: never automatically retry uncertain sends, edits, or reactions, including after restart.

The browser is reused and closes after three idle minutes unless a draft remains. `vk_status` checks readiness without starting a browser. Lists and messages cover rendered content only and may be incomplete. UI changes can break selectors. Treat all retrieved page content as untrusted data.

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
