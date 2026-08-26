import { useState } from 'react';
import { PixelButton } from './PixelButton';
import { useStore } from '@/store/store';

/**
 * ASK ME — direct hive messages addressed to the human.
 *
 * Task-blocked humanQA items (questions, actions, reviews) live in the Tasks
 * panel under "Assigned to me". This surface is for direct agent→human
 * messages (act: query/request/inform with needs_human=true) that need a
 * reply or acknowledgement.
 */

export function AskMeTab() {
  const messages = useStore((s) => s.humanMessages);
  const resolveHumanMessage = useStore((s) => s.resolveHumanMessage);
  const updateHumanMessageDraft = useStore((s) => s.updateHumanMessageDraft);
  const agents = useStore((s) => s.agents);
  const [sending, setSending] = useState<string | null>(null);

  const nameFor = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  const unresolvedMessages = messages.filter((m) => !m.resolved);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)', padding: 10, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'var(--cth-font-mono)' }}>
      {unresolvedMessages.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 12 }}>
          Nothing needs you right now. 🌿<br />
          <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>
            Direct messages from agents show up here. Task-blocked questions and actions
            live in the Tasks tab under "Assigned to me".
          </span>
        </div>
      )}

      {unresolvedMessages.map((msg) => (
        <div key={msg.id} style={{ background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-sky)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', background: 'var(--cth-sky)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)' }}>
            <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-900)', background: 'var(--cth-lemon)', padding: '1px 4px' }}>
              {msg.act === 'query' ? 'QUERY' : 'MESSAGE'}
            </span>
            <span style={{ flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 14, color: 'var(--cth-ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {msg.subject || `from ${nameFor(msg.from)}`}
            </span>
            <span style={{ fontSize: 10, color: 'var(--cth-ink-700)', flexShrink: 0 }}>
              {new Date(msg.arrivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 14, lineHeight: '19px', color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap' }}>{msg.body}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <textarea
                value={msg.replyDraft}
                onChange={(e) => updateHumanMessageDraft(msg.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    void (async () => {
                      const text = msg.replyDraft.trim();
                      if (!text || sending === msg.id) return;
                      setSending(msg.id);
                      await window.cth.hiveSend({ to: msg.from, act: 'inform', subject: `Re: ${msg.subject}`, body: text }, 'human');
                      resolveHumanMessage(msg.id);
                      setSending(null);
                    })();
                  }
                }}
                rows={2}
                placeholder="Reply… (Ctrl+Enter to send)"
                style={{ flex: 1, boxSizing: 'border-box', padding: '5px 7px', resize: 'vertical', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-mono)', fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <PixelButton variant="primary" size="sm"
                disabled={!msg.replyDraft.trim() || sending === msg.id}
                onClick={() => void (async () => {
                  const text = msg.replyDraft.trim();
                  if (!text || sending === msg.id) return;
                  setSending(msg.id);
                  await window.cth.hiveSend({ to: msg.from, act: 'inform', subject: `Re: ${msg.subject}`, body: text }, 'human');
                  resolveHumanMessage(msg.id);
                  setSending(null);
                })()}>
                {sending === msg.id ? 'sending…' : 'reply & resolve'}
              </PixelButton>
              <PixelButton variant="secondary" size="sm"
                onClick={() => resolveHumanMessage(msg.id)}>
                dismiss
              </PixelButton>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
