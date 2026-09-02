import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import { useFleetTelemetry, totalTokens, type BreakerState } from '@/hooks/useTelemetry';
import { useRateLimits, ratePaceColor, fmtReset } from '@/hooks/useRateLimits';
import { inferAgentProvider, providerPreset, type AgentProvider, type RuntimeProfile } from '@/store/config';
import { AppChromeControls } from './AppChromeControls';

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

interface RatePaceInfo {
  paceRatio: number;
  targetPct: number;
  projectedPct: number;
  color: string;
  label: string;
}

/**
 * Derive expected pace target from rate-limit numbers:
 * targetPct = elapsedFraction * 100 (% you should be at for even burn across the window)
 * paceRatio = (used% / 100) / elapsedFraction (burn rate vs even burn)
 * projected% = used% / elapsedFraction (projected total at end of window)
 * Color cues: green <= 1x, amber <= 1.5x, red > 1.5x
 */
function calcRatePace(pct: number, resetsAtIso: string, windowMins: number): RatePaceInfo | null {
  const resetsAtMs = new Date(resetsAtIso).getTime();
  if (!Number.isFinite(resetsAtMs)) return null;
  const windowMs = windowMins * 60 * 1000;
  const windowStartMs = resetsAtMs - windowMs;
  const now = Date.now();
  const elapsedMs = Math.max(1000, now - windowStartMs);
  const elapsedFraction = Math.min(1, Math.max(0.001, elapsedMs / windowMs));
  const targetPct = elapsedFraction * 100;
  const paceRatio = (pct / 100) / elapsedFraction;
  const projectedPct = pct / elapsedFraction;
  const isEarly = elapsedFraction < 0.03;
  const color = isEarly && pct < 5
    ? 'var(--cth-mint)'
    : paceRatio > 1.5
    ? 'var(--cth-coral)'
    : paceRatio > 1.0
    ? 'var(--cth-lemon)'
    : 'var(--cth-mint)';
  const label = `${targetPct.toFixed(1)}%`;
  return { paceRatio, targetPct, projectedPct, color, label };
}

export function StatusBar() {
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const messageQueues = useStore((s) => s.messageQueues);
  const { samples, rate, breakers } = useFleetTelemetry();
  const rateLimits = useRateLimits();

  // Non-Claude engines (agy/Antigravity, codex) never emit OTel usage samples;
  // main parses their PTY for tokens/cost/ctx% and pushes it here keyed by agent
  // id. It's the fallback that lets the session chips below read for every
  // engine, not just Claude.
  const [fleetTok, setFleetTok] = useState<Record<string, { tokens: number; ctxPct: number | null; usd: number }>>({});
  useEffect(() => {
    if (!window.cth?.onFleetTokens) return;
    return window.cth.onFleetTokens((data) => setFleetTok(data));
  }, []);

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

  const focusProvider = useMemo<AgentProvider>(() => {
    if (focusAgent?.profileId) {
      const profile = runtimeProfiles.find((p) => p.id === focusAgent.profileId);
      if (profile?.provider) return profile.provider;
    }
    return focusAgent ? inferAgentProvider(focusAgent.command, focusAgent.provider) : 'claude';
  }, [focusAgent?.command, focusAgent?.profileId, focusAgent?.provider, runtimeProfiles]);

  const showRateLimitMeters = focusProvider === 'claude';

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
  // falls back to the app-wide CLAUDE_CONFIG_DIR badge otherwise (Claude only).
  const displayBadge = useMemo<'WORK' | 'PERSONAL' | null>(() => {
    if (!accountBadge) return null;
    if (focusProvider !== 'claude') return null;
    if (focusAgent?.profileId) {
      const profile = runtimeProfiles.find((p) => p.id === focusAgent.profileId);
      if (profile?.claudeConfigDir) {
        const dir = profile.claudeConfigDir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
        return dir === '.claude-personal' ? 'PERSONAL' : 'WORK';
      }
    }
    return accountBadge;
  }, [focusAgent?.id, focusAgent?.profileId, runtimeProfiles, accountBadge, focusProvider]);

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

  // Session info for the FOCUSED agent, not a fleet roll-up: the engine/model/
  // dir chips already track focusAgent, so the tokens/cost/ctx chips must too or
  // they read as "locked to the profile" when a non-Claude agent is selected.
  // OTel sample first (Claude); PTY-parsed fleet snapshot as the fallback for
  // engines that don't emit hooks.
  const { tokens, usd, tokPerMin, ctxPct } = useMemo(() => {
    const id = focusAgent?.id;
    if (!id) return { tokens: 0, usd: 0, tokPerMin: 0, ctxPct: null as number | null };
    const s = samples[id];
    const pty = fleetTok[id];
    const t = s ? totalTokens(s) : (pty?.tokens ?? 0);
    const d = s ? s.usd : (pty?.usd ?? 0);
    const r = rate[id] ?? 0;
    const exactPct = focusAgent?.contextTokens !== undefined && focusAgent?.contextLimit
      ? (focusAgent.contextTokens / focusAgent.contextLimit) * 100
      : null;
    const p = exactPct ?? (pty?.ctxPct ?? null);
    return {
      tokens: Number.isFinite(t) ? t : 0,
      usd: Number.isFinite(d) ? d : 0,
      tokPerMin: Number.isFinite(r) ? r : 0,
      ctxPct: p !== null && Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : null,
    };
  }, [focusAgent?.id, focusAgent?.contextTokens, focusAgent?.contextLimit, samples, rate, fleetTok]);

  const ctxColor = ctxPct === null ? 'var(--cth-ink-500)'
    : ctxPct >= 88 ? 'var(--cth-coral)'
    : ctxPct >= 75 ? 'var(--cth-lemon)'
    : 'var(--cth-mint)';

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
            <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: displayBadge === 'PERSONAL' ? 'var(--cth-mint)' : 'var(--cth-sky)' }}>
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
            <span style={{ color: 'var(--cth-ink-400)', fontSize: 13 }}>·</span>
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
            style={{ padding: '0 6px', fontSize: 13 }}
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
      <Chip title={`${focusAgent ? `${focusAgent.name}: ` : ''}session tokens${samples[focusAgent?.id ?? ''] ? ' (live OpenTelemetry)' : fleetTok[focusAgent?.id ?? ''] ? ' (PTY-parsed)' : ''}`}>
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
      <Chip title={`${focusAgent ? `${focusAgent.name}: ` : ''}${billingMode === 'api' ? 'session cost (API billing)' : 'estimated session cost (subscription, not actual billing)'}`}>
        <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)' }}>
          {billingMode === 'api' ? fmtUsd(usd) : `~${fmtUsd(usd)}`}
        </span>
        {billingMode !== 'api' && (
          <span style={{ color: 'var(--cth-ink-500)', fontSize: 13 }}>est.</span>
        )}
      </Chip>

      {ctxPct !== null && (
        <>
          <Sep />
          <Chip title={`${focusAgent ? `${focusAgent.name}: ` : ''}context window ${ctxPct}% full`}>
            <span style={{ color: 'var(--cth-ink-500)' }}>ctx</span>
            <span style={{
              display: 'inline-block', width: 36, height: 5,
              background: 'var(--cth-cream-200)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              overflow: 'hidden', verticalAlign: 'middle', margin: '0 2px'
            }}>
              <span style={{
                display: 'block', height: '100%',
                width: `${Math.min(100, Math.max(0, ctxPct))}%`,
                background: ctxColor
              }} />
            </span>
            <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)' }}>
              {ctxPct}%
            </span>
          </Chip>
        </>
      )}

      {showRateLimitMeters && worstFiveHour && (() => {
        const pace = calcRatePace(worstFiveHour.pct, worstFiveHour.resetsAt, 300);
        return (
          <>
            <Sep />
            <Chip title={`5h rate limit: ${worstFiveHour.pct.toFixed(2)}% used${pace ? ` · target pace: ${pace.targetPct.toFixed(1)}% (${pace.paceRatio.toFixed(1)}x burn rate, proj ${Math.round(pace.projectedPct)}%)` : ''} · resets ${fmtReset(worstFiveHour.resetsAt)}`}>
              <span style={{ color: 'var(--cth-ink-500)' }}>5h</span>
              <span style={{
                display: 'inline-block', width: 36, height: 5,
                background: 'var(--cth-cream-200)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                overflow: 'hidden', verticalAlign: 'middle', margin: '0 2px'
              }}>
                <span style={{
                  display: 'block', height: '100%',
                  width: `${Math.min(100, Math.max(0, worstFiveHour.pct))}%`,
                  background: pace?.color ?? ratePaceColor(worstFiveHour.pct, worstFiveHour.resetsAt, 300)
                }} />
              </span>
              <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)' }}>
                {worstFiveHour.pct.toFixed(2)}%
              </span>
              {pace && (
                <span style={{ fontFamily: 'var(--cth-font-ui)', color: pace.color, fontSize: 12, fontWeight: 500 }}>
                  ({pace.label})
                </span>
              )}
              <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)', fontSize: 13 }}>
                {fmtReset(worstFiveHour.resetsAt)}
              </span>
            </Chip>
          </>
        );
      })()}

      {showRateLimitMeters && worstSevenDay && (() => {
        const pace = calcRatePace(worstSevenDay.pct, worstSevenDay.resetsAt, 10080);
        return (
          <>
            <Sep />
            <Chip title={`7d rate limit: ${worstSevenDay.pct.toFixed(2)}% used${pace ? ` · target pace: ${pace.targetPct.toFixed(1)}% (${pace.paceRatio.toFixed(1)}x burn rate, proj ${Math.round(pace.projectedPct)}%)` : ''} · resets ${fmtReset(worstSevenDay.resetsAt)}`}>
              <span style={{ color: 'var(--cth-ink-500)' }}>7d</span>
              <span style={{
                display: 'inline-block', width: 36, height: 5,
                background: 'var(--cth-cream-200)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                overflow: 'hidden', verticalAlign: 'middle', margin: '0 2px'
              }}>
                <span style={{
                  display: 'block', height: '100%',
                  width: `${Math.min(100, Math.max(0, worstSevenDay.pct))}%`,
                  background: pace?.color ?? ratePaceColor(worstSevenDay.pct, worstSevenDay.resetsAt, 10080)
                }} />
              </span>
              <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)' }}>
                {worstSevenDay.pct.toFixed(2)}%
              </span>
              {pace && (
                <span style={{ fontFamily: 'var(--cth-font-ui)', color: pace.color, fontSize: 12, fontWeight: 500 }}>
                  ({pace.label})
                </span>
              )}
              <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)', fontSize: 13 }}>
                {fmtReset(worstSevenDay.resetsAt)}
              </span>
            </Chip>
          </>
        );
      })()}

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
              <span style={{ fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)', fontSize: 13 }}>
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

      {/* App chrome relocated from the old titlebar — version/update, theme,
          settings, focus mode. This bar is always mounted (fullscreen mounts
          its own copy), so nothing is view-gated. */}
      <Sep />
      <span style={{ display: 'inline-flex', alignItems: 'center', paddingLeft: 4 }}>
        <AppChromeControls />
      </span>
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
