import { useEffect, useState, useCallback, useRef } from 'react';
import { PixelButton } from './PixelButton';

/**
 * WORKERS — live god-triggered ephemeral Slack workers (the Phase-1 spawn loop):
 * fresh isolated worktree → does a job → replies in-thread → safe teardown. This
 * tab reads main's `liveWorkers` map (via workers:list) so a human can SEE what's
 * running and stop one by hand; it also surfaces worktrees PRESERVED at teardown
 * (held until their work integrates, then auto-GC'd) so nothing silently piles up.
 *
 * Filter tabs split the view into running / completed (signaled done, or a
 * manual stop) / reaped (idle timeout or token cap) — completed+reaped come
 * from main's bounded `workerHistory` ring, since a torn-down worker vanishes
 * from `liveWorkers` with no other record of how it ended.
 */

// Types flow from main's `workers:list` handler via the typed `window.cth` global
// (declared in preload/index.d.ts) — derived here so there's no cross-package import.
type WorkersData = Awaited<ReturnType<typeof window.cth.listWorkers>>;
type WorkerSnapshot = WorkersData['live'][number];
type PreservedWorktreeSnapshot = WorkersData['preserved'][number];
type WorkerHistoryEntry = WorkersData['history'][number];

const POLL_MS = 2000;
/** Chars of PTY tail to fetch on open / retain client-side as new chunks stream in. */
const TAIL_CHARS = 8000;

/** Strip ANSI escape sequences (colors, cursor moves, OSC) for a plain-text
 *  read-only tail — this panel is a log view, not a terminal emulator. */
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

const REASON_LABEL: Record<WorkerHistoryEntry['reason'], string> = {
  done: 'done', 'manual-stop': 'stopped', idle: 'idle timeout', 'token-cap': 'token cap'
};
function isCompletedReason(reason: WorkerHistoryEntry['reason']): boolean {
  return reason === 'done' || reason === 'manual-stop';
}

function relAge(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const card: React.CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6
};
const metaRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontFamily: 'var(--cth-font-ui)',
  fontSize: 11, color: 'var(--cth-ink-700)'
};
const sectionHead: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--cth-ink-900)', margin: '2px 0'
};
const filterBtnRow: React.CSSProperties = { display: 'flex', gap: 6 };

function StatusBadge({ w }: { w: WorkerSnapshot }) {
  const releasing = w.status === 'releasing';
  return (
    <span style={{
      fontFamily: 'var(--cth-font-ui)', fontSize: 10, padding: '1px 6px',
      textTransform: 'uppercase', letterSpacing: 0.5,
      color: releasing ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)',
      background: releasing ? 'var(--cth-ink-700)' : 'var(--cth-green, #2f8f4e)',
      boxShadow: releasing ? 'none' : 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      {releasing ? 'stopping' : 'working'}
    </span>
  );
}

function ReasonBadge({ reason }: { reason: WorkerHistoryEntry['reason'] }) {
  const completed = isCompletedReason(reason);
  return (
    <span style={{
      fontFamily: 'var(--cth-font-ui)', fontSize: 10, padding: '1px 6px',
      textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--cth-ink-900)',
      background: completed ? 'var(--cth-green, #2f8f4e)' : 'var(--cth-salmon, #f47d55)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      {REASON_LABEL[reason]}
    </span>
  );
}

/** Live read-only tail of a worker's PTY output, plus a "send message" input
 *  that types into the same PTY (mirrors the two-step write pattern used
 *  elsewhere: text, a short settle, then a separate Enter — writing them as
 *  one chunk makes the TUI treat it as a paste and it never submits). */
function WorkerLogPanel({ workerId }: { workerId: string }) {
  const [tail, setTail] = useState('');
  const [sendText, setSendText] = useState('');
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    window.cth.getPtyTail(workerId, TAIL_CHARS)
      .then((t) => { if (!cancelled) setTail(t ? stripAnsi(t) : ''); })
      .catch(() => { /* worker's pty already gone */ });
    const unsub = window.cth.onPtyData(workerId, (chunk) => {
      setTail((prev) => (prev + stripAnsi(chunk)).slice(-TAIL_CHARS));
    });
    return () => { cancelled = true; unsub(); };
  }, [workerId]);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);

  const send = useCallback(() => {
    const text = sendText.trim();
    if (!text || sending) return;
    setSending(true);
    (async () => {
      // Multi-line text goes in as one bracketed paste so embedded newlines
      // land as literal newlines rather than each submitting early.
      const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
      const wrote = await window.cth.writePty(workerId, payload);
      if (wrote?.ok) {
        await new Promise((r) => setTimeout(r, 140));
        await window.cth.writePty(workerId, '\r');
      }
    })().finally(() => { setSending(false); setSendText(''); });
  }, [workerId, sendText, sending]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
      <pre ref={boxRef} style={{
        margin: 0, background: 'var(--cth-ink-900)', color: 'var(--cth-paper-100)',
        fontFamily: 'var(--cth-font-mono, ui-monospace, monospace)', fontSize: 11, lineHeight: 1.4,
        padding: 8, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all'
      }}>
        {tail || '(no output yet)'}
      </pre>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={sendText}
          onChange={(e) => setSendText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Send a message into this worker's terminal…"
          style={{
            flex: 1, fontFamily: 'var(--cth-font-ui)', fontSize: 12, padding: '4px 8px',
            background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', border: 'none'
          }}
        />
        <PixelButton onClick={send} disabled={sending || !sendText.trim()}>
          {sending ? 'sending…' : 'send'}
        </PixelButton>
      </div>
    </div>
  );
}

export function WorkersTab() {
  const [data, setData] = useState<WorkersData | null>(null);
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<'running' | 'completed' | 'reaped'>('running');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    window.cth.listWorkers().then(setData).catch(() => { /* main not ready */ });
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const stop = useCallback((workerId: string) => {
    setStopping((s) => ({ ...s, [workerId]: true }));
    window.cth.stopWorker(workerId)
      .catch(() => { /* surfaced by the row vanishing or not */ })
      .finally(() => { refresh(); });
  }, [refresh]);

  const toggleLog = useCallback((workerId: string) => {
    setExpanded((e) => ({ ...e, [workerId]: !e[workerId] }));
  }, []);

  const live = data?.live ?? [];
  const preserved = data?.preserved ?? [];
  const history = data?.history ?? [];
  const max = data?.maxWorkers ?? 4;
  const completedHistory = history.filter((h) => isCompletedReason(h.reason));
  const reapedHistory = history.filter((h) => !isCompletedReason(h.reason));
  const shownHistory = filter === 'completed' ? completedHistory : filter === 'reaped' ? reapedHistory : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 14px 16px', overflow: 'auto' }}>
      <div style={filterBtnRow}>
        <PixelButton onClick={() => setFilter('running')} disabled={filter === 'running'}>
          running ({live.length})
        </PixelButton>
        <PixelButton onClick={() => setFilter('completed')} disabled={filter === 'completed'}>
          completed ({completedHistory.length})
        </PixelButton>
        <PixelButton onClick={() => setFilter('reaped')} disabled={filter === 'reaped'}>
          reaped ({reapedHistory.length})
        </PixelButton>
      </div>

      {filter === 'running' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span style={sectionHead}>Live workers</span>
            <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
              {live.length} / {max}
            </span>
          </div>
          <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
            Isolated workers Abathur spins up to handle Slack messages — they run to completion, reply in-thread, then tear down.
          </p>

          {live.length === 0 ? (
            <div style={{ ...card, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
              No workers running right now.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {live.map((w) => (
                <div key={w.workerId} style={card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <StatusBadge w={w} />
                      <span style={{
                        fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                      }}>{w.name}</span>
                      {w.hasSlack && (
                        <span title="replies to a Slack thread" style={{
                          fontFamily: 'var(--cth-font-ui)', fontSize: 10, color: 'var(--cth-ink-700)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', padding: '0 5px'
                        }}>slack</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <PixelButton onClick={() => toggleLog(w.workerId)}>
                        {expanded[w.workerId] ? 'hide log' : 'view log'}
                      </PixelButton>
                      <PixelButton
                        onClick={() => stop(w.workerId)}
                        disabled={w.releasing || !!stopping[w.workerId]}
                      >
                        {w.releasing || stopping[w.workerId] ? 'stopping…' : 'stop'}
                      </PixelButton>
                    </div>
                  </div>
                  <div style={metaRow}>
                    <span title="worker / PTY id">{w.workerId}</span>
                    <span title="base branch the worktree was cut from">base: {w.baseBranch}</span>
                    <span title="time since spawn">up {relAge(w.ageMs)}</span>
                    <span title="time since last terminal output">
                      {w.idleMs === null ? 'pty gone' : `idle ${relAge(w.idleMs)}`}
                    </span>
                    <span title="cumulative tokens (input+output+cache)">
                      tokens {fmtTokens(w.tokensUsed)}{w.tokenCap !== null ? ` / ${fmtTokens(w.tokenCap)}` : ' · uncapped'}
                    </span>
                    <span title="most recent tool call">tool: {w.lastTool ?? '—'}</span>
                  </div>
                  {expanded[w.workerId] && <WorkerLogPanel workerId={w.workerId} />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {filter !== 'running' && (
        <div>
          <span style={sectionHead}>
            {filter === 'completed' ? 'Completed workers' : 'Reaped workers'}
          </span>
          <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
            {filter === 'completed'
              ? 'Signaled done in-thread, or were stopped by hand. Most recent first.'
              : 'Reaped by the idle-timeout or per-worker token cap before signaling done. Most recent first.'}
          </p>
          {shownHistory.length === 0 ? (
            <div style={{ ...card, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
              No {filter} workers yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {shownHistory.map((h) => (
                <div key={`${h.workerId}-${h.endedAt}`} style={card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                    <span style={{
                      fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)'
                    }}>{h.name}</span>
                    <ReasonBadge reason={h.reason} />
                  </div>
                  <div style={metaRow}>
                    <span title="worker / PTY id">{h.workerId}</span>
                    <span title="base branch the worktree was cut from">base: {h.baseBranch}</span>
                    <span title="wall-clock time it ran">ran {relAge(Math.max(0, h.endedAt - h.spawnedAt))}</span>
                    <span title="time since it ended">ended {relAge(Math.max(0, Date.now() - h.endedAt))} ago</span>
                    {h.hasSlack && <span>slack</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {preserved.length > 0 && (
        <div>
          <span style={sectionHead}>Preserved worktrees ({preserved.length})</span>
          <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
            Finished workers whose worktree held un-integrated work — kept (never auto-discarded) and auto-reclaimed once the work lands in its base branch.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {preserved.map((p) => (
              <div key={p.wtPath} style={card}>
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                  {p.workerId}
                </div>
                <div style={metaRow}>
                  <span style={{ wordBreak: 'break-all' }}>{p.wtPath}</span>
                  <span>base: {p.baseBranch}</span>
                  <span>kept {relAge(Math.max(0, Date.now() - p.preservedAt))} ago</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
