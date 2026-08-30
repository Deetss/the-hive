import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import { useFleetTelemetry, totalTokens, type BreakerState } from '@/hooks/useTelemetry';
import { useRateLimits, ratePaceColor, fmtReset } from '@/hooks/useRateLimits';
import { inferAgentProvider, providerPreset, type RuntimeProfile } from '@/store/config';

/**
 * Persistent bottom status line: live hive+fleet state at a glance.
 *
 * Reads the SAME sources the rest of the app already uses: the zustand roster
 * (`agents`, `messageQueues`) and the OTel telemetry hook
 * (`useFleetTelemetry`: per-agent usage samples + breaker state). No new IPC:
 * everything here is already streamed to the renderer.
 *
 * "pending" count = outgoing message queue (messages parked for busy agents),
 * NOT the agents' on-disk hive inbox. Aggregate per-agent inbox reads would
 * require N IPC calls per render; this is the cheapest live proxy and the
 * tooltip says so.
 *
 * Parity with Dylan's CC statusline-command.sh (fleet-adapted):
 *   engine/model: selected agent's engine (Claude / Codex / agy / Antigravity) + model
 *   dir:branch: selected agent's cwd basename + git branch (async, compact)
 *   5h/7d rate limits: hooks.ts reads rate_limits from the CC status JSON and pushes
 *     via hive:rateLimitsUpdate. Chips render when CC includes the field (non-zero usage).
 *   WORK/PERSONAL badge: derived from CLAUDE_CONFIG_DIR basename via getConfig().accountBadge.
 *   loc (edgentic savings): NOT available — edgentic runs on remote Jetson; usage.log
 *     has no accessible local path.
 *   vim mode: NOT available — .vim.mode from Status JSON not forwarded by main.
 */

type Health = 'healthy' | 'steering' | 'constrained' | 'stopped';
type GovernorMode = 'green' | 'yellow' | 'red';
type GovernorPayload = { mode: GovernorMode; reason?: string };

const HEALTH_RANK: Record<Health, number> = {
  healthy: 0, steering: 1, constrained: 2, stopped: 3
};

function govColor(mode: GovernorMode): string {
  if (mode === 'red') return 'var(--cth-coral)';
  if (mode === 'yellow') return 'var(--cth-lemon)';
  return 'var(--cth-mint)';
}

function govWindow(reason?: string): string | null {
  if (!reason) return null;
  if (reason.startsWith('5h:')) return '5h';
  if (reason.startsWith('7d:')) return '7d';
  return null;
}

function healthColor(level: Health): string {
  if (level === 'constrained' || level === 'stopped') return 'var(--cth-coral)';
  if (level === 'steering') return 'var(--cth-lemon)';
  return 'var(--cth-mint)';
}

/** 4-cell filled/empty glyph bar. */
function ctxBar(pct: number): string {
  const filled = Math.min(4, Math.round(pct / 25));
  return '█'.repeat(filled) + '░'.repeat(4 - filled);
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n === 0) return '$0.00';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return '<$0.01';
}

const tail = (p: string) => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? p;

export function StatusBar() {
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const messageQueues = useStore((s) => s.messageQueues);
  const { samples, rate, breakers } = useFleetTelemetry();
  const rateLimits = useRateLimits();

  // One-time read of app-wide badge + profiles for per-agent badge resolution.
  const [accountBadge, setAccountBadge] = useState<'WORK' | 'PERSONAL' | null>(null);
  const [billingMode, setBillingMode] = useState<'subscription' | 'api' | null>(null);
  const [runtimeProfiles, setRuntimeProfiles] = useState<RuntimeProfile[]>([]);
  useEffect(() => {
    window.cth?.getConfig?.().then((c) => {
      setAccountBadge(c.accountBadge ?? null);
      setBillingMode(c.billingMode ?? null);
      setRuntimeProfiles(c.runtimeProfiles ?? []);
    }).catch(() => {});
  }, []);

  const [governor, setGovernor] = useState<GovernorPayload | null>(null);
  useEffect(() => {
    window.cth?.governorSnapshot?.().then((snap) => {
      setGovernor({ mode: snap.mode });
    }).catch(() => {});
    const off = window.cth?.onGovernorMode?.((payload) => {
      setGovernor({ mode: payload.mode, reason: payload.reason });
    });
    return () => { off?.(); };
  }, []);

  const live = useMemo(() => agents.filter((a) => a.ptyId && !a.archived), [agents]);

  // Selected agent (or god as fallback) for per-agent context chips.
  const focusAgent = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? agents.find((a) => a.isOvermind) ?? agents[0] ?? null,
    [agents, selectedId]
  );

  // Engine and model clarity: primary information for the active/focused agent.
  const engineInfo = useMemo(() => {
    if (!focusAgent) return null;
    const provider = inferAgentProvider(focusAgent.command, focusAgent.provider);
    const preset = providerPreset(provider);
    const engineName = preset.label;
    const rawModel = focusAgent.model || '';
    const modelName = rawModel
      ? rawModel.replace(/^claude-3-5-/, '').replace(/^claude-3-7-/, '').replace(/^claude-3-/, '').replace(/^gemini-2\.5-/, '').replace(/^gpt-/, '')
      : 'default';
    return { engineName, modelName, rawModel: rawModel || 'default' };
  }, [focusAgent]);

  // Resolve the badge for the currently focused agent.
  // Uses its profileId → runtimeProfiles.claudeConfigDir if available;
  // falls back to the app-wide CLAUDE_CONFIG_DIR badge otherwise.
  const displayBadge = useMemo<'WORK' | 'PERSONAL' | null>(() => {
    if (!accountBadge) return null;
    if (focusAgent?.profileId) {
      const profile = runtimeProfiles.find((p) => p.id === focusAgent.profileId);
      if (profile?.claudeConfigDir) {
        const dir = profile.claudeConfigDir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
        return dir === '.claude-personal' ? 'PERSONAL' : 'WORK';
      }
    }
    return accountBadge;
  }, [focusAgent?.profileId, runtimeProfiles, accountBadge]);

  // Async git branch for the focused agent's cwd.
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    const cwd = focusAgent?.worktreePath ?? focusAgent?.cwd;
    if (!cwd) { setBranch(null); return; }
    let cancelled = false;
    window.cth?.gitBranch?.(cwd).then((r) => {
      if (cancelled) return;
      setBranch('current' in r && r.current ? r.current : null);
    }).catch(() => setBranch(null));
    return () => { cancelled = true; };
  }, [focusAgent?.id, focusAgent?.cwd, focusAgent?.worktreePath]);

  const { tokens, usd, tokPerMin } = useMemo(() => {
    let t = 0, d = 0, r = 0;
    for (const a of live) {
      const s = samples[a.id];
      if (s) { t += totalTokens(s); d += s.usd; }
      r += rate[a.id] ?? 0;
    }
    return {
      tokens: Number.isFinite(t) ? t : 0,
      usd: Number.isFinite(d) ? d : 0,
      tokPerMin: Number.isFinite(r) ? r : 0,
    };
  }, [live, samples, rate]);

  const worst = useMemo<BreakerState | null>(() => {
    let acc: BreakerState | null = null;
    for (const a of live) {
      const b = breakers[a.id];
      if (b && (!acc || HEALTH_RANK[b.level] > HEALTH_RANK[acc.level])) acc = b;
    }
    return acc;
  }, [live, breakers]);

  const armedCount = useMemo(
    () => live.filter((a) => {
      const l = breakers[a.id]?.level;
      return l === 'steering' || l === 'constrained' || l === 'stopped';
    }).length,
    [live, breakers]
  );

  const queued = useMemo(
    () => Object.values(messageQueues).reduce((n, q) => n + (q?.length ?? 0), 0),
    [messageQueues]
  );

  // Fleet-worst rate limits among LIVE agents only (same filter as ctxPct).
  // rateLimitsById is never pruned, so dead agents would linger; scope to live
  // to prevent a killed agent's stale high-% from inflating the meter forever.
  const { worstFiveHour, worstSevenDay } = useMemo(() => {
    // Which Claude account an agent belongs to, by the same rule as displayBadge.
    const accountOf = (profileId?: string): 'WORK' | 'PERSONAL' | null => {
      if (profileId) {
        const profile = runtimeProfiles.find((p) => p.id === profileId);
        if (profile?.claudeConfigDir) {
          const dir = profile.claudeConfigDir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
          return dir === '.claude-personal' ? 'PERSONAL' : 'WORK';
        }
      }
      return accountBadge;
    };
    const byId = new Map(live.map((a) => [a.id, a]));
    let fh: { pct: number; resetsAt: string } | null = null;
    let sd: { pct: number; resetsAt: string } | null = null;
    for (const [agentId, entry] of Object.entries(rateLimits)) {
      const a = byId.get(agentId);
      if (!a) continue;
      // Scope the meters to the focused account so a WORK badge never shows
      // PERSONAL's 5h/7d usage (and vice-versa). Without a resolvable badge,
      // fall back to fleet-worst.
      if (displayBadge && accountOf(a.profileId) !== displayBadge) continue;
      if (entry.fiveHour && (!fh || entry.fiveHour.pct > fh.pct)) fh = entry.fiveHour;
      if (entry.sevenDay && (!sd || entry.sevenDay.pct > sd.pct)) sd = entry.sevenDay;
    }
    return { worstFiveHour: fh, worstSevenDay: sd };
  }, [rateLimits, live, displayBadge, runtimeProfiles, accountBadge]);

  const health: Health = worst?.level ?? 'healthy';

  return (
    <div
      role="status"
      aria-label="Hive status"
      style={{
        height: 26, minHeight: 26, flexShrink: 0,
        background: 'var(--cth-paper-100)',
        borderTop: '1px solid var(--cth-ink-300)',
        display: 'flex', alignItems: 'center', gap: 0,
        padding: '0 12px',
        fontFamily: 'var(--cth-font-ui)', fontSize: 12,
        color: 'var(--cth-ink-700)', userSelect: 'none',
        overflow: 'hidden', minWidth: 0,
      }}
    >
      {displayBadge && (
        <>
          <Chip title={`Account: ${displayBadge} (from CLAUDE_CONFIG_DIR${focusAgent?.profileId ? ' via agent profile' : ''})`}>
            <Dot color={displayBadge === 'PERSONAL' ? 'var(--cth-mint)' : 'var(--cth-sky)'} />
            <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 9, color: displayBadge === 'PERSONAL' ? 'var(--cth-mint)' : 'var(--cth-sky)' }}>
              {displayBadge}
            </span>
          </Chip>
          <Sep />
        </>
      )}

      {engineInfo && (
        <>
          <Chip title={`Engine: ${engineInfo.engineName} · Model: ${engineInfo.rawModel}${focusAgent ? ` (${focusAgent.name})` : ''}`}>
            <span style={{ fontWeight: 600, color: 'var(--cth-ink-900)' }}>
              {engineInfo.engineName}
            </span>
            <span style={{ color: 'var(--cth-ink-400)', fontSize: 10 }}>·</span>
            <span style={{ color: 'var(--cth-ink-800)' }}>
              {engineInfo.modelName}
            </span>
          </Chip>
          <Sep />
        </>
      )}

      {focusAgent && (
        <>
          <Chip
            title={`${focusAgent.name} · ${focusAgent.worktreePath ?? focusAgent.cwd}`}
            style={{ padding: '0 6px', fontSize: 11 }}
          >
            <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-sky)' }}>
              {tail(focusAgent.worktreePath ?? focusAgent.cwd)}
            </span>
            {branch && (
              <>
                <span style={{ color: 'var(--cth-ink-300)' }}>:</span>
                <span style={{ color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)' }}>{branch}</span>
              </>
            )}
          </Chip>
          <Sep />
        </>
      )}

      <Sep />
      <Chip title={`${live.length} agent(s) with a live terminal`}>
        <strong style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)' }}>
          {live.length}
        </strong>
        <span style={{ color: 'var(--cth-ink-500)' }}>active</span>
      </Chip>

      <Sep />
      <Chip title="Fleet tokens used (live OpenTelemetry)">
        <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)' }}>
          {fmtTokens(tokens)}
        </span>
        <span style={{ color: 'var(--cth-ink-500)' }}>tok</span>
        {tokPerMin >= 1 && (
          <span style={{ color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)' }}>
            {fmtTokens(tokPerMin)}/m
          </span>
        )}
      </Chip>

      <Sep />
      <Chip title={billingMode === 'api' ? 'Fleet cost so far (OTel · API billing)' : 'Estimated fleet cost (OTel · subscription — not actual billing)'}>
        <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)' }}>
          {billingMode === 'api' ? fmtUsd(usd) : `~${fmtUsd(usd)}`}
        </span>
        {billingMode !== 'api' && (
          <span style={{ color: 'var(--cth-ink-500)', fontSize: 11 }}>est.</span>
        )}
      </Chip>

      {worstFiveHour && (
        <>
          <Sep />
          <Chip title={`5h rate limit: ${worstFiveHour.pct}% used · resets ${fmtReset(worstFiveHour.resetsAt)}`}>
            <span style={{ color: 'var(--cth-ink-500)' }}>5h</span>
            <span style={{ fontFamily: 'var(--cth-font-mono)', color: ratePaceColor(worstFiveHour.pct, worstFiveHour.resetsAt, 300), letterSpacing: 1 }}>
              {ctxBar(worstFiveHour.pct)}
            </span>
            <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)' }}>
              {worstFiveHour.pct}%
            </span>
            <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)', fontSize: 11 }}>
              {fmtReset(worstFiveHour.resetsAt)}
            </span>
          </Chip>
        </>
      )}

      {worstSevenDay && (
        <>
          <Sep />
          <Chip title={`7d rate limit: ${worstSevenDay.pct}% used · resets ${fmtReset(worstSevenDay.resetsAt)}`}>
            <span style={{ color: 'var(--cth-ink-500)' }}>7d</span>
            <span style={{ fontFamily: 'var(--cth-font-mono)', color: ratePaceColor(worstSevenDay.pct, worstSevenDay.resetsAt, 10080), letterSpacing: 1 }}>
              {ctxBar(worstSevenDay.pct)}
            </span>
            <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)' }}>
              {worstSevenDay.pct}%
            </span>
            <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)', fontSize: 11 }}>
              {fmtReset(worstSevenDay.resetsAt)}
            </span>
          </Chip>
        </>
      )}

      {queued > 0 && (
        <>
          <Sep />
          <Chip title="Messages parked for busy agents (outgoing queue, not hive inbox)">
            <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)' }}>
              {queued}
            </span>
            <span style={{ color: 'var(--cth-ink-500)' }}>pending</span>
          </Chip>
        </>
      )}

      <div style={{ marginLeft: 'auto' }} />
      {governor && governor.mode !== 'green' && (
        <>
          <Chip
            title={`Usage governor: ${governor.mode.toUpperCase()}${governor.reason ? ` — ${governor.reason}` : ''}${governor.mode === 'red' ? ' · click to force-green' : ''}`}
            onClick={governor.mode === 'red' ? () => {
              window.cth?.setGovernorOverride?.('force-green').then(() => setGovernor({ mode: 'green' })).catch(() => {});
            } : undefined}
          >
            <Dot color={govColor(governor.mode)} />
            <span style={{ color: govColor(governor.mode) }}>gov</span>
            {governor.mode === 'red' && govWindow(governor.reason) && (
              <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)', fontSize: 11 }}>
                {govWindow(governor.reason)}
              </span>
            )}
          </Chip>
          <Sep />
        </>
      )}
      <Chip title={worst ? `${health}${worst.reason ? `: ${worst.reason}` : ''}` : 'All breakers healthy'}>
        <Dot color={healthColor(health)} />
        <span style={{ color: 'var(--cth-ink-700)' }}>{health}</span>
        {armedCount > 0 && (
          <span style={{ color: 'var(--cth-ink-500)' }}>({armedCount})</span>
        )}
      </Chip>
    </div>
  );
}

function Chip({ children, title, onClick, style }: { children: React.ReactNode; title?: string; onClick?: () => void; style?: React.CSSProperties }) {
  return (
    <span
      title={title}
      onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 8px', whiteSpace: 'nowrap', cursor: onClick ? 'pointer' : undefined, ...style }}
    >
      {children}
    </span>
  );
}

function Sep() {
  return <span aria-hidden style={{ width: 1, height: 12, background: 'var(--cth-ink-300)' }} />;
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />;
}
