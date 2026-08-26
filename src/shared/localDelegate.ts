export type LdaCapability = 'find' | 'map' | 'run' | 'check' | 'task' | 'loop';

export interface LdaTransportWslExec {
  kind: 'wsl-exec';
  distro: string;
  scriptPrefix: string;
}

export type LdaTransport = LdaTransportWslExec;

export interface LocalDelegateConfig {
  id: string;
  label: string;
  transport: LdaTransport;
  model: string;
  capabilities: LdaCapability[];
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
