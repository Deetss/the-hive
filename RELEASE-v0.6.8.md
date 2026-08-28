# The Hive v0.6.8

Integration tip: 5d30b08 (on integration/fork-v1, base 0.6.7 03663fb).
Typecheck: node + web PASS (zero errors). Build: dist:win OK, NSIS + portable.

## Folded (1 feature, zero merge conflicts)
- **governor-policy-config-build** (jim-codex, 5e65a1b / b5da851) — adds `resolveGovernorPolicy` to normalize per-profile policies from config and rethreads the main loop to respect those per-profile gates before dispatch/offload.

## Artifacts (TheHive/dist/)
- The-Hive-0.6.8-win-x64-setup.exe (136.5M) + .blockmap
- The-Hive-0.6.8-win-x64-portable.exe (136.3M)
- latest.yml

## Gate
Dylan installs + validates, then publishes. No auto-publish.
