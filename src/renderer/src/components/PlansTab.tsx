import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { Markdown } from './Markdown';
import { parseTasks } from './TasksKanban';
import type { GsdPlan, GsdPhase } from '@shared/planLedger';
import type { HiveTask } from '../types/tasks';

const POLL_MS = 5000;

/** Normalize whatever hive:plans returns into a typed plan array — the same
 *  hand-written-file caution as TasksKanban's parseTasks, since agents write
 *  hive/plans/<id>.json by hand. */
function parsePlans(raw: unknown): GsdPlan[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p): GsdPlan => ({
      id: typeof p.id === 'string' ? p.id : '',
      title: typeof p.title === 'string' ? p.title : '(untitled plan)',
      goal: typeof p.goal === 'string' ? p.goal : '',
      status: (['draft', 'review', 'approved', 'active', 'done', 'archived'] as const)
        .includes(p.status as GsdPlan['status']) ? (p.status as GsdPlan['status']) : 'draft',
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
      createdBy: typeof p.createdBy === 'string' ? p.createdBy : '',
      decisions: Array.isArray(p.decisions)
        ? p.decisions.filter((d): d is string => typeof d === 'string') : undefined,
      phases: Array.isArray(p.phases)
        ? (p.phases as unknown[])
          .filter((ph): ph is Record<string, unknown> => !!ph && typeof ph === 'object')
          .map((ph, i): GsdPhase => ({
            id: typeof ph.id === 'string' ? ph.id : `phase-${i}`,
            index: typeof ph.index === 'number' ? ph.index : i,
            title: typeof ph.title === 'string' ? ph.title : '(untitled phase)',
            goal: typeof ph.goal === 'string' ? ph.goal : '',
            acceptanceCriteria: Array.isArray(ph.acceptanceCriteria)
              ? ph.acceptanceCriteria.filter((a): a is string => typeof a === 'string') : [],
            taskIds: Array.isArray(ph.taskIds)
              ? ph.taskIds.filter((t): t is string => typeof t === 'string') : [],
            status: (['todo', 'doing', 'blocked', 'done'] as const).includes(ph.status as GsdPhase['status'])
              ? (ph.status as GsdPhase['status']) : 'todo',
            notes: typeof ph.notes === 'string' ? ph.notes : undefined
          }))
        : []
    }))
    .filter((p) => p.id);
}

function PhaseProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <span style={{
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

const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: 'DRAFT', color: 'var(--cth-ink-200)' },
  review: { label: 'REVIEW', color: 'var(--cth-sky)' },
  approved: { label: 'APPROVED', color: 'var(--cth-mint)' },
  active: { label: 'ACTIVE', color: 'var(--cth-lemon)' },
  done: { label: 'DONE', color: 'var(--cth-mint)' },
  archived: { label: 'ARCHIVED', color: 'var(--cth-ink-200)' },
  todo: { label: 'TODO', color: 'var(--cth-ink-200)' },
  doing: { label: 'DOING', color: 'var(--cth-lemon)' },
  blocked: { label: 'BLOCKED', color: 'var(--cth-coral)' }
};

/**
 * Read-only VIEW over `hive/plans/*.json` — the SAME "derived state, not its
 * own source of truth" pattern as UatPanel. Agents write plan files directly
 * (see PROTOCOL.md's GSD-style planning section); this only renders them and
 * hands a phase's tasks off to the existing TaskDetail overlay.
 */
export function PlansTab() {
  const [plans, setPlans] = useState<GsdPlan[]>([]);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const openTaskDetail = useStore((s) => s.openTaskDetail);

  const load = useCallback(async () => {
    try {
      const [rawPlans, rawTasks] = await Promise.all([
        window.cth?.hivePlans ? window.cth.hivePlans() : Promise.resolve([]),
        window.cth?.hiveTasks ? window.cth.hiveTasks() : Promise.resolve({ tasks: [] })
      ]);
      setPlans(parsePlans(rawPlans));
      setTasks(parseTasks(rawTasks));
    } catch (e) {
      console.error('[PlansTab] failed to load plans:', e);
    }
  }, []);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => { void load(); }, POLL_MS);
    const off = window.cth?.onPlansChanged?.(() => void load());
    return () => {
      if (timer.current) clearInterval(timer.current);
      off?.();
    };
  }, [load]);

  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const phaseProgress = useCallback((phase: GsdPhase): number => {
    if (phase.taskIds.length === 0) return phase.status === 'done' ? 100 : 0;
    const values = phase.taskIds.map((id) => {
      const t = tasksById.get(id);
      if (!t) return 0;
      if (t.status === 'done') return 100;
      return typeof t.progress === 'number' ? t.progress : 0;
    });
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }, [tasksById]);

  if (plans.length === 0) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 }}>
        <div style={{
          padding: 12, fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)',
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}>
          No GSD plans yet. An agent drafts one at <code>hive/plans/&lt;id&gt;.json</code> — see
          PROTOCOL.md's "GSD-style planning" section.
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
      {plans.map((plan) => {
        const isOpen = !collapsed[plan.id];
        const meta = STATUS_META[plan.status] ?? STATUS_META.draft;
        return (
          <div key={plan.id} style={{ background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
            <button
              onClick={() => setCollapsed((prev) => ({ ...prev, [plan.id]: isOpen }))}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left'
              }}
            >
              <span style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)',
                display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.1s'
              }}>▶</span>
              <span style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 7, padding: '1px 5px 0',
                background: meta.color, color: 'var(--cth-ink-900)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0
              }}>{meta.label}</span>
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--cth-ink-900)', flex: 1 }}>
                {plan.title}
              </span>
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>
                {plan.phases.length} phase{plan.phases.length === 1 ? '' : 's'}
              </span>
            </button>
            {isOpen && (
              <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {plan.goal && (
                  <Markdown text={plan.goal} style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-700)' }} />
                )}
                {plan.phases.slice().sort((a, b) => a.index - b.index).map((phase) => {
                  const pMeta = STATUS_META[phase.status] ?? STATUS_META.todo;
                  const progress = phaseProgress(phase);
                  const hasTasks = phase.taskIds.length > 0;
                  return (
                    <button
                      key={phase.id}
                      onClick={hasTasks ? () => openTaskDetail(phase.taskIds[0]) : undefined}
                      title={hasTasks ? "open this phase's tasks" : 'no tasks linked to this phase yet'}
                      style={{
                        display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', textAlign: 'left',
                        border: 'none', cursor: hasTasks ? 'pointer' : 'default',
                        background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{
                          fontFamily: 'var(--cth-font-ui)', fontSize: 7, padding: '1px 5px 0',
                          background: pMeta.color, color: 'var(--cth-ink-900)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0
                        }}>{pMeta.label}</span>
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', flex: 1 }}>
                          {phase.title}
                        </span>
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>{progress}%</span>
                      </span>
                      <PhaseProgressBar value={progress} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
