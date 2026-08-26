/**
 * Hive PROFILES — a named, fully-isolated hive as a first-class thing rather than
 * a raw `HARNESS_HOME` env var.
 *
 * A profile bundles the TWO axes that must BOTH be distinct for two hives to run
 * concurrently on one machine without colliding:
 *   - `harnessHome` — the hive's on-disk home (its git repo, hooks.sock,
 *     spawn-requests, cost-ledger). Isolated by `resolveHarnessHome()` /
 *     `HARNESS_HOME`.
 *   - `userData`    — Electron's per-app state (config.json, harness.db, the
 *     single-instance lock, slack-reply/integration secrets). Isolated by the
 *     native `--user-data-dir` switch.
 *
 * HARNESS_HOME ALONE IS NOT ENOUGH for concurrency: `requestSingleInstanceLock`,
 * `harness.db` (WAL single-writer) and `config.json` are keyed on userData, so
 * two instances sharing userData fight over the lock/db even with different
 * homes. A profile pins both, which is why it is the unit the launcher uses.
 *
 * The store lives at `~/.thehive/profiles.json` — a MACHINE-level path OUTSIDE
 * any per-instance userData, so every instance sees the same profile list.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface HiveProfile {
  id: string;
  name: string;
  harnessHome: string;
  userData: string;
  /** Set when this profile was JOINED from another device — the remote it clones. */
  remote?: string;
  createdAt: number;
}

function storeDir(): string { return join(homedir(), '.thehive'); }
export function profilesPath(): string { return join(storeDir(), 'profiles.json'); }

export function listProfiles(): HiveProfile[] {
  try {
    const p = profilesPath();
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? (parsed as HiveProfile[]).filter((x) => x && x.id && x.harnessHome) : [];
  } catch { return []; }
}

function writeProfiles(list: HiveProfile[]): void {
  const p = profilesPath();
  mkdirSync(storeDir(), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  renameSync(tmp, p);
}

export function getProfile(id: string): HiveProfile | null {
  return listProfiles().find((p) => p.id === id) ?? null;
}

/** Insert or replace a profile by id. */
export function upsertProfile(p: HiveProfile): HiveProfile {
  const list = listProfiles().filter((x) => x.id !== p.id);
  list.push(p);
  writeProfiles(list);
  return p;
}

export function removeProfile(id: string): void {
  writeProfiles(listProfiles().filter((p) => p.id !== id));
}

/** Create a new isolated profile. `userData` defaults to a sibling of the home so
 *  the two axes stay together and predictable. Does NOT create the dirs — the app
 *  makes `harnessHome` on bootstrap (ensureHive) and Electron makes `userData`. */
export function createProfile(name: string, harnessHome: string, opts?: { userData?: string; remote?: string }): HiveProfile {
  const id = randomUUID();
  const userData = opts?.userData ?? `${harnessHome.replace(/[\\/]+$/, '')}-userdata`;
  return upsertProfile({ id, name: name.trim() || 'hive', harnessHome, userData, remote: opts?.remote, createdAt: nowStamp() });
}

/** The profile matching THIS running instance (its resolved home + userData), or
 *  null when the instance wasn't launched from a registered profile. */
export function currentProfile(harnessHome: string | null, userData: string): HiveProfile | null {
  if (!harnessHome) return null;
  return listProfiles().find((p) => sameDir(p.harnessHome, harnessHome) && sameDir(p.userData, userData)) ?? null;
}

/** The exec + args + env a launcher uses to open a profile as a NEW isolated
 *  instance. Packaged: spawn the app exe with `--user-data-dir`. Dev (Electron):
 *  the app entry path must lead the argv. HARNESS_HOME rides in the env. */
export function launchSpec(profile: HiveProfile, packaged: boolean, appPath: string, execPath: string): { exec: string; args: string[]; env: NodeJS.ProcessEnv } {
  const udd = `--user-data-dir=${profile.userData}`;
  const args = packaged ? [udd] : [appPath, udd];
  return { exec: execPath, args, env: { ...process.env, HARNESS_HOME: profile.harnessHome } };
}

/**
 * JOIN a hive that lives on another device: clone its git repo into a fresh
 * profile's `<harnessHome>/hive`, then register the profile. The caller launches
 * it afterwards (launchSpec). Best-effort; returns the new profile or an error.
 *
 * The advisory lock (`.sync/owner.json`) is INSIDE the cloned repo, so join
 * semantics are per-hive automatically: joining hive X never touches hive Y.
 * Resuming EXISTING agents on the joined device needs the Phase-B cwd remap +
 * session-transcript handoff; participating (board/tasks/mail/new agents) works
 * as soon as the clone lands.
 */
export function joinHive(remoteUrl: string, name: string, harnessHome: string): { ok: boolean; profile?: HiveProfile; error?: string } {
  const url = (remoteUrl ?? '').trim();
  if (!url) return { ok: false, error: 'no remote url' };
  const hiveDir = join(harnessHome, 'hive');
  if (existsSync(join(hiveDir, '.git'))) return { ok: false, error: `a hive already exists at ${hiveDir}` };
  try { mkdirSync(harnessHome, { recursive: true }); } catch (e) { return { ok: false, error: `mkdir failed: ${String(e)}` }; }
  const res = spawnSync('git', ['clone', '--quiet', url, hiveDir], { encoding: 'utf8', timeout: 120_000 });
  if (res.status !== 0) return { ok: false, error: `git clone failed: ${(res.stderr ?? '').trim() || 'unknown error'}` };
  const profile = createProfile(name, harnessHome, { remote: url });
  return { ok: true, profile };
}

// Date.now is wrapped so the module stays easy to reason about under test.
function nowStamp(): number { return Date.now(); }

function sameDir(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
