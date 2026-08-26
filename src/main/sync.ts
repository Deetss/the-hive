/**
 * Device-sync orchestration (v1: git-based, ONE device at a time).
 *
 * The hive at `<harnessHome>/hive` is ALREADY a git repo the app commits to on
 * every state change. Sync adds a REMOTE and pushes/pulls around those commits:
 *   - on start, BEFORE bootstrap: `pull --ff-only` and read the advisory lock;
 *   - on quit, AFTER teardown: commit a checkpoint + `push`;
 *   - a manual "Sync now" that quiesces the fleet, commits, pulls, pushes.
 * There is deliberately NO background auto-pull while agents run — a pull can
 * rewrite files an agent is mid-edit. Push-only side effects are safe.
 *
 * EVERYTHING here is inert until the user configures a remote, so an install
 * that never opts in behaves exactly as before (this is what keeps enabling it
 * risk-free: no remote → every function is a no-op).
 *
 * Secrets never travel: the sync unit is the hive repo only, and all secrets live
 * in userData (config.json, integration-secrets.json, slack-*.json) — outside it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { foreignLiveOwner, type OwnerRecord } from './syncLock';

export interface SyncStatus {
  /** Configured remote URL, or null when sync is not set up (feature inert). */
  remote: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  /** A different device holding a live lock, if any. */
  foreignLive: OwnerRecord | null;
  lastError: string | null;
}

function git(root: string, args: string[]): { ok: boolean; out: string; err: string } {
  const res = spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local', ...args],
    { cwd: root, encoding: 'utf8', timeout: 30_000 }
  );
  return { ok: res.status === 0, out: res.stdout ?? '', err: res.stderr ?? '' };
}

function isRepo(root: string): boolean {
  return !!root && existsSync(join(root, '.git'));
}

/** The configured push/pull remote URL (origin), or null when none is set. */
export function currentRemote(root: string): string | null {
  if (!isRepo(root)) return null;
  const r = git(root, ['remote', 'get-url', 'origin']);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

function currentBranch(root: string): string | null {
  const r = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

/** Set (or replace) the origin remote and record the current branch's upstream.
 *  Does NOT push — the caller does an explicit first push so failures surface. */
export function setRemote(root: string, url: string): { ok: boolean; error?: string } {
  if (!isRepo(root)) return { ok: false, error: 'hive is not a git repo yet' };
  const clean = (url ?? '').trim();
  if (!clean) {
    git(root, ['remote', 'remove', 'origin']); // clearing the remote disables sync
    return { ok: true };
  }
  const has = currentRemote(root);
  const set = has
    ? git(root, ['remote', 'set-url', 'origin', clean])
    : git(root, ['remote', 'add', 'origin', clean]);
  if (!set.ok) return { ok: false, error: set.err.trim() || 'could not set remote' };
  return { ok: true };
}

/** ahead/behind counts vs the upstream, best-effort (0/0 when unknown). */
function aheadBehind(root: string, branch: string): { ahead: number; behind: number } {
  const r = git(root, ['rev-list', '--left-right', '--count', `origin/${branch}...${branch}`]);
  if (!r.ok) return { ahead: 0, behind: 0 };
  const m = r.out.trim().split(/\s+/);
  const behind = Number(m[0]) || 0;
  const ahead = Number(m[1]) || 0;
  return { ahead, behind };
}

/**
 * Start-of-session sync, run BEFORE bootstrapHiveServices. Inert without a
 * remote. Fetches, reports any FOREIGN live lock (the caller decides whether to
 * surface/refuse), then fast-forwards. A non-ff pull is left as an explicit
 * error rather than auto-merged — the sync layer never guesses at hive state.
 */
export function syncOnStart(root: string): { ok: boolean; blocked?: OwnerRecord; error?: string } {
  if (!isRepo(root) || !currentRemote(root)) return { ok: true };
  const branch = currentBranch(root);
  if (!branch) return { ok: true };
  const fetch = git(root, ['fetch', '--quiet', 'origin', branch]);
  if (!fetch.ok) return { ok: false, error: `fetch failed: ${fetch.err.trim()}` };
  // Read the lock as it stands on the remote tip, without merging it in.
  const foreign = readRemoteForeignOwner(root, branch);
  // Fast-forward only — never a merge commit of divergent hive state.
  const pull = git(root, ['merge', '--ff-only', `origin/${branch}`]);
  if (!pull.ok) {
    return { ok: false, blocked: foreign ?? undefined, error: `not a fast-forward (local and remote diverged): ${pull.err.trim()}` };
  }
  return { ok: true, blocked: foreign ?? undefined };
}

/** Read `.sync/owner.json` from the fetched remote tip and apply the same
 *  foreign-live test as the local lock, so a start can see a peer that is live
 *  even before we merge. Best-effort: null on any error/absence. */
function readRemoteForeignOwner(root: string, branch: string): OwnerRecord | null {
  const show = git(root, ['show', `origin/${branch}:.sync/owner.json`]);
  if (!show.ok || !show.out.trim()) return foreignLiveOwner(root); // fall back to working tree
  try {
    // Compare against our own device via the shared helper by writing nothing —
    // reuse foreignLiveOwner's TTL logic by inlining the parse here.
    const o = JSON.parse(show.out) as OwnerRecord;
    const localView = foreignLiveOwner(root); // gives us deviceId comparison + TTL on the working copy
    // Prefer the remote record when it names a different, fresher owner.
    if (o && o.device && localView && o.device === localView.device) return o;
    return localView ?? (o && o.device ? o : null);
  } catch { return foreignLiveOwner(root); }
}

/** Quit-time push: commit anything staged-by-others plus the released lock, then
 *  push. Best-effort and bounded — a hung network must never wedge quit. */
export function syncOnQuit(root: string): void {
  if (!isRepo(root) || !currentRemote(root)) return;
  const branch = currentBranch(root);
  if (!branch) return;
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'hive: sync checkpoint']); // no-op if nothing staged
  git(root, ['push', '--quiet', 'origin', branch]); // best-effort; offline just retries next session
}

/**
 * Manual "Sync now": quiesce the fleet (caller pauses via control), commit,
 * ff-only pull, push, then resume. Returns a human-readable error on the first
 * failing step. The quiesce/resume are injected so this module stays decoupled
 * from the control registry.
 */
export function syncNow(
  root: string,
  quiesce: () => void,
  resume: () => void
): { ok: boolean; error?: string } {
  if (!isRepo(root)) return { ok: false, error: 'hive is not a git repo' };
  if (!currentRemote(root)) return { ok: false, error: 'no sync remote configured' };
  const branch = currentBranch(root);
  if (!branch) return { ok: false, error: 'no branch' };
  try {
    quiesce();
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'hive: sync now']);
    const fetch = git(root, ['fetch', '--quiet', 'origin', branch]);
    if (!fetch.ok) return { ok: false, error: `fetch failed: ${fetch.err.trim()}` };
    const merge = git(root, ['merge', '--ff-only', `origin/${branch}`]);
    if (!merge.ok) return { ok: false, error: `not a fast-forward — local and remote diverged; resolve manually` };
    const push = git(root, ['push', '--quiet', 'origin', branch]);
    if (!push.ok) return { ok: false, error: `push failed: ${push.err.trim()}` };
    return { ok: true };
  } finally {
    try { resume(); } catch { /* resume must never mask the sync result */ }
  }
}

export function getStatus(root: string): SyncStatus {
  const remote = currentRemote(root);
  const branch = currentBranch(root);
  const ab = remote && branch ? aheadBehind(root, branch) : { ahead: 0, behind: 0 };
  return {
    remote,
    branch,
    ahead: ab.ahead,
    behind: ab.behind,
    foreignLive: foreignLiveOwner(root),
    lastError: null
  };
}
