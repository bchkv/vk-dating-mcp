# 0.4.0 — Loaded conversation history

Conversation reads now wait for visible loaders and a settled message list, fail explicitly on initial loading errors, and support bounded backward scrolling with exclusive message-ID cursors. Results distinguish confirmed older messages, a confirmed beginning, and unknown completeness. No-growth scrolls never imply a complete conversation. Existing draft protection and message logging remain in place; no persistent cache is introduced.

History markers and scroll behavior are covered by synthetic UI tests. Unit tests also cover delayed loaders, loading failures, pagination overlap and virtualization, cursor bounds, and incomplete results. UI changes may require adapter updates; live account history has not been validated in this release.
