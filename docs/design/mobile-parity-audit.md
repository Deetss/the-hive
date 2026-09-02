# Mobile/Desktop UI Parity Audit — Component Reuse

Snapshot: The Hive @ `dab919cd` (integration/fork-v1), 2026-09-02.

Scope: Dylan's request — "we should be reusing as much of our UI as possible in
our mobile site too, we currently have such differences between them." This
audit maps **code/architecture** divergence (shared components, duplicated
logic, layout) across all mobile screens against their desktop equivalents.

A separate audit already exists at `MOBILE_PARITY.md` (2026-09-01) covering
**feature availability** (what mobile can't do at all, e.g. no agent respawn).
Several of its "critical" gaps have since closed (Settings/governor control,
Schedules, Insights all shipped since that snapshot). This document is
complementary: it assumes rough feature parity per-screen and asks whether the
two implementations share any code, and whether new desktop features are
reaching mobile at all.

## The headline finding

Desktop (`src/renderer/src/`) is a ~65-component React/TypeScript app.
Mobile (`src/mobile/index.html`) is a single 3,138-line hand-written HTML file
with inline `<style>` and a vanilla-JS `<script>` block — no bundler, no
framework, no build step. **Nothing is shared.** Mobile cannot `import` a
`.tsx` component; every screen is a second, independently maintained
implementation of the same UI. Confirmed via search: zero references to any
`src/renderer` component from `src/mobile`.

The task note that prompted this audit assumed `AgentRosterItem` (the desktop
agent card, `AgentRosterItem.tsx`) was "already shared — verify." **That is
incorrect.** `AgentRosterItem` is only imported by `AgentCard.tsx`,
`CommandCenterPanel.tsx`, `FullscreenTerminal.tsx`, and `RosterList.tsx` — all
desktop-only. Mobile renders its own agent card from scratch in `agentCard()`
(`src/mobile/index.html:1690`).

## Tab-by-tab map

| Tab | Desktop file(s) | Mobile file(s) | Gap summary |
|---|---|---|---|
| **Agents** (Fleet) | `AgentRosterItem.tsx` (1105 lines), `AgentCard.tsx`, `RosterList.tsx`, `AgentStrip.tsx`, `CommandCenterPanel.tsx` (1769), `HiveScene.tsx` (PixiJS office floor) | `index.html` `renderFleet()` L1610, `agentCard()` L1690 | Independent HTML-string card renderer. No live PTY terminal embed, no office-floor visualization (floor is arguably desktop-only by design — small screen). |
| **For You** (AskMe) | `AskMeTab.tsx` (734 lines) | `index.html` `renderAskMe()` L2442, `askItem()` L2480 | Mobile is PASS/FAIL buttons only. Desktop's `AskMeTab.tsx` picked up a chat-thread UI plus image paste/attach in the last two commits (+77, +92 lines) — mobile got none of it. |
| **Tasks** | `TasksKanban.tsx` (1263 lines — **already accepts a `mobile?: boolean` prop** that switches its flex layout to a single column), `TaskDetailOverlay.tsx` | `index.html` `renderTasks()` L2533, `taskCard()` L2576 | Desktop already built a mobile-responsive layout mode into the real component and it is unused by the actual mobile client. Mobile also lacks the just-shipped file/image attach on task notes. |
| **Workers** | `WorkersTab.tsx` (637 lines) | `index.html` `renderWorkers()`/`workerCard()` L2045-2104, `renderProcesses()`/`processCard()` L2251-2261, new-agent + new-terminal forms L1190-1227 | Roughly functional-equivalent per the prior feature audit, but fully re-implemented — zero shared code. |
| **Dispatch** | *No longer a standalone tab.* Folded into `MessageQueueComposer.tsx` (1006 lines) as of the "ux-unified-input" change (see comment at `CommandCenterPanel.tsx:736`). | `index.html` `screen-dispatch` L1152-1187 — dedicated to/act/subject/body/priority form, unchanged | **UX model has diverged, not just code.** Mobile still exposes the old standalone-dispatch pattern desktop deliberately retired. |
| **Settings** | `SettingsModal.tsx` (2745 lines): AI engines, MCP defaults, local-delegate config, Hive profiles, office theme, and more | `index.html` `screen-settings` L1231-1266: governor override, token/cost cap, default model, KB path only | Mobile exposes ~2 of 10+ desktop settings sections. No engine/model provider config, no MCP defaults, no local-delegate settings, no theme picker. |
| *(unscoped)* Schedules | `TriggersTab.tsx` / `TriggerHistoryTab.tsx` (cron-style) | `index.html` `screen-schedules` — simple interval scheduler | Different data model, not a straight port; flagged for completeness since mobile has a nav item desktop doesn't call "Schedules." |
| *(unscoped)* Insights | `MemoryTab`, `MemoryGraphPanel.tsx`, `ActivityTab`, `SkillsTab.tsx`, `DelegationsTab.tsx` (5 separate tabs) | `index.html` `screen-insights` — single screen, 3 sub-tabs (Memory/Activity/Skills) | Read-only surfaces; Memory Graph and Delegations have no mobile equivalent at all. Low priority per prior audit. |

## Already-shared components

**None.** This is worth stating plainly since the originating task note assumed
otherwise. The only "shared" surface is naming: mobile's CSS custom properties
copy the desktop design-token *names* (`--cth-lemon`, `--cth-ink-900`, etc.)
by hand, but not the values — see Gap #1 below, they've already drifted.

## Top 3 gaps, ranked by impact

**1. Design tokens are duplicated by hand and have already drifted.**
`src/renderer/src/design/tokens.css` is the desktop source of truth
(`--cth-lemon: #D4A02A`). Mobile hardcodes its own copy at the top of
`index.html` (`--cth-lemon: #F2C55A`) — a different color, same variable name,
on every screen. This is the highest-impact, lowest-effort fix: one small file,
affects every mobile screen's visual consistency with the brand, and requires
no architecture change — generate mobile's `:root` block from `tokens.css` at
build/release time (or load `tokens.css` directly) instead of hand-copying.

**2. Every screen is a full second implementation, and the gap is actively
widening.** `TasksKanban.tsx` already has the layout logic to render correctly
on a phone (`mobile` prop), but the real mobile client ignores it and hand-rolls
its own. The same pattern repeats for Agents, For You, and Workers
(`AgentRosterItem.tsx`, `AskMeTab.tsx`, `WorkersTab.tsx` — 3,700+ combined
lines of logic mobile can't reach). This isn't just historical debt: the last
three feature commits on desktop (image paste in AskMe, image paste in the UAT
panel, file attach on task notes) touched zero mobile files. Every future
desktop feature has to be built twice, and right now it's only being built
once. Highest long-term cost of the three.

**3. Dispatch has diverged in UX model, not just code.** Desktop deliberately
retired the standalone dispatch form in favor of the unified
`MessageQueueComposer` (send-a-message-or-dispatch from one composer, per
agent). Mobile still presents the old separate "Dispatch" screen as its own
nav tab. A user moving between desktop and mobile hits two different mental
models for the same action, not just a different-looking form for the same
one.

## Suggested next step

Ranked #1 is nearly free and should happen regardless of what else gets
picked. #2 is the real "reuse our UI" ask but is an architecture decision
(rebuild `src/mobile` as a small React entry point that imports existing
components with their `mobile` props vs. keep it vanilla JS and invest in
sharing at the design-token/CSS layer only) — worth Dylan's input before
committing engineering time. #3 is a smaller, scoped fix (bring mobile's
Dispatch screen into the MessageQueueComposer model) that could ship
independently of the #2 decision.
