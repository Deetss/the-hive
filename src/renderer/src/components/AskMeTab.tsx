import { useEffect, useState, useCallback } from 'react';
import { PixelButton } from './PixelButton';
import { Markdown } from './Markdown';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import type { OpenHumanQAItem } from '../types/tasks';

function formatAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return 'recently';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'recently';
  const diff = Math.max(0, now - ts);
  if (diff < 45_000) return 'just now';
  if (diff < 90_000) return '1 min ago';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 48) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(diff / 86_400_000);
  return `${days} d ago`;
}

/**
 * ASK ME — Unified Human Attention Hub:
 * 1. Direct agent pings (act: query/request/inform with needs_human=true)
 * 2. Open humanQA acceptance tests from tasks.json (UAT checklist)
 */
export function AskMeTab() {
  const messages = useStore((s) => s.humanMessages);
  const resolveHumanMessage = useStore((s) => s.resolveHumanMessage);
  const updateHumanMessageDraft = useStore((s) => s.updateHumanMessageDraft);
  const agents = useStore((s) => s.agents);

  const [openQA, setOpenQA] = useState<OpenHumanQAItem[]>([]);
  const [failOpen, setFailOpen] = useState<Record<string, boolean>>({});
  const [failNotes, setFailNotes] = useState<Record<string, string>>({});
  const [busyTasks, setBusyTasks] = useState<Record<string, boolean>>({});
  const [sendingMsg, setSendingMsg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const nameFor = (id: string | null | undefined) => {
    if (!id) return 'unassigned';
    return agents.find((a) => a.id === id)?.name ?? id;
  };

  const loadQA = useCallback(async () => {
    try {
      if (window.cth?.openHumanQA) {
        const items = await window.cth.openHumanQA();
        setOpenQA(Array.isArray(items) ? items : []);
      }
    } catch (e) {
      console.error('[AskMeTab] failed to load openHumanQA:', e);
    }
  }, []);

  useEffect(() => {
    void loadQA();
    const unsub = window.cth?.onHumanQAChanged?.(() => {
      void loadQA();
    });
    const interval = setInterval(() => {
      void loadQA();
      setNow(Date.now());
    }, 4000);
    return () => {
      unsub?.();
      clearInterval(interval);
    };
  }, [loadQA]);

  const handleAnswer = async (
    taskId: string,
    question: string,
    verdict: 'PASS' | 'FAIL',
    note?: string
  ) => {
    if (busyTasks[taskId]) return;
    setBusyTasks((prev) => ({ ...prev, [taskId]: true }));
    try {
      if (window.cth?.answerHumanQA) {
        await window.cth.answerHumanQA(taskId, question, verdict, note);
      }
      setFailOpen((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
      setFailNotes((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
      await loadQA();
    } catch (e) {
      console.error('[AskMeTab] failed to answer humanQA:', e);
    } finally {
      setBusyTasks((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
    }
  };

  const isQueryThread = (m: { act?: string; subject?: string; conversation?: string }) => {
    if (m.act === 'query' || m.act === 'reply') return true;
    if (m.subject && /quick\s*ask/i.test(m.subject)) return true;
    if (m.conversation?.startsWith('qa-')) return true;
    return false;
  };

  const unresolvedMessages = messages.filter((m) => !m.resolved && !isQueryThread(m));
  const hasDirectPings = unresolvedMessages.length > 0;
  const hasUatQuestions = openQA.length > 0;
  const isAllClear = !hasDirectPings && !hasUatQuestions;

  return (
    <div style={{
      flex: 1, minHeight: 0, overflowY: 'auto',
      background: 'var(--cth-paper-200)', padding: 12,
      display: 'flex', flexDirection: 'column', gap: 14,
      fontFamily: 'var(--cth-font-ui)'
    }}>
      {/* SECTION 3 — ALL CLEAR */}
      {isAllClear && (
        <div style={{
          textAlign: 'center', padding: '36px 16px',
          color: 'var(--cth-ink-500)', fontSize: 13,
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>🌿</div>
          <strong style={{ fontSize: 14, color: 'var(--cth-ink-900)' }}>No pending questions — floor is all clear.</strong><br />
          <span style={{ fontSize: 13, color: 'var(--cth-ink-500)', marginTop: 4, display: 'inline-block' }}>
            Direct agent queries and open human acceptance tests will appear here when attention is needed.
          </span>
        </div>
      )}

      {/* SECTION 1 — DIRECT AGENT PINGS (NEEDS ATTENTION NOW) */}
      {hasDirectPings && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12, fontWeight: 700, color: 'var(--cth-coral)',
            textTransform: 'uppercase', letterSpacing: '0.5px'
          }}>
            <span>⚠ NEEDS ATTENTION NOW ({unresolvedMessages.length})</span>
          </div>

          {unresolvedMessages.map((msg) => (
            <div key={msg.id} style={{
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-sky)',
              display: 'flex', flexDirection: 'column'
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px',
                background: 'var(--cth-sky)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)'
              }}>
                <span style={{
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600,
                  color: 'var(--cth-ink-900)', background: 'var(--cth-lemon)', padding: '1px 4px'
                }}>
                  {msg.act === 'prompt' ? 'PROMPT' : msg.act === 'request' ? 'REQUEST' : 'MESSAGE'}
                </span>
                <span style={{
                  flex: 1, fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 600,
                  color: 'var(--cth-ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}>
                  {msg.subject || `from ${nameFor(msg.from)}`}
                </span>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', flexShrink: 0 }}>
                  {new Date(msg.arrivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Markdown text={msg.body} style={{ fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)' }} />
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                  <textarea
                    value={msg.replyDraft}
                    onChange={(e) => updateHumanMessageDraft(msg.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        void (async () => {
                          const text = msg.replyDraft.trim();
                          if (!text || sendingMsg === msg.id) return;
                          setSendingMsg(msg.id);
                          await window.cth.hiveSend({ to: msg.from, act: 'inform', subject: `Re: ${msg.subject}`, body: text }, 'human');
                          resolveHumanMessage(msg.id);
                          setSendingMsg(null);
                        })();
                      }
                    }}
                    rows={2}
                    placeholder="Reply… (Ctrl+Enter to send)"
                    style={{
                      flex: 1, boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical',
                      background: 'var(--cth-paper-100)', border: 'none',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
                    }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <PixelButton variant="primary" size="sm"
                    disabled={!msg.replyDraft.trim() || sendingMsg === msg.id}
                    onClick={() => void (async () => {
                      const text = msg.replyDraft.trim();
                      if (!text || sendingMsg === msg.id) return;
                      setSendingMsg(msg.id);
                      await window.cth.hiveSend({ to: msg.from, act: 'inform', subject: `Re: ${msg.subject}`, body: text }, 'human');
                      resolveHumanMessage(msg.id);
                      setSendingMsg(null);
                    })()}>
                    {sendingMsg === msg.id ? 'sending…' : 'reply & resolve'}
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
      )}

      {/* SECTION 2 — OPEN UAT ACCEPTANCE TESTS */}
      {hasUatQuestions && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            fontSize: 12, fontWeight: 700, color: 'var(--cth-ink-700)',
            textTransform: 'uppercase', letterSpacing: '0.5px'
          }}>
            <span>📋 OPEN UAT QUESTIONS ({openQA.length})</span>
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--cth-ink-500)', textTransform: 'none' }}>
              Verify worker changes &amp; check off tasks
            </span>
          </div>

          {openQA.map((item) => {
            const isBusy = !!busyTasks[item.taskId];
            const isFailing = !!failOpen[item.taskId];
            const noteVal = failNotes[item.taskId] ?? '';

            return (
              <div
                key={`${item.taskId}-${item.question}`}
                style={{
                  background: 'var(--cth-paper-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  display: 'flex', flexDirection: 'column'
                }}
              >
                {/* Header info row */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                  background: 'var(--cth-cream-100)', borderBottom: '1px solid var(--cth-ink-100)'
                }}>
                  <span style={{
                    fontFamily: 'var(--cth-font-ui)', fontSize: 11, fontWeight: 600,
                    background: 'var(--cth-lemon-light)', color: 'var(--cth-ink-900)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-lemon)',
                    padding: '1px 5px', textTransform: 'uppercase', flexShrink: 0
                  }}>
                    {nameFor(item.assignee)}
                  </span>
                  <span style={{
                    flex: 1, fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 600,
                    color: 'var(--cth-ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }} title={item.taskTitle}>
                    {item.taskTitle}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', flexShrink: 0 }}>
                    {formatAgo(item.askedAt, now)}
                  </span>
                </div>

                {/* Question body & actions */}
                <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{
                    fontSize: 13, lineHeight: '19px', color: 'var(--cth-ink-900)',
                    background: 'var(--cth-paper-200)', padding: '8px 10px',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                  }}>
                    <Markdown text={item.question} />
                  </div>

                  {/* Failure note input field */}
                  {isFailing && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
                      <label style={{ fontSize: 12, color: 'var(--cth-coral)', fontWeight: 600 }}>
                        Failure Reason / Feedback for {nameFor(item.assignee)}:
                      </label>
                      <textarea
                        value={noteVal}
                        onChange={(e) => setFailNotes((prev) => ({ ...prev, [item.taskId]: e.target.value }))}
                        rows={2}
                        placeholder="What didn't work? (e.g. icon still shows wrong symbol, button not clickable...)"
                        style={{
                          width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                          background: 'var(--cth-paper-100)', border: 'none',
                          boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                          fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
                        }}
                      />
                    </div>
                  )}

                  {/* Action buttons */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {!isFailing ? (
                      <>
                        <PixelButton
                          variant="primary"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => void handleAnswer(item.taskId, item.question, 'PASS')}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="check" /> PASS ✓
                          </span>
                        </PixelButton>

                        <PixelButton
                          variant="secondary"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => setFailOpen((prev) => ({ ...prev, [item.taskId]: true }))}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--cth-coral)' }}>
                            <Icon name="x" /> FAIL ✗
                          </span>
                        </PixelButton>
                      </>
                    ) : (
                      <>
                        <PixelButton
                          variant="primary"
                          size="sm"
                          disabled={isBusy || !noteVal.trim()}
                          onClick={() => void handleAnswer(item.taskId, item.question, 'FAIL', noteVal.trim())}
                        >
                          <span>Reject &amp; Send Feedback</span>
                        </PixelButton>

                        <PixelButton
                          variant="secondary"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => setFailOpen((prev) => {
                            const next = { ...prev };
                            delete next[item.taskId];
                            return next;
                          })}
                        >
                          Cancel
                        </PixelButton>
                      </>
                    )}

                    {isBusy && (
                      <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                        processing…
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
