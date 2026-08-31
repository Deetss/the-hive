import { useState, useEffect, useCallback } from 'react';
import type { DelegationEntry, DelegationStats } from '../../../preload';

type DelegationData = { log: DelegationEntry[]; stats: DelegationStats };

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function decisionBadge(decision: DelegationEntry['decision']): React.ReactNode {
  const styles = {
    delegated: { bg: '#00ff41', text: '#000', label: '🔀 Delegated' },
    allowed: { bg: 'var(--cth-ink-300)', text: 'var(--cth-ink-900)', label: '✓ Allowed' },
    blocked: { bg: '#ff4444', text: '#fff', label: '✗ Blocked' }
  };
  const { bg, text, label } = styles[decision];
  return (
    <span style={{
      backgroundColor: bg,
      color: text,
      padding: '2px 6px',
      borderRadius: 3,
      fontFamily: 'var(--cth-font-ui)',
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.5px'
    }}>
      {label}
    </span>
  );
}

const card: React.CSSProperties = {
  backgroundColor: 'var(--cth-bg-card)',
  border: '1px solid var(--cth-ink-100)',
  padding: 10,
  borderRadius: 6,
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6
};

const sectionHead: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: 'var(--cth-ink-900)',
  display: 'block',
  marginBottom: 6
};

const metaRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 11,
  color: 'var(--cth-ink-700)'
};

function PixelButton(props: {
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        padding: '4px 8px',
        border: '1px solid var(--cth-ink-200)',
        backgroundColor: props.disabled ? 'var(--cth-ink-100)' : 'var(--cth-bg-card)',
        color: props.disabled ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',
        borderRadius: 3,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        transition: 'all 0.1s'
      }}
      onMouseEnter={(e) => {
        if (!props.disabled) {
          e.currentTarget.style.backgroundColor = 'var(--cth-ink-50)';
        }
      }}
      onMouseLeave={(e) => {
        if (!props.disabled) {
          e.currentTarget.style.backgroundColor = 'var(--cth-bg-card)';
        }
      }}
    >
      {props.children}
    </button>
  );
}

export function DelegationsTab() {
  const [data, setData] = useState<DelegationData | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const refresh = useCallback(() => {
    window.cth.delegationsList?.().then(setData).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const unsub = window.cth.onDelegationEvent?.(() => {
      refresh();
    });
    return unsub;
  }, [refresh]);

  const clear = useCallback(() => {
    window.cth.delegationsClear?.()
      .then(() => { refresh(); })
      .catch(() => {});
  }, [refresh]);

  const toggleExpanded = useCallback((idx: number) => {
    setExpanded((e) => ({ ...e, [idx]: !e[idx] }));
  }, []);

  if (!data) {
    return <div style={{ padding: 20, fontFamily: 'var(--cth-font-ui)', fontSize: 13 }}>Loading...</div>;
  }

  const { log, stats } = data;

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 18,
            fontWeight: 700,
            margin: 0,
            marginBottom: 4,
            color: 'var(--cth-ink-900)'
          }}>
            Delegations
            {stats.delegated > 0 && (
              <span style={{
                marginLeft: 8,
                backgroundColor: '#00ff41',
                color: '#000',
                padding: '2px 8px',
                borderRadius: 12,
                fontSize: 12,
                fontWeight: 600
              }}>
                {stats.delegated}
              </span>
            )}
          </h2>
          <p style={{
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 13,
            color: 'var(--cth-ink-700)',
            margin: 0
          }}>
            LDA (Local Delegation Assistant) telemetry — edgentic calls logged in this session.
          </p>
        </div>
        <PixelButton onClick={clear}>Clear</PixelButton>
      </div>

      <div style={card}>
        <div style={{
          display: 'flex',
          gap: 16,
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 13,
          fontWeight: 600
        }}>
          <span>{stats.delegated} delegated</span>
          <span style={{ color: 'var(--cth-ink-500)' }}>·</span>
          <span>{stats.allowed} allowed</span>
          <span style={{ color: 'var(--cth-ink-500)' }}>·</span>
          <span>{stats.blocked} blocked</span>
        </div>
      </div>

      <div>
        <span style={sectionHead}>Log ({log.length})</span>
        {log.length === 0 ? (
          <div style={{ ...card, fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, color: 'var(--cth-ink-900)', marginBottom: 6 }}>No delegations this session.</div>
            <div style={{ color: 'var(--cth-ink-700)' }}>
              LDA (Local Delegation Assistant) delegates large reads to the edgentic model running on edgentic1.
              To enable: make sure <code style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11 }}>edgentic</code> is
              reachable on PATH, then configure local delegation in{' '}
              <strong>Settings → Connections → Local Delegates</strong>.
              Once active, large file reads and grep operations will appear here.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {log.map((entry, idx) => (
              <div key={idx} style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    {decisionBadge(entry.decision)}
                    <span style={{
                      fontFamily: 'var(--cth-font-ui)',
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--cth-ink-900)'
                    }}>
                      {entry.tool}
                    </span>
                    <span style={{
                      fontFamily: 'var(--cth-font-mono)',
                      fontSize: 11,
                      color: 'var(--cth-ink-700)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}>
                      {entry.fileOrArg}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                    <span style={{
                      fontFamily: 'var(--cth-font-mono)',
                      fontSize: 11,
                      color: 'var(--cth-ink-700)'
                    }}>
                      {entry.durationMs}ms
                    </span>
                    {entry.resultSnippet && (
                      <PixelButton onClick={() => toggleExpanded(idx)}>
                        {expanded[idx] ? 'hide' : 'show'}
                      </PixelButton>
                    )}
                  </div>
                </div>
                <div style={metaRow}>
                  <span>{relTime(entry.ts)}</span>
                </div>
                {expanded[idx] && entry.resultSnippet && (
                  <div style={{
                    marginTop: 6,
                    padding: 8,
                    backgroundColor: 'var(--cth-ink-50)',
                    borderRadius: 3,
                    fontFamily: 'var(--cth-font-mono)',
                    fontSize: 11,
                    color: 'var(--cth-ink-900)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}>
                    {entry.resultSnippet}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
