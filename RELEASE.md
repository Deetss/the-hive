# The Hive v0.6.65

A multi-agent autonomous coding hive for Claude, Antigravity, and Codex.

### Added

- **GSD Skill & Subagent Discovery (`5462fb0b`):** Collapsible GSD agent picker in the spawn system and automatic PERSONA system prompt injection for detected agent roles.
- **Custom Model Endpoint UI (`89ce5c8a`):** Base URL and cloud API key configuration fields in AI Engine Settings for custom runtime profiles.
- **Hive GSD Planning UI (`7f19047a`):** Dedicated Plans tab in Command Center and plan-to-task kanban breadcrumbs.
- **Mobile Bridge WebSocket Authentication (`b73da0e2`):** Token-gated `/bridge` WebSocket with constant-time secret verification matching `/api/*` REST security.
- **Focus Mode Permission Prompts (`79bbe976`):** CLI permission prompts and approval banners surfaced directly in focus mode.

### Changed

- **Review Gate Enforcement (`9ef93b36`):** Worker completion messages now transition tasks to `review` status instead of directly closing to `done`, ensuring human/overmind UAT verification.

### Fixed

- **HumanQA Chat Delivery & Overmind Routing (`ee643595`):** Full end-to-end chat message delivery to agent inboxes with automatic directory creation, Overmind fallback for unassigned tasks, and resolution of "waiting for unassigned" banners.
- **Outline Knowledge Base MCP Worker Fix (`830651db`):** Normalized Outline Streamable HTTP MCP endpoints to `/mcp`, resolving connection errors across all agent worker sessions.

