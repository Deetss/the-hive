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
import { getAgentDisplayName } from '@/lib/agentNames';

export function AskMeTab() {
  const messages = useStore((s) => s.humanMessages);
  const resolveHumanMessage = useStore((s) => s.resolveHumanMessage);
  const updateHumanMessageDraft = useStore((s) => s.updateHumanMessageDraft);
  const agents = useStore((s) => s.agents);
  const restorableAgents = useStore((s) => s.restorableAgents);

  const openQA = useStore((s) => s.openHumanQAItems);
  const setOpenHumanQA = useStore((s) => s.setOpenHumanQA);

  // Optional comment on a UAT item — rides along on PASS / FAIL, or stands alone
  // as a "comment only" note.
  const [comments, setComments] = useState<Record<string, string>>({});
  // At most one pasted/attached screenshot per open item, as a data URL — rides
  // along on the same PASS / FAIL / comment submit as the comment text.
  const [images, setImages] = useState<Record<string, string>>({});
  const [answerVals, setAnswerVals] = useState<Record<string, string>>({});
  const [busyTasks, setBusyTasks] = useState<Record<string, boolean>>({});
  // "Chat about this" — thread drafts / open / sending, keyed by `${taskId}::${question}`
  // (NOT taskId alone: one card can carry several open items).
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>({});
  const [chatOpen, setChatOpen] = useState<Record<string, boolean>>({});
  const [chatSending, setChatSending] = useState<Record<string, boolean>>({});
  // At most one pasted/attached screenshot per chat draft, keyed like chatDrafts.
  const [chatImages, setChatImages] = useState<Record<string, string>>({});
  const [sendingMsg, setSendingMsg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const nameFor = (id: string | null | undefined) => getAgentDisplayName(id, agents, restorableAgents);

  const loadQA = useCallback(async () => {
    try {
      if (window.cth?.openHumanQA) {
        const items = await window.cth.openHumanQA();
        setOpenHumanQA(Array.isArray(items) ? items : []);
      }
    } catch (e) {
      console.error('[AskMeTab] failed to load openHumanQA:', e);
    }
  }, [setOpenHumanQA]);

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
    verdict: 'PASS' | 'FAIL' | 'ANSWER',
    note?: string
  ) => {
    if (busyTasks[taskId]) return;
    setBusyTasks((prev) => ({ ...prev, [taskId]: true }));
    try {
      const image = images[taskId];
      if (window.cth?.answerHumanQA) {
        await window.cth.answerHumanQA(taskId, question, verdict, note, image ? [image] : undefined);
      }
      setOpenHumanQA(openQA.filter((q) => !(q.taskId === taskId && q.question === question)));
      setComments((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
      setAnswerVals((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
      setImages((prev) => {
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

  const handleChat = async (taskId: string, question: string) => {
    const key = `${taskId}::${question}`;
    const text = (chatDrafts[key] ?? '').trim();
    if (!text || chatSending[key]) return;
    setChatSending((p) => ({ ...p, [key]: true }));
    try {
      const image = chatImages[key];
      if (window.cth?.chatHumanQA) {
        await window.cth.chatHumanQA(taskId, question, text, image ? [image] : undefined);
      }
      setChatDrafts((p) => { const n = { ...p }; delete n[key]; return n; });
      setChatImages((p) => { const n = { ...p }; delete n[key]; return n; });
      await loadQA();
    } catch (e) {
      console.error('[AskMeTab] failed to send chat:', e);
    } finally {
      setChatSending((p) => { const n = { ...p }; delete n[key]; return n; });
    }
  };

  const handleDismiss = async (taskId: string, question: string) => {
    if (busyTasks[taskId]) return;
    setBusyTasks((prev) => ({ ...prev, [taskId]: true }));
    try {
      if (window.cth?.dismissHumanQA) {
        await window.cth.dismissHumanQA(taskId, question);
      }
      setOpenHumanQA(openQA.filter((q) => !(q.taskId === taskId && q.question === question)));
      await loadQA();
    } catch (e) {
      console.error('[AskMeTab] failed to dismiss humanQA:', e);
    } finally {
      setBusyTasks((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
    }
  };

  const readImageAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
      reader.readAsDataURL(file);
    });

  const handlePasteImage = (taskId: string) => (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const item = Array.from(e.clipboardData.items).find((it) => it.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    void readImageAsDataUrl(file)
      .then((dataUrl) => setImages((prev) => ({ ...prev, [taskId]: dataUrl })))
      .catch((err) => console.error('[AskMeTab] failed to read pasted image:', err));
  };

  const handleAttachImage = (taskId: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void readImageAsDataUrl(file)
      .then((dataUrl) => setImages((prev) => ({ ...prev, [taskId]: dataUrl })))
      .catch((err) => console.error('[AskMeTab] failed to read attached image:', err));
  };

  const clearImage = (taskId: string) => {
    setImages((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  };

  const handlePasteChatImage = (chatKey: string) => (e: React.ClipboardEvent<HTMLInputElement>) => {
    const item = Array.from(e.clipboardData.items).find((it) => it.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    void readImageAsDataUrl(file)
      .then((dataUrl) => setChatImages((prev) => ({ ...prev, [chatKey]: dataUrl })))
      .catch((err) => console.error('[AskMeTab] failed to read pasted chat image:', err));
  };

  const handleAttachChatImage = (chatKey: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void readImageAsDataUrl(file)
      .then((dataUrl) => setChatImages((prev) => ({ ...prev, [chatKey]: dataUrl })))
      .catch((err) => console.error('[AskMeTab] failed to read attached chat image:', err));
  };

  const clearChatImage = (chatKey: string) => {
    setChatImages((prev) => {
      const next = { ...prev };
      delete next[chatKey];
      return next;
    });
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
                  color: 'var(--cth-ink-900)', background: 'var(--cth-lemon)', padding: '1px 4px', flexShrink: 0
                }}>
                  {msg.act === 'prompt' ? 'PROMPT' : msg.act === 'request' ? 'REQUEST' : 'MESSAGE'}
                </span>
                <span style={{
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600,
                  color: 'var(--cth-ink-900)', background: 'var(--cth-cream-200)', padding: '1px 5px',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0
                }}>
                  {nameFor(msg.from)}
                </span>
                <span style={{
                  flex: 1, fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 600,
                  color: 'var(--cth-ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}>
                  {msg.subject || 'Direct message'}
                </span>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', flexShrink: 0 }}>
                  {new Date(msg.arrivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Markdown text={msg.body} style={{ fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)', maxWidth: '72ch' }} />
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
            const commentVal = comments[item.taskId] ?? '';
            const isUrgent = item.priority === 'urgent';
            const isDecision = item.kind === 'decision';
            const answerVal = answerVals[item.taskId] ?? '';

            return (
              <div
                key={`${item.taskId}-${item.question}`}
                style={{
                  background: 'var(--cth-paper-100)',
                  boxShadow: isUrgent ? 'inset 0 0 0 2px var(--cth-coral), 0 0 8px rgba(235, 87, 87, 0.2)' : 'inset 0 0 0 1px var(--cth-ink-300)',
                  display: 'flex', flexDirection: 'column'
                }}
              >
                {/* Header info row */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                  background: isUrgent ? 'var(--cth-coral-light, #fee2e2)' : 'var(--cth-cream-100)',
                  borderBottom: isUrgent ? '1px solid var(--cth-coral)' : '1px solid var(--cth-ink-100)'
                }}>
                  {isUrgent && (
                    <span style={{
                      fontFamily: 'var(--cth-font-ui)', fontSize: 11, fontWeight: 700,
                      background: 'var(--cth-coral)', color: '#fff',
                      padding: '1px 6px', textTransform: 'uppercase', flexShrink: 0
                    }}>
                      🚨 URGENT
                    </span>
                  )}
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
                  <button
                    type="button"
                    title="Dismiss question without changing task status"
                    disabled={isBusy}
                    onClick={() => void handleDismiss(item.taskId, item.question)}
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer',
                      fontSize: 12, color: 'var(--cth-ink-500)', padding: '2px 6px',
                      display: 'inline-flex', alignItems: 'center', gap: 3
                    }}
                  >
                    ✕ clear
                  </button>
                </div>

                {/* Question body & actions */}
                <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{
                    fontSize: 13, lineHeight: '19px', color: 'var(--cth-ink-900)',
                    background: 'var(--cth-paper-200)', padding: '8px 10px',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                  }}>
                    <Markdown text={item.question} style={{ maxWidth: '72ch' }} />
                  </div>

                  {isDecision ? (
                    <>
                      {/* Decision ask — freeform text reply, no PASS/FAIL */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
                        <label style={{ fontSize: 12, color: 'var(--cth-ink-700)', fontWeight: 600 }}>
                          Your answer for {nameFor(item.assignee)}:
                        </label>
                        <textarea
                          value={answerVal}
                          onChange={(e) => setAnswerVals((prev) => ({ ...prev, [item.taskId]: e.target.value }))}
                          rows={2}
                          placeholder="Type your reply (e.g. 'go with option B', 'yes, ship it')…"
                          style={{
                            width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                            background: 'var(--cth-paper-100)', border: 'none',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
                          }}
                        />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <PixelButton
                          variant="primary"
                          size="sm"
                          disabled={isBusy || !answerVal.trim()}
                          onClick={() => void handleAnswer(item.taskId, item.question, 'ANSWER', answerVal.trim())}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="check" /> Send answer
                          </span>
                        </PixelButton>
                        <PixelButton
                          variant="secondary"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => void handleDismiss(item.taskId, item.question)}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            clear / dismiss
                          </span>
                        </PixelButton>
                        {isBusy && (
                          <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                            processing…
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                  <>
                  {/* Optional comment — included in the PASS / FAIL answer, or
                      sent on its own as a note with no verdict. Paste or attach
                      one screenshot alongside it as visual evidence. */}
                  <textarea
                    value={commentVal}
                    onChange={(e) => setComments((prev) => ({ ...prev, [item.taskId]: e.target.value }))}
                    onPaste={handlePasteImage(item.taskId)}
                    rows={2}
                    placeholder="Optional comment… (you can paste a screenshot)"
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                      background: 'var(--cth-paper-100)', border: 'none',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
                    }}
                  />

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <label
                      title="Attach a screenshot"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                        fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)'
                      }}
                    >
                      <Icon name="image" /> attach
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleAttachImage(item.taskId)}
                        style={{ display: 'none' }}
                      />
                    </label>
                    {images[item.taskId] && (
                      <div style={{ position: 'relative', display: 'inline-flex' }}>
                        <img
                          src={images[item.taskId]}
                          alt="attachment preview"
                          style={{ height: 44, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', display: 'block' }}
                        />
                        <button
                          type="button"
                          title="Remove attachment"
                          onClick={() => clearImage(item.taskId)}
                          style={{
                            position: 'absolute', top: -6, right: -6, width: 16, height: 16, padding: 0,
                            border: 'none', borderRadius: '50%', background: 'var(--cth-coral)', color: '#fff',
                            fontSize: 10, lineHeight: '16px', cursor: 'pointer'
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <PixelButton
                      variant="primary"
                      size="sm"
                      disabled={isBusy}
                      onClick={() => void handleAnswer(item.taskId, item.question, 'PASS', commentVal.trim() || undefined)}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Icon name="check" /> PASS ✓
                      </span>
                    </PixelButton>

                    <PixelButton
                      variant="secondary"
                      size="sm"
                      disabled={isBusy}
                      onClick={() => void handleAnswer(item.taskId, item.question, 'FAIL', commentVal.trim() || undefined)}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--cth-coral)' }}>
                        <Icon name="x" /> FAIL ✗
                      </span>
                    </PixelButton>

                    <PixelButton
                      variant="secondary"
                      size="sm"
                      disabled={isBusy || !commentVal.trim()}
                      onClick={() => void handleAnswer(item.taskId, item.question, 'ANSWER', commentVal.trim())}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        comment only
                      </span>
                    </PixelButton>

                    <PixelButton
                      variant="secondary"
                      size="sm"
                      disabled={isBusy}
                      onClick={() => void handleDismiss(item.taskId, item.question)}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        clear / dismiss
                      </span>
                    </PixelButton>

                    {isBusy && (
                      <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                        processing…
                      </span>
                    )}
                  </div>
                  </>
                  )}

                  {/* Chat about this — a back-and-forth with the assigned agent,
                      additive to the PASS/FAIL/comment decision above. */}
                  {(() => {
                    const chatKey = `${item.taskId}::${item.question}`;
                    const thread = item.thread ?? [];
                    const isOpen = !!chatOpen[chatKey] || thread.length > 0;
                    const draft = chatDrafts[chatKey] ?? '';
                    const sending = !!chatSending[chatKey];
                    return (
                      <div style={{ borderTop: '1px solid var(--cth-ink-100)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => setChatOpen((p) => ({ ...p, [chatKey]: !isOpen }))}
                          style={{
                            alignSelf: 'flex-start', border: 'none', background: 'transparent', cursor: 'pointer',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)',
                            display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0
                          }}
                        >
                          💬 Chat about this{thread.length ? ` (${thread.length})` : ''} {isOpen ? '▾' : '▸'}
                        </button>
                        {isOpen && (
                          <>
                            {thread.length > 0 && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {thread.map((m, mi) => (
                                  <div key={mi} style={{
                                    alignSelf: m.from === 'human' ? 'flex-end' : 'flex-start',
                                    maxWidth: '85%',
                                    background: m.from === 'human' ? 'var(--cth-sky-light, #e3f0fb)' : 'var(--cth-cream-100)',
                                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', padding: '5px 8px'
                                  }}>
                                    <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 10, color: 'var(--cth-ink-500)', marginBottom: 2 }}>
                                      {m.from === 'human' ? 'you' : nameFor(item.assignee)} · {formatAgo(m.ts, now)}
                                    </div>
                                    <Markdown text={m.text} style={{ fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)', maxWidth: '72ch' }} />
                                    {m.images?.[0] && (
                                      <img
                                        src={m.images[0]}
                                        alt="attached screenshot"
                                        style={{ marginTop: 4, maxHeight: 140, maxWidth: '100%', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}
                                      />
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                            {thread.length > 0 && thread[thread.length - 1].from === 'human' && (
                              <div style={{
                                alignSelf: 'flex-start', fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                                fontStyle: 'italic', color: 'var(--cth-ink-500)'
                              }}>
                                waiting for {nameFor(item.assignee)} to reply…
                              </div>
                            )}
                            {chatImages[chatKey] && (
                              <div style={{ position: 'relative', display: 'inline-flex', alignSelf: 'flex-start' }}>
                                <img
                                  src={chatImages[chatKey]}
                                  alt="attachment preview"
                                  style={{ height: 40, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', display: 'block' }}
                                />
                                <button
                                  type="button"
                                  title="Remove attachment"
                                  onClick={() => clearChatImage(chatKey)}
                                  style={{
                                    position: 'absolute', top: -6, right: -6, width: 16, height: 16, padding: 0,
                                    border: 'none', borderRadius: '50%', background: 'var(--cth-coral)', color: '#fff',
                                    fontSize: 10, lineHeight: '16px', cursor: 'pointer'
                                  }}
                                >
                                  ✕
                                </button>
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <input
                                type="text"
                                value={draft}
                                onChange={(e) => setChatDrafts((p) => ({ ...p, [chatKey]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') void handleChat(item.taskId, item.question); }}
                                onPaste={handlePasteChatImage(chatKey)}
                                placeholder={`ask ${nameFor(item.assignee)}…`}
                                disabled={sending}
                                style={{
                                  flex: 1, padding: '4px 8px', border: 'none', outline: 'none',
                                  background: 'var(--cth-paper-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
                                  fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)'
                                }}
                              />
                              <label
                                title="Attach a screenshot"
                                style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', color: 'var(--cth-ink-700)' }}
                              >
                                <Icon name="image" />
                                <input
                                  type="file"
                                  accept="image/*"
                                  onChange={handleAttachChatImage(chatKey)}
                                  style={{ display: 'none' }}
                                />
                              </label>
                              <PixelButton
                                variant="secondary"
                                size="sm"
                                onClick={() => void handleChat(item.taskId, item.question)}
                                disabled={sending || !draft.trim()}
                              >
                                {sending ? '…' : 'send'}
                              </PixelButton>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
