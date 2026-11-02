# 0.5.0 — Preview-first replies and local tracking

Added a local SQLite event stream and current conversation records, observed messages/revisions, matches, invitations, Telegram exchanges, dates, and correlated action outcomes. Tracking classifications retain message or preview provenance and confidence, support manual corrections, and keep actual timestamps separate from discovery times. Derived statistics report missing timestamp and history coverage limitations.

Overview synchronization returns previews plus cached context without opening individual conversations. Single and batch send previews now run locally; explicit execution still opens and validates recipients. Full conversation reads retain the bounded, loading-aware history pagination introduced in 0.4.0.

The database and its sidecars are ignored by Git. Node.js 22.13+ is required for the built-in SQLite module. No third-party database or model API is used. Existing JSONL logs are preserved separately, not silently backfilled into verified history.
