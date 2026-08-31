# The Hive v0.6.6

Integration tip: 6d2d219 (integration/fork-v1, base 0.6.5 707605e).
Typecheck: node + web PASS. Build: `npm run dist:win` (NSIS + portable) — completed locally.

## Folded changes
- **render-memo perf sweep** (feat/render-memo — 823df91, d27be04, 43b16cf)
  - Memoizes the shared Markdown renderer to avoid re-parsing on every poll.
  - Memoizes Command Center memory tab rows/options to prevent redundant markdown work.
  - Dedupe Tasks kanban polling: skips state updates when payload unchanged, memoizes cards, reduces re-renders.
- **offload red gate fix** (feat/offload-red-gate — 1d930be)
  - Persist governor usage so RED state survives pauses/restarts and auto-offload routes to Azure instead of falling back to Claude when paused agents stop reporting.
- **inbox reminder ergonomics** — inbox wake nudges now instruct agents to list only `$AGENT_DIR/inbox` (no recursive globs), and the Hive sync skill docs match, preventing future timeout loops.


## Artifacts (C:\Users\dylan\source\TheHive\dist\)
- The-Hive-0.6.6-win-x64-setup.exe (~137 MB) + .blockmap
- The-Hive-0.6.6-win-x64-portable.exe (~137 MB)
- latest.yml (points to 0.6.6)

## Next steps / gate
Install locally to verify perf gains (Markdown + Tasks board) and confirm auto-offload routing under paused Claude profiles, then publish.
