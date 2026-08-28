# The Hive v0.6.5

Integration tip: 707605e (on integration/fork-v1, base 0.6.4 da3470e).
Typecheck: node + web PASS (zero errors). Build: dist:win OK, NSIS + portable.

## Folded (4 features, zero merge conflicts)
- **governor-policy-config** (jim-codex, 183753b) — user-configurable governor policy: per-profile load + thresholds, independent per-window tripMode, snapshot/override handling; migration mirrors legacy per-window caps (back-compatible).
- **open-in-browser** (dwight-codex, 9d9d77b) — serve the renderer over localhost so the UI opens in a desktop browser; menu/IPC launch control.
- **first-run-profile-onboarding** (jim-codex, 4069aea) — first-run profile walkthrough modal (work + personal Claude accounts + codex profile), onboardingComplete flag, re-openable from settings.
- **mobile-responsive** (dwight-codex, 9326a36) — responsive single-column touch layout for floor/roster/tasks/detail at phone width (chunk 1 of mobile-remote-manage; pairs with open-in-browser).

## Artifacts (TheHive/dist/)
- The-Hive-0.6.5-win-x64-setup.exe (137M) + .blockmap
- The-Hive-0.6.5-win-x64-portable.exe (137M)
- latest.yml

## Gate
Dylan installs + validates, then publishes. No auto-publish.
