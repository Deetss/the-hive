# The Hive v0.6.10

Integration tip: c74be17 (on integration/fork-v1, base 0.6.9 cfcc093).
Typecheck: not run (JS-only asset copy hotfix). Build: dist:win OK, NSIS + portable.

## Fix
- **browser-bridge.js packaged copy** (god, 096f4d1) — adds `copyRendererSidecars` to `electron.vite.config.ts` so `browser-bridge.js` is emitted to `out/renderer/` and served at `/browser-bridge.js`. With the v0.6.9 WebSocket URL fix, the browser UI at http://localhost:48003 now loads end-to-end in packaged builds.

## Artifacts (TheHive/dist/)
- The-Hive-0.6.10-win-x64-setup.exe (136.5M) + .blockmap
- The-Hive-0.6.10-win-x64-portable.exe (136.3M)
- latest.yml

## Gate
Dylan installs + opens http://localhost:48003 in Chrome/Edge to confirm the bridge script loads and the UI renders.
