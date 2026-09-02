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

## Update, 2026-09-02: the "unverified" path resolves without a code change

Dylan's answer ("this was all in my existing config") checks out literally.
`~/.codex/config.toml` (his real, personal one — not anything Hive-specific)
already has the full Azure Foundry wiring:

```
model = "gpt-5-mini"
model_provider = "azure-foundry"

[model_providers.azure-foundry]
name = "Azure AI Foundry"
base_url = "https://lots-open-ai.services.ai.azure.com/openai/v1"
env_key = "AZURE_OPENAI_KEY"
wire_api = "responses"
requires_openai_auth = false

[[models]]
id = "gpt-5-mini"
name = "gpt-5-mini (Azure)"
model_provider = "azure-foundry"
```

Two things this changes about the plan:

1. **`installCodexHooks` (`hive.ts:~2463`) already copies this file verbatim**
   into every per-agent `CODEX_HOME/config.toml` before appending the hive
   `[hooks]`/`approval_policy`/trust sections — it reads
   `join(userHome, 'config.toml')` as the seed, not a stripped-down template.
   So `model_provider`/`model_providers`/`[[models]]` all survive into a hive
   codex worker's config untouched. Nothing to wire here.
2. **The API key needs no `apiKeyRef`/`safeStorage` plumbing at all.**
   `AZURE_OPENAI_KEY` is set as a Windows **User**-level environment variable
   (`setx`-style, persisted — confirmed via `[Environment]::GetEnvironmentVariable(...,"User")`),
   so it's already in the Electron main process's `process.env`, and
   `buildPtyEnv` (`ptyEnv.ts`) forwards the full parent env to every agent PTY
   except Claude-identity-prefixed keys. It reaches a codex worker for free.

Net: the `RuntimeProfile.baseUrl`/`apiKeyRef` → `OPENAI_BASE_URL`/`OPENAI_API_KEY`
injection (`index.ts:~5559`) is real and works, but it's the wrong mechanism for
this setup — it only overrides the *default* `openai` provider. Dylan's config
uses a **named custom provider** (`azure-foundry`), which Codex resolves
entirely from `config.toml`, ignoring `OPENAI_BASE_URL`. Setting
`baseUrl`/`apiKeyRef` on the two existing "Azure gpt-5-mini" / "Azure
gpt-5-codex" `RuntimeProfile`s (`the-hive/config.json`) would be a no-op at
best. Skipped it. The `AiEnginesSettings.tsx` UI gap above is still real but
now looks like a separate, lower-priority feature (redirecting the *default*
provider), not a blocker for Dylan's actual ask.

**One real gap found:** the personal `config.toml`'s `[[models]]` table only
maps `gpt-5-mini` → `azure-foundry`. The "Azure gpt-5-codex" `RuntimeProfile`
(`the-hive/config.json`, id `dd196bb7-...`) has no matching entry. The
top-level `model_provider = "azure-foundry"` default may still route an
unmapped model id there correctly — genuinely unverified, not guessed at.
Raised as humanQA on the task card rather than either assuming it's fine or
editing Dylan's personal codex config on spec.

**Not done, deliberately:** no live `codex exec` call against the real Foundry
endpoint. That's a network request to an external system per the worker
external-action gate, and this task's dispatch didn't name that command
explicitly — left for Dylan (or an Overmind-approved follow-up) to trigger by
just using the existing "Azure gpt-5-mini" profile.
