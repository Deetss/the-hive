import { useEffect, useRef, useState } from 'react';
import { PixelButton } from './PixelButton';

/**
 * QuickAskPanel — lightweight inline Q&A with god.
 *
 * The human types a question; it is sent to god via the existing inbox/outbox
 * bus as a `query` message. God sees it in its inbox, replies with an `inform`
 * back to `'human'`, and the reply lands here via the live `hive:message` push
 * (which emits body+conversation when needsHuman is true). No kanban task is
 * created; the thread is in-memory for the session.
 */

const TIMEOUT_MS = 90_000;

interface QAEntry {
  id: string;
  question: string;
  /** undefined = not yet answered; string (including '') = god replied */
  answer?: string;
  askedAt: number;
  conversation: string;
  waiting: boolean;
  timedOut: boolean;
}

export function QuickAskPanel() {
  const [entries, setEntries] = useState<QAEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  // Per-conversation timeout handles so we can cancel when the answer arrives.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const cancelTimer = (conversation: string) => {
    const t = timers.current.get(conversation);
    if (t !== undefined) { clearTimeout(t); timers.current.delete(conversation); }
  };

  const armTimer = (conversation: string) => {
    cancelTimer(conversation);
    const t = setTimeout(() => {
      timers.current.delete(conversation);
      setEntries((prev) =>
        prev.map((e) =>
          e.conversation === conversation && e.waiting
            ? { ...e, waiting: false, timedOut: true }
            : e
        )
      );
    }, TIMEOUT_MS);
    timers.current.set(conversation, t);
  };

  // Clear all pending timers on unmount.
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);

  // Subscribe to hive:message so god's replies land inline without polling.
  useEffect(() => {
    if (!window.cth?.onHiveMessage) return;
    const unsub = window.cth.onHiveMessage((e) => {
      // Fix: use `e.body === undefined` instead of `!e.body` so an intentionally
      // empty reply still resolves the bubble (empty string is a valid answer).
      if (!e.needsHuman || e.body === undefined || !e.conversation) return;
      cancelTimer(e.conversation);
      setEntries((prev) =>
        prev.map((entry) =>
          entry.conversation === e.conversation && entry.waiting
            ? { ...entry, answer: e.body, waiting: false, timedOut: false }
            : entry
        )
      );
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to bottom whenever thread grows.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries]);

  const submit = async () => {
    const q = draft.trim();
    if (!q || sending) return;
    const conversation = `qa-${crypto.randomUUID()}`;
    const entry: QAEntry = {
      id: conversation, question: q, askedAt: Date.now(),
      conversation, waiting: true, timedOut: false
    };
    setEntries((prev) => [...prev, entry]);
    setDraft('');
    setSending(true);
    try {
      await window.cth.hiveSend(
        { to: 'god', act: 'query', subject: 'Quick ask', body: q, conversation },
        'human'
      );
      // Arm the timeout now that the message is on the bus.
      armTimer(conversation);
    } catch {
      setEntries((prev) =>
        prev.map((e) =>
          e.conversation === conversation
            ? { ...e, answer: '(send failed — check god is online)', waiting: false, timedOut: false }
            : e
        )
      );
    }
    setSending(false);
  };

  const retry = (entry: QAEntry) => {
    setEntries((prev) =>
      prev.map((e) =>
        e.conversation === entry.conversation ? { ...e, waiting: true, timedOut: false, answer: undefined } : e
      )
    );
    void window.cth.hiveSend(
      { to: 'god', act: 'query', subject: 'Quick ask (retry)', body: entry.question, conversation: entry.conversation },
      'human'
    ).then(() => armTimer(entry.conversation)).catch(() => {
      setEntries((prev) =>
        prev.map((e) =>
          e.conversation === entry.conversation
            ? { ...e, answer: '(retry failed)', waiting: false, timedOut: false }
            : e
        )
      );
    });
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
  };

  const renderAnswer = (e: QAEntry) => {
    if (e.waiting) {
      return <span style={{ color: 'var(--cth-ink-500)', fontStyle: 'italic' }}>waiting for god…</span>;
    }
    if (e.timedOut) {
      return (
        <span style={{ color: 'var(--cth-ink-500)' }}>
          no answer yet (god may be busy){' '}
          <button
            onClick={() => retry(e)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)',
              fontSize: 11, textDecoration: 'underline'
            }}
          >
            retry
          </button>
        </span>
      );
    }
    return e.answer ?? '';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Thread */}
      <div
        ref={threadRef}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          background: 'var(--cth-paper-200)', padding: 10,
          display: 'flex', flexDirection: 'column', gap: 10,
          fontFamily: 'var(--cth-font-mono)'
        }}
      >
        {entries.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 12 }}>
            Ask god anything about the hive — tasks, agents, status, decisions.
            <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--cth-ink-300)' }}>
              Press Enter to send. Shift+Enter for a new line.
            </span>
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Question bubble */}
            <div style={{
              alignSelf: 'flex-end', maxWidth: '85%',
              background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
              padding: '6px 10px 4px', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            }}>
              {e.question}
            </div>
            {/* Answer bubble */}
            <div style={{
              alignSelf: 'flex-start', maxWidth: '85%',
              background: 'var(--cth-lilac-light, #ece2f5)',
              boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)',
              padding: '6px 10px 4px', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            }}>
              {renderAnswer(e)}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div style={{
        borderTop: '1px solid var(--cth-ink-100)',
        padding: '8px 10px',
        display: 'flex', gap: 6, alignItems: 'flex-end',
        background: 'var(--cth-paper-100)'
      }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask god a question…"
          rows={2}
          style={{
            flex: 1, resize: 'none', background: 'transparent', border: 'none', outline: 'none',
            fontFamily: 'var(--cth-font-mono)', fontSize: 13, lineHeight: '18px',
            color: 'var(--cth-ink-900)', padding: '2px 0'
          }}
        />
        <PixelButton variant="primary" size="sm" onClick={submit} disabled={!draft.trim() || sending}>
          {sending ? '…' : 'ask'}
        </PixelButton>
      </div>
    </div>
  );
}
