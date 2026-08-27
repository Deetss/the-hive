import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readConfig, resolveHarnessHome } from './config';
import type { AutoOffloadConfig } from './config';
import type { AgentProvider } from '../shared/agentProvider';

const DEFAULT_TRY_ORDER = ['edgentic', 'azure'];
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 2000;

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
}

export interface OffloadSpawnResult {
  id: string;
  filePath: string;
}

export interface AttemptGovernorOffloadsOptions {
  policy?: AutoOffloadConfig;
  hiveRoot?: string | null;
  pendingObjectives?: OffloadWorkSpec[];
}

const queuedObjectives: OffloadWorkSpec[] = [];
const activeRequestIds = new Set<string>();
let attemptRunning = false;

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
  return { enabled, targetsFile, tryOrder, maxConcurrent, healthCheckTimeoutMs, dryRun };
}

export function queueOffloadObjective(spec: OffloadWorkSpec): void {
  if (!spec?.objective || !spec.cwd) return;
  queuedObjectives.push(spec);
}

export function pendingOffloadObjectives(): OffloadWorkSpec[] {
  return [...queuedObjectives];
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
  const queue = [...queuedObjectives, ...(options.pendingObjectives ?? [])];
  if (!queue.length) return;
  const limit = Math.max(0, resolved.maxConcurrent - activeRequestIds.size);
  if (limit <= 0) return;
  attemptRunning = true;
  try {
    const targets = await findHealthyTargets(resolved.targetsFile, resolved.tryOrder, resolved.healthCheckTimeoutMs);
    if (!targets.length) {
      console.warn('[governor-offload] no healthy offload targets');
      return;
    }
    let processed = 0;
    while (processed < limit && queue.length) {
      const next = queue.shift();
      if (!next) break;
      consumeQueuedObjective(next);
      const target = pickTarget(next, targets);
      if (!target) {
        console.warn('[governor-offload] no suitable target for objective');
        continue;
      }
      if (resolved.dryRun) {
        console.log(`[governor-offload] dry-run: would offload objective "${next.objective}" to ${target.id}`);
        processed += 1;
        continue;
      }
      const result = createOffloadSpawnRequest(spawnDir, target, next);
      if (result) {
        activeRequestIds.add(result.id);
        processed += 1;
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
  payload.hive = { offload: { target: target.id } };
  return payload;
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
