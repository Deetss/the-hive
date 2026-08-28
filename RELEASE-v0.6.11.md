# The Hive v0.6.11

Integration tip: 1a45f3b (on integration/fork-v1).

## Changes

- **debug: browser invoke logging** (3c5eda9) — rowser-bridge.js now logs every invoke send (invoke -> id channel) and receive (invoke <- id channel ok|error: ...) to the browser DevTools console. If a send appears but no matching receive, the main process is not responding. If the receive shows an error, the error message is explicit.
- **debug: catch getConfig failure** (3c5eda9) — App.tsx initial config load now has .catch(err => console.error('[app] getConfig failed:', err)) so a timeout or server error is visible in DevTools instead of silently ignored.

## Artifacts (TheHive/dist/)

- The-Hive-0.6.11-win-x64-setup.exe + .blockmap
- The-Hive-0.6.11-win-x64-portable.exe

## Gate

Dylan installs, opens http://localhost:48003 in Chrome, opens DevTools Console, waits ~20s, pastes full console output so god can diagnose why getConfig is not resolving.
