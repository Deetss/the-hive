# The Hive v0.6.59

A multi-agent autonomous coding hive for Claude, Antigravity, and Codex.

### Added

- Add Linux .deb build target
- Add Respawn (↺) button to agent fleet cards in UI (archives session & resumes fresh from memory.md)
- Surface open UAT checklist and humanQA items in UI via For You and tasks badge counts and actionable top alert banner
- Wire Bee-casso animated worker bee entity sprites into the Hive office floor desks
- Implement 3-tier priority (urgent/normal/backlog) across hive router delivery, PROTOCOL.md schema, mobile and desktop dispatch UI, mobile and desktop Ask Me lists, and God inbox scan order

### Changed

- Replace non-semantic monospace font usage with proportional UI typography across FullscreenTerminal, MessageQueueComposer, McpDefaultsSettings, and DelegationsTab
- Default office theme is now **The Hive**, and TV-show themes ship enabled so new installs open straight into BeeYoncé's honeycomb floor.
- Hive theme now ships a painted honeycomb floor, wax wall panels, and hex pod desks instead of the temporary overlay, while honey task boards keep the bursting pipe, honey vat, and comb-note visuals.
- Hive theme textures reworked: handcrafted PixiJS honeycomb floor, wax wall panels, and desk pods with hive wall accents.

### Fixed

- Fix query routing bug where human query replies from god appeared in For You instead of Ask
- Fix Overmind (Queen) respawn button flow to directly launch fresh session via `spawnAgentCore`
- Fix macOS release workflow failure by disabling auto-discovered code signing when cert secrets are absent
- Fix procedural honeycomb office floor hex geometry and alignment to eliminate visible seams between tiles
- Fix raw agent IDs like "god" displaying across For You, Activity, and Tasks UI by resolving to registry display names
- Add clear and dismiss actions for open humanQA items in For You tab and top alert banner
