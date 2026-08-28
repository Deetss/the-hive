# The Hive v0.6.9

Integration tip: cfcc093 (on integration/fork-v1).

## Fix

- **browser-bridge: WS URL missing leading slash** (6d58d4b) — `ws://host:portbridge` → `ws://host:port/bridge`. The WS server registers on path `/bridge`; the missing `/` caused every browser client to fail the upgrade handshake silently, leaving the page blank. This closes the browser UI IPC bridge feature — the served UI at http://localhost:48003 now loads in Chrome/Edge.

## Artifacts (TheHive/dist/)

- The-Hive-0.6.9-win-x64-setup.exe + .blockmap
- The-Hive-0.6.9-win-x64-portable.exe
- latest.yml

## Gate

Dylan installs + opens http://localhost:48003 in Chrome/Edge to confirm non-blank load.
