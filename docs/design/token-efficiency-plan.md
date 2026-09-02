# Token Efficiency Follow-Ups

_Updated September 2, 2026_

The immediate queen model recommendation now points new hives at **Claude Code · Sonnet 4.6 · 1M**, cutting BeeYoncé's orchestration cost by roughly 80% versus Opus 4.8 while keeping the full 1M context window. The next phase is to tighten visibility into real token burn and reduce the respawn orientation payload. This note captures the proposed workstreams so we can queue them deliberately once Dylan prioritises execution.

## 1. Telemetry & Instrumentation

- **Objective:** Quantify real Anthropic spend drivers (tool-call storms, respawn bursts, long sessions) without reading entire log streams into agent context.
- **Scope:**
  - Extend `fleet.json` emission to include per-agent rolling counters for tool calls, tool-call rate (per minute), and cumulative Claude tokens broken down by prompt/completion.
  - Add a lightweight `log.jsonl` sampler in the Overmind that records `tool_call` and `respawn` events into an hourly histogram (agent id → count) persisted to a new `telemetry/hourly.jsonl` ring buffer.
  - Emit explicit `respawn:start` / `respawn:finish` events with the orientation byte size and elapsed time so bursts are measurable.
  - Surface the above metrics in the UI: augment the Agent Detail “Usage” panel and add a warning badge when a worker exceeds a configurable tool-call rate threshold.
  - Guard against runaway logging by delegating bulk crunching to the `edgentic` helper (same pattern as the audit request) and storing only aggregates inside hive state.
- **Acceptance Criteria:**
  - Agents can chart tool-call rate and total tokens without tailing `log.jsonl` in-process.
  - Respawn storms appear as spikes in the hourly histogram, enabling alerting.
  - Instrumentation adds <1% overhead to steady-state token usage (all heavy sampling jobs offloaded).
- **Dependencies / Notes:**
  - Requires schema update for `fleet.json`; ensure readers tolerate new keys.
  - Coordinate with breaker logic so new rate metrics can trip safeguards automatically.

## 2. Orientation Boot-Set Optimisation

- **Objective:** Reduce the ≈19.8 KB (~4.9k tokens) per-agent respawn payload so bursts stop multiplying costs.
- **Baseline:** Current boot set includes `PROTOCOL.md`, `board.md`, recent inbox/outbox, `memory.md`, and the packaged Overmind orientation. Every respawn re-reads raw text.
- **Proposal:**
  - Precompute a compact orientation bundle per agent containing the static portions (protocol, board scaffolding) and cache it under `agents/<id>/cache/orientation.json` with a content hash.
  - At respawn, send only the diff: static hash reference + dynamic delta (latest memory / open humanQA threads). Agents fetch the static chunk from disk when needed, avoiding retransmission over the Claude API.
  - Introduce a `maxBootTokens` guard that requests a trim pass (or warns the human) when memory or open tasks exceed the target budget.
  - Investigate compressing Markdown orientation sections into bullet summaries stored alongside the full text for cold-start; fallback to the full text if compaction loses required detail.
- **Validation:**
  - Instrument orientation size before/after to confirm ≥50% token reduction per respawn.
  - Ensure cache invalidates on protocol changes (hash mismatch triggers recompute).
  - Add UAT scenario covering mass respawn (6 workers) to confirm caches prevent repeat uploads.
- **Risks / Mitigations:**
  - Cache staleness → include schema version in the hash key.
  - Additional disk churn → reuse existing agent cache folder and prune old bundles on compact.

## 3. Rollout Considerations

- Stage telemetry first to gather real measurements while Sonnet migrates.
- Once data confirms sustained savings, expose a “cost saver” banner in Settings explaining the Sonnet recommendation and showing live token reductions.
- Coordinate with Dylan for sequencing so the held local commits on `integration/fork-v1` stay mergeable.

Document owner: bee-casso2w (bee-casso2w-mtkb6jm4)
