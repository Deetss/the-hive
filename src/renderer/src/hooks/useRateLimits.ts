import { useEffect, useState } from 'react';

export interface RateLimitEntry {
  pct: number;
  resetsAt: string; // ISO timestamp
}

export interface AgentRateLimits {
  fiveHour: RateLimitEntry | null;
  sevenDay: RateLimitEntry | null;
  ts: number;
}

/**
 * Live per-agent rate-limit data from the CC status line JSON
 * (.rate_limits.five_hour / .seven_day), forwarded by hooks.ts on every
 * Status tick. Returns an empty map until the first tick arrives.
 */
export function useRateLimits(): Record<string, AgentRateLimits> {
  const [limits, setLimits] = useState<Record<string, AgentRateLimits>>({});

  useEffect(() => {
    let alive = true;
    window.cth?.rateLimitsSnapshot?.().then((snap) => {
      if (alive) setLimits(snap);
    }).catch(() => { /* collector not up */ });

    const unsub = window.cth?.onRateLimitsUpdate?.((payload) => {
      if (!alive) return;
      const { agentId, ...entry } = payload;
      setLimits((prev) => ({ ...prev, [agentId]: entry }));
    });

    return () => { alive = false; unsub?.(); };
  }, []);

  return limits;
}

/** Pace-color for a rate-limit meter: matches statusline-command.sh pace_color logic. */
export function ratePaceColor(pct: number, resetsAtIso: string, windowMins: number): string {
  if (pct >= 90) return 'var(--cth-coral)';
  if (pct < 10) return 'var(--cth-mint)';
  const resetsAtMs = new Date(resetsAtIso).getTime();
  if (!Number.isFinite(resetsAtMs)) return 'var(--cth-mint)';
  const windowMs = windowMins * 60 * 1000;
  const windowStartMs = resetsAtMs - windowMs;
  const elapsedMins = Math.max(1, (Date.now() - windowStartMs) / 60000);
  const ratio = (pct * windowMins) / (elapsedMins * 100);
  if (ratio >= 1.2) return 'var(--cth-coral)';
  if (ratio >= 0.8) return 'var(--cth-lemon)';
  return 'var(--cth-mint)';
}

/** Format the time until a rate-limit window resets: /Xh Ym or /Ym. */
export function fmtReset(resetsAtIso: string): string {
  const minsLeft = Math.max(0, Math.round((new Date(resetsAtIso).getTime() - Date.now()) / 60000));
  const h = Math.floor(minsLeft / 60);
  const m = minsLeft % 60;
  return h > 0 ? `/${h}h ${m}m` : `/${m}m`;
}
