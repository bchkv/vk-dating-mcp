## 0.7.1

- Persist security pauses and require explicit manual resume after restriction resolution.
- Reuse installed Chrome and authenticated sessions; add request budgets and a cross-process operation lock.
- Disable automatic profile browsing, bulk sends and automated swiping; cache inbox snapshots for 60 seconds.
- Add explicit profile reads and cached bios with provenance, freshness and identity checks.
- Reconcile conversation visibility while preserving historical data and separating active/historical counts.
- Add visible-login recovery, bounded private failure diagnostics and guarded unmatching.

# 0.6.1 — Visible sign-in recovery

Detected VK sign-in pages now open a visible browser on the dedicated persistent profile. Authentication windows are retained until completion; a later request returns to headless browsing. Interrupted operations are not replayed. Authentication-required responses are explicit, with setup guidance when no visible browser is available. Unrelated app loading failures do not trigger login windows.

The four-tool interface from 0.6.0 remains unchanged.
