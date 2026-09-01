# Mobile PWA <-> Desktop Parity Audit

Compares the mobile PWA (`src/mobile/index.html`) against the desktop Electron app
(`src/renderer/src/`, primarily `CommandCenterPanel`). Snapshot: The Hive v0.6.59,
2026-09-01. Grouped by impact: Critical blocks a real remote workflow, Important is a
significant gap, Nice-to-have is polish or insight.

## What the mobile PWA already does (at parity)

- **Fleet**: live roster over SSE (`/api/events`), per-agent status.
- **Per-agent controls**: live terminal OUTPUT stream, send a message (`/api/agents/:id/message`),
  and **Stop** (`/api/agents/:id/stop`). Per-agent status bar (tokens, session cost, context %, engine/model).
- **For You (Ask Me)**: answer/dismiss open `humanQA` items (PASS/FAIL) via `/api/tasks/:id/qa/:index/answer`.
- **Tasks**: filter by status; change status; edit title / notes / result; set assignee (`PATCH /api/tasks/:id`).
- **Dispatch**: to / act / subject / body / priority, routed through Abathur.
- **Workers**: ephemeral-worker list, tracked processes, kill a process, launch a new terminal.
- **Machines**: pair via QR, add/switch machines, re-auth.

## Critical (blocks a real remote workflow)

1. **No agent restart / respawn.** Mobile can only Stop an agent, never recover one. A
   stuck, crashed, or quota-limited agent cannot be brought back from the phone, so
   unattended away-from-desk operation dead-ends the moment an agent needs a restart.
   Desktop has the Respawn (↺) control. *Add `POST /api/agents/:id/respawn` + a card button.*
2. **No raw terminal input.** Mobile sends a queued "message", but cannot type into the
   live session: it can't answer an in-terminal prompt, send a slash command (`/compact`,
   `/clear`), or send control keys. You can watch an agent but not truly drive it.
   *Add a PTY write path (`POST /api/agents/:id/input`) or surface remote-control approvals.*

## Important (significant gap)

3. **No settings / budget / governor control.** Token cap, governor override/pause,
   default model/engine, runtime-profile switch, and the knowledge-base path are all
   desktop-only. If the floor is paused or over budget while you're away, mobile can't fix it.
   *Expose a read+write subset of `getConfig`/`updateConfig` over the mobile API.*
4. **No agent creation / spawn.** Desktop has Add Agent; mobile can only dispatch to Abathur
   or existing agents. You cannot stand up a new named agent from the phone.
5. **No triggers / schedule management.** Desktop has Triggers + Trigger History (cron/webhook);
   mobile has none, so scheduled work can't be created or inspected remotely.
6. **Fleet card is missing the newer desktop signals** added in 0.6.59: the `quota`,
   `idle Xh`, and profile/model chips. Mobile shows a status bar but not these at-a-glance flags.

## Nice-to-have (insight / polish)

7. **Insight tabs absent**: Memory, Memory Graph, Activity feed, Skills, Delegations.
   These are read-mostly context surfaces; useful remotely but not blocking.
8. **Code tabs absent**: Git, Files, IDE, Review. Editing/reviewing code from a phone is
   low-value; skip unless specifically wanted.
9. **No office-floor / monitor visualization**: mobile uses a list fleet, not the animated
   PixiJS floor. Cosmetic on a small screen.

## Suggested order

Critical 1 -> 2 first (recovery + real control are what "control it as if at my desk"
actually needs), then Important 3 (governor/budget) and 6 (cheap, reuses existing flags),
then 4 -> 5. Nice-to-have items only if time allows.
