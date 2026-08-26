import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listLocalDelegates } from './config';
import type {
  LdaCapability,
  LdaInvokeRequest,
  LdaResult,
  LdaHealthResult,
  LocalDelegateConfig
} from '../shared/localDelegate';

const execFileAsync = promisify(execFile);

const HEALTH_TIMEOUT_MS = 8_000;
const INVOKE_TIMEOUT_MS = 300_000;

// Translate a Windows path arg to WSL /mnt form so the remote script can read it.
function translatePath(a: string): string {
  if (/^[A-Za-z]:[\\/]/.test(a)) {
    const drive = a[0].toLowerCase();
    const rest = a.slice(2).replace(/\\/g, '/');
    return `/mnt/${drive}${rest}`;
  }
  if (/^\/[A-Za-z]\//.test(a)) {
    return `/mnt${a}`;
  }
  return a;
}

function buildCapabilityArgs(cap: LdaCapability, req: LdaInvokeRequest['args']): string[] {
  switch (cap) {
    case 'find':
      return [req.question ?? '', req.file ?? ''].filter(Boolean).map(translatePath);
    case 'map':
      return [req.question ?? '', ...(req.files ?? []).map(translatePath)];
    case 'run':
      return ['--', req.command ?? '', ...(req.commandArgs ?? [])];
    case 'check':
      return [req.claim ?? '', req.file ? translatePath(req.file) : ''].filter(Boolean);
    case 'task': {
      const a = [req.instruction ?? ''];
      if (req.contextFile) { a.push('-f'); a.push(translatePath(req.contextFile)); }
      if (req.outputFile) { a.push('-o'); a.push(translatePath(req.outputFile)); }
      if (req.verifyCmd) { a.push('--verify'); a.push(req.verifyCmd); }
      return a;
    }
    case 'loop': {
      const a = [req.instruction ?? '', ...(req.files ?? []).map(translatePath)];
      if (req.apply) a.push('--apply');
      if (req.verifyCmd) { a.push('--verify'); a.push(req.verifyCmd); }
      return a;
    }
  }
}

function scriptName(cap: LdaCapability): string {
  const names: Record<LdaCapability, string> = {
    find: 'edgentic-find',
    map: 'edgentic-map',
    run: 'edgentic-run',
    check: 'edgentic-check',
    task: 'edgentic-task',
    loop: 'edgentic-loop'
  };
  return names[cap];
}

async function runWslExec(cfg: LocalDelegateConfig, cap: LdaCapability, capArgs: string[]): Promise<LdaResult> {
  if (cfg.transport.kind !== 'wsl-exec') {
    return { ok: false, output: 'unsupported transport', exitCode: 1, durationMs: 0 };
  }
  const { distro, scriptPrefix } = cfg.transport;
  const script = `${scriptPrefix}/${scriptName(cap)}`;
  // script is $1, capArgs are $2+. "$@" expands to $1..$N = script+capArgs,
  // which is exactly the intended invocation. exec "$1" "$@" would duplicate
  // the script path as arg[0] of the subprocess — use "$@" directly instead.
  // Validated at upsert time; safe even if validation somehow fails.
  const remote = `PATH="$HOME/.local/scripts:$PATH" exec "$@"`;
  const argv = ['-d', distro, '-e', 'bash', '-c', remote, '_', script, ...capArgs];
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('wsl.exe', argv, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: INVOKE_TIMEOUT_MS
    });
    const durationMs = Date.now() - t0;
    const output = stdout + (stderr ? `\n${stderr}` : '');
    return { ok: true, output: output.trim(), exitCode: 0, durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - t0;
    const e = err as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean; message?: string };
    const output = ((e.stdout ?? '') + (e.stderr ? `\n${e.stderr}` : '')).trim();
    const exitCode = typeof e.code === 'number' ? e.code : 1;
    const msg = e.killed ? `timed out after ${INVOKE_TIMEOUT_MS}ms` : (output || (e.message ?? 'unknown error'));
    return { ok: false, output: msg, exitCode, durationMs };
  }
}

export const ldaRunner = {
  async invoke(req: LdaInvokeRequest): Promise<LdaResult> {
    const delegates = listLocalDelegates();
    const cfg = delegates.find((d) => d.id === req.delegateId);
    if (!cfg) return { ok: false, output: `no delegate: ${req.delegateId}`, exitCode: 1, durationMs: 0 };
    if (!cfg.enabled) return { ok: false, output: `delegate disabled: ${req.delegateId}`, exitCode: 1, durationMs: 0 };
    const cap = req.args.capability;
    if (!cfg.capabilities.includes(cap)) {
      return { ok: false, output: `delegate ${req.delegateId} does not declare capability: ${cap}`, exitCode: 1, durationMs: 0 };
    }
    const capArgs = buildCapabilityArgs(cap, req.args);
    return runWslExec(cfg, cap, capArgs);
  },

  async health(id: string): Promise<LdaHealthResult> {
    const delegates = listLocalDelegates();
    const cfg = delegates.find((d) => d.id === id);
    if (!cfg) return { ok: false, latencyMs: 0, error: `no delegate: ${id}` };
    if (cfg.transport.kind !== 'wsl-exec') return { ok: false, latencyMs: 0, error: 'unsupported transport' };
    const { distro, scriptPrefix } = cfg.transport;
    const healthScript = `${scriptPrefix}/edgentic`;
    const remote = `PATH="$HOME/.local/scripts:$PATH" exec "$1" --health`;
    const t0 = Date.now();
    try {
      await execFileAsync('wsl.exe', ['-d', distro, '-e', 'bash', '-c', remote, '_', healthScript], {
        timeout: HEALTH_TIMEOUT_MS
      });
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string; killed?: boolean; message?: string };
      const latencyMs = Date.now() - t0;
      const msg = e.killed
        ? `timed out after ${HEALTH_TIMEOUT_MS}ms`
        : ((e.stderr ?? e.stdout ?? e.message ?? 'unknown').toString().trim().slice(0, 200));
      return { ok: false, latencyMs, error: msg };
    }
  }
};
