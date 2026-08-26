import { spawnSync } from 'node:child_process';
import { listLocalDelegates } from './config';
import type {
  LdaCapability,
  LdaInvokeRequest,
  LdaResult,
  LdaHealthResult,
  LocalDelegateConfig
} from '../shared/localDelegate';

// Translate a Windows path arg to WSL /mnt form so the remote script can read it.
function translatePath(a: string): string {
  if (/^[A-Za-z]:[\\/]/.test(a)) {
    // C:/foo or C:\foo -> /mnt/c/foo
    const drive = a[0].toLowerCase();
    const rest = a.slice(2).replace(/\\/g, '/');
    return `/mnt/${drive}${rest}`;
  }
  if (/^\/[A-Za-z]\//.test(a)) {
    // /c/foo -> /mnt/c/foo
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

function runWslExec(cfg: LocalDelegateConfig, cap: LdaCapability, capArgs: string[]): LdaResult {
  if (cfg.transport.kind !== 'wsl-exec') {
    return { ok: false, output: 'unsupported transport', exitCode: 1, durationMs: 0 };
  }
  const { distro, scriptPrefix } = cfg.transport;
  const script = `${scriptPrefix}/${scriptName(cap)}`;
  // Build the remote bash -c string; PATH prepend ensures edgentic's own
  // internal rerank call resolves the same way the bridge script does.
  const remote = `PATH="$HOME/.local/scripts:$PATH" exec "${script}" "$@"`;
  const t0 = Date.now();
  const result = spawnSync('wsl.exe', ['-d', distro, '-e', 'bash', '-c', remote, '_', ...capArgs], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  const durationMs = Date.now() - t0;
  const ok = result.status === 0;
  const output = (result.stdout ?? '') + (result.stderr ? `\n${result.stderr}` : '');
  return { ok, output: output.trim(), exitCode: result.status ?? 1, durationMs };
}

export const ldaRunner = {
  invoke(req: LdaInvokeRequest): LdaResult {
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

  health(id: string): LdaHealthResult {
    const delegates = listLocalDelegates();
    const cfg = delegates.find((d) => d.id === id);
    if (!cfg) return { ok: false, latencyMs: 0, error: `no delegate: ${id}` };
    if (cfg.transport.kind !== 'wsl-exec') return { ok: false, latencyMs: 0, error: 'unsupported transport' };
    const { distro, scriptPrefix } = cfg.transport;
    const remote = `PATH="$HOME/.local/scripts:$PATH" exec "${scriptPrefix}/edgentic" --health`;
    const t0 = Date.now();
    const result = spawnSync('wsl.exe', ['-d', distro, '-e', 'bash', '-c', remote], { encoding: 'utf8' });
    const latencyMs = Date.now() - t0;
    if (result.status === 0) return { ok: true, latencyMs };
    return { ok: false, latencyMs, error: (result.stderr ?? result.stdout ?? '').trim().slice(0, 200) };
  }
};
