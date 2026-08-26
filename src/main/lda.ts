import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { listLocalDelegates } from './config';
import { getSecret } from './integrations';
import type {
  LdaCapability,
  LdaApiCapability,
  LdaInvokeRequest,
  LdaResult,
  LdaHealthResult,
  LocalDelegateConfig
} from '../shared/localDelegate';

const execFileAsync = promisify(execFile);

const DEFAULT_HEALTH_MS = 8_000;
const DEFAULT_INVOKE_MS = 300_000;

function timeouts(cfg: LocalDelegateConfig): { health: number; invoke: number } {
  return {
    health: cfg.timeoutMs?.health ?? DEFAULT_HEALTH_MS,
    invoke: cfg.timeoutMs?.invoke ?? DEFAULT_INVOKE_MS
  };
}

// ─── Path translation (wsl-exec only) ────────────────────────────────────────

function translatePath(a: string): string {
  if (/^[A-Za-z]:[\\/]/.test(a)) {
    const drive = a[0].toLowerCase();
    const rest = a.slice(2).replace(/\\/g, '/');
    return `/mnt/${drive}${rest}`;
  }
  if (/^\/[A-Za-z]\//.test(a)) return `/mnt${a}`;
  return a;
}

// ─── Script-runner capability → argv ─────────────────────────────────────────

function scriptName(cap: LdaCapability): string {
  const names: Record<LdaCapability, string> = {
    find: 'edgentic-find', map: 'edgentic-map', run: 'edgentic-run',
    check: 'edgentic-check', task: 'edgentic-task', loop: 'edgentic-loop'
  };
  return names[cap];
}

function buildScriptArgs(cap: LdaCapability, req: LdaInvokeRequest['args'], translate: (p: string) => string): string[] {
  switch (cap) {
    case 'find':
      return [req.question ?? '', req.file ?? ''].filter(Boolean).map(translate);
    case 'map':
      return [req.question ?? '', ...(req.files ?? []).map(translate)];
    case 'run':
      return ['--', req.command ?? '', ...(req.commandArgs ?? [])];
    case 'check':
      return [req.claim ?? '', req.file ? translate(req.file) : ''].filter(Boolean);
    case 'task': {
      const a = [req.instruction ?? ''];
      if (req.contextFile) { a.push('-f'); a.push(translate(req.contextFile)); }
      if (req.outputFile) { a.push('-o'); a.push(translate(req.outputFile)); }
      if (req.verifyCmd) { a.push('--verify'); a.push(req.verifyCmd); }
      return a;
    }
    case 'loop': {
      const a = [req.instruction ?? '', ...(req.files ?? []).map(translate)];
      if (req.apply) a.push('--apply');
      if (req.verifyCmd) { a.push('--verify'); a.push(req.verifyCmd); }
      return a;
    }
  }
}

// ─── wsl-exec transport ───────────────────────────────────────────────────────

async function runWslExec(cfg: LocalDelegateConfig, cap: LdaCapability, capArgs: string[], invokeMs: number): Promise<LdaResult> {
  const t = cfg.transport;
  if (t.kind !== 'wsl-exec') return { ok: false, output: 'wrong transport', exitCode: 1, durationMs: 0 };
  const script = `${t.scriptPrefix}/${scriptName(cap)}`;
  const remote = `PATH="$HOME/.local/scripts:$PATH" exec "$@"`;
  const argv = ['-d', t.distro, '-e', 'bash', '-c', remote, '_', script, ...capArgs];
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('wsl.exe', argv, { maxBuffer: 4 * 1024 * 1024, timeout: invokeMs });
    const output = stdout + (stderr ? `\n${stderr}` : '');
    return { ok: true, output: output.trim(), exitCode: 0, durationMs: Date.now() - t0 };
  } catch (err: unknown) {
    const durationMs = Date.now() - t0;
    const e = err as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean; message?: string };
    const out = ((e.stdout ?? '') + (e.stderr ? `\n${e.stderr}` : '')).trim();
    const msg = e.killed ? `timed out after ${invokeMs}ms` : (out || (e.message ?? 'unknown error'));
    return { ok: false, output: msg, exitCode: typeof e.code === 'number' ? e.code : 1, durationMs };
  }
}

async function healthWslExec(cfg: LocalDelegateConfig, healthMs: number): Promise<LdaHealthResult> {
  const t = cfg.transport;
  if (t.kind !== 'wsl-exec') return { ok: false, latencyMs: 0, error: 'wrong transport' };
  const healthScript = `${t.scriptPrefix}/edgentic`;
  const remote = `PATH="$HOME/.local/scripts:$PATH" exec "$1" --health`;
  const t0 = Date.now();
  try {
    await execFileAsync('wsl.exe', ['-d', t.distro, '-e', 'bash', '-c', remote, '_', healthScript], { timeout: healthMs });
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; killed?: boolean; message?: string };
    const msg = e.killed ? `timed out after ${healthMs}ms`
      : ((e.stderr ?? e.stdout ?? e.message ?? 'unknown').toString().trim().slice(0, 200));
    return { ok: false, latencyMs: Date.now() - t0, error: msg };
  }
}

// ─── SSH transport ────────────────────────────────────────────────────────────

/** POSIX shell single-quote escaping. Wraps the value in single quotes and
 *  escapes any embedded single quotes with the '\'' idiom. This is the only safe
 *  way to pass arbitrary data into a shell command string — double-quote escaping
 *  still allows $, `, and \ expansion. */
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function sshBaseArgs(t: { host: string; port: number; user: string; identityFile?: string }): string[] {
  // BatchMode=yes: fail immediately if host key not accepted (no interactive prompt).
  // StrictHostKeyChecking=accept-new: silently accept new host keys but reject changed
  // ones (protects against MITM after first connection). User must SSH manually once
  // to populate known_hosts before using a delegate.
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-p', String(t.port)];
  if (t.identityFile) args.push('-i', t.identityFile);
  args.push(`${t.user}@${t.host}`);
  return args;
}

async function runSsh(cfg: LocalDelegateConfig, cap: LdaCapability, capArgs: string[], invokeMs: number): Promise<LdaResult> {
  const t = cfg.transport;
  if (t.kind !== 'ssh') return { ok: false, output: 'wrong transport', exitCode: 1, durationMs: 0 };
  const script = `${t.scriptPrefix}/${scriptName(cap)}`;
  // SSH concatenates all command args into a single remote shell string — passing
  // multiple positional args is NOT safe because the remote shell re-parses them.
  // We build one shell-safe command string with every arg single-quoted via shq().
  const remoteCmd = `PATH="$HOME/.local/scripts:$PATH" exec ${[script, ...capArgs].map(shq).join(' ')}`;
  const argv = [...sshBaseArgs(t), remoteCmd];
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('ssh', argv, { maxBuffer: 4 * 1024 * 1024, timeout: invokeMs });
    const output = stdout + (stderr ? `\n${stderr}` : '');
    return { ok: true, output: output.trim(), exitCode: 0, durationMs: Date.now() - t0 };
  } catch (err: unknown) {
    const durationMs = Date.now() - t0;
    const e = err as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean; message?: string };
    const out = ((e.stdout ?? '') + (e.stderr ? `\n${e.stderr}` : '')).trim();
    const msg = e.killed ? `timed out after ${invokeMs}ms` : (out || (e.message ?? 'unknown error'));
    return { ok: false, output: msg, exitCode: typeof e.code === 'number' ? e.code : 1, durationMs };
  }
}

async function healthSsh(cfg: LocalDelegateConfig, healthMs: number): Promise<LdaHealthResult> {
  const t = cfg.transport;
  if (t.kind !== 'ssh') return { ok: false, latencyMs: 0, error: 'wrong transport' };
  const healthScript = `${t.scriptPrefix}/edgentic`;
  const remoteCmd = `PATH="$HOME/.local/scripts:$PATH" exec ${shq(healthScript)} --health`;
  const argv = [...sshBaseArgs(t), remoteCmd];
  const t0 = Date.now();
  try {
    await execFileAsync('ssh', argv, { timeout: healthMs });
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; killed?: boolean; message?: string };
    const msg = e.killed ? `timed out after ${healthMs}ms`
      : ((e.stderr ?? e.stdout ?? e.message ?? 'unknown').toString().trim().slice(0, 200));
    return { ok: false, latencyMs: Date.now() - t0, error: msg };
  }
}

// ─── HTTP / model-API transport ───────────────────────────────────────────────

function httpFetch(urlStr: string, opts: {
  method: string; headers: Record<string, string>; body: string; timeoutMs: number;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: opts.method, headers: { ...opts.headers, 'Content-Length': Buffer.byteLength(opts.body) } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => { body += d; if (body.length > 8 * 1024 * 1024) req.destroy(new Error('response too large')); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`timed out after ${opts.timeoutMs}ms`)));
    req.on('error', reject);
    req.write(opts.body);
    req.end();
  });
}

function buildApiRequestBody(cfg: LocalDelegateConfig, prompt: string): string {
  switch (cfg.providerKind) {
    case 'openai-compat':
      return JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: 4096 });
    case 'anthropic-compat':
      return JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: 4096 });
    case 'ollama':
      return JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], stream: false });
    default:
      return JSON.stringify({ prompt, model: cfg.model });
  }
}

function extractApiResponseText(cfg: LocalDelegateConfig, body: string): string {
  try {
    const r = JSON.parse(body) as Record<string, unknown>;
    if (cfg.providerKind === 'openai-compat') {
      const choices = r.choices as Array<{ message?: { content?: string } }> | undefined;
      return choices?.[0]?.message?.content ?? body;
    }
    if (cfg.providerKind === 'anthropic-compat') {
      const content = r.content as Array<{ text?: string }> | undefined;
      return content?.[0]?.text ?? body;
    }
    if (cfg.providerKind === 'ollama') {
      const msg = (r.message as { content?: string } | undefined);
      return msg?.content ?? body;
    }
    return body;
  } catch { return body; }
}

function apiEndpoint(cfg: LocalDelegateConfig, cap: LdaApiCapability | 'health'): string {
  const base = (cfg.transport as { baseUrl: string }).baseUrl.replace(/\/+$/, '');
  if (cap === 'health') {
    return cfg.providerKind === 'ollama' ? `${base}/api/tags` : `${base}/v1/models`;
  }
  if (cap === 'embed') return `${base}/v1/embeddings`;
  if (cfg.providerKind === 'ollama') return `${base}/api/chat`;
  if (cfg.providerKind === 'anthropic-compat') return `${base}/v1/messages`;
  return `${base}/v1/chat/completions`;
}

function apiHeaders(cfg: LocalDelegateConfig, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'the-hive-lda/1.0' };
  if (apiKey) {
    if (cfg.providerKind === 'anthropic-compat') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }
  return headers;
}

/** Validate a file path from the renderer before reading it into a prompt.
 *  Must be absolute and must not contain path-traversal sequences. */
function safeReadFile(filePath: string): string | null {
  if (!filePath || !isAbsolute(filePath)) return null;
  const norm = normalize(filePath);
  // Reject if normalization changes the path (indicates .. traversal was present)
  if (norm !== filePath && norm !== filePath.replace(/[/\\]+$/, '')) return null;
  try { return readFileSync(norm, 'utf8'); } catch { return null; }
}

function buildApiPrompt(cap: LdaApiCapability, req: LdaInvokeRequest['args']): string {
  if (req.prompt) return req.prompt;
  if (cap === 'complete') {
    if (req.question) {
      if (req.file) {
        const content = safeReadFile(req.file);
        if (content !== null) return `${req.question}\n\nFile: ${req.file}\n\`\`\`\n${content}\n\`\`\``;
      }
      return req.question;
    }
    if (req.claim && req.file) {
      const content = safeReadFile(req.file);
      if (content !== null) {
        return `Verify the following claim about the file "${req.file}". Answer only "true" or "false" followed by a brief explanation.\nClaim: ${req.claim}\n\nFile:\n\`\`\`\n${content}\n\`\`\``;
      }
      return req.claim;
    }
  }
  return req.question ?? req.claim ?? req.instruction ?? '';
}

async function runHttp(cfg: LocalDelegateConfig, cap: LdaApiCapability, req: LdaInvokeRequest['args'], invokeMs: number): Promise<LdaResult> {
  const apiKey = cfg.secretRef ? getSecret(cfg.secretRef) : undefined;
  const prompt = buildApiPrompt(cap, req);
  const body = cap === 'embed'
    ? JSON.stringify({ model: cfg.model, input: prompt })
    : buildApiRequestBody(cfg, prompt);
  const t0 = Date.now();
  try {
    const res = await httpFetch(apiEndpoint(cfg, cap), {
      method: 'POST',
      headers: apiHeaders(cfg, apiKey),
      body,
      timeoutMs: invokeMs
    });
    const durationMs = Date.now() - t0;
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, output: `HTTP ${res.status}: ${res.body.slice(0, 400)}`, exitCode: res.status, durationMs };
    }
    const output = cap === 'embed' ? res.body : extractApiResponseText(cfg, res.body);
    return { ok: true, output, exitCode: 0, durationMs };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg, exitCode: 1, durationMs: Date.now() - t0 };
  }
}

async function healthHttp(cfg: LocalDelegateConfig, healthMs: number): Promise<LdaHealthResult> {
  const apiKey = cfg.secretRef ? getSecret(cfg.secretRef) : undefined;
  const url = apiEndpoint(cfg, 'health');
  const t0 = Date.now();
  try {
    const res = await httpFetch(url, { method: 'GET', headers: apiHeaders(cfg, apiKey), body: '', timeoutMs: healthMs });
    const latencyMs = Date.now() - t0;
    if (res.status < 200 || res.status >= 300) return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    return { ok: true, latencyMs };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: Date.now() - t0, error: msg.slice(0, 200) };
  }
}

// ─── Public runner ────────────────────────────────────────────────────────────

export const ldaRunner = {
  async invoke(req: LdaInvokeRequest): Promise<LdaResult> {
    const delegates = listLocalDelegates();
    const cfg = delegates.find((d) => d.id === req.delegateId);
    if (!cfg) return { ok: false, output: `no delegate: ${req.delegateId}`, exitCode: 1, durationMs: 0 };
    if (!cfg.enabled) return { ok: false, output: `delegate disabled: ${req.delegateId}`, exitCode: 1, durationMs: 0 };
    const cap = req.args.capability as string;
    const { invoke: invokeMs } = timeouts(cfg);
    const transportKind = cfg.transport.kind;

    // API capability (http transport)
    if (cap === 'complete' || cap === 'embed') {
      if (transportKind !== 'http') {
        return { ok: false, output: `capability '${cap}' requires http transport`, exitCode: 1, durationMs: 0 };
      }
      if (!(cfg.apiCapabilities as string[]).includes(cap)) {
        return { ok: false, output: `delegate does not declare apiCapability: ${cap}`, exitCode: 1, durationMs: 0 };
      }
      return runHttp(cfg, cap as LdaApiCapability, req.args, invokeMs);
    }

    // Script capability
    if (!(cfg.capabilities as string[]).includes(cap)) {
      return { ok: false, output: `delegate does not declare capability: ${cap}`, exitCode: 1, durationMs: 0 };
    }
    const translate = transportKind === 'wsl-exec' ? translatePath : (a: string) => a;
    const capArgs = buildScriptArgs(cap as LdaCapability, req.args, translate);
    if (transportKind === 'wsl-exec') return runWslExec(cfg, cap as LdaCapability, capArgs, invokeMs);
    if (transportKind === 'ssh') return runSsh(cfg, cap as LdaCapability, capArgs, invokeMs);
    return { ok: false, output: `transport '${transportKind}' does not support script capabilities`, exitCode: 1, durationMs: 0 };
  },

  async health(id: string): Promise<LdaHealthResult> {
    const delegates = listLocalDelegates();
    const cfg = delegates.find((d) => d.id === id);
    if (!cfg) return { ok: false, latencyMs: 0, error: `no delegate: ${id}` };
    const { health: healthMs } = timeouts(cfg);
    const tk = cfg.transport.kind;
    if (tk === 'wsl-exec') return healthWslExec(cfg, healthMs);
    if (tk === 'ssh') return healthSsh(cfg, healthMs);
    if (tk === 'http') return healthHttp(cfg, healthMs);
    return { ok: false, latencyMs: 0, error: `unsupported transport: ${tk}` };
  }
};
