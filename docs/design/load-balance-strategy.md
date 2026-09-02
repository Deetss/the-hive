# Load-Balancing Hive Workers: Claude vs Codex/Foundry

_Findings, September 2, 2026_

## 1. What Codex currently points at

Codex workers run under a per-agent `CODEX_HOME` (`hive.ts:2324+`) seeded from the
user's real `~/.codex` login (`auth.json` copied in, `config.toml` regenerated with
our `[hooks]` + `approval_policy` additions). By default this means Codex
authenticates as the user's own ChatGPT/OpenAI account — there is no per-agent
routing to a different backend out of the box.

A **v2 "cloud endpoint" mechanism already exists** on `RuntimeProfile`
(`src/shared/runtimeProfile.ts`) and is fully wired on the backend:

- `RuntimeProfile.baseUrl` — an OpenAI-compatible base URL (Azure AI Foundry is the
  named use case in the doc comment).
- `RuntimeProfile.apiKeyRef` — a `safeStorage` pointer (`profile:<id>:apikey`), never
  the literal key.
- `RuntimeProfile.allowPrivate` — allow RFC-1918 addresses for local/LAN testing.
- At spawn (`index.ts:5545-5561`), if the profile has both `baseUrl` and
  `apiKeyRef`, and `isSafeHttpUrl` re-validates the URL, the harness injects
  `OPENAI_BASE_URL` + `OPENAI_API_KEY` into that agent's process env.
- IPC is in place to set/clear/check the key and validate the URL:
  `profile:setApiKey`, `profile:removeApiKey`, `profile:hasApiKey`,
  `profile:isSafeUrl` (all in `index.ts`, all exposed on `window.cth` in
  `preload/index.ts:1547-1557`).

**Gap: no UI exposes this today.** Neither `AiEnginesSettings.tsx` (the profile
list/add form) nor `ProfileWalkthrough.tsx` (onboarding) render an input for
`baseUrl`, `apiKeyRef`, or `allowPrivate`, and neither calls the `profile:*` IPCs
above. The data model and spawn-time plumbing are done; the front end to let a
human type in a Foundry URL and paste a key is not. That's the smallest next PR if
this gets prioritized.

**Unverified:** whether the Codex CLI itself actually honors `OPENAI_BASE_URL` for
its default `openai` model provider, or whether it needs a `model_providers` entry
written into `config.toml` instead. Our `config.toml` regeneration (`hive.ts:2455+`)
currently only touches `[hooks]`/`approval_policy`/trust, not provider routing. This
needs a manual test against a real Foundry endpoint before relying on it.

## 2. Best task types for Codex vs Claude

Rough split based on how the hive already frames the two engines:

- **Claude** — orchestration (Overmind), anything needing our tool ecosystem
  (edgentic delegation, hive protocol conventions, humanQA/tasks.json discipline),
  and any task where correctness on ambiguous/cross-cutting decisions matters.
- **Codex** — bounded, well-specified coding tasks: a single file's fix, a scoped
  refactor, boilerplate/test generation — the same shape of work `edgentic-task`
  already targets, but with actual code-editing tool access Codex has and edgentic
  doesn't. Good candidate for "read the spec, write the diff, run the verify
  command" work where a human or CI gate checks the result.
- Not a good fit for Codex today: anything depending on hive-specific conventions
  it hasn't been oriented on as deeply, or long-running orchestration.

This split is a hypothesis, not measured — telemetry work in
`token-efficiency-plan.md` (per-agent token/cost breakdown) would let us confirm it
with real spend data once instrumented.

## 3. What Dylan needs to provide for Foundry config

To actually route a Codex worker's spend through Azure AI Foundry instead of
Claude:

1. **Foundry base URL** — the OpenAI-compatible endpoint URL for the deployed
   model (e.g. `https://<resource>.openai.azure.com/openai/deployments/<deployment>`
   or the Foundry-specific equivalent — exact shape depends on how the deployment
   is exposed).
2. **Model/deployment name** — whatever `RuntimeProfile.model` should be set to so
   Codex requests the right deployment.
3. **API key** — to be stored via `profile:setApiKey`, never typed into `config.json`
   directly.

Pushed as a `humanQA` ask on the task card (see below) rather than guessed.

## Open question

Should this session build the missing `baseUrl`/`apiKeyRef` UI fields into
`AiEnginesSettings.tsx` as a follow-up task once Dylan confirms the Foundry
endpoint, or is that already someone else's card? Flagged to Abathur separately.
