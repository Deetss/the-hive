import { useEffect, useRef } from 'react';
import { PixelButton } from './PixelButton';
import { Markdown } from './Markdown';
import { useStore, type QAEntry } from '@/store/store';

/**
 * QuickAskPanel — lightweight inline Q&A with god.
 *
 * The human types a question; it is sent to god via the existing inbox/outbox
 * bus as a `query` message. God sees it in its inbox, replies with an `inform`
 * back to `'human'`, and the reply lands via the live `hive:message` push in
 * App.tsx's always-on subscription (which calls resolveQuickAskReply on the
 * store). The Q&A thread lives in the zustand store so it survives tab switches
 * and unmount/remount cycles; replies are captured even while the panel is not
 * mounted.
 */

const TIMEOUT_MS = 90_000;

// Module-level timer map — outlives component mounts/unmounts so timeouts fire
// even when the panel is not currently rendered.
const _qaTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function cancelQaTimer(wireId: string) {
  const t = _qaTimers.get(wireId);
  if (t !== undefined) { clearTimeout(t); _qaTimers.delete(wireId); }
}

function armQaTimer(wireId: string) {
  cancelQaTimer(wireId);
  _qaTimers.set(wireId, setTimeout(() => {
    _qaTimers.delete(wireId);
    useStore.getState().timeoutQuickAskEntry(wireId);
  }, TIMEOUT_MS));
}

export function QuickAskPanel() {
  const entries = useStore((s) => s.quickAskEntries);
  const addQuickAskEntry = useStore((s) => s.addQuickAskEntry);
  const rotateQuickAskEntry = useStore((s) => s.rotateQuickAskEntry);
  const failQuickAskEntry = useStore((s) => s.failQuickAskEntry);
  const trackQuickAskConversation = useStore((s) => s.trackQuickAskConversation);
  const draft = useStore((s) => s.drafts['__quickask__'] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const sending = useRef(false);
  const threadRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom whenever thread grows.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries]);

  const submit = async () => {
    const q = draft.trim();
    if (!q || sending.current) return;
    const wireId = `qa-${crypto.randomUUID()}`;
    const entry: QAEntry = {
      id: wireId, question: q, askedAt: Date.now(),
      currentConversation: wireId, waiting: true, timedOut: false
    };
    addQuickAskEntry(entry);
    setDraft('__quickask__', '');
    sending.current = true;
    try {
      await window.cth.hiveSend(
        { to: 'god', act: 'query', subject: 'Quick ask', body: q, conversation: wireId },
        'human'
      );
      trackQuickAskConversation(wireId);
      armQaTimer(wireId);
    } catch {
      failQuickAskEntry(wireId, '(send failed — check the Overmind is online)');
    }
    sending.current = false;
  };

  const retry = (entry: QAEntry) => {
    cancelQaTimer(entry.currentConversation);
    const newWireId = `qa-${crypto.randomUUID()}`;
    rotateQuickAskEntry(entry.id, newWireId);
    void window.cth.hiveSend(
      { to: 'god', act: 'query', subject: 'Quick ask (retry)', body: entry.question, conversation: newWireId },
      'human'
    ).then(() => {
      trackQuickAskConversation(newWireId);
      armQaTimer(newWireId);
    }).catch(() => {
      failQuickAskEntry(entry.id, '(retry failed)');
    });
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
  };

  const renderAnswer = (e: QAEntry): JSX.Element => {
    if (e.waiting) {
      return <span style={{ color: 'var(--cth-ink-500)', fontStyle: 'italic' }}>waiting for the Overmind…</span>;
    }
    if (e.timedOut) {
      return (
        <span style={{ color: 'var(--cth-ink-500)' }}>
          no answer yet (the Overmind may be busy){' '}
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
    return <Markdown text={e.answer ?? ''} style={{ fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)', wordBreak: 'break-word' }} />;
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
            Ask the Overmind anything about the hive — tasks, agents, status, decisions.
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
              <Markdown text={e.question} style={{ fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)', wordBreak: 'break-word' }} />
            </div>
            {/* Answer bubble */}
            <div style={{
              alignSelf: 'flex-start', maxWidth: '85%',
              background: 'var(--cth-lilac-light, #ece2f5)',
              boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)',
              padding: '6px 10px 4px', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)',
              wordBreak: 'break-word'
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
          onChange={(e) => setDraft('__quickask__', e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask the Overmind a question…"
          rows={2}
          style={{
            flex: 1, resize: 'none', background: 'transparent', border: 'none', outline: 'none',
            fontFamily: 'var(--cth-font-mono)', fontSize: 13, lineHeight: '18px',
            color: 'var(--cth-ink-900)', padding: '2px 0'
          }}
        />
        <PixelButton variant="primary" size="sm" onClick={submit} disabled={!draft.trim()}>
          ask
        </PixelButton>
      </div>
    </div>
  );
}
