/**
 * Artifact Review panel — the human review queue for agent-generated artifacts
 * (plans, images, docs, designs) dropped into <hive>/artifacts/.
 *
 * A full-window overlay (like IdePanel), opened from the title-bar Review
 * button. Left column lists the pending descriptors; the right column previews
 * the selected one and carries the approve/reject controls. The descriptor list
 * lives in the store (App.tsx keeps it live), so this panel just renders it and
 * calls the artifacts:* IPC to act.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import type { ArtifactDescriptor, ArtifactType } from '@shared/artifacts';
import { Icon, type IconName } from '@/components/Icon';
import { PixelButton } from '@/components/PixelButton';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';

function formatAgo(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const TYPE_ICON: Record<ArtifactType, IconName> = {
  image: 'image',
  plan: 'ledger',
  doc: 'ledger',
  design: 'sparkle'
};

function TypeBadge({ type }: { type: ArtifactType }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: 'var(--cth-font-ui)', fontSize: 8, lineHeight: '12px',
      textTransform: 'uppercase', letterSpacing: 0.4,
      padding: '2px 5px',
      background: 'var(--cth-lilac-light)', color: 'var(--cth-ink-900)'
    }}>
      <Icon name={TYPE_ICON[type]} size={1} style={{ width: 10, height: 10 }} />
      {type}
    </span>
  );
}

/** Load an image artifact's bytes over IPC and hand back a blob: URL. Mirrors
 *  useWorkspaceImage's revoke discipline: the blob is created only while
 *  mounted and revoked on cleanup, so "mounted" and "URL alive" match. */
function useArtifactImage(id: string | null): { status: 'loading' | 'ready' | 'error'; url?: string; error?: string } {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; url?: string; error?: string }>({ status: 'loading' });
  useEffect(() => {
    if (!id) { setState({ status: 'error', error: 'no artifact' }); return; }
    let alive = true;
    let created: string | null = null;
    setState({ status: 'loading' });
    void window.cth.artifactsReadImage(id).then((res) => {
      if (!alive) return;
      if (!res.ok) { setState({ status: 'error', error: res.error }); return; }
      created = URL.createObjectURL(new Blob([res.bytes], { type: res.mime }));
      setState({ status: 'ready', url: created });
    }).catch((e: unknown) => {
      if (alive) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    });
    return () => { alive = false; if (created) URL.revokeObjectURL(created); };
  }, [id]);
  return state;
}

function ImageArtifact({ id }: { id: string }) {
  const img = useArtifactImage(id);
  if (img.status === 'loading') return <Muted>Loading image…</Muted>;
  if (img.status === 'error') return <Muted>Could not load image: {img.error}</Muted>;
  return (
    <div style={{ overflow: 'auto', flex: 1, minHeight: 0, padding: 16, textAlign: 'center' }}>
      <img src={img.url} alt="artifact preview" style={{ maxWidth: '100%', height: 'auto' }} />
    </div>
  );
}

function TextArtifact({ id }: { id: string }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; content?: string; error?: string }>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    void window.cth.artifactsReadFile(id).then((res) => {
      if (!alive) return;
      if (res.ok) setState({ status: 'ready', content: res.content });
      else setState({ status: 'error', error: res.error });
    }).catch((e: unknown) => {
      if (alive) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    });
    return () => { alive = false; };
  }, [id]);
  if (state.status === 'loading') return <Muted>Loading…</Muted>;
  if (state.status === 'error') return <Muted>Could not read file: {state.error}</Muted>;
  return (
    <div style={{ overflow: 'auto', flex: 1, minHeight: 0, padding: '4px 16px' }}>
      <MarkdownPreview source={state.content ?? ''} />
    </div>
  );
}

function DesignArtifact({ artifact }: { artifact: ArtifactDescriptor }) {
  const reveal = useCallback(() => { void window.cth.artifactsReveal(artifact.id); }, [artifact.id]);
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
        {artifact.description || 'No description provided.'}
      </p>
      <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>
        {artifact.filePath}
      </div>
      <div>
        <PixelButton variant="secondary" size="md" onClick={reveal}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Icon name="folder" /> open in OS
          </span>
        </PixelButton>
      </div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)', fontSize: 13, padding: 24, textAlign: 'center'
    }}>{children}</div>
  );
}

export function ReviewPanel({ onClose }: { onClose?: () => void }) {
  const setReviewOpen = useStore((s) => s.setReviewOpen);
  const pending = useStore((s) => s.pendingArtifacts);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Refresh the "time ago" labels once a minute.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Keep a valid selection as the queue changes: default to the first item, and
  // drop a selection that was just acted on (no longer pending).
  useEffect(() => {
    if (pending.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !pending.some((a) => a.id === selectedId)) {
      setSelectedId(pending[0].id);
    }
  }, [pending, selectedId]);

  // Clear the note field when switching artifacts.
  useEffect(() => { setNote(''); }, [selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setReviewOpen(false);
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setReviewOpen, onClose]);

  const selected = useMemo(() => pending.find((a) => a.id === selectedId) ?? null, [pending, selectedId]);

  const act = useCallback(async (decision: 'approve' | 'reject') => {
    if (!selected || busy) return;
    setBusy(true);
    const trimmed = note.trim() || undefined;
    try {
      const res = decision === 'approve'
        ? await window.cth.artifactsApprove(selected.id, trimmed)
        : await window.cth.artifactsReject(selected.id, trimmed);
      if (!res.ok) console.error('[review] decision failed:', res.error);
      // The store list refreshes from the onArtifactsChanged push in App.tsx.
    } finally {
      setBusy(false);
    }
  }, [selected, note, busy]);

  return (
    <div style={{
      height: '100%',
      background: 'var(--cth-cream-100)',
      display: 'flex', flexDirection: 'column'
    }}>
      {/* Title bar */}
      <div
        style={{
          flexShrink: 0, height: 36,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '1px solid var(--cth-ink-300)',
          display: 'flex', alignItems: 'center',
          paddingLeft: 12, paddingRight: 8, gap: 10,
          userSelect: 'none'
        }}
      >
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
          THE HIVE · REVIEW
        </span>
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>
          {pending.length} pending
        </span>
        <button
          onClick={() => { setReviewOpen(false); onClose?.(); }}
          title="Close Review (Esc)"
          aria-label="Close Review"
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            border: 'none', borderRadius: 2, cursor: 'pointer', color: 'var(--cth-ink-900)'
          }}
        >
          <Icon name="x" size={1} style={{ width: 16, height: 16 }} />
        </button>
      </div>

      {pending.length === 0 ? (
        <Muted>No pending artifacts</Muted>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {/* ── Left: pending queue ── */}
          <div style={{
            width: 300, flexShrink: 0, minHeight: 0, overflow: 'auto',
            borderRight: '1px solid var(--cth-ink-700)', background: 'var(--cth-cream-50)'
          }}>
            {pending.map((a) => {
              const active = a.id === selectedId;
              return (
                <button
                  key={a.id}
                  onClick={() => setSelectedId(a.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '10px 12px', border: 'none', cursor: 'pointer',
                    borderBottom: '1px solid var(--cth-ink-300)',
                    background: active ? 'var(--cth-paper-100)' : 'transparent',
                    boxShadow: active ? 'inset 3px 0 0 var(--cth-lilac)' : 'none'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <TypeBadge type={a.type} />
                    <span style={{ marginLeft: 'auto', fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                      {formatAgo(a.createdAt, now)}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cth-ink-900)', lineHeight: '18px' }}>
                    {a.title}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginTop: 2 }}>
                    {a.agentName ?? a.agentId}
                  </div>
                </button>
              );
            })}
          </div>

          {/* ── Right: preview + decision ── */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {!selected ? (
              <Muted>Select an artifact to review</Muted>
            ) : (
              <>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--cth-ink-300)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <TypeBadge type={selected.type} />
                    <h2 style={{ margin: 0, fontSize: 15, color: 'var(--cth-ink-900)' }}>{selected.title}</h2>
                  </div>
                  {selected.description && (
                    <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
                      {selected.description}
                    </p>
                  )}
                  <div style={{ marginTop: 4, fontSize: 11, color: 'var(--cth-ink-500)' }}>
                    from {selected.agentName ?? selected.agentId} · {formatAgo(selected.createdAt, now)}
                  </div>
                </div>

                {/* Preview by type */}
                {selected.type === 'image' && <ImageArtifact id={selected.id} />}
                {(selected.type === 'plan' || selected.type === 'doc') && <TextArtifact id={selected.id} />}
                {selected.type === 'design' && <DesignArtifact artifact={selected} />}

                {/* Decision bar */}
                <div style={{
                  flexShrink: 0, borderTop: '1px solid var(--cth-ink-300)',
                  padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
                  background: 'var(--cth-cream-50)'
                }}>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Optional note for the agent…"
                    rows={2}
                    style={{
                      resize: 'vertical', width: '100%', boxSizing: 'border-box',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                      padding: '6px 8px', border: '1px solid var(--cth-ink-300)', borderRadius: 2,
                      background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)'
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <PixelButton variant="destructive" size="md" disabled={busy} onClick={() => void act('reject')}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="x" /> Reject
                      </span>
                    </PixelButton>
                    <PixelButton variant="primary" size="md" disabled={busy} onClick={() => void act('approve')}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="check" /> Approve
                      </span>
                    </PixelButton>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
