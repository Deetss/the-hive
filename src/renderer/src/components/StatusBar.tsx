import { useMemo } from 'react';
import { useStore } from '@/store/store';
import { useFleetTelemetry, totalTokens, type BreakerState } from '@/hooks/useTelemetry';

/**
 * Persistent bottom status line: live hive+fleet state at a glance.
 *
 * Reads the SAME sources the rest of the app already uses: the zustand roster
 * (`agents`, `godStatus`, `messageQueues`) and the OTel telemetry hook
 * (`useFleetTelemetry`: per-agent usage samples + breaker state). No new IPC:
 * everything here is already streamed to the renderer.
 */

type Health = 'healthy' | 'steering' | 'constrained' | 'stopped';

const HEALTH_RANK: Record<Health, number> = {
  healthy: 0, steering: 1, constrained: 2, stopped: 3
};

/** Same thresholds/palette the Command Center token meter uses (mint→lemon→coral). */
function healthColor(level: Health): string {
  if (level === 'constrained' || level === 'stopped') return 'var(--cth-coral)';
  if (level === 'steering') return 'var(--cth-lemon)';
  return 'var(--cth-mint)';
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function pctColor(pct: number): string {
  if (pct >= 90) return 'var(--cth-coral)';
  if (pct >= 60) return 'var(--cth-lemon)';
  return 'var(--cth-mint)';
}

export function StatusBar() {
  const agents = useStore((s) => s.agents);
  const godStatus = useStore((s) => s.godStatus);
  const messageQueues = useStore((s) => s.messageQueues);
  const { samples, rate, breakers } = useFleetTelemetry();

  const live = useMemo(() => agents.filter((a) => a.ptyId && !a.archived), [agents]);

  const { tokens, usd, tokPerMin } = useMemo(() => {
    let t = 0, d = 0, r = 0;
    for (const a of live) {
      const s = samples[a.id];
      if (s) { t += totalTokens(s); d += s.usd; }
      r += rate[a.id] ?? 0;
    }
    return { tokens: t, usd: d, tokPerMin: r };
  }, [live, samples, rate]);

  // Busiest agent's context fill is the risk signal: a near-full window is the
  // one worth surfacing, so we show the max rather than an average.
  const ctxPct = useMemo(() => {
    let max = -1;
    for (const a of live) {
      if (a.contextTokens && a.contextLimit && a.contextLimit > 0) {
        max = Math.max(max, Math.round((a.contextTokens / a.contextLimit) * 100));
      }
    }
    return max;
  }, [live]);

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

  const godColor = godStatus === 'ready' ? 'var(--cth-mint)'
    : godStatus === 'failed' ? 'var(--cth-coral)' : 'var(--cth-lemon)';
  const health: Health = worst?.level ?? 'healthy';

  return (
    <div
      role="status"
      aria-label="Hive status"
      style={{
        height: 26, minHeight: 26, flexShrink: 0,
        background: 'linear-gradient(180deg, var(--cth-cream-200) 0%, var(--cth-cream-100) 100%)',
        borderTop: '1px solid var(--cth-ink-300)',
        display: 'flex', alignItems: 'center', gap: 0,
        padding: '0 12px',
        fontFamily: 'var(--cth-font-ui)', fontSize: 12,
        color: 'var(--cth-ink-700)', userSelect: 'none'
      }}
    >
      <Chip title={`Orchestrator: ${godStatus}`}>
        <Dot color={godColor} />
        <span style={{ color: 'var(--cth-ink-500)' }}>hive</span>
      </Chip>

      <Sep />
      <Chip title={`${live.length} agent(s) with a live terminal`}>
        <strong style={{ fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-900)' }}>
          {live.length}
        </strong>
        <span style={{ color: 'var(--cth-ink-500)' }}>active</span>
      </Chip>

      <Sep />
      <Chip title="Fleet tokens used (live OpenTelemetry)">
        <span style={{ fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-900)' }}>
          {fmtTokens(tokens)}
        </span>
        <span style={{ color: 'var(--cth-ink-500)' }}>tok</span>
        {tokPerMin >= 1 && (
          <span style={{ color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-mono)' }}>
            {fmtTokens(tokPerMin)}/m
          </span>
        )}
      </Chip>

      <Sep />
      <Chip title="Estimated fleet cost so far">
        <span style={{ fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-900)' }}>
          {fmtUsd(usd)}
        </span>
      </Chip>

      {ctxPct >= 0 && (
        <>
          <Sep />
          <Chip title="Fullest agent context window">
            <Dot color={pctColor(ctxPct)} />
            <span style={{ color: 'var(--cth-ink-500)' }}>ctx</span>
            <span style={{ fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-900)' }}>
              {ctxPct}%
            </span>
          </Chip>
        </>
      )}

      {queued > 0 && (
        <>
          <Sep />
          <Chip title="Messages queued for delivery to agents">
            <span style={{ fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-900)' }}>
              {queued}
            </span>
            <span style={{ color: 'var(--cth-ink-500)' }}>queued</span>
          </Chip>
        </>
      )}

      <div style={{ marginLeft: 'auto' }} />
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

function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 10px', whiteSpace: 'nowrap' }}
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
