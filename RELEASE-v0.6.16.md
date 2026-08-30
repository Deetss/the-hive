# The Hive v0.6.16

Integration tip: 15050808 (on integration/fork-v1, base 0.6.14 35bbec58).
Typecheck: `npm run typecheck`. Build: `npm run dist:win` (NSIS + portable).

## Highlights
- **Unified hook shims across providers.** Commit 00e53187 moves Claude and Codex through a shared `COMMON_HOOK_EVENTS` shim so both engines emit the same lifecycle payloads, trimming redundant sandbox wiring and keeping future hooks agent-agnostic.
- **Edit Agent modal persists engine selections.** Commits f6195367 and 79a92e5a add a `hivePatchAgentEngine` bridge so provider/profile changes write straight to `registry.json`, preventing respawns from reverting to the old engine.
- **Prompt-lite onboarding copy.** Commit aea014bb shortens the injected guardrail instructions, cutting baseline token burn for every spawn.
- **Renderer bridge ships as a module script.** The browser bridge now loads as `<script type="module">`, making `electron-vite` bundle the asset cleanly for the packaged build.

## Artifacts (`dist/`)
- `The-Hive-0.6.16-win-x64-setup.exe` (~136.5 MB) + `.blockmap`
- `The-Hive-0.6.16-win-x64-portable.exe` (~136.4 MB)
- `latest.yml`
- `win-unpacked/`

## Gate
1. Install the 0.6.16 setup build and edit an agent's provider/profile; confirm the modal saves without respawn drift and the change persists in `registry.json`.
2. Run `npm test test/hive-roster-injection.test.cjs` to verify the new `patchAgentEngine` coverage.
3. Launch the portable build, toggle hook-driven features on Codex and Claude agents, and confirm events appear identically in the roster logs.
