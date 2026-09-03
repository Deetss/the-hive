# The Hive v0.6.63

A multi-agent autonomous coding hive for Claude, Antigravity, and Codex.

### Added

- Spawn workers in WSL for WSL paths, with login-shell PATH resolution and launching WSL apps from the Workers tab
- Import an AI profile from clipboard
- Per-request spawn approval flow in the Workers tab (approve/decline pending spawns)
- Edit an agent's workspace (cwd) with relaunch
- Chat-about-this threads on humanQA cards, and surfacing agents blocked on a TUI prompt via toast + needs-input chip
- Per-agent touched-files ledger, exposed via a new Touched tab in Command Center and Focus Mode
- Rate-limit pace and projected-usage indicators in the status bar and fleet cards
- Custom endpoint UI for runtime profiles
- Image paste/attach support in humanQA chat, the For You UAT panel, and task notes
- Mobile parity push: insight tabs (memory/activity/skills), Schedules screen, New Agent spawn form, settings screen, fleet chips, respawn button, and pull-to-refresh
- Knowledge base as a multi-source list with MCP sources, plus an onboarding KB source setup step
- Hive network discovery via mDNS/Bonjour
- User-editable agent prompts in Settings, with all static prompts exposed
- Dispatch form v2 (project field, no subject), richer project suggestions, and one-click dispatch from the Floor tab
- Toasts for new Ask Me questions and for human commands typed directly into a terminal
- Hive office floor visuals: animated bee sprites, hex pod desks, honeycomb tiles, honey vat with drip/puddle animation, and comb-note task board props

### Changed

- Unified duplicated agent roster UIs into a shared AgentRosterItem component
- Consolidated UAT into a single home in the For You tab, retiring uat.json
- Relocated settings, fullscreen, and theme controls into the focus and office view chrome
- Raised default worker token cap from 1M to 16M
- Command Center tabs now order by usage and dwell time instead of MRU
- Titlebar now shows a fleet status strip instead of a static logo
- Reworked hive floor rendering to a strict per-desk grid, fixing seams and off-grid pods

### Fixed

- Respawn now works for workspace-only workers, keeps tokenCap, and reconnects the real terminal
- Orphan-heal now catches archived/gone agents and reassigns a reaped agent's tasks to god
- Self-healing for task cards with a bogus or manually-archived assignee
- Duplicate humanQA entries on dismiss, and UAT verdicts routing to god when the worker is gone
- Mobile QR pairing URL hijack, and mobile CSS tokens now match desktop
- Settings crash when the prompt-defaults IPC is absent; Settings modal widened for readability
- Hive taskbar icon/AUMID grouping, and Windows notifications now read "The Hive"
- Rate-limit chip percentage and pace calculations
- Dispatch composer field clipping, and Enter in the project field no longer sends prematurely
- "What's new" button opening nothing after an update
