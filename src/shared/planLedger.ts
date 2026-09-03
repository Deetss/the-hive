/**
 * Non-destructive edits to a GSD plan file (`hive/plans/<planId>.json`).
 *
 * Mirrors `taskLedger.ts`'s reasoning, scoped to a single hand-written plan
 * object instead of an array-in-one-file ledger: every plan lives in its own
 * file, so there is no id-matching to do, but the same problem applies — a
 * writer holding a partial model of the plan (a UI patch, an agent's status
 * flip) must not delete fields it doesn't know about (`decisions`, `notes`
 * on a phase, anything a planning agent wrote that this process's model
 * hasn't caught up to).
 *
 *   - `mergePlanLedger` — the persistence-side backstop. Fold an incoming
 *     (possibly partial) plan over whatever is already on disk.
 *   - `patchPlanInLedger` — the caller-side rule. Apply a patch to the RAW
 *     on-disk plan rather than a re-serialized display model.
 *
 * Both collapse to the same shallow merge here (one object, not a list), but
 * are kept as two functions to mirror `taskLedger.ts` and its two call sites.
 */

export interface GsdPhase {
  id: string;
  index: number;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  taskIds: string[];
  status: 'todo' | 'doing' | 'blocked' | 'done';
  notes?: string;
}

export interface GsdPlan {
  id: string;
  title: string;
  goal: string;
  status: 'draft' | 'review' | 'approved' | 'active' | 'done' | 'archived';
  createdAt: string;
  createdBy: string;
  decisions?: string[];
  phases: GsdPhase[];
}

/** One raw ledger entry as it sits on disk — an object of unknown fields. */
type RawPlan = Record<string, unknown>;

function isRawPlan(value: unknown): value is RawPlan {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Fold `incoming` over `existing`. A field `incoming` DOES send wins,
 * including an explicit `null` — that's the way to clear one. A field it
 * doesn't mention keeps whatever `existing` already had, so a partial
 * writer never wipes fields it doesn't know about.
 */
export function mergePlanLedger(existing: unknown, incoming: unknown): unknown {
  if (!isRawPlan(incoming)) return incoming;
  const prior = isRawPlan(existing) ? existing : {};
  return { ...prior, ...incoming };
}

/**
 * Apply `patch` to a RAW plan object, leaving every field the patch doesn't
 * mention byte-identical. What a UI edit should write before sending to
 * `hive:patchPlan`, mirroring `patchTaskInLedger`'s caller-side rule.
 */
export function patchPlanInLedger(rawPlan: unknown, patch: Record<string, unknown>): unknown {
  const prior = isRawPlan(rawPlan) ? rawPlan : {};
  return { ...prior, ...patch };
}
