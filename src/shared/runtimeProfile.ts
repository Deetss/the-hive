/**
 * Agent RUNTIME PROFILE — a reusable, named bundle of "which engine + which
 * account + which model launches an agent", selectable per-agent at spawn time.
 *
 * DISTINCT from a HIVE profile (`src/main/profiles.ts`), which isolates a whole
 * INSTANCE (harnessHome + userData). A runtime profile picks what ONE agent runs
 * on inside a hive; a hive profile picks which hive you are in.
 *
 * v1 scope (Claude multi-account): the load-bearing field is `claudeConfigDir` —
 * a per-account `CLAUDE_CONFIG_DIR` (its own `~/.claude` login) so two Claude
 * agents can run under two different accounts. It is wired into the agent's spawn
 * env in `hive.ensureAgent` (the per-agent-env-wins seam, `ptyEnv.ts`). Non-Claude
 * engines already spawn via the provider machinery; per-engine account isolation
 * for them is v2 (deferred).
 *
 * SECRETS: a profile is METADATA only. `claudeConfigDir` is a PATH (a pointer to a
 * login dir that lives OUTSIDE the synced hive repo — in userData or an absolute
 * path the operator logged into); no key/token is ever stored on the profile.
 */
import type { AgentProvider } from './agentProvider';

export interface RuntimeProfile {
  /** Stable id (uuid). */
  id: string;
  /** Human label shown in the picker (e.g. "Claude · work account"). */
  name: string;
  /** Engine this profile launches. */
  provider: AgentProvider;
  /** Model id for that provider; unset = the provider/global default. */
  model?: string;
  /** Optional full command-line override; unset = the provider preset's binary. */
  command?: string;
  /** Extra argv flags appended at spawn; unset = none. */
  extraArgs?: string[];
  /** v1 account isolation for Claude: the per-account CLAUDE_CONFIG_DIR (its own
   *  login dir). A PATH pointer only; never a credential, kept outside the synced repo. */
  claudeConfigDir?: string;
  /** v2 cloud endpoint: an OpenAI-compatible base URL (e.g. Azure AI Foundry).
   *  Injected as OPENAI_BASE_URL at spawn. Validated via isSafeHttpUrl. */
  baseUrl?: string;
  /** Pointer into safeStorage: "profile:<id>:apikey". Key injected as OPENAI_API_KEY
   *  at spawn (MAIN-ONLY). Never stored in config.json or the synced hive repo. */
  apiKeyRef?: string;
  /** When true, isSafeHttpUrl allows RFC-1918 addresses in baseUrl (for local testing).
   *  Defaults to false (cloud-only). */
  allowPrivate?: boolean;
  createdAt: number;
}

/** Validate + normalize an untrusted value into a RuntimeProfile (drops junk
 *  fields, trims strings). Returns null when it lacks the required id/name/provider,
 *  so callers can filter a stored array without trusting its shape. */
export function normalizeRuntimeProfile(x: unknown): RuntimeProfile | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  const provider = typeof r.provider === 'string' ? (r.provider.trim() as AgentProvider) : '';
  if (!id || !name || !provider) return null;
  const out: RuntimeProfile = {
    id,
    name,
    provider: provider as AgentProvider,
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0
  };
  if (typeof r.model === 'string' && r.model.trim()) out.model = r.model.trim();
  if (typeof r.command === 'string' && r.command.trim()) out.command = r.command.trim();
  if (Array.isArray(r.extraArgs)) {
    const args = r.extraArgs.filter((a): a is string => typeof a === 'string' && !!a.trim()).map((a) => a.trim());
    if (args.length) out.extraArgs = args;
  }
  if (typeof r.claudeConfigDir === 'string' && r.claudeConfigDir.trim()) out.claudeConfigDir = r.claudeConfigDir.trim();
  if (typeof r.baseUrl === 'string' && r.baseUrl.trim()) out.baseUrl = r.baseUrl.trim();
  if (typeof r.apiKeyRef === 'string' && r.apiKeyRef.trim()) out.apiKeyRef = r.apiKeyRef.trim();
  if (r.allowPrivate === true) out.allowPrivate = true;
  return out;
}

/** Filter a stored array down to valid profiles. */
export function normalizeRuntimeProfiles(list: unknown): RuntimeProfile[] {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeRuntimeProfile).filter((p): p is RuntimeProfile => p !== null);
}
