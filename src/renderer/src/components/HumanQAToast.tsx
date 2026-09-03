/**
 * A brief top-right toast when a NEW humanQA (Ask Me) question appears, so
 * Dylan doesn't have to be watching the Ask Me tab to notice one. Self-
 * subscribing to the store's `openHumanQAItems` (kept live at App root
 * regardless of which tab/agent is focused) — it owns no polling of its own.
 * Mount once, anywhere in the renderer tree.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import type { OpenHumanQAItem } from '../types/tasks';

interface ActiveToast {
  key: string;
  taskTitle: string;
  question: string;
}

const AUTO_DISMISS_MS = 6000;
const MAX_VISIBLE = 4;
const QUESTION_TRUNCATE = 140;

function itemKey(item: OpenHumanQAItem): string {
  return `${item.taskId}::${item.question}`;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function HumanQAToast(): JSX.Element | null {
  const openQA = useStore((s) => s.openHumanQAItems);
  const agents = useStore((s) => s.agents);
  const select = useStore((s) => s.select);
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  // null until the first poll seeds it — that first poll must NOT toast for
  // questions that were already open before this session started watching.
  const seenKeys = useRef<Set<string> | null>(null);
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
    if (seenKeys.current === null) {
      seenKeys.current = new Set(openQA.map(itemKey));
      return;
    }
    const seen = seenKeys.current;
    const fresh = openQA.filter((item) => !seen.has(itemKey(item)));
    for (const item of fresh) {
      const key = itemKey(item);
      seen.add(key);
      const toast: ActiveToast = { key, taskTitle: item.taskTitle, question: truncate(item.question, QUESTION_TRUNCATE) };
      setToasts((prev) => [...prev, toast].slice(-MAX_VISIBLE));
      const tm = setTimeout(() => dismiss(key), AUTO_DISMISS_MS);
      timers.current.set(key, tm);
    }
    // A question that closed (answered/dismissed) drops out of "seen" too, so
    // the same taskId+question re-asked later toasts again instead of staying
    // silent forever.
    const openKeys = new Set(openQA.map(itemKey));
    for (const k of Array.from(seen)) {
      if (!openKeys.has(k)) seen.delete(k);
    }
  }, [openQA]);

  useEffect(() => {
    const timersAtMount = timers.current;
    return () => {
      for (const tm of timersAtMount.values()) clearTimeout(tm);
      timersAtMount.clear();
    };
  }, []);

  const goToAskMe = (key: string): void => {
    const god = agents.find((a) => a.isOvermind);
    if (god) select(god.id);
    requestCommandCenterTab('human');
    dismiss(key);
  };

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 360,
        pointerEvents: 'none'
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.key}
          role="status"
          onClick={() => goToAskMe(t.key)}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-coral), 4px 4px 0 0 var(--cth-ink-900)',
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
            <Icon name="bell" /> new question
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); dismiss(t.key); }}
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
          <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
            {t.taskTitle}
          </div>
          <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
            {t.question}
          </div>
        </div>
      ))}
    </div>
  );
}
