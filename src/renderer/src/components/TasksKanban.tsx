import { ClipboardEvent, CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { UatPanel } from './UatPanel';
import { Markdown } from './Markdown';
import { useStore } from '@/store/store';
import { HumanQA, HiveTask } from '@/types/tasks';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { getAgentDisplayName } from '@/lib/agentNames';

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



function fmtSessionTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Waiting on the human = blocked with an unanswered question on the card. */
export function waitsOnHuman(t: HiveTask): boolean {
  return t.status === 'blocked' && !!openQuestion(t);
}

type Status = HiveTask['status'];

const COLUMNS: { key: Status; label: string; accent: string; pipColor: string }[] = [
  { key: 'todo',    label: 'TODO',    accent: 'var(--cth-ink-300)', pipColor: 'var(--cth-ink-500)' },
  { key: 'doing',   label: 'DOING',   accent: 'var(--cth-sky)',     pipColor: 'var(--cth-sky)' },
  { key: 'blocked', label: 'BLOCKED', accent: 'var(--cth-coral)',   pipColor: 'var(--cth-coral)' },
  { key: 'done',    label: 'DONE',    accent: 'var(--cth-mint)',    pipColor: 'var(--cth-mint)' }
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
      notes: typeof t.notes === 'string' ? t.notes : undefined,
      result: typeof t.result === 'string' ? t.result : undefined,
      assignee: typeof t.assignee === 'string' ? t.assignee : undefined,
      status: (['todo', 'doing', 'blocked', 'done'] as const).includes(t.status as Status)
        ? (t.status as Status) : 'todo',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      priority: typeof t.priority === 'number' ? t.priority : 3,
      progress: typeof t.progress === 'number' ? Math.max(0, Math.min(100, t.progress)) : undefined,
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
        : undefined,
      progressLog: Array.isArray(t.progressLog)
        ? (t.progressLog as unknown[])
          .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { step?: unknown }).step === 'string')
          .map((e) => ({
            step: e.step as string,
            ts: typeof e.ts === 'string' ? e.ts : new Date().toISOString()
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
  const activeTaskSession = useStore((s) => s.activeTaskSession);
  const taskSessionHistory = useStore((s) => s.taskSessionHistory);
  const viewedTaskSessionId = useStore((s) => s.viewedTaskSessionId);
  const selectTaskSession = useStore((s) => s.selectTaskSession);
  const startNewTaskSession = useStore((s) => s.startNewTaskSession);
  const renameTaskSession = useStore((s) => s.renameTaskSession);
  const deleteTaskSession = useStore((s) => s.deleteTaskSession);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [view, setView] = useState<'tasks' | 'uat'>('tasks');
  const [uatPending, setUatPending] = useState(0);
  const [dragOverColumn, setDragOverColumn] = useState<Status | null>(null);
  const dragTaskIdRef = useRef<string | null>(null);

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
  }, [loadLiveTasks, startNewTaskSession, tasks]);

  const moveTaskToStatus = useCallback(async (taskId: string, newStatus: Status) => {
    if (readOnly) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === newStatus) return;
    // Optimistic update
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: newStatus } : t));
    try {
      await window.cth.hivePatchTask(taskId, { status: newStatus });
    } catch {
      void loadLiveTasks();
    }
  }, [loadLiveTasks, readOnly, tasks]);

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

  const restorableAgents = useStore((s) => s.restorableAgents);
  /** Resolve an assignee id to a display name — falls back to the restorable
   *  roster so a done card keeps its author's name even after that worker's
   *  terminal is gone, then to the raw id. */
  const nameFor = (id?: string): string | undefined => (id ? getAgentDisplayName(id, agents, restorableAgents) : undefined);

  const baseToggleStyle = {
    fontFamily: 'var(--cth-font-ui)',
    fontSize: 13,
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
    fontSize: 13,
    padding: '3px 8px',
    border: '1px solid var(--cth-ink-200)',
    background: 'var(--cth-paper-100)',
    color: 'var(--cth-ink-700)',
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
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', letterSpacing: '0.08em' }}>
          SESSIONS
        </span>
        <button
          onClick={handleSelectActive}
          style={{ ...sessionButtonStyle, ...(viewingActive ? sessionButtonActiveStyle : {}) }}
          title={`Started ${activeSessionStarted}`}
        >
          {activeTaskSession.label}
        </button>
        <span style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>
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
          fontSize: 13, color: 'var(--cth-ink-700)'
        }}>
          Viewing archived session {selectedArchivedSession.label} ({selectedSessionRange}). Actions are read-only.
        </div>
      )}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)', background: 'var(--cth-paper-100)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', letterSpacing: '0.08em' }}>
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
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--cth-ink-700)' }}>
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
          const isDropTarget = dragOverColumn === col.key;
          return (
            <div
              key={col.key}
              onDragOver={readOnly ? undefined : (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverColumn(col.key); }}
              onDragLeave={readOnly ? undefined : () => setDragOverColumn(null)}
              onDrop={readOnly ? undefined : (e) => {
                e.preventDefault();
                const taskId = e.dataTransfer.getData('text/plain') || dragTaskIdRef.current;
                setDragOverColumn(null);
                dragTaskIdRef.current = null;
                if (taskId) void moveTaskToStatus(taskId, col.key);
              }}
              style={{
                flex: mobile ? '1 0 auto' : '1 1 0',
                minWidth: mobile ? '100%' : 170,
                display: 'flex', flexDirection: 'column',
                background: isDropTarget ? 'var(--cth-cream-200)' : 'var(--cth-cream-100)',
                boxShadow: isDropTarget
                  ? `inset 0 0 0 2px ${col.accent}`
                  : 'inset 0 0 0 1px var(--cth-ink-300)',
                transition: 'background 0.12s, box-shadow 0.12s'
              }}
            >
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
                background: 'var(--cth-cream-200)',
                boxShadow: 'inset 0 -1px 0 var(--cth-ink-300)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, color: 'var(--cth-ink-900)'
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: col.pipColor, flexShrink: 0 }} />
                {col.label}
                <span style={{
                  marginLeft: 'auto', fontSize: 11, fontWeight: 600,
                  background: 'var(--cth-cream-100)', color: 'var(--cth-ink-500)',
                  padding: '0 5px', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}>{cards.length}</span>
              </div>
              <div style={{
                flex: 1,
                minHeight: mobile ? 'auto' : 0,
                overflowY: 'auto',
                padding: 6,
                display: 'flex', flexDirection: 'column', gap: 6
              }}>
                {cards.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', textAlign: 'center', padding: '8px 0' }}>—</div>
                )}
                {cards.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    accent={col.accent}
                    assigneeName={nameFor(t.assignee)}
                    onOpen={readOnly ? undefined : handleOpenTask}
                    onDismiss={readOnly ? undefined : dismissTask}
                    onDragStart={readOnly ? undefined : (id) => { dragTaskIdRef.current = id; }}
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
  onDragStart?: (taskId: string) => void;
  readOnly: boolean;
}

const TaskCard = memo(function TaskCard({ task, accent, assigneeName, onOpen, onDismiss, onDragStart, readOnly }: TaskCardProps) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      draggable={!readOnly}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.id);
        setDragging(true);
        onDragStart?.(task.id);
      }}
      onDragEnd={() => setDragging(false)}
      style={{ position: 'relative', display: 'flex', opacity: dragging ? 0.45 : 1, transition: 'opacity 0.12s' }}
    >
      <button
        onClick={readOnly || !onOpen ? undefined : () => onOpen(task.id)}
        title={readOnly ? 'Session history view (read-only)' : 'open task details'}
        style={{
          flex: 1, minWidth: 0,
          display: 'flex', alignItems: 'stretch', gap: 0, padding: 0,
          border: 'none', cursor: readOnly || !onOpen ? 'default' : 'pointer', textAlign: 'left',
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)'
        }}
      >
        <span style={{ width: 4, flexShrink: 0, background: accent, boxShadow: 'inset -1px 0 0 var(--cth-ink-700)' }} />
        <span style={{ flex: 1, minWidth: 0, padding: '6px 18px 6px 7px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
            color: 'var(--cth-ink-900)',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'
          }}>{task.title}</span>
          {typeof task.progress === 'number' && <ProgressBar value={task.progress} />}
          {assigneeName && (
            <span style={{ fontSize: 13, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)' }}>
              {assigneeName.toUpperCase()}
            </span>
          )}
        </span>
        {waitsOnHuman(task) && (
          <span title="waiting on YOUR answer — see the FOR YOU tab" style={{
            alignSelf: 'center', marginRight: 18, flexShrink: 0,
            fontFamily: 'var(--cth-font-ui)', fontSize: 13, padding: '2px 5px 1px',
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
  && prev.onDismiss === next.onDismiss
  && prev.onDragStart === next.onDragStart);


// ─── Detail view ─────────────────────────────────────────────────────────────
// The full breakdown of one task: status, assignee, priority, the complete
// description (the god writes 4-part dispatch contracts in there — preserved
// line by line), dependencies resolved to their titles, the human Q&A trail,
// and the move/assign controls that used to crowd every card. Rendered as an
// APP-WIDE overlay (over the office floor) — this content grows, so it gets
// the big stage instead of the narrow side panel. Exported for App's
// TaskDetailOverlay; opened via the store's openTaskDetail from anywhere.

export function TaskDetail({ task, all, assigneeName, onMove, onAssign, onPatch, onClose }: {
  task: HiveTask;
  all: HiveTask[];
  assigneeName?: string;
  onMove: (s: Status) => void;
  onAssign: () => void;
  onPatch?: (patch: Partial<HiveTask>) => Promise<void>;
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

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState(task.notes || task.description || '');
  const [isEditingResult, setIsEditingResult] = useState(false);
  const [resultDraft, setResultDraft] = useState(task.result || '');
  const [progressDraft, setProgressDraft] = useState<number>(task.progress ?? 0);

  const agents = useStore((s) => s.agents);
  const requestDispatchSeed = useStore((s) => s.requestDispatchSeed);
  const [isDispatchOpen, setIsDispatchOpen] = useState(false);
  const [dispatchRecipient, setDispatchRecipient] = useState(() => agents.find((a) => a.isOvermind)?.id ?? (agents[0]?.id ?? 'god'));
  const [dispatchMessage, setDispatchMessage] = useState(() => `Task: ${task.title}\nContext: ${task.notes || task.description || ''}`);
  const [dispatchPriority, setDispatchPriority] = useState<'urgent' | 'normal' | 'backlog'>(() => {
    if (task.priority === 1 || (task.priority as unknown) === 'urgent' || (task as any).isUrgent) return 'urgent';
    if (task.priority === 3 || (task.priority as unknown) === 'backlog') return 'backlog';
    return 'normal';
  });
  const [dispatchFeedback, setDispatchFeedback] = useState<string | null>(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);

  useEffect(() => {
    setTitleDraft(task.title);
    setNotesDraft(task.notes || task.description || '');
    setResultDraft(task.result || '');
    setProgressDraft(task.progress ?? 0);
    setDispatchMessage(`Task: ${task.title}\nContext: ${task.notes || task.description || ''}`);
    if (task.priority === 1 || (task.priority as unknown) === 'urgent' || (task as any).isUrgent) setDispatchPriority('urgent');
    else if (task.priority === 3 || (task.priority as unknown) === 'backlog') setDispatchPriority('backlog');
    else setDispatchPriority('normal');
  }, [task.title, task.notes, task.description, task.result, task.progress, task.priority]);

  const saveTitle = async () => {
    setIsEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) {
      await onPatch?.({ title: trimmed });
    }
  };

  const saveNotes = async () => {
    setIsEditingNotes(false);
    if (notesDraft !== (task.notes || task.description || '')) {
      await onPatch?.({ description: notesDraft, notes: notesDraft });
    }
  };

  // Append an attached/pasted file's absolute path on its own line, same
  // path-based convention as the dispatch composer (MessageQueueComposer.tsx).
  const appendNotesPath = (path: string) => {
    if (!path) return;
    setNotesDraft((prev) => (prev.trim() ? `${prev}\n${path}` : path));
  };

  const attachNotesFile = async () => {
    const res = await window.cth.attachFiles();
    if (res.ok) res.files.forEach((f) => appendNotesPath(f.path));
  };

  // Paste a screenshot (no path -> persist the clipboard image to a temp file)
  // or paste files copied from the OS file manager (carry a real path).
  const onNotesPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const hasImage = items.some((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (hasImage) {
      e.preventDefault();
      const res = await window.cth.saveClipboardImage();
      if (res.ok) appendNotesPath(res.file.path);
      return;
    }
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      const paths = files.map((f) => window.cth.pathForFile(f)).filter(Boolean);
      if (paths.length) {
        e.preventDefault();
        paths.forEach(appendNotesPath);
      }
    }
  };

  const saveResult = async () => {
    setIsEditingResult(false);
    if (resultDraft !== (task.result || '')) {
      await onPatch?.({ result: resultDraft });
    }
  };

  const saveProgress = async (next: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(next)));
    setProgressDraft(clamped);
    if (clamped !== (task.progress ?? 0)) {
      await onPatch?.({ progress: clamped });
    }
  };

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
              {isEditingTitle ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="text"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={saveTitle}
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveTitle(); if (e.key === 'Escape') setIsEditingTitle(false); }}
                    autoFocus
                    style={{
                      flex: 1, padding: '4px 8px', fontFamily: 'var(--cth-font-ui)', fontSize: 15,
                      fontWeight: 600, color: 'var(--cth-ink-900)', background: 'var(--cth-paper-100)',
                      border: '1px solid var(--cth-ink-700)', outline: 'none'
                    }}
                  />
                  <PixelButton variant="primary" size="sm" onClick={saveTitle}>save</PixelButton>
                </div>
              ) : (
                <div
                  onClick={() => setIsEditingTitle(true)}
                  title="Click to edit title"
                  style={{
                    fontFamily: 'var(--cth-font-ui)', fontSize: 15, lineHeight: '20px',
                    color: 'var(--cth-ink-900)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{task.title}</span>
                  <span style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>✎</span>
                </div>
              )}
            </div>

            {/* Fact row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 13, padding: '2px 6px 1px',
                background: col.accent, color: 'var(--cth-ink-900)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}>{col.label}</span>
              {assigneeName
                ? <PixelBadge status="working" label={assigneeName} />
                : <span style={{ fontSize: 13, color: 'var(--cth-ink-300)' }}>unassigned</span>}
              <PriorityDots level={Math.max(1, Math.min(5, task.priority))} />
              <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)' }}>
                {isNaN(created.getTime()) ? '' : created.toLocaleString()}
              </span>
            </div>

            {/* Progress — a bar plus a 0–100 numeric input */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', flexShrink: 0 }}>
                PROGRESS
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ProgressBar value={progressDraft} />
              </div>
              <input
                type="number"
                min={0}
                max={100}
                value={progressDraft}
                onChange={(e) => setProgressDraft(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                onBlur={() => void saveProgress(progressDraft)}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveProgress(progressDraft); }}
                style={{
                  width: 56, padding: '3px 6px', textAlign: 'right',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                  background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', outline: 'none'
                }}
              />
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)', flexShrink: 0 }}>%</span>
            </div>

            {/* The contract / notes — preserved line by line & editable */}
            <div style={{
              padding: 10, background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              display: 'flex', flexDirection: 'column', gap: 6
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>
                  NOTES / DESCRIPTION
                </span>
                {!isEditingNotes && (
                  <button
                    onClick={() => setIsEditingNotes(true)}
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)',
                      textDecoration: 'underline'
                    }}
                  >edit</button>
                )}
              </div>
              {isEditingNotes ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    onPaste={onNotesPaste}
                    rows={6}
                    autoFocus
                    style={{
                      width: '100%', padding: '6px 8px', fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                      lineHeight: '18px', color: 'var(--cth-ink-900)', background: 'var(--cth-cream-100)',
                      border: '1px solid var(--cth-ink-700)', outline: 'none', resize: 'vertical', boxSizing: 'border-box'
                    }}
                  />
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
                    <PixelButton variant="ghost" size="sm" onClick={() => void attachNotesFile()}>
                      <Icon name="plus" /> attach
                    </PixelButton>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <PixelButton variant="ghost" size="sm" onClick={() => setIsEditingNotes(false)}>cancel</PixelButton>
                      <PixelButton variant="primary" size="sm" onClick={saveNotes}>save notes</PixelButton>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  onClick={() => setIsEditingNotes(true)}
                  title="Click to edit notes"
                  style={{
                    fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '18px',
                    color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'pointer'
                  }}
                >
                  {task.notes?.trim() || task.description?.trim() || <span style={{ color: 'var(--cth-ink-300)' }}>(click to add notes/description)</span>}
                </div>
              )}
            </div>

            {/* Result / Deliverable */}
            <div style={{
              padding: 10, background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-mint)',
              display: 'flex', flexDirection: 'column', gap: 6
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-mint)' }}>
                  RESULT / DELIVERABLE
                </span>
                {!isEditingResult && (
                  <button
                    onClick={() => setIsEditingResult(true)}
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)',
                      textDecoration: 'underline'
                    }}
                  >edit</button>
                )}
              </div>
              {isEditingResult ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea
                    value={resultDraft}
                    onChange={(e) => setResultDraft(e.target.value)}
                    rows={4}
                    placeholder="Summary of outcome / deliverable…"
                    autoFocus
                    style={{
                      width: '100%', padding: '6px 8px', fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                      lineHeight: '18px', color: 'var(--cth-ink-900)', background: 'var(--cth-cream-100)',
                      border: '1px solid var(--cth-ink-700)', outline: 'none', resize: 'vertical', boxSizing: 'border-box'
                    }}
                  />
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <PixelButton variant="ghost" size="sm" onClick={() => setIsEditingResult(false)}>cancel</PixelButton>
                    <PixelButton variant="primary" size="sm" onClick={saveResult}>save result</PixelButton>
                  </div>
                </div>
              ) : (
                <div
                  onClick={() => setIsEditingResult(true)}
                  title="Click to edit result"
                  style={{
                    fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '18px',
                    color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'pointer'
                  }}
                >
                  {task.result?.trim() || <span style={{ color: 'var(--cth-ink-300)' }}>(click to add result / deliverable)</span>}
                </div>
              )}
            </div>

            {/* Progress Log — timestamped notes agents write during execution */}
            {(task.progressLog?.length ?? 0) > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>
                  AGENT PROGRESS LOG
                </div>
                <div style={{
                  padding: '6px 8px', background: 'var(--cth-paper-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  display: 'flex', flexDirection: 'column', gap: 0
                }}>
                  {task.progressLog!.map((entry, i) => {
                    const d = new Date(entry.ts);
                    const timeLabel = isNaN(d.getTime()) ? entry.ts : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const isLast = i === task.progressLog!.length - 1;
                    return (
                      <div key={i} style={{ display: 'flex', gap: 8, paddingBottom: isLast ? 0 : 8, position: 'relative' }}>
                        {/* timeline spine */}
                        {!isLast && (
                          <div style={{
                            position: 'absolute', left: 5, top: 14, bottom: 0,
                            width: 1, background: 'var(--cth-ink-300)'
                          }} />
                        )}
                        <div style={{
                          width: 11, height: 11, marginTop: 2, borderRadius: '50%',
                          background: isLast ? 'var(--cth-mint)' : 'var(--cth-ink-300)',
                          boxShadow: isLast ? '0 0 0 2px var(--cth-mint-light, #d9eed9)' : 'none',
                          flexShrink: 0
                        }} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-400)' }}>
                            {timeLabel}
                          </div>
                          <div style={{
                            fontSize: 12, lineHeight: '17px', fontFamily: 'var(--cth-font-ui)',
                            color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                          }}>
                            {entry.step}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* The human Q&A trail — every decision documented on the card */}
            {(task.humanQA?.length ?? 0) > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>
                  HUMAN Q&A
                </div>
                {task.humanQA!.map((e, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{
                      padding: '5px 7px', background: 'var(--cth-lilac-light, #ece2f5)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      display: 'flex', gap: 6, alignItems: 'flex-start'
                    }}>
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, flexShrink: 0 }}>Q</span>
                      <Markdown text={e.q} style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)', minWidth: 0, flex: 1, maxWidth: '72ch' }} />
                    </div>
                    {e.a ? (
                      <div style={{
                        padding: '5px 7px', background: 'var(--cth-mint-light, #d9eed9)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        display: 'flex', gap: 6, alignItems: 'flex-start'
                      }}>
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, flexShrink: 0 }}>A</span>
                        <Markdown text={e.a} style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)', minWidth: 0, flex: 1, maxWidth: '72ch' }} />
                      </div>
                    ) : (
                      <div style={{ fontSize: 13, color: 'var(--cth-coral)', fontFamily: 'var(--cth-font-ui)' }}>
                        AWAITING YOUR ANSWER — FOR YOU TAB
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Dependencies, resolved to titles */}
            {deps.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>
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

            {/* Dispatch / Assign Inline Panel */}
            {isDispatchOpen && (
              <div style={{
                padding: 10, background: 'var(--cth-paper-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-lemon)',
                display: 'flex', flexDirection: 'column', gap: 8,
                borderRadius: 2
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                    DISPATCH / ASSIGN TASK
                  </span>
                  {dispatchFeedback && (
                    <span style={{ fontSize: 12, color: 'var(--cth-mint)', fontWeight: 600 }}>
                      {dispatchFeedback}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', flexShrink: 0 }}>Assign to:</span>
                  <select
                    value={dispatchRecipient}
                    onChange={(e) => setDispatchRecipient(e.target.value)}
                    style={{
                      flex: 1, padding: '4px 8px', background: 'var(--cth-cream-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', border: 'none',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                      outline: 'none'
                    }}
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.isOvermind ? 'Overmind' : a.description ? a.description.slice(0, 24) : a.id})
                      </option>
                    ))}
                  </select>
                </div>

                <textarea
                  value={dispatchMessage}
                  onChange={(e) => setDispatchMessage(e.target.value)}
                  rows={3}
                  placeholder="Instructions for the agent…"
                  style={{
                    width: '100%', padding: '6px 8px', fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                    lineHeight: '18px', color: 'var(--cth-ink-900)', background: 'var(--cth-cream-100)',
                    border: '1px solid var(--cth-ink-300)', outline: 'none', resize: 'vertical', boxSizing: 'border-box'
                  }}
                />

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <span style={{ color: 'var(--cth-ink-500)', fontWeight: 600 }}>Priority:</span>
                    {(['urgent', 'normal', 'backlog'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setDispatchPriority(p)}
                        style={{
                          padding: '2px 8px',
                          border: 'none',
                          borderRadius: 3,
                          cursor: 'pointer',
                          fontFamily: 'var(--cth-font-ui)',
                          fontSize: 11,
                          fontWeight: dispatchPriority === p ? 700 : 400,
                          background: dispatchPriority === p
                            ? (p === 'urgent' ? 'var(--cth-coral)' : p === 'backlog' ? 'var(--cth-sky)' : 'var(--cth-lemon)')
                            : 'var(--cth-paper-200)',
                          color: dispatchPriority === p
                            ? (p === 'urgent' ? '#fff' : 'var(--cth-ink-900)')
                            : 'var(--cth-ink-700)'
                        }}
                      >
                        {p === 'urgent' ? '🚨 Urgent' : p === 'backlog' ? 'Backlog' : 'Normal'}
                      </button>
                    ))}
                  </div>

                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                    <PixelButton variant="ghost" size="sm" onClick={() => setIsDispatchOpen(false)}>
                      cancel
                    </PixelButton>
                    <PixelButton
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        requestDispatchSeed(dispatchMessage);
                        setDispatchFeedback('✓ Queued in dispatch box');
                        setTimeout(() => setDispatchFeedback(null), 3000);
                      }}
                    >
                      queue in dispatch box
                    </PixelButton>
                    <PixelButton
                      variant="primary"
                      size="sm"
                      disabled={dispatchBusy || !dispatchMessage.trim()}
                      onClick={async () => {
                        setDispatchBusy(true);
                        try {
                          await window.cth.hiveSend({
                            to: dispatchRecipient,
                            act: 'request',
                            subject: task.title,
                            body: dispatchMessage,
                            priority: dispatchPriority
                          }, 'human');
                          const priorityNum = dispatchPriority === 'urgent' ? 1 : dispatchPriority === 'backlog' ? 3 : 2;
                          await onPatch?.({ assignee: dispatchRecipient, status: 'doing', priority: priorityNum });
                          setDispatchFeedback(`✓ Dispatched to ${agents.find(a => a.id === dispatchRecipient)?.name || dispatchRecipient}`);
                          setTimeout(() => {
                            setDispatchFeedback(null);
                            setIsDispatchOpen(false);
                          }, 1800);
                        } catch {
                          setDispatchFeedback('✗ Send failed');
                        } finally {
                          setDispatchBusy(false);
                        }
                      }}
                    >
                      {dispatchBusy ? 'dispatching…' : 'dispatch now'}
                    </PixelButton>
                  </div>
                </div>
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
              <PixelButton variant="secondary" size="sm" onClick={() => { setIsDispatchOpen((prev) => !prev); onAssign?.(); }}>
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

/** Thin horizontal completion bar (0–100). Fills green (--cth-accent-green) over
 *  a gray track; a 0% bar reads as an empty track. */
function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <span title={`${pct}% complete`} style={{
      display: 'block', height: 4, width: '100%',
      background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      <span style={{
        display: 'block', height: '100%', width: `${pct}%`,
        background: 'var(--cth-accent-green, var(--cth-mint))'
      }} />
    </span>
  );
}

function PriorityDots({ level }: { level: number }) {
  // Subtle priority pips: desaturated for lower levels, muted coral for high priority.
  const color = level >= 4 ? 'var(--cth-coral)' : level === 3 ? 'var(--cth-ink-700)' : 'var(--cth-ink-500)';
  return (
    <span title={`Priority ${level}/5`} style={{ display: 'inline-flex', gap: 2, flexShrink: 0, marginTop: 2 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{
          width: 3, height: 7,
          background: i <= level ? color : 'var(--cth-cream-200)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
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
  fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)'
};
