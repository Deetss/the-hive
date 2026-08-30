import { CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { UatPanel } from './UatPanel';
import { useStore } from '@/store/store';
import { HumanQA, HiveTask } from '@/types/tasks';
import { useMediaQuery } from '@/hooks/useMediaQuery';

/** The card's currently open question for the human, if any. An entry the human
 *  dismissed (dismissedAt) counts as resolved, same as an answered one.
 *  Only returns 'question' kind entries (not action/review — those are in assignedToMe). */
export function openQuestion(t: HiveTask): HumanQA | undefined {
  if (!Array.isArray(t.humanQA)) return undefined;
  for (let i = t.humanQA.length - 1; i >= 0; i--) {
    const e = t.humanQA[i];
    const kind = e?.kind ?? 'question';
    if (e && typeof e.q === 'string' && kind === 'question' && !e.a && !e.dismissedAt) return e;
  }
  return undefined;
}

/** True if this humanQA entry is still pending the human's action. */
function isPendingHumanQA(e: HumanQA): boolean {
  if (e.dismissedAt) return false;
  const kind = e.kind ?? 'question';
  if (kind === 'question') return !e.a;
  if (kind === 'action') return !e.doneAt;
  if (kind === 'review') return e.approved === undefined;
  return false;
}

function fmtAge(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '<1m';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function fmtSessionTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Waiting on the human = blocked with an unanswered question on the card. */
export function waitsOnHuman(t: HiveTask): boolean {
  return t.status === 'blocked' && !!openQuestion(t);
}

type Status = HiveTask['status'];

const COLUMNS: { key: Status; label: string; accent: string }[] = [
  { key: 'todo',    label: 'TODO',    accent: 'var(--cth-sky)' },
  { key: 'doing',   label: 'DOING',   accent: 'var(--cth-lemon)' },
  { key: 'blocked', label: 'BLOCKED', accent: 'var(--cth-coral)' },
  { key: 'done',    label: 'DONE',    accent: 'var(--cth-mint)' }
];

const POLL_MS = 5000;

/** Deterministic fallback id derived from a task's content (djb2 → base36).
 *  Used for tasks lacking a valid string id so re-parsing tasks.json on every
 *  5s poll yields the SAME id — no React key churn / card remount. Unlike
 *  shortId() (random, for brand-new tasks), this never changes across polls. */
function stableId(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (((h << 5) + h) ^ seed.charCodeAt(i)) | 0;
  return `t-${(h >>> 0).toString(36)}`;
}

/** Normalize whatever hive:tasks returns into a typed task array. The god
 *  writes this file by hand — every field except the shape itself is optional
 *  in practice, so EVERY consumer must go through this (exported for the
 *  detail overlay; a raw card without dependsOn once crashed it). */
export function parseTasks(raw: unknown): HiveTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: unknown[] }).tasks
    : [];
  return list
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t, i) => ({
      id: typeof t.id === 'string' && t.id
        ? t.id
        : stableId(`${typeof t.title === 'string' ? t.title : ''}|${typeof t.createdAt === 'string' ? t.createdAt : ''}|${i}`),
      title: typeof t.title === 'string' ? t.title : '(untitled)',
      description: typeof t.description === 'string' ? t.description : undefined,
      assignee: typeof t.assignee === 'string' ? t.assignee : undefined,
      status: (['todo', 'doing', 'blocked', 'done'] as const).includes(t.status as Status)
        ? (t.status as Status) : 'todo',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      priority: typeof t.priority === 'number' ? t.priority : 3,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
      humanQA: Array.isArray(t.humanQA)
        ? (t.humanQA as unknown[])
          .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { q?: unknown }).q === 'string')
          .map((e) => ({
            q: e.q as string,
            kind: (e.kind === 'question' || e.kind === 'action' || e.kind === 'review')
              ? e.kind : undefined,
            a: typeof e.a === 'string' ? e.a : undefined,
            askedAt: typeof e.askedAt === 'string' ? e.askedAt : undefined,
            answeredAt: typeof e.answeredAt === 'string' ? e.answeredAt : undefined,
            dismissedAt: typeof e.dismissedAt === 'string' ? e.dismissedAt : undefined,
            doneAt: typeof e.doneAt === 'string' ? e.doneAt : undefined,
            docPath: typeof e.docPath === 'string' ? e.docPath : undefined,
            approved: typeof e.approved === 'boolean' ? e.approved : undefined
          }))
        : undefined
    }));
}

/**
 * Task kanban over hive/tasks.json — a READ surface. Polls every 5s; cards
 * carry just the title and open the app-wide detail overlay on click. The god
 * is the ledger's writer: new work enters via the dispatch box (mailed to the
 * god), never by the human inserting cards the orchestrator never heard about.
 */
export function TasksKanban({ mobile = false }: { mobile?: boolean } = {}) {
  const agents = useStore((s) => s.agents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const lastTasksSerialized = useRef<string>('');
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const setAssignedPending = useStore((s) => s.setAssignedPending);
  const activeTaskSession = useStore((s) => s.activeTaskSession);
  const taskSessionHistory = useStore((s) => s.taskSessionHistory);
  const viewedTaskSessionId = useStore((s) => s.viewedTaskSessionId);
  const selectTaskSession = useStore((s) => s.selectTaskSession);
  const startNewTaskSession = useStore((s) => s.startNewTaskSession);
  const renameTaskSession = useStore((s) => s.renameTaskSession);
  const deleteTaskSession = useStore((s) => s.deleteTaskSession);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [atmeCollapsed, setAtmeCollapsed] = useState(false);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [view, setView] = useState<'tasks' | 'uat'>('tasks');
  const [uatPending, setUatPending] = useState(0);

  const viewingActive = viewedTaskSessionId === null;
  const selectedArchivedSession = useMemo(
    () => taskSessionHistory.find((entry) => entry.id === viewedTaskSessionId) ?? null,
    [taskSessionHistory, viewedTaskSessionId]
  );
  const readOnly = !viewingActive;

  const tasksByStatus = useMemo(() => {
    const buckets = new Map<Status, HiveTask[]>(COLUMNS.map((col) => [col.key, []] as [Status, HiveTask[]]));
    for (const task of tasks) {
      const bucket = buckets.get(task.status) ?? buckets.get('todo');
      bucket?.push(task);
    }
    return buckets;
  }, [tasks]);

  const loadLiveTasks = useCallback(async (): Promise<HiveTask[] | null> => {
    try {
      const next = parseTasks(await window.cth.hiveTasks());
      const serialized = JSON.stringify(next);
      setTasks((prev) => {
        if (lastTasksSerialized.current === serialized) return prev;
        lastTasksSerialized.current = serialized;
        return next;
      });
      return next;
    } catch {
      return null;
    }
  }, [lastTasksSerialized]);

  const dismissTask = useCallback(async (id: string) => {
    if (readOnly) return;
    setTasks((prev) => prev.filter((t) => t.id !== id));
    try {
      const result = await window.cth.hiveDeleteTask(id);
      if (!result.ok) void loadLiveTasks();
    } catch {
      void loadLiveTasks();
    }
  }, [loadLiveTasks, readOnly]);

  const patchQA = useCallback(async (taskId: string, qa: HumanQA[]) => {
    if (readOnly) return;
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, humanQA: qa } : t));
    try {
      await window.cth.hivePatchTask(taskId, { humanQA: qa });
    } catch {
      void loadLiveTasks();
    }
  }, [loadLiveTasks, readOnly]);

  const sendAnswer = useCallback(async (task: HiveTask, e: HumanQA, draftKey: string) => {
    if (readOnly) return;
    const text = (answerDrafts[draftKey] ?? '').trim();
    if (!text || acting) return;
    setActing(draftKey);
    try {
      const qa = (task.humanQA ?? []).map((q) => q === e ? { ...q, a: text, answeredAt: new Date().toISOString() } : q);
      await patchQA(task.id, qa);
      await window.cth.hiveSend({ to: 'god', act: 'inform', subject: `HUMAN ANSWER on task "${task.title}"`, body: `Q: ${e.q}\nA: ${text}` }, 'human');
      setAnswerDrafts((d) => { const n = { ...d }; delete n[draftKey]; return n; });
    } catch {
      /* leave draft */
    }
    setActing(null);
  }, [acting, answerDrafts, patchQA, readOnly]);

  const markDone = useCallback(async (task: HiveTask, e: HumanQA, draftKey: string) => {
    if (readOnly || acting) return;
    setActing(draftKey);
    try {
      const qa = (task.humanQA ?? []).map((q) => q === e ? { ...q, doneAt: new Date().toISOString() } : q);
      await patchQA(task.id, qa);
    } catch {
      void loadLiveTasks();
    }
    setActing(null);
  }, [acting, loadLiveTasks, patchQA, readOnly]);

  const reviewDecide = useCallback(async (task: HiveTask, e: HumanQA, approved: boolean, draftKey: string) => {
    if (readOnly || acting) return;
    setActing(draftKey);
    try {
      const qa = (task.humanQA ?? []).map((q) => q === e ? { ...q, approved, answeredAt: new Date().toISOString() } : q);
      await patchQA(task.id, qa);
      await window.cth.hiveSend({ to: 'god', act: 'inform', subject: `REVIEW ${approved ? 'APPROVED' : 'CHANGES REQUESTED'} on task "${task.title}"`, body: `${approved ? 'Approved' : 'Changes requested'}: ${e.docPath ?? e.q}` }, 'human');
    } catch {
      void loadLiveTasks();
    }
    setActing(null);
  }, [acting, loadLiveTasks, patchQA, readOnly]);

  const handleSelectActive = useCallback(() => {
    if (!viewingActive) selectTaskSession(null);
  }, [selectTaskSession, viewingActive]);

  const handleSelectArchived = useCallback((sessionId: string) => {
    if (viewedTaskSessionId !== sessionId) selectTaskSession(sessionId);
  }, [selectTaskSession, viewedTaskSessionId]);

  const handleRenameActive = useCallback(() => {
    const next = window.prompt('Rename current session', activeTaskSession.label);
    if (!next) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === activeTaskSession.label) return;
    renameTaskSession(activeTaskSession.id, trimmed);
  }, [activeTaskSession, renameTaskSession]);

  const handleRenameArchived = useCallback((sessionId: string, currentLabel: string) => {
    const next = window.prompt('Rename session', currentLabel);
    if (!next) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === currentLabel) return;
    renameTaskSession(sessionId, trimmed);
  }, [renameTaskSession]);

  const handleOpenTask = useCallback((taskId: string) => {
    if (readOnly) return;
    openTaskDetail(taskId);
  }, [openTaskDetail, readOnly]);

  const handleDeleteArchived = useCallback((sessionId: string) => {
    const ok = window.confirm('Delete this archived session? This removes its task snapshot permanently.');
    if (!ok) return;
    deleteTaskSession(sessionId);
  }, [deleteTaskSession]);

  const handleNewSession = useCallback(async () => {
    const latest = await loadLiveTasks();
    const snapshot = latest ?? tasks;
    startNewTaskSession(snapshot);
    setAnswerDrafts({});
    setExpandedKeys(new Set());
  }, [loadLiveTasks, setAnswerDrafts, setExpandedKeys, startNewTaskSession, tasks]);

  useEffect(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    if (viewingActive) {
      void loadLiveTasks();
      timer.current = setInterval(() => { void loadLiveTasks(); }, POLL_MS);
    } else {
      const snapshot = selectedArchivedSession?.tasks ?? [];
      lastTasksSerialized.current = JSON.stringify(snapshot);
      setTasks(snapshot);
    }
    return () => {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
    };
  }, [loadLiveTasks, selectedArchivedSession, viewingActive]);

  const pendingItems = useMemo(() => tasks
    .flatMap((t) => (t.humanQA ?? [])
      .map((qa, qi) => ({ task: t, qa, key: `${t.id}:${qi}` }))
      .filter((item) => isPendingHumanQA(item.qa)))
    .sort((a, b) => (a.qa.askedAt ?? '') < (b.qa.askedAt ?? '') ? -1 : 1), [tasks]);

  useEffect(() => {
    if (viewingActive) setAssignedPending(pendingItems.length);
  }, [pendingItems.length, setAssignedPending, viewingActive]);

  const restorableAgents = useStore((s) => s.restorableAgents);
  /** Resolve an assignee id to a display name — falls back to the restorable
   *  roster so a done card keeps its author's name even after that worker's
   *  terminal is gone, then to the raw id. */
  const nameFor = (id?: string): string | undefined =>
    id
      ? (agents.find((a) => a.id === id)?.name
        ?? restorableAgents.find((a) => a.id === id)?.name
        ?? id)
      : undefined;

  const baseToggleStyle = {
    fontFamily: 'var(--cth-font-display)',
    fontSize: 9,
    letterSpacing: '0.08em',
    textTransform: 'uppercase'
  };
  const activeToggleStyle = {
    background: 'var(--cth-ink-900)',
    color: 'var(--cth-cream-50)',
    boxShadow: 'inset 0 0 0 1px var(--cth-ink-900), 0 1px 0 var(--cth-ink-900)'
  };
  const sessionButtonStyle: CSSProperties = {
    fontFamily: 'var(--cth-font-ui)',
    fontSize: 11,
    padding: '3px 8px',
    border: '1px solid var(--cth-ink-200)',
    background: 'var(--cth-paper-100)',
    color: 'var(--cth-ink-800)',
    cursor: 'pointer',
    borderRadius: 4,
    lineHeight: '14px',
    whiteSpace: 'nowrap'
  };
  const sessionButtonActiveStyle: CSSProperties = {
    background: 'var(--cth-ink-900)',
    color: 'var(--cth-cream-50)',
    borderColor: 'var(--cth-ink-900)'
  };
  const sessionIconButtonStyle: CSSProperties = {
    background: 'none',
    border: 'none',
    color: 'var(--cth-ink-500)',
    cursor: 'pointer',
    padding: 0,
    lineHeight: 1
  };
  const uatBadgeStatus = uatPending > 0 ? 'waiting' : 'success';
  const uatBadgeLabel = uatPending > 0
    ? `${uatPending} UAT ${uatPending === 1 ? 'item' : 'items'} open`
    : 'UAT clear';
  const activeSessionStarted = fmtSessionTimestamp(activeTaskSession.startedAt);
  const isViewingArchived = !viewingActive && !!selectedArchivedSession;
  const selectedSessionRange = selectedArchivedSession
    ? `Started ${fmtSessionTimestamp(selectedArchivedSession.startedAt)} · Ended ${fmtSessionTimestamp(selectedArchivedSession.endedAt)}`
    : '';

  return (
    <div style={{
      flex: 1,
      minHeight: mobile ? 'auto' : 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--cth-paper-200)',
      position: 'relative'
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)', background: 'var(--cth-paper-50)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', letterSpacing: '0.08em' }}>
          SESSIONS
        </span>
        <button
          onClick={handleSelectActive}
          style={{ ...sessionButtonStyle, ...(viewingActive ? sessionButtonActiveStyle : {}) }}
          title={`Started ${activeSessionStarted}`}
        >
          {activeTaskSession.label}
        </button>
        <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>
          since {activeSessionStarted}
        </span>
        {taskSessionHistory.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {taskSessionHistory.map((session) => (
              <div key={session.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                  onClick={() => handleSelectArchived(session.id)}
                  style={{ ...sessionButtonStyle, ...(viewedTaskSessionId === session.id ? sessionButtonActiveStyle : {}) }}
                  title={`Started ${fmtSessionTimestamp(session.startedAt)} · Ended ${fmtSessionTimestamp(session.endedAt)}`}
                >
                  {session.label}
                </button>
                <button
                  onClick={() => handleRenameArchived(session.id, session.label)}
                  style={sessionIconButtonStyle}
                  title="Rename session"
                >
                  ✎
                </button>
                <button
                  onClick={() => handleDeleteArchived(session.id)}
                  style={sessionIconButtonStyle}
                  title="Delete session"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <PixelButton variant="secondary" size="sm" onClick={handleRenameActive}>
            rename
          </PixelButton>
          <PixelButton variant="primary" size="sm" onClick={handleNewSession}>
            new session
          </PixelButton>
        </div>
      </div>
      {isViewingArchived && selectedArchivedSession && (
        <div style={{
          padding: '6px 10px', borderBottom: '1px solid var(--cth-ink-300)',
          background: 'var(--cth-paper-100)', fontFamily: 'var(--cth-font-ui)',
          fontSize: 11, color: 'var(--cth-ink-700)'
        }}>
          Viewing archived session {selectedArchivedSession.label} ({selectedSessionRange}). Actions are read-only.
        </div>
      )}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)', background: 'var(--cth-paper-100)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', letterSpacing: '0.08em' }}>
          MODES
        </span>
        <PixelButton
          variant="secondary"
          size="sm"
          onClick={() => setView('tasks')}
          style={{ ...baseToggleStyle, ...(view === 'tasks' ? activeToggleStyle : {}) }}
        >
          TASK BOARD
        </PixelButton>
        <PixelButton
          variant="secondary"
          size="sm"
          onClick={() => setView('uat')}
          style={{ ...baseToggleStyle, ...(view === 'uat' ? activeToggleStyle : {}) }}
        >
          UAT CHECKLIST
        </PixelButton>
        <div style={{ marginLeft: 'auto' }}>
          <PixelBadge status={uatBadgeStatus} label={uatBadgeLabel} />
        </div>
      </div>

      <div style={{
        flex: 1, minHeight: 0, display: view === 'tasks' ? 'flex' : 'none', flexDirection: 'column'
      }}>
        {/* Assigned to me — pending humanQA items across all tasks */}
        {pendingItems.length > 0 && (
        <div style={{ flexShrink: 0, borderBottom: '2px solid var(--cth-ink-300)' }}>
          <button
            onClick={() => setAtmeCollapsed((v) => !v)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '5px 10px', border: 'none', cursor: 'pointer',
              background: 'var(--cth-coral-light, #fde8e8)',
              fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)',
              textAlign: 'left'
            }}
          >
            <span>ASSIGNED TO ME</span>
            <span style={{
              minWidth: 16, height: 16, borderRadius: 8,
              background: 'var(--cth-coral)', color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 8, padding: '0 4px', boxSizing: 'border-box'
            }}>{pendingItems.length}</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>
              {atmeCollapsed ? '▶' : '▼'}
            </span>
          </button>
          {!atmeCollapsed && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {pendingItems.map(({ task, qa, key }) => {
                const kind = qa.kind ?? 'question';
                const chipColor = kind === 'question' ? 'var(--cth-lilac)'
                  : kind === 'action' ? 'var(--cth-lemon)'
                  : 'var(--cth-sky)';
                const chipLabel = kind === 'question' ? 'QUESTION' : kind === 'action' ? 'ACTION' : 'REVIEW';
                const isActing = acting === key;
                return (
                  <div key={key} style={{
                    padding: '7px 10px',
                    borderBottom: '1px solid var(--cth-ink-100)',
                    background: 'var(--cth-cream-100)',
                    display: 'flex', flexDirection: 'column', gap: 4
                  }}>
                    {/* Header row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        fontFamily: 'var(--cth-font-display)', fontSize: 7, padding: '1px 5px 0',
                        background: chipColor, color: 'var(--cth-ink-900)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0
                      }}>{chipLabel}</span>
                      <span style={{
                        fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1
                      }}>{task.title}</span>
                      <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--cth-ink-400)', fontFamily: 'var(--cth-font-display)' }}>
                        {fmtAge(qa.askedAt)}
                      </span>
                    </div>
                    {/* Ask text — click to expand/collapse when long */}
                    <div
                      onClick={() => setExpandedKeys((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key); else next.add(key);
                        return next;
                      })}
                      title={expandedKeys.has(key) ? 'Click to collapse' : 'Click to expand'}
                      style={{
                        fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '15px',
                        color: 'var(--cth-ink-800)', cursor: 'pointer',
                        ...(expandedKeys.has(key) ? {} : {
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'
                        })
                      }}
                    >
                      {kind === 'review' && qa.docPath ? qa.docPath : qa.q}
                    </div>
                    {/* Action row */}
                    {kind === 'question' && (
                      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                        <input
                          type="text"
                        value={answerDrafts[key] ?? ''}
                        onChange={(e) => setAnswerDrafts((d) => ({ ...d, [key]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') void sendAnswer(task, qa, key); }}
                        placeholder="your answer…"
                          disabled={readOnly || isActing}
                          style={{
                            flex: 1, padding: '3px 6px', border: 'none', outline: 'none',
                            background: 'var(--cth-paper-100)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                            color: 'var(--cth-ink-900)'
                          }}
                        />
                        <button
                          onClick={() => void sendAnswer(task, qa, key)}
                          disabled={readOnly || isActing || !(answerDrafts[key] ?? '').trim()}
                          style={{
                            padding: '3px 8px', border: 'none', cursor: 'pointer',
                            background: 'var(--cth-mint)', color: 'var(--cth-ink-900)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                            fontFamily: 'var(--cth-font-display)', fontSize: 8,
                            opacity: isActing ? 0.5 : 1
                          }}
                        >SEND</button>
                      </div>
                    )}
                    {kind === 'action' && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 2 }}>
                        <button
                          onClick={() => void markDone(task, qa, key)}
                          disabled={readOnly || isActing}
                          style={{
                            padding: '3px 8px', border: 'none', cursor: 'pointer',
                            background: 'var(--cth-mint)', color: 'var(--cth-ink-900)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                            fontFamily: 'var(--cth-font-display)', fontSize: 8,
                            opacity: isActing ? 0.5 : 1
                          }}
                        >MARK DONE</button>
                      </div>
                    )}
                    {kind === 'review' && (
                      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                        {qa.docPath && (
                          <button
                            onClick={() => window.cth.openExternal?.(qa.docPath!)}
                            style={{
                              padding: '3px 8px', border: 'none', cursor: 'pointer',
                              background: 'var(--cth-paper-100)', color: 'var(--cth-ink-700)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                              fontFamily: 'var(--cth-font-display)', fontSize: 8
                            }}
                          >OPEN</button>
                        )}
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                          <button
                            onClick={() => void reviewDecide(task, qa, false, key)}
                            disabled={readOnly || isActing}
                            style={{
                              padding: '3px 8px', border: 'none', cursor: 'pointer',
                              background: 'var(--cth-coral-light, #fde8e8)', color: 'var(--cth-ink-900)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                              fontFamily: 'var(--cth-font-display)', fontSize: 8,
                              opacity: isActing ? 0.5 : 1
                            }}
                          >CHANGES</button>
                          <button
                            onClick={() => void reviewDecide(task, qa, true, key)}
                            disabled={readOnly || isActing}
                            style={{
                              padding: '3px 8px', border: 'none', cursor: 'pointer',
                              background: 'var(--cth-mint)', color: 'var(--cth-ink-900)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                              fontFamily: 'var(--cth-font-display)', fontSize: 8,
                              opacity: isActing ? 0.5 : 1
                            }}
                          >APPROVE</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)' }}>
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cth-ink-300)' }}>
          new work? dispatch it to Abathur (monitor tab)
        </span>
      </div>

      {/* Columns */}
      <div style={{
        flex: 1,
        minHeight: mobile ? 'auto' : 0,
        display: 'flex',
        flexDirection: mobile ? 'column' : 'row',
        gap: 8,
        padding: 10,
        overflowX: mobile ? 'hidden' : 'auto',
        overflowY: mobile ? 'visible' : 'hidden'
      }}>
        {COLUMNS.map((col) => {
          const cards = tasksByStatus.get(col.key) ?? [];
          return (
            <div key={col.key} style={{
              flex: mobile ? '1 0 auto' : '1 1 0',
              minWidth: mobile ? '100%' : 170,
              display: 'flex', flexDirection: 'column',
              background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 4px',
                background: col.accent, boxShadow: 'inset 0 -1px 0 var(--cth-ink-900)',
                fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)'
              }}>
                {col.label}
                <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--cth-font-ui)' }}>{cards.length}</span>
              </div>
              <div style={{
                flex: 1,
                minHeight: mobile ? 'auto' : 0,
                overflowY: 'auto',
                padding: 6,
                display: 'flex', flexDirection: 'column', gap: 6
              }}>
                {cards.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-300)', textAlign: 'center', padding: '8px 0' }}>—</div>
                )}
                {cards.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    accent={col.accent}
                    assigneeName={nameFor(t.assignee)}
                    onOpen={readOnly ? undefined : handleOpenTask}
                    onDismiss={readOnly ? undefined : dismissTask}
                    readOnly={readOnly}
                  />
                ))}
              </div>
            </div>
          );
        })}
        </div>
      </div>

      <div style={{
        flex: 1, minHeight: 0, display: view === 'uat' ? 'flex' : 'none', flexDirection: 'column', padding: 10
      }}>
        <UatPanel onPendingChange={setUatPending} />
      </div>
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────
// Deliberately minimal — a colored status edge, the title, a whisper of an
// assignee. Everything else (the full contract, deps, controls) lives in the
// detail view a click away: a kanban card can carry a title at most.

interface TaskCardProps {
  task: HiveTask;
  accent: string;
  assigneeName?: string;
  onOpen?: (taskId: string) => void;
  onDismiss?: (taskId: string) => void;
  readOnly: boolean;
}

const TaskCard = memo(function TaskCard({ task, accent, assigneeName, onOpen, onDismiss, readOnly }: TaskCardProps) {
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        onClick={readOnly || !onOpen ? undefined : () => onOpen(task.id)}
        title={readOnly ? 'Session history view (read-only)' : 'open task details'}
        style={{
          flex: 1, minWidth: 0,
          display: 'flex', alignItems: 'stretch', gap: 0, padding: 0,
          border: 'none', cursor: readOnly || !onOpen ? 'default' : 'pointer', textAlign: 'left',
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}
      >
        <span style={{ width: 4, flexShrink: 0, background: accent, boxShadow: 'inset -1px 0 0 var(--cth-ink-700)' }} />
        <span style={{ flex: 1, minWidth: 0, padding: '6px 18px 6px 7px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
            color: 'var(--cth-ink-900)',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'
          }}>{task.title}</span>
          {assigneeName && (
            <span style={{ fontSize: 10, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)' }}>
              {assigneeName.toUpperCase()}
            </span>
          )}
        </span>
        {waitsOnHuman(task) && (
          <span title="waiting on YOUR answer — see the ASK ME tab" style={{
            alignSelf: 'center', marginRight: 18, flexShrink: 0,
            fontFamily: 'var(--cth-font-display)', fontSize: 10, padding: '2px 5px 1px',
            background: 'var(--cth-lilac)', color: 'var(--cth-ink-900)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>?</span>
        )}
      </button>
      {!readOnly && onDismiss && (
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(task.id); }}
          title="dismiss this task (removes it from the board)"
          aria-label="dismiss task"
          style={{
            position: 'absolute', top: 0, right: 0, width: 16, height: 16, padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
            border: 'none', cursor: 'pointer', background: 'transparent',
            color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)', fontSize: 12
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--cth-coral)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--cth-ink-500)'; }}
        >✕</button>
      )}
    </div>
  );
}, (prev, next) =>
  prev.task === next.task
  && prev.accent === next.accent
  && prev.assigneeName === next.assigneeName
  && prev.readOnly === next.readOnly
  && prev.onOpen === next.onOpen
  && prev.onDismiss === next.onDismiss);

// ─── Detail view ─────────────────────────────────────────────────────────────
// The full breakdown of one task: status, assignee, priority, the complete
// description (the god writes 4-part dispatch contracts in there — preserved
// line by line), dependencies resolved to their titles, the human Q&A trail,
// and the move/assign controls that used to crowd every card. Rendered as an
// APP-WIDE overlay (over the office floor) — this content grows, so it gets
// the big stage instead of the narrow side panel. Exported for App's
// TaskDetailOverlay; opened via the store's openTaskDetail from anywhere.

export function TaskDetail({ task, all, assigneeName, onMove, onAssign, onClose }: {
  task: HiveTask;
  all: HiveTask[];
  assigneeName?: string;
  onMove: (s: Status) => void;
  onAssign: () => void;
  onClose: () => void;
}) {
  const isMobile = useMediaQuery('(max-width: 480px)');
  const col = COLUMNS.find((c) => c.key === task.status) ?? COLUMNS[0];
  // Belt + suspenders: parseTasks normalizes these, but the ledger is a
  // hand-written file — never trust a card's shape at the point of use.
  const deps = (task.dependsOn ?? [])
    .map((id) => all.find((t) => t.id === id))
    .filter((t): t is HiveTask => !!t);
  const created = new Date(task.createdAt);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 280,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex',
        alignItems: isMobile ? 'flex-end' : 'center',
        justifyContent: 'center',
        padding: isMobile ? 0 : 24
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: isMobile ? '100%' : 720,
          maxWidth: '100%',
          maxHeight: isMobile ? '100%' : '90vh',
          height: isMobile ? '100%' : 'auto',
          display: 'flex'
        }}
      >
        <PixelPanel variant="dialog" title="TASK" noPadding style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: 0 }}>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto' }}>
            {/* Title under a status-colored bar */}
            <div style={{ borderLeft: `4px solid ${col.accent}`, paddingLeft: 8 }}>
              <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 15, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                {task.title}
              </div>
            </div>

            {/* Fact row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 8, padding: '2px 6px 1px',
                background: col.accent, color: 'var(--cth-ink-900)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}>{col.label}</span>
              {assigneeName
                ? <PixelBadge status="working" label={assigneeName} />
                : <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>unassigned</span>}
              <PriorityDots level={Math.max(1, Math.min(5, task.priority))} />
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)' }}>
                {isNaN(created.getTime()) ? '' : created.toLocaleString()}
              </span>
            </div>

            {/* The contract — preserved line by line */}
            <div style={{
              padding: 10, background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '18px',
              color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            }}>
              {task.description?.trim() || <span style={{ color: 'var(--cth-ink-300)' }}>(no description on this card)</span>}
            </div>

            {/* The human Q&A trail — every decision documented on the card */}
            {(task.humanQA?.length ?? 0) > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>
                  HUMAN Q&A
                </div>
                {task.humanQA!.map((e, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{
                      padding: '5px 7px', background: 'var(--cth-lilac-light, #ece2f5)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap'
                    }}>
                      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, marginRight: 6 }}>Q</span>
                      {e.q}
                    </div>
                    {e.a ? (
                      <div style={{
                        padding: '5px 7px', background: 'var(--cth-mint-light, #d9eed9)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap'
                      }}>
                        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, marginRight: 6 }}>A</span>
                        {e.a}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: 'var(--cth-coral)', fontFamily: 'var(--cth-font-display)' }}>
                        AWAITING YOUR ANSWER — ASK ME TAB
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Dependencies, resolved to titles */}
            {deps.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>
                  DEPENDS ON
                </div>
                {deps.map((d) => {
                  const dc = COLUMNS.find((c) => c.key === d.status) ?? COLUMNS[0];
                  return (
                    <div key={d.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px',
                      background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      fontSize: 12, color: 'var(--cth-ink-700)'
                    }}>
                      <span style={{ width: 8, height: 8, background: dc.accent, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <select
                value={task.status}
                onChange={(e) => onMove(e.target.value as Status)}
                style={{
                  flex: 1, padding: '4px 6px', background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontFamily: 'var(--cth-font-ui)',
                  fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer'
                }}
              >
                {COLUMNS.map((c) => (<option key={c.key} value={c.key}>{c.label.toLowerCase()}</option>))}
              </select>
              <PixelButton variant="secondary" size="sm" onClick={onAssign}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <Icon name="arrow-right" /> assign
                </span>
              </PixelButton>
              <PixelButton variant="ghost" size="sm" onClick={onClose}>close</PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function PriorityDots({ level }: { level: number }) {
  // 1 = lowest, 5 = highest. Warmer fill as priority climbs.
  const color = level >= 4 ? 'var(--cth-coral)' : level === 3 ? 'var(--cth-lemon)' : 'var(--cth-mint)';
  return (
    <span title={`Priority ${level}/5`} style={{ display: 'inline-flex', gap: 1, flexShrink: 0, marginTop: 2 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{
          width: 4, height: 8,
          background: i <= level ? color : 'var(--cth-cream-200)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }} />
      ))}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)', outline: 'none', boxSizing: 'border-box'
};

const selectStyle: React.CSSProperties = {
  padding: '3px 6px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer'
};

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)'
};
