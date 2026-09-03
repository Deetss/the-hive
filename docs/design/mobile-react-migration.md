# Mobile React Migration — Architecture Plan

Snapshot: The Hive @ `c0d746f5` (integration/fork-v1), 2026-09-03. Research only,
no code changes. Builds on `mobile-parity-audit.md` (2026-09-02), which
established that mobile shares zero code with desktop and ranked the fix as
"rebuild `src/mobile` as a React entry point" (its gap #2). Dylan has approved
that direction. This doc is the concrete plan for doing it.

## 0. A framing correction, found during research

The task brief asks "does Electron's `BrowserWindow` need a new URL?" — it
doesn't, because mobile is never loaded into a `BrowserWindow` at all. Today:

- **Desktop** runs inside Electron. `BrowserWindow` loads
  `out/renderer/index.html` from disk (or `src/renderer/index.html` via the
  Vite dev server). `src/preload/index.ts` runs in that window's isolated
  context and calls `contextBridge.exposeInMainWorld('cth', api)`, where
  `api` (`src/preload/index.ts:691-1799`, ~190 methods) is a flat object of
  `ipcRenderer.invoke(...)` wrappers.
- **Mobile** is served over plain HTTP to an actual phone browser. `src/main/index.ts`
  runs a `node:http` server (`ensureBrowserServer`, `src/main/index.ts:1826`)
  bound to `0.0.0.0:48003` (packaged) / `:48103` (dev). Requests to `/mobile/*`
  are routed (`src/main/index.ts:1856-1910`) to `resolveMobileStaticFile`,
  which reads raw files off disk — in dev straight from `src/mobile/`, in a
  packaged build from `out/mobile/` (copied verbatim by
  `tools/copy-main-assets.cjs:26-28`, no bundling). There is no
  `BrowserWindow` involved anywhere in that path; the phone is just an HTTP
  client. A React rewrite of mobile changes what gets served at `/mobile/*`,
  not any `BrowserWindow.loadURL` call.
- **There is already a third mode**, and it matters a lot for this plan: the
  same HTTP server also serves the **desktop** renderer bundle
  (`out/renderer`, `BROWSER_SERVER_ROOT`) to any browser that hits `/`, and
  pairs it with a WebSocket at `/bridge` (`setupBrowserSocketServer`,
  `src/main/index.ts:208`). `src/renderer/browser-bridge.js` (loaded only
  when `window.cth` isn't already defined by Electron's preload) reimplements
  `window.cth` over that WebSocket — same method names, same shapes, driven
  by a hand-written `INVOKE_CHANNELS`/`EVENT_CHANNELS` map (189 + 28 entries,
  `src/renderer/browser-bridge.js:5-320`). **This is the mechanism that makes
  "import desktop components into mobile" real**: a plain browser tab that
  isn't Electron at all can already get a working `window.cth` today, for
  the desktop app. Mobile just isn't plugged into it. See §4 risk #1 before
  reusing it as-is, though — it's currently unauthenticated.

## 1. Build system changes

**Recommendation: give `electron.vite.config.ts` a second, independent
renderer config**, using electron-vite's array form for `renderer` (it
accepts one config or an array — each with its own `root`, `build.outDir`,
`resolve.alias`, and plugin list). Do not add a second `input` entry to the
existing single renderer config; that shares one `outDir` and one alias
config across two apps that have different asset base paths and don't want
to accidentally cross-import.

```
renderer: [
  { /* existing desktop config, unchanged, outDir: out/renderer */ },
  {
    root: resolve(__dirname, 'src/mobile'),
    base: '/mobile/',                    // served under this path prefix, not '/'
    build: {
      outDir: resolve(__dirname, 'out/mobile'),
      rollupOptions: { input: resolve(__dirname, 'src/mobile/index.html') }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),   // reuse desktop components
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
]
```

Concretely:

- `src/mobile/index.html` stops being the shipped artifact and becomes a
  Vite entry HTML (a `<div id="root">` + `<script type="module" src="./main.tsx">`),
  same shape as `src/renderer/index.html` today.
- `base: '/mobile/'` is required — mobile is served at the `/mobile/*` path
  prefix on the shared HTTP server, not at the origin root like desktop is.
  Without it, Vite emits asset URLs (`/assets/index-xxxx.js`) that collide
  with desktop's own `/assets/*` on the same server/port.
- `tools/copy-main-assets.cjs:26-28` (`copyDir(src/mobile → out/mobile)`)
  gets replaced, not extended: once Vite builds mobile into `out/mobile`
  itself, a raw copy over the top would clobber the bundle. Keep a narrower
  copy step only for the *unbundled* PWA files that must stay static and
  byte-identical (manifest.json, any icons) — Vite's `publicDir` (pointed at
  a new `src/mobile/public/`) handles that natively and can replace the
  custom copy script entirely for anything under it.
- `resolveMobileStaticFile` (`src/main/index.ts:405-427`) still works as the
  file-serving fallback with no change — it already reads `out/mobile/**` by
  path, and doesn't care whether those files came from a raw copy or a Vite
  build. The dev-mode `sw.js` cache-buster override at
  `src/main/index.ts:1868-1878` also needs no change.
- **Dev mode is the one open question.** Desktop dev runs through
  electron-vite's dev server with HMR; whether mobile dev should run the
  same way (a second Vite dev server proxied under `/mobile/`) or stay on
  the current "edit `src/mobile`, reload phone" static-file flow (now
  pointed at a `vite build --watch` on the mobile config) is a call worth
  getting Dylan's input on before implementation — it changes the mobile
  dev loop, not just the build.
- `electron-builder.yml` needs **no change**. `files: [out/**, ...]` already
  ships everything under `out/`, and the `!**/*.{md,map,ts,tsx}` exclusion
  won't touch mobile's compiled `.js`/`.css` output (only the built HTML/JS
  ships, same as desktop today).

## 2. Component inventory

Static-analysis pass over `src/renderer/src/components/` (65 files):
grepped for direct `window.cth.` calls, cross-checked which of the resulting
"pure" set are PTY- or canvas-coupled by name/import. 47 of 65 files call
`window.cth` directly.

| Category | Meaning for mobile | Files (representative, not exhaustive) |
|---|---|---|
| **Safe to import directly** — no IPC, no PTY, no canvas | Works today through props alone; becomes real once wired to a data source | `PixelButton.tsx`, `PixelPanel.tsx`, `PixelBadge.tsx`, `Icon.tsx`, `Markdown.tsx`, `CopyButton.tsx`, `ProviderLogo.tsx`, `RecentText.tsx`, `SpritePortrait.tsx`, `SidebarTabs.tsx`, `SidebarSplitter.tsx`, `CommandBar.tsx`, `AgentNameEditor.tsx`, `BlockedBanner.tsx`, `QuitWarningModal.tsx`, `ToolWaterfall.tsx`, `IntegrationsRegistry.tsx`, `AbathurBooting.tsx`, `TouchedTab.tsx`, `UatPanel.tsx`, `RosterList.tsx`, `AgentCard.tsx` (but see caveat below) |
| **Needs `window.cth` via the browser-bridge** — same code works once §4 risk #1 (auth) is fixed | This is most of the app: `AskMeTab.tsx`, `TasksKanban.tsx`, `MessageQueueComposer.tsx`, `WorkersTab.tsx`, `CommandCenterPanel.tsx`, `SettingsModal.tsx`, `AgentDetailPanel.tsx`, `AgentRosterItem.tsx`, `AgentStrip.tsx`, `EditAgentModal.tsx`, `AddAgentModal.tsx`, `DelegationsTab.tsx`, `SkillsTab.tsx`, `MemoryPanel.tsx`, `MemoryGraphPanel.tsx`, `GitTab.tsx`, `FileTree.tsx`, `triggers/SchedulesSection.tsx`, `triggers/WebhooksSection.tsx`, `NearbyHivesPanel.tsx`, `HivePicker.tsx`, `HiveProfiles.tsx`, `ThreadsPanel.tsx`, `TaskDetailOverlay.tsx`, `OnboardingWizard.tsx`, `SetupPanel.tsx`, `ReviewPanel.tsx`, `QuickAskPanel.tsx`, `LocalDelegateSettings.tsx`, `McpDefaultsSettings.tsx`, `AiEnginesSettings.tsx`, `AgentControlStrip.tsx`, `AgentHoldButton.tsx`, `AppChromeControls.tsx`, `StatusBar.tsx`, `OfficeThemePicker.tsx`, `UpdateBadge.tsx`, `UpdateToast.tsx`, `SettingsHeroCard.tsx`, `ProfileWalkthrough.tsx` | (39 files total in this bucket) |
| **Desktop-only, no mobile equivalent planned** — PTY or canvas coupled; `browser-bridge.js` stubs every `*Pty*` method as `unsupportedAsync` (`src/renderer/browser-bridge.js:491-497`, `listPtys` returns `[]`) | Importing these gets a component that renders and silently does nothing | `TerminalView.tsx`, `PtyTerminalView.tsx`, `FullscreenTerminal.tsx`, `CodeEditor.tsx`, `terminalPool.ts`, `terminalAutomation.ts`, `terminalRecovery.ts`, `terminalSelection.ts`, `terminalFontSize.ts`, `ansiText.ts`, `termColor.ts`, `HiveScene.tsx` (PixiJS office floor — the parity audit already flagged this as reasonably desktop-only for screen-size reasons) |

Caveat on `AgentCard.tsx`: it doesn't call `window.cth` itself, but it wraps
`AgentRosterItem.tsx`, which does — so it inherits that dependency
transitively. Grep-for-direct-calls undercounts anything that only shows up
through composition; treat the "safe" column as a starting list to verify
per-component at port time, not a guarantee.

## 3. Migration sequence

Recommended order, least-risky first:

1. **Design tokens / CSS** — already done (`aa6fc15c`, "sync mobile CSS
   tokens to desktop"). No longer a blocker for this plan.
2. **Proof of concept: Tasks.** `TasksKanban.tsx` (1263 lines) already has a
   `mobile?: boolean` prop that switches it to a single-column layout — it
   was built for this and has sat unused. This is the lowest-risk, highest-
   signal first port: no new component design needed, just wiring
   (`window.cth` via the bridge, real navigation, the existing prop). If the
   browser-bridge auth gap (§4 risk #1) isn't fixed yet, Tasks can still be
   proven with a temporary dev-only unauthenticated bridge connection to
   validate the *rendering* approach before the auth work lands.
3. **Dispatch** — already brought into UX parity with `MessageQueueComposer`
   (`c0d746f5`, "align mobile Dispatch UX to desktop") at the markup/CSS
   layer. Natural second port: swap the hand-rolled form for the real
   `MessageQueueComposer.tsx` now that the UX model matches.
4. **For You (AskMe)** — `AskMeTab.tsx` is self-contained per the parity
   audit and mobile's version is currently missing the chat-thread UI and
   image attach that desktop already has; porting it closes a real feature
   gap, not just a code-sharing one.
5. **Workers** — functionally equivalent already per the prior feature
   audit, so this is a pure code-dedup port with low behavioral risk.
6. **Fleet/Agents** — highest-value but highest-effort: `AgentRosterItem.tsx`
   is 1105 lines and `CommandCenterPanel.tsx` is 1769; do this after the
   bridge/auth pattern is proven on 2-5 so mistakes are cheap.
7. **Settings, Schedules, Insights** — last. Largest desktop surface
   (`SettingsModal.tsx` is 2745 lines covering ~10 sections mobile doesn't
   have at all); port piecemeal, section by section, once the pattern is
   routine.

Each step's exit criterion should be "renders and functions identically to
today's hand-rolled mobile screen, verified on an actual phone," not just
"compiles" — mobile has real constraints (touch targets, viewport, the
multi-machine picker below) that desktop review won't catch.

## 4. Risk flags

1. **`/bridge` is unauthenticated today — do not point mobile at it as-is.**
   `setupBrowserSocketServer` (`src/main/index.ts:208-221`) accepts any
   WebSocket connection with no token check, and it grants the *entire*
   `window.cth` surface: arbitrary file read/write (`readFile`/`writeFile`),
   git checkout, process spawn (`spawnProcess`), config mutation, etc. It's
   reachable today because `BROWSER_SERVER_HOST = '0.0.0.0'` — anyone on the
   LAN who finds port 48003 can already open `/bridge` and get full IPC
   access; that's a pre-existing gap this migration doesn't create. But
   mobile's current `/api/*` transport **is** token-gated (`isMobileAuthed`,
   `src/main/index.ts:481-511`, checked against `ensureMobileApiSecret()`
   on every request and on the `/api/events` SSE stream). Wiring the new
   mobile React app to `/bridge` without first adding the same token check
   to the WebSocket upgrade would be a regression from "gated REST subset"
   to "ungated full IPC," for a client (a phone on a home/office network)
   that's explicitly designed to be used off the trusted machine. This has
   to be fixed in `setupBrowserSocketServer`/`handleBrowserClientMessage`
   before step 2 of §3 ships for real, not after.
2. **Multi-machine pairing breaks a naive "just use `window.cth`" port.**
   Mobile isn't only a phone-shaped view of localhost — `src/mobile/index.html`
   stores multiple paired machines in `localStorage` (`hive_machines`,
   `src/mobile/index.html:1402-1450`) and can point at a different Hive
   instance's host:port + token entirely. Desktop's `window.cth` (via
   preload or via `browser-bridge.js`) is implicitly bound to one origin.
   The mobile React app needs the bridge client built as an instance
   parameterized by `{ baseUrl, token }` and provided through context/props,
   not a bare global `window.cth`, or switching machines silently breaks.
3. **PTY and canvas components are dead weight if imported as-is.**
   `browser-bridge.js` stubs every PTY method (`unsupportedAsync`,
   `src/main/index.ts` preload equivalent at lines 491-497) — a ported
   `PtyTerminalView` would mount, call `spawnPty`, and silently do nothing.
   Keep those components out of the shared-import set (§2 table, third row)
   until/unless there's a real design for a mobile terminal view (the
   parity audit already treats no-PTY-on-mobile as acceptable).
4. **The channel map is hand-maintained and already 189+28 entries deep.**
   `browser-bridge.js`'s `INVOKE_CHANNELS`/`EVENT_CHANNELS` (lines 5-320)
   are a manually kept-in-sync mirror of `src/preload/index.ts`'s `api`
   object (lines 691-1799) — nothing generates one from the other. Every
   future IPC method added to preload and forgotten in `browser-bridge.js`
   already silently breaks "open in browser" today; routing mobile through
   the same bridge doubles the blast radius of that omission (a missed
   channel now also breaks a real phone user, not just an edge-case desktop
   feature). Worth flagging to whoever owns that file as a candidate for
   codegen, independent of this migration.
5. **Vite config isolation matters.** Because both desktop and mobile now
   build through the same `electron.vite.config.ts`, a change made "for
   mobile" (an alias, a plugin, a `define`) in a merged/shared renderer
   config risks silently changing desktop's build too. §1's recommendation
   to use electron-vite's array-of-renderer-configs form (fully separate
   `root`/`outDir`/`alias`/`plugins` per app) is specifically to keep that
   blast radius at zero — don't collapse them into one config later "to
   simplify."
6. **CSS bleed.** Desktop components pull in `src/renderer/src/design/tokens.css`
   and other desktop-scoped global styles (sidebar widths, hover states
   tuned for mouse input, etc.). Importing a component doesn't guarantee it
   looks right at phone width — `TasksKanban.tsx`'s `mobile` prop is the
   existing pattern (component owns its own responsive behavior via a prop,
   not via the importer fighting its CSS); components without an equivalent
   prop will need one added as part of their port, not worked around from
   the mobile side.

## Suggested next step

This plan assumes the browser-bridge auth fix (risk #1) is a prerequisite,
not a parallel-track nice-to-have — recommend scoping it as its own small
phase 2a before phase 2b (the Tasks proof-of-concept), since building real
mobile screens against an intentionally-insecure transport and then
retrofitting auth is more rework than doing it in the right order.
