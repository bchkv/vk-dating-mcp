# Publication preparation — 0.3.0

Clean source export from the installed server. No account profile, logs, captures, local backups, or machine-specific client configuration is included. MIT licensed.

Added visible first-login command, portable client configuration example, install instructions, privacy and contribution documentation, and Linux CI on Node 22/24. Status queries no longer start the browser. Updated stale protocol tests and made the idle shutdown test wait for the asynchronous logged close.

Validation: 40 unit/protocol tests pass locally on Node 26. Two Playwright browser integration tests could not run because the macOS sandbox rejects Chromium's Mach port registration. They remain required in the full npm test CI suite. Manual first-login flow has not been exercised against a live account in this copy.

Before publishing: run the full CI suite in an unrestricted environment. Create the GitHub repository and push this source only; never upload the installed server directory or runtime data.
