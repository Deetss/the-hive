/**
 * Human-command toast — surfaces a decision or instruction the human types
 * straight into an agent's terminal so it is not buried in that one scrollback.
 *
 * The terminal is the one place a human directive ("let's cut another release")
 * lands with zero hive awareness: `onUserPrompt` already stamps `agent.lastPrompt`
 * (a card on the office floor), but that is invisible in focus mode or with the
 * floor scrolled away. This is the app-wide, layout-independent surface — the
 * same self-subscribing / self-dismissing pattern as CompletionToast / UpdateToast,
 * mounted once in App.tsx.
 *
 * NOT part of the humanQA / ASK ME system: this is a passive glanceable record of
 * what was typed, not a question that needs answering.
 */
import { useEffect, useRef, useState } from 'react';

/** Window CustomEvent the terminal hosts dispatch on a human-submitted line. */
const EVENT = 'cth:human-terminal-input';

export interface HumanCommandDetail {
  agentId: string;
  agentName: string;
  text: string;
}

/** Dispatch a human-command signal for the toast. Filters out the lines that are
 *  not decisions or instructions: slash-commands (agent control, already visible
 *  in the agent's own reaction) and bare single-token entries (`ls`, `y`). */
export function emitHumanCommand(agentId: string, agentName: string, text: string): void {
  const t = text.trim();
  if (!t || t.length > 500) return;
  if (t.startsWith('/')) return;
  if (t.split(/\s+/).length < 2) return;
  window.dispatchEvent(new CustomEvent<HumanCommandDetail>(EVENT, { detail: { agentId, agentName, text: t } }));
}

interface ActiveToast extends HumanCommandDetail {
  key: string;
}

const AUTO_DISMISS_MS = 9000;
const MAX_VISIBLE = 4;

export function HumanCommandToast(): JSX.Element | null {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = (key: string): void => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
    const tm = timers.current.get(key);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(key);
    }
  };

  useEffect(() => {
    const timersAtMount = timers.current;
    const onEvt = (e: Event): void => {
      const detail = (e as CustomEvent<HumanCommandDetail>).detail;
      if (!detail || !detail.text) return;
      const key = `${detail.agentId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { ...detail, key }].slice(-MAX_VISIBLE));
      const tm = setTimeout(() => dismiss(key), AUTO_DISMISS_MS);
      timersAtMount.set(key, tm);
    };
    window.addEventListener(EVENT, onEvt);
    return () => {
      window.removeEventListener(EVENT, onEvt);
      for (const tm of timersAtMount.values()) clearTimeout(tm);
      timersAtMount.clear();
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: 16,
        bottom: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 380,
        pointerEvents: 'none'
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.key}
          role="status"
          style={{
            pointerEvents: 'auto',
            background: 'var(--cth-paper-100)',
            // Sky edge + heavy ink drop, so it reads as "the human said this"
            // rather than as agent output or a completion notice.
            boxShadow: 'inset 0 0 0 1.5px var(--cth-sky), 4px 4px 0 0 var(--cth-ink-900)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: 'var(--cth-font-ui)',
              fontSize: 13,
              lineHeight: '12px',
              color: 'var(--cth-ink-900)',
              textTransform: 'uppercase'
            }}
          >
            <span style={{ color: 'var(--cth-sky)' }}>You → {t.agentName}</span>
            <button
              type="button"
              onClick={() => dismiss(t.key)}
              aria-label="Dismiss"
              style={{
                marginLeft: 'auto',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 13,
                lineHeight: '10px',
                color: 'var(--cth-ink-700)',
                padding: 0
              }}
            >
              ✕
            </button>
          </div>
          <div
            style={{
              fontFamily: 'var(--cth-font-ui)',
              fontSize: 15,
              lineHeight: '20px',
              color: 'var(--cth-ink-900)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            }}
          >
            {t.text}
          </div>
        </div>
      ))}
    </div>
  );
}
