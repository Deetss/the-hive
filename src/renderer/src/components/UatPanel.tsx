import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';

type UatStatus = 'pending' | 'pass' | 'fail';

export interface UatItem {
  id: string;
  text: string;
  status: UatStatus;
  createdBy?: string;
  createdAt?: string;
  checkedBy?: string;
  checkedAt?: string;
  notes?: string;
}

interface UatDocument {
  version: 1;
  title?: string;
  updatedAt?: string;
  items: UatItem[];
}

interface UatPanelProps {
  onPendingChange?: (pending: number) => void;
}

const FILENAME = 'uat.json';
const POLL_MS = 5000;

const STATUS_META: Record<UatStatus, { label: string; color: string; icon: Parameters<typeof Icon>[0]['name'] }> = {
  pending: { label: 'pending', color: 'var(--cth-lemon)', icon: 'clock' },
  pass: { label: 'pass', color: 'var(--cth-mint)', icon: 'check' },
  fail: { label: 'fail', color: 'var(--cth-coral)', icon: 'x' }
};

function emptyDoc(): UatDocument {
  return { version: 1, items: [], updatedAt: new Date().toISOString() };
}

function parseDoc(raw: string): UatDocument {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyDoc();
    const version = parsed.version === 1 ? 1 : 1;
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return {
      version,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
      items: items
        .filter((item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item: Record<string, unknown>) => ({
          id: typeof item.id === 'string' && item.id ? item.id : newId(),
          text: typeof item.text === 'string' ? item.text : '(untitled)',
          status: item.status === 'pass' || item.status === 'fail' ? item.status : 'pending',
          createdBy: typeof item.createdBy === 'string' ? item.createdBy : undefined,
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
          checkedBy: typeof item.checkedBy === 'string' ? item.checkedBy : undefined,
          checkedAt: typeof item.checkedAt === 'string' ? item.checkedAt : undefined,
          notes: typeof item.notes === 'string' ? item.notes : undefined
        }))
    };
  } catch {
    return emptyDoc();
  }
}

function newId(): string {
  return `uat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function UatPanel({ onPendingChange }: UatPanelProps) {
  const [root, setRoot] = useState<string | null>(null);
  const [doc, setDoc] = useState<UatDocument | null>(null);
  const docRef = useRef<UatDocument | null>(null);
  // When we're mid-write, suppress the poll so it can't overwrite our optimistic update.
  const writingRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [draftOwner, setDraftOwner] = useState('');
  const [verifier, setVerifier] = useState(() => {
    try { return window.localStorage.getItem('cth.uat.verifier') ?? ''; } catch { return ''; }
  });

  useEffect(() => { docRef.current = doc; }, [doc]);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await window.cth.getConfig();
        setRoot(cfg.harnessHome ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const pendingCount = useMemo(() =>
    (doc?.items ?? []).filter((item) => item.status !== 'pass').length,
  [doc?.items]);

  useEffect(() => {
    if (onPendingChange) onPendingChange(pendingCount);
  }, [pendingCount, onPendingChange]);

  const loadDoc = useCallback(async () => {
    if (!root) return;
    if (writingRef.current) return; // don't overwrite an in-flight write
    setLoading(true);
    try {
      const res = await window.cth.readFile(root, FILENAME);
      const content = res.ok ? res.content : '';
      const next = res.ok ? parseDoc(content) : emptyDoc();
      const hydrated = { ...next, updatedAt: next.updatedAt ?? new Date().toISOString() };
      docRef.current = hydrated;
      setDoc(hydrated);
      setError(null);
    } catch (e) {
      setDoc(emptyDoc());
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    if (!root) return;
    void loadDoc();
    const timer = window.setInterval(() => { void loadDoc(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadDoc, root]);

  const persist = useCallback(async (build: (prev: UatDocument) => UatDocument) => {
    if (!root) {
      setError('No harness home configured.');
      return;
    }
    const prev = docRef.current ?? emptyDoc();
    const next = build(prev);
    next.updatedAt = new Date().toISOString();
    setSaving(true);
    writingRef.current = true;
    try {
      const res = await window.cth.writeFile(root, FILENAME, JSON.stringify(next, null, 2) + '\n');
      if (!res.ok) throw new Error(res.error ?? 'Could not write UAT checklist');
      docRef.current = next;
      setDoc(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      writingRef.current = false;
    }
  }, [root]);

  const addItem = useCallback(async () => {
    const text = draftText.trim();
    if (!text) return;
    const owner = draftOwner.trim();
    const now = new Date().toISOString();
    await persist((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        {
          id: newId(),
          text,
          status: 'pending',
          createdBy: owner || undefined,
          createdAt: now
        }
      ]
    }));
    setDraftText('');
    setDraftOwner('');
  }, [draftOwner, draftText, persist]);

  const updateStatus = useCallback(async (id: string, status: UatStatus) => {
    const reviewer = verifier.trim() || 'human';
    const now = new Date().toISOString();
    await persist((prev) => ({
      ...prev,
      items: prev.items.map((item) => item.id === id
        ? {
            ...item,
            status,
            checkedBy: status === 'pending' ? undefined : reviewer,
            checkedAt: status === 'pending' ? undefined : now
          }
        : item)
    }));
  }, [persist, verifier]);

  const updateTitle = useCallback(async (title: string) => {
    await persist((prev) => ({ ...prev, title: title.trim() || undefined }));
  }, [persist]);

  const removeItem = useCallback(async (id: string) => {
    await persist((prev) => ({
      ...prev,
      items: prev.items.filter((item) => item.id !== id)
    }));
  }, [persist]);

  const sortedItems = useMemo(() => {
    const items = doc?.items ?? [];
    const order: Record<UatStatus, number> = { pending: 0, fail: 1, pass: 2 };
    return [...items].sort((a, b) => {
      const byStatus = order[a.status] - order[b.status];
      if (byStatus !== 0) return byStatus;
      return (a.text || '').localeCompare(b.text || '');
    });
  }, [doc?.items]);

  useEffect(() => {
    try { window.localStorage.setItem('cth.uat.verifier', verifier); } catch { /* noop */ }
  }, [verifier]);

  const titleDraft = doc?.title ?? '';

  return (
    <PixelPanel
      variant="default"
      style={{
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0
      }}
    >
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--cth-ink-200)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center'
      }}>
        <input
          defaultValue={titleDraft}
          placeholder="Release / checklist name"
          onBlur={(e) => { if (e.target.value !== titleDraft) void updateTitle(e.target.value); }}
          style={{
            flex: '1 1 160px',
            minWidth: 160,
            padding: '4px 8px',
            border: 'none',
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 14,
            color: 'var(--cth-ink-900)'
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>
            pending: {pendingCount}
          </span>
          <PixelButton variant="secondary" size="sm" onClick={() => void loadDoc()}>
            refresh
          </PixelButton>
        </div>
      </div>

      <div style={{
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflowY: 'auto',
        flex: 1,
        background: 'var(--cth-paper-200)'
      }}>
        {loading && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>loading checklist…</span>}
        {!loading && sortedItems.length === 0 && (
          <div style={{
            padding: 16,
            border: '1px dashed var(--cth-ink-200)',
            background: 'var(--cth-paper-100)',
            fontSize: 13,
            color: 'var(--cth-ink-500)'
          }}>
            No UAT items yet. Agents can append to <code style={{ fontFamily: 'var(--cth-font-mono)' }}>{FILENAME}</code>, or add one below.
          </div>
        )}

        {sortedItems.map((item) => {
          const meta = STATUS_META[item.status];
          return (
            <div key={item.id} style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 12,
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)'
            }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <PixelBadge
                  label={meta.label}
                  status={item.status === 'pass' ? 'success' : item.status === 'fail' ? 'blocked' : 'waiting'}
                />
                <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, color: 'var(--cth-ink-900)', flex: 1 }}>
                  {item.text}
                </span>
                <button
                  onClick={() => void removeItem(item.id)}
                  title="Remove item"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    color: 'var(--cth-ink-400)'
                  }}
                >
                  <Icon name="x" />
                </button>
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {(['pending', 'pass', 'fail'] as UatStatus[]).map((status) => {
                  const active = item.status === status;
                  return (
                    <button
                      key={status}
                      onClick={() => void updateStatus(item.id, status)}
                      style={{
                        border: 'none',
                        cursor: 'pointer',
                        padding: '4px 10px',
                        fontFamily: 'var(--cth-font-ui)',
                        fontSize: 13,
                        background: active ? STATUS_META[status].color : 'var(--cth-cream-100)',
                        color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-600)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)'
                      }}
                    >
                      {STATUS_META[status].label}
                    </button>
                  );
                })}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13, color: 'var(--cth-ink-500)' }}>
                <span>
                  created {formatTimestamp(item.createdAt)}{item.createdBy ? ` by ${item.createdBy}` : ''}
                </span>
                {item.checkedAt && (
                  <span>
                    checked {formatTimestamp(item.checkedAt)}{item.checkedBy ? ` by ${item.checkedBy}` : ''}
                  </span>
                )}
              </div>
            </div>
          );
        })}

        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 12,
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)'
        }}>
          <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>Add checklist item</div>
          <input
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            placeholder="What needs verification?"
            style={{
              width: '100%',
              padding: '4px 8px',
              border: 'none',
              background: 'var(--cth-paper-200)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
              fontFamily: 'var(--cth-font-ui)',
              fontSize: 13,
              color: 'var(--cth-ink-900)'
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={draftOwner}
              onChange={(e) => setDraftOwner(e.target.value)}
              placeholder="posted by (optional)"
              style={{
                flex: 1,
                padding: '4px 8px',
                border: 'none',
                background: 'var(--cth-paper-200)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 13,
                color: 'var(--cth-ink-900)'
              }}
            />
            <PixelButton
              variant="primary"
              size="sm"
              onClick={() => void addItem()}
              disabled={!draftText.trim()}
            >
              add
            </PixelButton>
          </div>
        </div>
      </div>

      <div style={{
        padding: '8px 14px',
        borderTop: '1px solid var(--cth-ink-200)',
        background: 'var(--cth-paper-100)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center'
      }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>your initials</span>
          <input
            value={verifier}
            onChange={(e) => setVerifier(e.target.value)}
            placeholder="human reviewer"
            style={{
              width: 120,
              padding: '3px 6px',
              border: 'none',
              background: 'var(--cth-paper-200)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
              fontFamily: 'var(--cth-font-ui)',
              fontSize: 12,
              color: 'var(--cth-ink-900)'
            }}
          />
        </div>
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>
          last updated: {formatTimestamp(doc?.updatedAt)}
        </span>
        {saving && <PixelBadge label="saving…" status="thinking" />}
        {error && (
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-coral)' }}>
            {error}
          </span>
        )}
      </div>
    </PixelPanel>
  );
}
