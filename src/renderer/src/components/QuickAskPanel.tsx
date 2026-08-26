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

interface QAEntry {
  id: string;
  question: string;
  answer?: string;
  askedAt: number;
  conversation: string;
  waiting: boolean;
}

export function QuickAskPanel() {
  const [entries, setEntries] = useState<QAEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  // Subscribe to hive:message so god's replies land inline without polling.
  useEffect(() => {
    if (!window.cth?.onHiveMessage) return;
    const unsub = window.cth.onHiveMessage((e) => {
      if (!e.needsHuman || !e.body || !e.conversation) return;
      setEntries((prev) =>
        prev.map((entry) =>
          entry.conversation === e.conversation && entry.waiting
            ? { ...entry, answer: e.body, waiting: false }
            : entry
        )
      );
    });
    return unsub;
  }, []);

  // Scroll to bottom whenever thread grows.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries]);

  const submit = async () => {
    const q = draft.trim();
    if (!q || sending) return;
    const conversation = `qa-${crypto.randomUUID()}`;
    const entry: QAEntry = { id: conversation, question: q, askedAt: Date.now(), conversation, waiting: true };
    setEntries((prev) => [...prev, entry]);
    setDraft('');
    setSending(true);
    try {
      await window.cth.hiveSend(
        { to: 'god', act: 'query', subject: 'Quick ask', body: q, conversation },
        'human'
      );
    } catch {
      setEntries((prev) =>
        prev.map((e) => e.conversation === conversation ? { ...e, answer: '(send failed — check god is online)', waiting: false } : e)
      );
    }
    setSending(false);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
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
            {/* Answer bubble or waiting indicator */}
            <div style={{
              alignSelf: 'flex-start', maxWidth: '85%',
              background: 'var(--cth-lilac-light, #ece2f5)',
              boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)',
              padding: '6px 10px 4px', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            }}>
              {e.waiting
                ? <span style={{ color: 'var(--cth-ink-500)', fontStyle: 'italic' }}>waiting for god…</span>
                : e.answer}
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
