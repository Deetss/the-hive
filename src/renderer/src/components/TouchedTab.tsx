import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useStore, type Agent } from '@/store/store';

interface TouchedLedgerEntry {
  path: string;
  verb: 'create' | 'write' | 'edit' | 'delete';
  ts: string;
  insideRepo: boolean;
  relativePath?: string;
}

interface TouchedTabProps {
  agent: Agent;
}

interface DisplayEntry {
  entry: TouchedLedgerEntry;
  count: number;
}

const MAX_ENTRIES = 200;

const VERB_STYLE: Record<TouchedLedgerEntry['verb'], { background: string; color: string }> = {
  create: { background: 'var(--cth-mint-light)', color: 'var(--cth-ink-900)' },
  write: { background: 'var(--cth-sky-light)', color: 'var(--cth-ink-900)' },
  edit: { background: 'var(--cth-lilac-light)', color: 'var(--cth-ink-900)' },
  delete: { background: 'var(--cth-coral-light)', color: 'var(--cth-ink-900)' }
};

const ACTION_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0
};

const ACTION_BUTTON_STYLE: CSSProperties = {
  padding: '2px 8px',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 11,
  borderRadius: 4,
  border: '1px solid var(--cth-ink-200)',
  background: 'var(--cth-cream-100)',
  color: 'var(--cth-ink-900)',
  cursor: 'pointer'
};

const DISABLED_BUTTON_STYLE: CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed'
};

export function TouchedTab({ agent }: TouchedTabProps) {
  const [entries, setEntries] = useState<TouchedLedgerEntry[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const openFileInIde = useStore((s) => s.openFileInIde);
  const openDiffInIde = useStore((s) => s.openDiffInIde);

  useEffect(() => {
    const fetchLedger = window.cth?.hiveTouchedLedger;
    if (typeof fetchLedger !== 'function') {
      setUnsupported(true);
      setEntries([]);
      return () => {};
    }

    setUnsupported(false);
    let active = true;
    void fetchLedger(agent.id).then((data) => {
      if (!active || !Array.isArray(data)) return;
      setEntries(data.slice(-MAX_ENTRIES));
    });

    const subscribe = window.cth?.onTouchedLedger;
    const unsubscribe = typeof subscribe === 'function'
      ? subscribe(({ agentId, entries: next }) => {
        if (agentId !== agent.id || !Array.isArray(next) || next.length === 0) return;
        setEntries((prev) => {
          const merged = prev.concat(next);
          return merged.length > MAX_ENTRIES ? merged.slice(-MAX_ENTRIES) : merged;
        });
      })
      : undefined;

    return () => {
      active = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [agent.id]);

  const displayEntries = useMemo<DisplayEntry[]>(() => {
    const buckets: DisplayEntry[] = [];
    const seen = new Map<string, DisplayEntry>();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const key = entry.path.toLowerCase();
      const existing = seen.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      const bucket: DisplayEntry = { entry, count: 1 };
      seen.set(key, bucket);
      buckets.push(bucket);
    }
    return buckets;
  }, [entries]);

  const workspace = agent.worktreePath ?? agent.cwd;

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--cth-paper-200)', padding: 12 }}>
      {unsupported ? (
        <div style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 13,
          color: 'var(--cth-ink-600)',
          textAlign: 'center',
          marginTop: 32,
          lineHeight: '18px'
        }}>
          Touched ledger data is unavailable until The Hive restarts with the latest preload.
        </div>
      ) : displayEntries.length === 0 ? (
        <div style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 13,
          color: 'var(--cth-ink-500)',
          textAlign: 'center',
          marginTop: 32
        }}>
          No files touched yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {displayEntries.map(({ entry, count }) => {
            const verbStyle = VERB_STYLE[entry.verb];
            const ts = safeFormatTimestamp(entry.ts);
            const relative = entry.insideRepo ? formatRelativePath(workspace, entry) : null;
            const label = relative ?? entry.path;
            const canOpenInIde = entry.insideRepo && typeof workspace === 'string' && workspace.length > 0;
            const disabledStyle = canOpenInIde ? undefined : DISABLED_BUTTON_STYLE;
            return (
              <div key={`${entry.path}-${entry.ts}`} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                background: 'var(--cth-paper-100)',
                border: '1px solid var(--cth-ink-200)',
                borderRadius: 4,
                padding: '8px 10px'
              }}>
                <span style={{
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '2px 6px',
                  borderRadius: 999,
                  background: verbStyle.background,
                  color: verbStyle.color,
                  textTransform: 'uppercase'
                }}>{entry.verb}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: 'var(--cth-font-mono)',
                    fontSize: 12,
                    color: 'var(--cth-ink-900)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }} title={label}>{label}</div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontFamily: 'var(--cth-font-ui)',
                    fontSize: 11,
                    color: 'var(--cth-ink-500)'
                  }}>
                    <span>{ts}</span>
                    {!entry.insideRepo && (
                      <span style={{
                        padding: '0 6px',
                        borderRadius: 999,
                        background: 'var(--cth-ink-200)',
                        color: 'var(--cth-ink-700)'
                      }}>[outside]</span>
                    )}
                    {count > 1 && (
                      <span style={{ color: 'var(--cth-ink-600)' }}>×{count}</span>
                    )}
                  </div>
                </div>
                <div style={ACTION_ROW_STYLE}>
                  <button
                    type="button"
                    onClick={() => { if (canOpenInIde) openFileInIde(entry.path); }}
                    disabled={!canOpenInIde}
                    style={{ ...ACTION_BUTTON_STYLE, ...(disabledStyle ?? {}) }}
                    title={canOpenInIde ? 'Open file in IDE' : 'Available for in-repo paths'}
                  >view</button>
                  <button
                    type="button"
                    onClick={() => { if (canOpenInIde) openDiffInIde(entry.path); }}
                    disabled={!canOpenInIde}
                    style={{ ...ACTION_BUTTON_STYLE, ...(disabledStyle ?? {}) }}
                    title={canOpenInIde ? 'View working tree diff' : 'Diffs require a repo path'}
                  >diff</button>
                  <button
                    type="button"
                    onClick={() => { void window.cth?.revealPath?.(entry.path); }}
                    style={ACTION_BUTTON_STYLE}
                    title="Reveal in file browser"
                  >reveal</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function safeFormatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
  } catch {
    return date.toISOString();
  }
}

function formatRelativePath(workspace: string | undefined, entry: TouchedLedgerEntry): string {
  if (!workspace) return entry.path;
  if (entry.relativePath && entry.relativePath !== '.') return entry.relativePath;
  const normalizedWorkspace = normalizeForCompare(workspace);
  const normalizedPath = normalizeForCompare(entry.path);
  if (normalizedPath === normalizedWorkspace) return '.';
  if (normalizedPath.startsWith(normalizedWorkspace + '/')) {
    return normalizedPath.slice(normalizedWorkspace.length + 1);
  }
  return entry.relativePath ?? entry.path;
}

function normalizeForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}
