import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readConfig, resolveHarnessHome } from './config';
import type { AutoOffloadConfig } from './config';
import type { AgentProvider } from '../shared/agentProvider';

const DEFAULT_TRY_ORDER = ['edgentic', 'azure-mini', 'azure-codex'];
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 2000;
const DEFAULT_TARGET_MAX_CONCURRENT = 2;
const DEFAULT_MAX_REQUEUES = 3;
const DEFAULT_HOLD_NOTIFY_INTERVAL_MS = 10 * 60 * 1000;

interface OffloadTargetDefinition {
  wire?: string;
  base?: string;
  model?: string;
  keyEnv?: string;
  auth?: string;
  provider?: AgentProvider;
  profile?: string;
  command?: string;
  name?: string;
  tokenCap?: number;
  /** Per-target concurrent-worker cap. Overrides the policy default. Heavy codex
   *  is the real constraint (~2-3 at current Azure quota). */
  maxConcurrent?: number;
  /** Per-target tokens/minute ceiling. 0/undefined = no tok/min gate. */
  tokensPerMinute?: number;
}

interface OffloadManifest {
  default?: string | string[];
  tryOrder?: string[];
  targets?: Record<string, OffloadTargetDefinition | undefined>;
}

export interface ResolvedAutoOffloadConfig {
  enabled: boolean;
  targetsFile: string;
  tryOrder: string[];
  maxConcurrent: number;
  healthCheckTimeoutMs: number;
  dryRun: boolean;
  defaultTargetMaxConcurrent: number;
  defaultTokensPerMinute: number;
  maxRequeues: number;
  holdNotifyIntervalMs: number;
}

export interface HealthyOffloadTarget extends OffloadTargetDefinition {
  id: string;
}

export interface OffloadWorkSpec {
  objective: string;
  cwd: string;
  name?: string;
  slack?: { channel: string; thread_ts: string };
  provider?: AgentProvider;
  model?: string;
  profile?: string;
  tokenCap?: number;
  isolate?: boolean;
  targetPreference?: string[];
  /** Claude account key this work WOULD have run under, so the per-profile RED
   *  gate (G4) offloads only work whose own account is over cap. */
  accountKey?: string;
  /** Targets already tried and failed for this objective — pickTarget skips them
   *  so a requeue lands on a different endpoint (§6 failure rollback). */
  excludeTargets?: string[];
  /** Requeue count, for the poison-spec cap. Internal. */
  requeues?: number;
}

export interface OffloadSpawnResult {
  id: string;
  filePath: string;
}

/** Callback for surfacing held/dropped work to god without importing index.ts. */
export type OffloadNotify = (subject: string, body: string) => void;

export interface AttemptGovernorOffloadsOptions {
  policy?: AutoOffloadConfig;
  hiveRoot?: string | null;
  pendingObjectives?: OffloadWorkSpec[];
  /** Claude account keys currently RED. When provided, only specs whose
   *  `accountKey` is in this set are offloaded (G4 per-profile trigger). A spec
   *  with no `accountKey` is always eligible (the beat only calls while RED). */
  redProfiles?: string[];
  notify?: OffloadNotify;
}

const queuedObjectives: OffloadWorkSpec[] = [];
/** offload spawn-request id -> target id, so a slot is released per target when
 *  the worker terminates (G2). Was a bare Set that was never drained. */
const activeRequests = new Map<string, string>();
/** target id -> rolling token-spend samples for the per-target tok/min gate. */
const targetTokenSpend = new Map<string, Array<{ ts: number; tokens: number }>>();
let attemptRunning = false;
let lastHoldNotifyAt = 0;

export function loadAutoOffloadConfig(policy?: AutoOffloadConfig, hiveRoot?: string | null): ResolvedAutoOffloadConfig {
  const configPolicy = policy ?? readConfig().governorPolicy?.autoOffload ?? {};
  const harnessHome = resolveHarnessHome();
  const root = hiveRoot ?? (harnessHome ? join(harnessHome, 'hive') : undefined);
  const defaultTargetsFile = root ? join(root, 'offload-targets.json') : 'offload-targets.json';
  const enabled = configPolicy.enabled === true;
  const targetsFile = typeof configPolicy.targetsFile === 'string' && configPolicy.targetsFile.trim()
    ? configPolicy.targetsFile.trim()
    : defaultTargetsFile;
  const tryOrderSource = Array.isArray(configPolicy.tryOrder) && configPolicy.tryOrder.length
    ? configPolicy.tryOrder
    : DEFAULT_TRY_ORDER;
  const tryOrder = dedupeStrings(tryOrderSource.map((k) => k.trim()).filter(Boolean));
  const maxConcurrent = numberWithFallback(configPolicy.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const healthCheckTimeoutMs = numberWithFallback(configPolicy.healthCheckTimeoutMs, DEFAULT_HEALTHCHECK_TIMEOUT_MS);
  const dryRun = configPolicy.dryRun === true;
  const defaultTargetMaxConcurrent = numberWithFallback(configPolicy.defaultTargetMaxConcurrent, DEFAULT_TARGET_MAX_CONCURRENT);
  const defaultTokensPerMinute = numberWithFallback(configPolicy.defaultTokensPerMinute, 0);
  const maxRequeues = numberWithFallback(configPolicy.maxRequeues, DEFAULT_MAX_REQUEUES);
  const holdNotifyIntervalMs = numberWithFallback(configPolicy.holdNotifyIntervalMs, DEFAULT_HOLD_NOTIFY_INTERVAL_MS);
  return {
    enabled, targetsFile, tryOrder, maxConcurrent, healthCheckTimeoutMs, dryRun,
    defaultTargetMaxConcurrent, defaultTokensPerMinute, maxRequeues, holdNotifyIntervalMs
  };
}

export function queueOffloadObjective(spec: OffloadWorkSpec): void {
  if (!spec?.objective || !spec.cwd) return;
  queuedObjectives.push(spec);
}

export function pendingOffloadObjectives(): OffloadWorkSpec[] {
  return [...queuedObjectives];
}

/** Free the concurrency slot a terminated offload worker held (G2). Idempotent
 *  and a no-op for ids we don't track, so index.ts can call it for EVERY worker
 *  teardown and every spawn-request failure without checking provenance first. */
export function releaseOffloadSlot(reqId: string): void {
  if (reqId) activeRequests.delete(reqId);
}

/** How many active offload workers are running against one target. */
function countActiveForTarget(targetId: string): number {
  let n = 0;
  for (const id of activeRequests.values()) if (id === targetId) n += 1;
  return n;
}

/** Re-queue an offloaded objective whose worker failed / was reaped, onto a
 *  DIFFERENT target (§6). Frees the slot, bumps the requeue count, and after
 *  `maxRequeues` HOLDS the work (informing god once) instead of looping. */
export function requeueOffloadObjective(reqId: string, spec: OffloadWorkSpec, failedTargetId?: string, notify?: OffloadNotify): void {
  releaseOffloadSlot(reqId);
  if (!spec?.objective || !spec.cwd) return;
  const resolved = loadAutoOffloadConfig();
  const attempts = (spec.requeues ?? 0) + 1;
  if (attempts > resolved.maxRequeues) {
    notify?.(
      `[offload held] ${spec.name ?? spec.objective.slice(0, 40)}`,
      `Offload objective failed on ${attempts} targets (last: ${failedTargetId ?? 'unknown'}) and hit the requeue cap (${resolved.maxRequeues}). Held — not retried. Objective: ${spec.objective}`
    );
    return;
  }
  const exclude = dedupeStrings([...(spec.excludeTargets ?? []), ...(failedTargetId ? [failedTargetId] : [])]);
  queuedObjectives.push({ ...spec, requeues: attempts, excludeTargets: exclude });
}

export async function attemptGovernorOffloads(options: AttemptGovernorOffloadsOptions = {}): Promise<void> {
  if (attemptRunning) return;
  const resolved = loadAutoOffloadConfig(options.policy, options.hiveRoot);
  if (!resolved.enabled) return;
  const hiveRoot = options.hiveRoot ?? resolveDefaultHiveRoot();
  if (!hiveRoot) {
    console.warn('[governor-offload] no hive root available for spawn queue');
    return;
  }
  const spawnDir = join(hiveRoot, 'spawn-requests');
  const redProfiles = options.redProfiles && options.redProfiles.length ? new Set(options.redProfiles) : null;
  const snapshot = [...queuedObjectives, ...(options.pendingObjectives ?? [])];
  if (!snapshot.length) return;
  let globalLimit = Math.max(0, resolved.maxConcurrent - activeRequests.size);
  if (globalLimit <= 0) return;
  attemptRunning = true;
  try {
    const targets = await findHealthyTargets(resolved.targetsFile, resolved.tryOrder, resolved.healthCheckTimeoutMs);
    if (!targets.length) {
      maybeNotifyHold(resolved, options.notify);
      return;
    }
    for (const next of snapshot) {
      if (globalLimit <= 0) break;
      // G4: offload only work whose OWNING profile is RED.
      if (redProfiles && next.accountKey && !redProfiles.has(next.accountKey)) continue;
      // Per-target concurrency + tok/min gate: skip a saturated/throttled target so
      // pickTarget falls through tryOrder instead of piling onto it (§4).
      const candidates = targets.filter((t) => targetHasCapacity(t, resolved) && !(next.excludeTargets ?? []).includes(t.id));
      const target = pickTarget(next, candidates);
      if (!target) continue; // no capacity anywhere this beat — leave it queued
      consumeQueuedObjective(next);
      if (resolved.dryRun) {
        console.log(`[governor-offload] dry-run: would offload "${next.objective}" to ${target.id}`);
        globalLimit -= 1;
        continue;
      }
      const result = createOffloadSpawnRequest(spawnDir, target, next);
      if (result) {
        activeRequests.set(result.id, target.id);
        recordTargetSpend(target.id, next.tokenCap ?? 0);
        globalLimit -= 1;
      }
    }
  } finally {
    attemptRunning = false;
  }
}

export async function findHealthyTargets(manifestPath: string, tryOrder: string[], timeoutMs: number): Promise<HealthyOffloadTarget[]> {
  if (!manifestPath || !existsSync(manifestPath)) return [];
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as OffloadManifest;
    const targets = manifest.targets ?? {};
    const order = effectiveTryOrder(tryOrder, manifest);
    const healthy: HealthyOffloadTarget[] = [];
    for (const id of order) {
      const def = targets[id];
      if (!def) continue;
      const health = await checkOffloadTargetHealth({ id, ...def }, timeoutMs);
      if (health.ok) healthy.push({ id, ...def });
    }
    return healthy;
  } catch (e) {
    console.error('[governor-offload] failed to read manifest:', e instanceof Error ? e.message : e);
    return [];
  }
}

export async function checkOffloadTargetHealth(target: HealthyOffloadTarget, timeoutMs: number): Promise<{ ok: boolean; reason?: string }> {
  if (!target) return { ok: false, reason: 'no target' };
  if (target.keyEnv) {
    const val = process.env[target.keyEnv];
    if (typeof val === 'string' && val.trim()) return { ok: true };
    return { ok: false, reason: `env ${target.keyEnv} missing` };
  }
  if (!target.base) return { ok: false, reason: 'no base URL' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  const start = Date.now();
  try {
    const response = await fetch(target.base, { method: 'GET', signal: controller.signal });
    const latency = Date.now() - start;
    if (response.ok) return { ok: true };
    if (response.status >= 400 && response.status < 500) {
      console.warn(`[governor-offload] ${target.id} responded ${response.status} (${latency}ms)`);
      return { ok: true };
    }
    return { ok: false, reason: `status ${response.status}` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: message };
  } finally {
    clearTimeout(timer);
  }
}

export function createOffloadSpawnRequest(spawnDir: string, target: HealthyOffloadTarget, spec: OffloadWorkSpec): OffloadSpawnResult | null {
  try {
    if (!spec.objective || !spec.cwd) throw new Error('objective/cwd required');
    mkdirSync(spawnDir, { recursive: true });
    const id = buildRequestId(target.id);
    const filePath = join(spawnDir, `${id}.json`);
    const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
    const request = buildSpawnRequest(id, target, spec);
    writeFileSync(tmpPath, JSON.stringify(request, null, 2), 'utf8');
    renameSync(tmpPath, filePath);
    return { id, filePath };
  } catch (e) {
    console.error('[governor-offload] failed to write spawn request:', e instanceof Error ? e.message : e);
    return null;
  }
}

function buildSpawnRequest(id: string, target: HealthyOffloadTarget, spec: OffloadWorkSpec): Record<string, unknown> {
  const provider = spec.provider ?? target.provider ?? providerFromWire(target.wire);
  const payload: Record<string, unknown> = {
    id,
    objective: spec.objective,
    cwd: spec.cwd,
    isolate: spec.isolate ?? true
  };
  if (spec.name || target.name) payload.name = spec.name ?? target.name;
  if (provider) payload.provider = provider;
  if (spec.model || target.model) payload.model = spec.model ?? target.model;
  if (spec.profile || target.profile) payload.profile = spec.profile ?? target.profile;
  if (target.command) payload.command = target.command;
  if (spec.tokenCap ?? target.tokenCap) payload.tokenCap = spec.tokenCap ?? target.tokenCap;
  if (spec.slack) payload.slack = spec.slack;
  // Provenance round-trips the target id + owning account so a reaped worker can be
  // requeued onto a different target and re-gated per-profile (§6, G4).
  payload.hive = { offload: { target: target.id, accountKey: spec.accountKey } };
  return payload;
}

/** True when a target has both a free concurrency slot AND tok/min headroom. */
function targetHasCapacity(target: HealthyOffloadTarget, resolved: ResolvedAutoOffloadConfig): boolean {
  const cap = target.maxConcurrent ?? resolved.defaultTargetMaxConcurrent;
  if (cap > 0 && countActiveForTarget(target.id) >= cap) return false;
  return targetTokenBudgetOk(target, resolved);
}

function targetTokenBudgetOk(target: HealthyOffloadTarget, resolved: ResolvedAutoOffloadConfig): boolean {
  const ceiling = target.tokensPerMinute ?? resolved.defaultTokensPerMinute;
  if (!ceiling || ceiling <= 0) return true; // no gate configured for this target
  const now = Date.now();
  const samples = (targetTokenSpend.get(target.id) ?? []).filter((s) => now - s.ts < 60_000);
  targetTokenSpend.set(target.id, samples);
  const spent = samples.reduce((a, s) => a + s.tokens, 0);
  return spent < ceiling;
}

function recordTargetSpend(targetId: string, tokens: number): void {
  if (!tokens || tokens <= 0) return;
  const now = Date.now();
  const samples = (targetTokenSpend.get(targetId) ?? []).filter((s) => now - s.ts < 60_000);
  samples.push({ ts: now, tokens });
  targetTokenSpend.set(targetId, samples);
}

function maybeNotifyHold(resolved: ResolvedAutoOffloadConfig, notify?: OffloadNotify): void {
  console.warn('[governor-offload] no healthy offload targets — work held');
  if (!notify) return;
  const now = Date.now();
  if (now - lastHoldNotifyAt < resolved.holdNotifyIntervalMs) return;
  lastHoldNotifyAt = now;
  notify(
    '[offload held] no healthy target',
    'Governor is RED and offload-eligible work is queued, but no offload target is healthy (down / throttled / missing key). Work is HELD and will drain when a target recovers or the window resets. Not routed onto a paused Claude account.'
  );
}

function providerFromWire(wire?: string): AgentProvider | undefined {
  switch ((wire ?? '').toLowerCase()) {
    case 'openai':
      return 'codex';
    case 'anthropic':
      return 'claude';
    default:
      return undefined;
  }
}

function buildRequestId(targetId: string): string {
  const suffix = randomBytes(4).toString('hex');
  return `offload-${targetId}-${Date.now().toString(36)}-${suffix}`;
}

function pickTarget(spec: OffloadWorkSpec, targets: HealthyOffloadTarget[]): HealthyOffloadTarget | undefined {
  const preferences = spec.targetPreference && spec.targetPreference.length
    ? spec.targetPreference
    : undefined;
  if (!preferences) return targets[0];
  for (const pref of preferences) {
    const found = targets.find((t) => t.id === pref);
    if (found) return found;
  }
  return targets[0];
}

function effectiveTryOrder(requested: string[], manifest: OffloadManifest): string[] {
  const manifestOrder: string[] = [];
  const manifestDefault = manifest.default;
  if (Array.isArray(manifestDefault)) manifestOrder.push(...manifestDefault);
  else if (typeof manifestDefault === 'string') manifestOrder.push(manifestDefault);
  if (Array.isArray(manifest.tryOrder)) manifestOrder.push(...manifest.tryOrder);
  const keys = manifest.targets ? Object.keys(manifest.targets) : [];
  return dedupeStrings([...requested, ...manifestOrder, ...keys]);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function numberWithFallback(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

function consumeQueuedObjective(spec: OffloadWorkSpec): void {
  const index = queuedObjectives.indexOf(spec);
  if (index >= 0) queuedObjectives.splice(index, 1);
}

function resolveDefaultHiveRoot(): string | undefined {
  const home = resolveHarnessHome();
  return home ? join(home, 'hive') : undefined;
}
