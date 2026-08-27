/**
 * Fallback-only model → price table (USD per million tokens).
 *
 * The LIVE telemetry path does NOT use this. Claude Code emits a pre-computed,
 * per-model `cost_usd` on every `api_request` log and a `claude_code.cost.usage`
 * metric (verified by the 7A.1 spike), so the collector (`telemetry.ts`) trusts
 * Claude's own figure. This table exists solely for the OFFLINE transcript
 * reconciler (`transcript.ts`), which runs when telemetry is off and must
 * estimate cost from raw token counts.
 *
 * It supersedes the old hard-coded Sonnet-for-everyone constants that lived in
 * `transcript.ts` (cost bug #1 — Opus undercosted ~5×, Haiku overcosted). Prices
 * are now matched per model family. This is the ONE place per-model pricing
 * lives; both the transcript backend and the collector's fallback import it.
 */

/** USD per million tokens for one model family. */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

// Anthropic list prices, USD per million tokens. Approximate, fallback-only —
// the live path uses Claude's own per-model cost, so drift here is harmless.
const OPUS: ModelPrice = { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 };
const SONNET: ModelPrice = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 };
const HAIKU: ModelPrice = { inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, cacheWritePerM: 1.0 };

// OpenAI tier (gpt-4o family) — 2024-05 pricing, fallback-only.
const GPT4O: ModelPrice = { inputPerM: 5, outputPerM: 15, cacheReadPerM: 0, cacheWritePerM: 0 };
const GPT4O_MINI: ModelPrice = { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0, cacheWritePerM: 0 };
const GPT35: ModelPrice = { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0, cacheWritePerM: 0 };

// Local/offline fallback — treat as zero-cost for accounting purposes.
const ZERO_COST: ModelPrice = { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };

/** When the model id is unknown, assume Sonnet (the historical default). */
const DEFAULT_PRICE: ModelPrice = SONNET;

/**
 * Strip Claude Code's variant suffix so `claude-opus-4-8[1m]` (the form the
 * `token.usage` metric carries) and `claude-opus-4-8` (the base id the
 * `api_request` log carries) resolve to the same family. Case is preserved;
 * matching is done case-insensitively in `priceFor`.
 */
export function normalizeModel(model: string | undefined | null): string {
  return (model ?? '').trim().replace(/\[[^\]]*\]\s*$/, '');
}

const PROVIDER_ALIASES: Record<string, 'anthropic' | 'openai' | 'ollama'> = {
  claude: 'anthropic',
  anthropic: 'anthropic',
  'anthropic-compat': 'anthropic',
  'anthropic-compatible': 'anthropic',
  'azure-claude': 'anthropic',
  codex: 'openai',
  openai: 'openai',
  'openai-compat': 'openai',
  'openai-compatible': 'openai',
  'azure-openai': 'openai',
  azure: 'openai',
  ollama: 'ollama'
};

const OPENAI_PATTERNS: Array<{ test: RegExp; price: ModelPrice }> = [
  { test: /gpt-4o-mini/, price: GPT4O_MINI },
  { test: /gpt-4\.1-mini/, price: GPT4O_MINI },
  { test: /gpt-4\.1/, price: GPT4O },
  { test: /gpt-4o/, price: GPT4O },
  { test: /gpt-4/g, price: GPT4O },
  { test: /gpt-3\.5/, price: GPT35 }
];

/** Resolve a model id (and optional provider) to its price row by family. */
export function priceFor(model: string | undefined | null, provider?: string | null): ModelPrice {
  const m = normalizeModel(model).toLowerCase();
  const provKey = provider ? PROVIDER_ALIASES[provider.toLowerCase()] : undefined;

  if (!provKey || provKey === 'anthropic') {
    if (m.includes('opus')) return OPUS;
    if (m.includes('haiku')) return HAIKU;
    if (m.includes('sonnet')) return SONNET;
    if (provKey === 'anthropic') return DEFAULT_PRICE;
  }

  if (provKey === 'openai') {
    for (const entry of OPENAI_PATTERNS) {
      if (entry.test.test(m)) return entry.price;
    }
    return GPT35;
  }

  if (provKey === 'ollama') return ZERO_COST;

  // fall back to pattern match regardless of provider if the model string hints at a Claude tier
  if (m.includes('opus')) return OPUS;
  if (m.includes('haiku')) return HAIKU;
  if (m.includes('sonnet')) return SONNET;
  if (m.includes('gpt-4o-mini')) return GPT4O_MINI;
  if (m.includes('gpt-4o') || m.includes('gpt-4.1')) return GPT4O;
  if (m.includes('gpt-3.5')) return GPT35;

  return provKey === 'ollama' ? ZERO_COST : DEFAULT_PRICE;
}

/** Token split used by the cost estimator (matches `AgentUsage` token fields). */
export interface TokenSplit {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Estimate USD cost for a token split using the model's fallback price row.
 * Used only by the transcript reconciler; the live path trusts Claude's cost.
 */
export function estimateCostUsd(model: string | undefined | null, tokens: TokenSplit, provider?: string | null): number {
  const p = priceFor(model, provider);
  return (
    (tokens.inputTokens / 1_000_000) * p.inputPerM +
    (tokens.outputTokens / 1_000_000) * p.outputPerM +
    (tokens.cacheReadTokens / 1_000_000) * p.cacheReadPerM +
    (tokens.cacheWriteTokens / 1_000_000) * p.cacheWritePerM
  );
}
