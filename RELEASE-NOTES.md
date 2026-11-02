# 0.6.1 — Visible sign-in recovery

Detected VK sign-in pages now open a visible browser on the dedicated persistent profile. Authentication windows are retained until completion; a later request returns to headless browsing. Interrupted operations are not replayed. Authentication-required responses are explicit, with setup guidance when no visible browser is available. Unrelated app loading failures do not trigger login windows.

The four-tool interface from 0.6.0 remains unchanged.
