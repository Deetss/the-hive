export type LdaCapability = 'find' | 'map' | 'run' | 'check' | 'task' | 'loop';
export type LdaApiCapability = 'complete' | 'embed';
export type LdaProviderKind = 'openai-compat' | 'anthropic-compat' | 'ollama' | 'edgentic-script';

export interface LdaTransportWslExec {
  kind: 'wsl-exec';
  distro: string;
  scriptPrefix: string;
}

export interface LdaTransportSsh {
  kind: 'ssh';
  host: string;
  port: number;
  user: string;
  identityFile?: string;
  scriptPrefix: string;
}

export interface LdaTransportHttp {
  kind: 'http';
  baseUrl: string;
  /** Allow private/LAN IP ranges (e.g. for a local Jetson/DGX).
   *  Default false — SSRF guard blocks 169.254.*, ::1, cloud-metadata ranges. */
  allowPrivate?: boolean;
}

export type LdaTransport = LdaTransportWslExec | LdaTransportSsh | LdaTransportHttp;

export interface LocalDelegateConfig {
  id: string;
  label: string;
  transport: LdaTransport;
  /** Which provider protocol this delegate speaks (drives HTTP wire format). */
  providerKind: LdaProviderKind;
  /** Model id passed to API calls; no longer informational-only. */
  model: string;
  /** Script verb capabilities (wsl-exec / ssh transport only). */
  capabilities: LdaCapability[];
  /** Model-API capabilities (http transport only). */
  apiCapabilities: LdaApiCapability[];
  /** Pointer into integration-secrets.json (e.g. "lda:<id>:apikey"). NEVER the key. */
  secretRef?: string;
  /** Per-delegate timeout overrides. */
  timeoutMs?: {
    health?: number;   // default 8 000 ms
    invoke?: number;   // default 300 000 ms
  };
  enabled: boolean;
}

export interface LdaInvokeArgs {
  capability: LdaCapability;
  question?: string;
  claim?: string;
  file?: string;
  files?: string[];
  command?: string;
  commandArgs?: string[];
  instruction?: string;
  contextFile?: string;
  outputFile?: string;
  verifyCmd?: string;
  apply?: boolean;
}

export interface LdaInvokeRequest {
  delegateId: string;
  args: LdaInvokeArgs;
}

export interface LdaResult {
  ok: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
}

export interface LdaHealthResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}
