# The Hive v0.6.7

Integration tip: 446cacb (on integration/fork-v1, base 0.6.5 707605e).
Typecheck: node + web PASS (zero errors). Build: dist:win OK, NSIS + portable.

## Folded (3 features, zero merge conflicts)
- **mobile-remote** (dwight-codex, 7d114a3 / f8550a2 / 80aa38c) — establishes the WebSocket bridge + renderer shim so open-in-browser clients can drive IPC, with connection hardening for multi-client safety.
- **offload-red-gate** (jim-codex, 1d930be) — keeps the governor RED state sticky across stale windows so offload gating survives reopen/hooks rebuilds.
- **render-memo** (jim-codex, 43b16cf / d27be04 / 823df91) — memoizes Markdown + memory panes and dedupes live tasks polling to trim renderer churn.

## Artifacts (TheHive/dist/)
- The-Hive-0.6.7-win-x64-setup.exe (136.5M) + .blockmap
- The-Hive-0.6.7-win-x64-portable.exe (136.3M)
- latest.yml

## Gate
Dylan installs + validates, then publishes. No auto-publish.

