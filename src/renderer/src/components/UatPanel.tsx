import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { Markdown } from './Markdown';

interface UatPanelProps {
  onPendingChange?: (pending: number) => void;
}

const KIND_META: Record<string, { label: string; color: string }> = {
  question: { label: 'QUESTION', color: 'var(--cth-lilac)' },
  action: { label: 'ACTION', color: 'var(--cth-lemon)' },
  review: { label: 'REVIEW', color: 'var(--cth-sky)' },
  decision: { label: 'DECISION', color: 'var(--cth-peach)' }
};

function fmtAge(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Read-only VIEW of the open humanQA / UAT items — the SAME list that drives the
 * "for you" tab, which is the single home for verification. Answering happens
 * there; this is a compact checklist summary (task title + question + kind + age).
 * The old uat.json-backed checklist was always empty because agents post humanQA
 * onto task cards, not to that file — so this reads the canonical humanQA list.
 */
export function UatPanel({ onPendingChange }: UatPanelProps) {
  const openQA = useStore((s) => s.openHumanQAItems);

  useEffect(() => {
    onPendingChange?.(openQA.length);
  }, [openQA.length, onPendingChange]);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-700)', margin: '0 0 10px' }}>
        Open verification items across all tasks. Answer them in the “for you” tab — this is a read-only summary.
      </p>
      {openQA.length === 0 ? (
        <div style={{
          padding: 12, fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)',
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}>
          Nothing waiting on you. Agents surface UAT questions here as they finish work.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {openQA.map((item, i) => {
            const meta = KIND_META[item.kind ?? 'question'] ?? KIND_META.question;
            return (
              <div key={`${item.taskId}:${i}`} style={{
                padding: '8px 10px', background: 'var(--cth-cream-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                display: 'flex', flexDirection: 'column', gap: 4
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    fontFamily: 'var(--cth-font-ui)', fontSize: 7, padding: '1px 5px 0',
                    background: meta.color, color: 'var(--cth-ink-900)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0
                  }}>{meta.label}</span>
                  <span style={{
                    fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-700)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1
                  }}>{item.taskTitle}</span>
                  <span style={{ flexShrink: 0, fontSize: 13, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)' }}>
                    {fmtAge(item.askedAt)}
                  </span>
                </div>
                <Markdown text={item.question} style={{
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '16px', color: 'var(--cth-ink-800)', maxWidth: '72ch'
                }} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
