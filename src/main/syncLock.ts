/**
 * Cross-device advisory lock for the one-device-at-a-time hive sync.
 *
 * The audit's core hazard: every live hive service assumes it EXCLUSIVELY owns
 * `harnessHome` — `hooks.sock`, the loopback broker/telemetry ports, the
 * `spawn-requests/` queue, `cost-ledger.jsonl`, and the git repo itself. Two live
 * instances on the same (synced) hive corrupt each other. Electron's
 * `requestSingleInstanceLock()` already stops that on ONE machine; this stops it
 * ACROSS machines, over the same git repo the state syncs through.
 *
 * `<hiveRoot>/.sync/owner.json` records who currently holds the hive. It is a
 * TRACKED file (so it travels with a push/pull), rewritten wholesale by the
 * acquire/heartbeat/release protocol and resolved by "latest heartbeat wins" in
 * code — never git-auto-merged (see the sync layer). A released record (empty
 * `device`) means the hive is free.
 *
 * The freshness of a FOREIGN owner is only as current as the last push that
 * carried its heartbeat, so `foreignLiveOwner` uses a generous TTL: under clean
 * one-at-a-time use the previous device releases on quit (pushes "free"), and the
 * TTL only matters when a device died without releasing — its heartbeat ages out
 * and the next device may take over.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app } from 'electron';

export interface OwnerRecord {
  /** Stable per-device id; empty string means the hive is released (free). */
  device: string;
  /** Hostname, for a human-readable "active on <host>" message. */
  host: string;
  pid: number;
  appVersion: string;
  acquiredAt: number;
  heartbeatAt: number;
}

/** An owner whose heartbeat is older than this is treated as dead (takeable).
 *  Generous on purpose — the heartbeat only travels at sync (push) time. */
export const OWNER_TTL_MS = 10 * 60_000;

function syncDir(hiveRoot: string): string { return join(hiveRoot, '.sync'); }
function ownerPath(hiveRoot: string): string { return join(syncDir(hiveRoot), 'owner.json'); }

let cachedDeviceId: string | null = null;

/** This device's stable id, persisted in userData (NOT synced, so it is unique
 *  per device even when two devices share an identical synced hive). */
export function deviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const p = join(app.getPath('userData'), 'device-id');
    if (existsSync(p)) cachedDeviceId = readFileSync(p, 'utf8').trim() || null;
    if (!cachedDeviceId) { cachedDeviceId = randomUUID(); writeFileSync(p, cachedDeviceId, 'utf8'); }
  } catch {
    cachedDeviceId = cachedDeviceId ?? `${hostname()}-${process.pid}`;
  }
  return cachedDeviceId as string;
}

export function readOwner(hiveRoot: string): OwnerRecord | null {
  try {
    const p = ownerPath(hiveRoot);
    if (!existsSync(p)) return null;
    const o = JSON.parse(readFileSync(p, 'utf8')) as OwnerRecord;
    return o && typeof o.device === 'string' ? o : null;
  } catch { return null; }
}

/** Atomic wholesale write (temp + rename) so a concurrent reader never sees a
 *  half-written record. Best-effort: never throws. */
function writeOwner(hiveRoot: string, rec: OwnerRecord): void {
  try {
    mkdirSync(syncDir(hiveRoot), { recursive: true });
    const p = ownerPath(hiveRoot);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
    renameSync(tmp, p);
  } catch { /* a lock write must never crash the app */ }
}

/** Claim the hive for this device (called after ensureHive, on bootstrap). */
export function acquire(hiveRoot: string, appVersion: string, now = Date.now()): OwnerRecord {
  const rec: OwnerRecord = {
    device: deviceId(), host: hostname(), pid: process.pid, appVersion,
    acquiredAt: now, heartbeatAt: now
  };
  writeOwner(hiveRoot, rec);
  return rec;
}

/** Refresh our heartbeat (or re-claim if the record is missing/ours). No-op when
 *  a DIFFERENT live device holds it, so a beat never steals an active lock. */
export function heartbeat(hiveRoot: string, appVersion: string, now = Date.now()): void {
  const cur = readOwner(hiveRoot);
  if (cur && cur.device && cur.device !== deviceId() && now - cur.heartbeatAt <= OWNER_TTL_MS) return;
  const acquiredAt = cur && cur.device === deviceId() ? cur.acquiredAt : now;
  writeOwner(hiveRoot, {
    device: deviceId(), host: hostname(), pid: process.pid, appVersion, acquiredAt, heartbeatAt: now
  });
}

/** Mark the hive free (on clean quit). Writes a released record rather than
 *  deleting the file, so the pushed state explicitly says "free". */
export function release(hiveRoot: string, now = Date.now()): void {
  const cur = readOwner(hiveRoot);
  if (cur && cur.device && cur.device !== deviceId()) return; // don't release someone else's lock
  writeOwner(hiveRoot, {
    device: '', host: hostname(), pid: 0, appVersion: cur?.appVersion ?? '', acquiredAt: 0, heartbeatAt: now
  });
}

/** A DIFFERENT device holding a FRESH lock, or null when the hive is free, held
 *  by us, or held by a stale (dead) owner past the TTL. This is what the
 *  start-time sync gate checks to refuse a colliding bootstrap. */
export function foreignLiveOwner(hiveRoot: string, ttlMs = OWNER_TTL_MS, now = Date.now()): OwnerRecord | null {
  const o = readOwner(hiveRoot);
  if (!o || !o.device) return null;
  if (o.device === deviceId()) return null;
  if (now - o.heartbeatAt > ttlMs) return null;
  return o;
}

/** Best-effort removal of the lock file (used by a full reset). */
export function clearOwner(hiveRoot: string): void {
  try { rmSync(ownerPath(hiveRoot), { force: true }); } catch { /* noop */ }
}
