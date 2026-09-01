import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  powerSaveBlocker,
  screen,
  shell,
  Notification,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  rmSync, existsSync, readFileSync, readdirSync, statSync, cpSync, writeFileSync,
  unlinkSync, mkdirSync, renameSync, createWriteStream, createReadStream, copyFileSync, lstatSync,
  readlinkSync, symlinkSync, watchFile, unwatchFile
} from 'node:fs';
import { randomBytes, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { join, resolve, sep, basename, dirname, extname } from 'node:path';
import { homedir, tmpdir, hostname } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { PtyManager, type SpawnOptions } from './pty';
import { resolveCommand as resolveCliCommand } from './shellEnv';
import { initAutoUpdater, abortPendingRestart } from './updater';
import { RealtimeFloorWatcher } from './realtimeFloorWatcher';
import {
  readConfig, writeConfig, setAgentTokenCap, resetConfig, ensureHarnessHome, ensureClaudePermissionsAccepted,
  resolveHarnessHome, getRuntimeProfile, listRuntimeProfiles, upsertRuntimeProfile, isSafeHttpUrl,
  listLocalDelegates, upsertLocalDelegate, removeLocalDelegate, ensureMobileApiSecret,
  modelForRole, OPS_STANDUP_MISSION, HEARTBEAT_MISSION, COMPACT_MAINTENANCE_MISSION,
  DEFAULT_GOVERNOR_PACE_MARGIN, DEFAULT_GOVERNOR_YELLOW_MARGIN, DEFAULT_GOVERNOR_EARLY_FLOOR,
  DEFAULT_GOVERNOR_ABSOLUTE_BACKSTOP, DEFAULT_GOVERNOR_RECENT_MS,
  resolveGovernorPolicy, resolveKnowledgeBaseSources, type ResolvedGovernorProfileSettings, type ResolvedGovernorWindowSettings,
  type HarnessConfig, type KnowledgeBaseSource, type ScheduledMission, type GovernorPolicy, type GovernorProfilePolicy, type GovernorWindowThreshold, type GovernorWindowTripMode, type AutoOffloadConfig
} from './config';
import { attemptGovernorOffloads, releaseOffloadSlot, requeueOffloadObjective, queueOffloadObjective, type OffloadWorkSpec } from './governor-offload';
import { listDir, readFileText, readFileBinary, writeFileText, statAbs, expandTilde } from './fs';
import * as artifacts from './artifacts';
import * as syncLock from './syncLock';
import * as sync from './sync';
import * as profiles from './profiles';
import { ldaRunner } from './lda';
import type { LdaUsageMetrics } from '../shared/localDelegate';
import { normalizeWeekly, weeklyDelayMs, nextWeeklyFireMs, formatWeekly } from '../shared/weeklySchedule';
import {
  getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo, getDiff, mainRepoRoot,
  addWorktree, removeWorktree, worktreeHasUnintegratedWork, worktreeIsGcSafe,
  getLogGraph, getCommitFiles, getFileAtRev, compareRefs, listWorktrees, checkoutRef
} from './git';
import { HiveManager, type AgentMeta, type HiveMessage, type HiveTask } from './hive';
import { HookServer } from './hooks';
import { CircuitBreaker, type BreakerInput } from './breaker';
import type { UsageProvider } from './usage';
import { MemoryManager } from './memory';
import { KnowledgeManager } from './knowledge';
import { MemoryReflector, type ReflectSettings } from './reflect';
import { PersistStore } from './db';
import { readAgentUsage, readContextTokens, seedSessionTranscript, resolveSessionCwd } from './transcript';
import { listIssues, listCIRuns } from './github';
import { SlackWebhookServer, SlackReplyServer, postSlackReply, type SlackEventFile } from './slack';
import {
  WebhookServer,
  type WebhookDispatch, type WebhookEndpointRef, type WebhookInbound, type WebhookTaskStatus
} from './webhook';
import {
  classifyInboundKind, isAutoAllowed,
  DEFAULT_CONTEXT_TRIGGER, DEFAULT_ORG_TRIGGER, DEFAULT_TRIGGER_MODE, DEFAULT_WEBHOOK_SCHEMA,
  type ContextRule, type ContextTriggerConfig, type InboundKind, type OrgTriggerConfig,
  type TriggerHistoryEntry, type TriggerMode, type WebhookTrigger
} from '../shared/triggers';
import {
  appendTriggerHistory, clearTriggerHistory, listTriggerHistory, updateTriggerHistory
} from './triggerHistory';
import { transcribeWithGroq, DEFAULT_GROQ_MODEL } from './freeflow';
import { registerRealtimeIpc } from './realtime';
import { registerRealtimeActionIpc } from './realtimeActions';
import { initCompletionWatcher } from './realtimeCompletionWatcher';
import type { TaskCard, InboxMessage } from './realtimeCompletionWatcher';
import { TelemetryCollector } from './telemetry';
import { CostLedgerTotals } from './costLifetime';
import { analytics } from './analytics';
import { IntegrationBroker } from './integrationBroker';
import * as integrations from './integrations';
import { validateBaseUrl, buildAuthHeaders, resolveUpstreamUrl, secretRefFor, INTEGRATION_TEMPLATES } from '../shared/integrations';
import { RosterStore } from './roster';
import { buildWorkerLaunch } from './workerLaunch';
import { ControlRegistry } from './control';
import { WorkerWakeWatchdog, type WorkerWakeFacts } from './workerWake';
import { inboxNudgeText } from '../shared/hiveNudge';
import { fetchHireManifest, readHireManifestFiles } from './hire';
import { parseHireDeepLink, type HireManifest } from '../shared/hire';
import { ClosingTimeController } from './closingTime';
import {
  argsWithAutoModeFlag,
  inferAgentProvider,
  isClaudeProvider,
  nonInteractiveEnvForProvider,
  providerPreset,
  installInfoForProvider,
  type AgentProvider
} from '../shared/agentProvider';
import { buildMissingCliScript, chooseInstallRung } from './cliInstall';
import { detectNodeVersion, nodeIsUsable, resolveNodeInstaller } from './nodeInstall';
import { toolCatalog, type ToolStatus } from '../shared/toolCatalog';
import { listLocalSkills, loadCatalog, installSkill, uninstallSkill, type LocalSkill } from './skills';
import { loadHero } from './hero';
import {
  CODEX_REMOTE_SOCKET_RELATIVE,
  codexRemoteAliasPath,
  codexRemoteEndpoint,
  codexRemoteSocketFits,
  withCodexRemoteArgs
} from '../shared/codexRemote';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

const BROWSER_SERVER_HOST = '0.0.0.0';
const BROWSER_SERVER_PORT = app.isPackaged ? 48003 : 48103;
const BROWSER_SERVER_ROOT = join(__dirname, '../renderer');
const BROWSER_SERVER_MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
};

let browserServer: HttpServer | null = null;
let browserServerUrl: string | null = null;
let browserServerStart: Promise<string> | null = null;

type BrowserBridgeClient = {
  socket: WebSocket;
  subscriptions: Set<string>;
  id: number;
};

const browserBridgeClients = new Set<BrowserBridgeClient>();
type IpcMainInvokeHandler = Parameters<typeof ipcMain.handle>[1];
const browserInvokeHandlers = new Map<string, IpcMainInvokeHandler>();
let browserSocketServer: WebSocket.Server | null = null;
let browserBridgeClientSeq = 0;
const BROWSER_BRIDGE_SEND_SYMBOL = Symbol('browserBridgeOriginalSend');

const originalIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = ((channel: string, listener: IpcMainInvokeHandler) => {
  browserInvokeHandlers.set(channel, listener);
  return originalIpcHandle(channel, listener);
}) as typeof ipcMain.handle;

const originalIpcRemoveHandler = ipcMain.removeHandler.bind(ipcMain);
ipcMain.removeHandler = ((channel: string) => {
  browserInvokeHandlers.delete(channel);
  return originalIpcRemoveHandler(channel);
}) as typeof ipcMain.removeHandler;

type BrowserBridgeInbound =
  | { type: 'invoke'; id: number; channel: string; args?: unknown[] }
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'ping'; id?: number };

type BrowserBridgeOutbound =
  | { type: 'hello'; version: number }
  | { type: 'invoke-result'; id: number; ok: true; value: unknown }
  | { type: 'invoke-result'; id: number; ok: false; error: { message: string; code?: unknown; stack?: string } }
  | { type: 'event'; channel: string; args: unknown[] }
  | { type: 'pong'; id?: number }
  | { type: 'error'; message: string };


type BrowserBridgeInvokeMessage = Extract<BrowserBridgeInbound, { type: 'invoke' }>;

function setupBrowserSocketServer(server: HttpServer): void {
  if (browserSocketServer) return;

  const wss = new WebSocket.Server({ server, path: '/bridge', perMessageDeflate: false });
  browserSocketServer = wss;
  wss.on('connection', (socket: WebSocket) => {
    const client: BrowserBridgeClient = { socket, subscriptions: new Set(), id: ++browserBridgeClientSeq };
    browserBridgeClients.add(client);
    browserBridgeSend(client, { type: 'hello', version: 1 });
    socket.on('message', (data: WebSocket.Data) => { handleBrowserClientMessage(client, data); });
    socket.on('close', () => { browserBridgeClients.delete(client); });
    socket.on('error', (err: Error) => { console.error('[browser-bridge] client error:', err); });
  });
  wss.on('error', (err: Error) => { console.error('[browser-bridge] server error:', err); });
  wss.on('close', () => {
    browserSocketServer = null;
    browserBridgeClients.clear();
  });
}

function teardownBrowserSocketServer(): void {
  for (const client of browserBridgeClients) {
    try { client.socket.close(1011, 'server closing'); } catch { /* ignore */ }
  }
  browserBridgeClients.clear();
  if (browserSocketServer) {
    try { browserSocketServer.close(); } catch { /* ignore */ }
    browserSocketServer = null;
  }
}

function stringifyBridgePayload(payload: BrowserBridgeOutbound): string | null {
  try {
    return JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  } catch (err) {
    console.error('[browser-bridge] serialize failed:', err);
    return null;
  }
}

function browserBridgeSend(client: BrowserBridgeClient, payload: BrowserBridgeOutbound): void {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  const data = stringifyBridgePayload(payload);
  if (data == null) return;
  try {
    client.socket.send(data);
  } catch (err) {
    console.error('[browser-bridge] send failed:', err);
    try { client.socket.close(1011, 'send failed'); } catch { /* ignore */ }
    browserBridgeClients.delete(client);
  }
}

function broadcastBrowserEvent(channel: string, args: unknown[]): void {
  if (browserBridgeClients.size === 0) return;
  const payload: BrowserBridgeOutbound = { type: 'event', channel, args };
  for (const client of browserBridgeClients) {
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    if (!client.subscriptions.has(channel)) continue;
    browserBridgeSend(client, payload);
  }
}

function toBridgeBuffer(value: Buffer | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value);
}

function normalizeBridgeData(data: WebSocket.Data): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => toBridgeBuffer(chunk))).toString('utf8');
  }
  return toBridgeBuffer(data as ArrayBuffer).toString('utf8');
}

function handleBrowserClientMessage(client: BrowserBridgeClient, raw: WebSocket.Data): void {
  let parsed: BrowserBridgeInbound;
  try {
    parsed = JSON.parse(normalizeBridgeData(raw)) as BrowserBridgeInbound;
  } catch {
    browserBridgeSend(client, { type: 'error', message: 'invalid message' });
    return;
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
    browserBridgeSend(client, { type: 'error', message: 'invalid message' });
    return;
  }
  switch (parsed.type) {
    case 'invoke': {
      if (typeof parsed.id !== 'number' || typeof parsed.channel !== 'string' || parsed.channel.length === 0) {
        browserBridgeSend(client, { type: 'error', message: 'invalid invoke payload' });
        return;
      }
      void handleBrowserInvoke(client, parsed);
      break;
    }
    case 'subscribe':
      if (typeof parsed.channel === 'string' && parsed.channel.length > 0) {
        client.subscriptions.add(parsed.channel);
      }
      break;
    case 'unsubscribe':
      if (typeof parsed.channel === 'string' && parsed.channel.length > 0) {
        client.subscriptions.delete(parsed.channel);
      }
      break;
    case 'ping':
      browserBridgeSend(client, { type: 'pong', id: parsed.id });
      break;
    default:
      browserBridgeSend(client, { type: 'error', message: `unknown message type: ${String((parsed as { type: unknown }).type)}` });
  }
}

async function handleBrowserInvoke(client: BrowserBridgeClient, msg: BrowserBridgeInvokeMessage): Promise<void> {
  const handler = browserInvokeHandlers.get(msg.channel);
  if (!handler) {
    browserBridgeSend(client, { type: 'invoke-result', id: msg.id, ok: false, error: { message: `No handler registered for ${msg.channel}` } });
    return;
  }
  const args = Array.isArray(msg.args) ? msg.args : [];
  try {
    const result = await Promise.resolve(handler(createBrowserInvokeEvent(client), ...args));
    browserBridgeSend(client, { type: 'invoke-result', id: msg.id, ok: true, value: result });
  } catch (err) {
    browserBridgeSend(client, { type: 'invoke-result', id: msg.id, ok: false, error: serializeBridgeError(err) });
  }
}

function serializeBridgeError(err: unknown): { message: string; code?: unknown; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack ?? undefined };
  }
  if (typeof err === 'object' && err && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    const anyErr = err as { message: string; code?: unknown; stack?: unknown };
    const payload: { message: string; code?: unknown; stack?: string } = { message: anyErr.message };
    if ('code' in anyErr) payload.code = anyErr.code;
    if (typeof anyErr.stack === 'string') payload.stack = anyErr.stack;
    return payload;
  }
  return { message: typeof err === 'string' ? err : 'invoke failed' };
}

function createBrowserInvokeEvent(client: BrowserBridgeClient): IpcMainInvokeEvent {
  const existing = liveWebContents() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isDestroyed())?.webContents;
  const sender = existing ?? createBridgeStubWebContents(client);
  const event: any = {
    sender,
    senderFrame: null,
    frameId: typeof sender?.mainFrame?.routingId === 'number' ? sender.mainFrame.routingId : 0,
    processId: typeof sender?.getProcessId === 'function' ? sender.getProcessId() : -1,
    ports: [],
    returnValue: undefined,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
  };
  Object.defineProperty(event, 'bridgeClient', { value: client, enumerable: false });
  return event as IpcMainInvokeEvent;
}

function createBridgeStubWebContents(client: BrowserBridgeClient): WebContents {
  const stub: Partial<WebContents> = {
    id: -client.id,
    send: (channel: string, ...args: unknown[]) => {
      browserBridgeSend(client, { type: 'event', channel, args });
    },
    isDestroyed: () => client.socket.readyState !== WebSocket.OPEN
  };
  return stub as WebContents;
}

function attachBrowserBridge(wc: WebContents | null | undefined): void {
  if (!wc) return;
  const anyWc = wc as unknown as { [key: symbol]: typeof wc.send };
  if (anyWc[BROWSER_BRIDGE_SEND_SYMBOL]) return;
  const originalSend = wc.send.bind(wc);
  anyWc[BROWSER_BRIDGE_SEND_SYMBOL] = originalSend;
  wc.send = ((channel: string, ...args: unknown[]) => {
    broadcastBrowserEvent(channel, args);
    return originalSend(channel, ...args);
  }) as typeof wc.send;
  wc.once('destroyed', () => {
    const saved = anyWc[BROWSER_BRIDGE_SEND_SYMBOL];
    if (saved) {
      wc.send = saved;
      delete anyWc[BROWSER_BRIDGE_SEND_SYMBOL];
    }
  });
}


function mimeTypeFor(ext: string): string {
  return BROWSER_SERVER_MIME[ext] ?? 'application/octet-stream';
}

function resolveMobileStaticFile(subPath: string): { filePath: string; mime: string } | null {
  let cleanSub = subPath.replace(/^\/+/, '');
  if (!cleanSub || cleanSub === 'mobile' || cleanSub === 'mobile/') cleanSub = 'index.html';
  if (cleanSub.startsWith('mobile/')) cleanSub = cleanSub.slice('mobile/'.length);
  if (!cleanSub) cleanSub = 'index.html';

  const candidates = [
    join(app.getAppPath(), 'src/mobile', cleanSub),
    join(process.cwd(), 'src/mobile', cleanSub),
    join(__dirname, '../../src/mobile', cleanSub),
    join(__dirname, '../renderer/mobile', cleanSub),
    join(__dirname, '../mobile', cleanSub)
  ];

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return { filePath: candidate, mime: mimeTypeFor(extname(candidate)) };
      }
    } catch { /* ignore */ }
  }
  return null;
}

function readJsonBody<T = any>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data.trim()) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

// Counts newlines in a file, stopping early once `threshold` is reached so a
// huge file never costs a full scan. Files above `maxBytes` are treated as
// "at least threshold" without reading — the delegation guard only cares
// whether a Read is large enough to redirect to edgentic.
function countLinesAtLeast(filePath: string, threshold: number, maxBytes = 5_000_000): number {
  const size = statSync(filePath).size;
  if (size > maxBytes) return threshold;
  const buf = readFileSync(filePath);
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      count++;
      if (count >= threshold) return count;
    }
  }
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) count++;
  return count;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmpPath, filePath);
}

function isMobileAuthed(req: IncomingMessage, url?: URL): boolean {
  const secret = ensureMobileApiSecret();
  if (!secret) return false;

  let token = '';
  if (url && url.searchParams.has('token')) {
    token = (url.searchParams.get('token') ?? '').trim();
  }
  if (!token) {
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      token = match ? match[1].trim() : authHeader.trim();
    }
  }
  if (!token && typeof req.headers['x-hive-secret'] === 'string') {
    token = (req.headers['x-hive-secret'] as string).trim();
  }

  if (!token) return false;

  const expectedBuf = Buffer.from(secret, 'utf8');
  const tokenBuf = Buffer.from(token, 'utf8');
  if (expectedBuf.length !== tokenBuf.length) {
    return false;
  }
  try {
    return timingSafeEqual(expectedBuf, tokenBuf);
  } catch {
    return false;
  }
}

function buildFleetPayload(hiveRoot: string | null) {
  let fleetData: { ts?: number; agents?: any[] } = { ts: Date.now(), agents: [] };
  if (hiveRoot && existsSync(join(hiveRoot, 'fleet.json'))) {
    try {
      fleetData = JSON.parse(readFileSync(join(hiveRoot, 'fleet.json'), 'utf8'));
    } catch {
      fleetData = { ts: Date.now(), agents: [] };
    }
  }
  const agents = Array.isArray(fleetData.agents) ? fleetData.agents : [];
  const activeCount = agents.filter((a) => !a.onHold && !a.archived).length;
  const totalUsd = agents.reduce((sum, a) => sum + (typeof a.usd === 'number' ? a.usd : 0), 0);
  return {
    ts: typeof fleetData.ts === 'number' ? fleetData.ts : Date.now(),
    agents,
    totals: {
      activeCount,
      totalUsd: Number(totalUsd.toFixed(4))
    }
  };
}

function buildBoardPayload(hiveRoot: string | null) {
  let content = '';
  let updatedAt = new Date().toISOString();
  if (hiveRoot && existsSync(join(hiveRoot, 'board.md'))) {
    try {
      const p = join(hiveRoot, 'board.md');
      content = readFileSync(p, 'utf8');
      updatedAt = statSync(p).mtime.toISOString();
    } catch {
      content = '';
    }
  }
  return {
    ok: true,
    content,
    updatedAt
  };
}

function buildTasksPayload(hiveRoot: string | null, statusParam?: string | null) {
  let tasks: any[] = [];
  if (hiveRoot && existsSync(join(hiveRoot, 'tasks.json'))) {
    try {
      const raw = JSON.parse(readFileSync(join(hiveRoot, 'tasks.json'), 'utf8'));
      if (Array.isArray(raw.tasks)) tasks = raw.tasks;
    } catch {
      tasks = [];
    }
  }
  if (statusParam) {
    const allowed = new Set(statusParam.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    if (allowed.size > 0) {
      tasks = tasks.filter((t) => t && typeof t.status === 'string' && allowed.has(t.status.toLowerCase()));
    }
  }
  return { tasks };
}

function buildAskMePayload(hiveRoot: string | null) {
  let tasks: any[] = [];
  if (hiveRoot && existsSync(join(hiveRoot, 'tasks.json'))) {
    try {
      const raw = JSON.parse(readFileSync(join(hiveRoot, 'tasks.json'), 'utf8'));
      if (Array.isArray(raw.tasks)) tasks = raw.tasks;
    } catch {
      tasks = [];
    }
  }
  const items: Array<{
    type: 'task_qa';
    taskId: string;
    taskTitle: string;
    assignee: string | null;
    index: number;
    question: string;
    priority: 'urgent' | 'normal' | 'backlog';
    askedAt: string | null;
  }> = [];

  for (const task of tasks) {
    if (task && Array.isArray(task.humanQA)) {
      const taskPriority: 'urgent' | 'normal' | 'backlog' =
        (task.priority === 1 || task.priority === 'urgent' || task.isUrgent) ? 'urgent' :
        (task.priority === 3 || task.priority === 'backlog') ? 'backlog' : 'normal';

      task.humanQA.forEach((qa: any, index: number) => {
        if (qa && typeof qa === 'object' && (qa.a === undefined || qa.a === null || qa.a === '')) {
          const itemPriority = qa.priority === 'urgent' ? 'urgent' : qa.priority === 'backlog' ? 'backlog' : taskPriority;
          items.push({
            type: 'task_qa',
            taskId: task.id ?? '',
            taskTitle: task.title ?? '',
            assignee: task.assignee ?? null,
            index,
            question: qa.q ?? '',
            priority: itemPriority,
            askedAt: qa.askedAt ?? null
          });
        }
      });
    }
  }
  return {
    unresolvedCount: items.length,
    items
  };
}

const sseClients = new Set<ServerResponse>();
let sseWatching = false;

function broadcastSse(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}

function updateSseWatchers(): void {
  const hiveRoot = hive.root() ?? (resolveHarnessHome() ? join(resolveHarnessHome()!, 'hive') : null);
  if (!hiveRoot) return;

  const fleetPath = join(hiveRoot, 'fleet.json');
  const tasksPath = join(hiveRoot, 'tasks.json');
  const boardPath = join(hiveRoot, 'board.md');

  if (sseClients.size > 0 && !sseWatching) {
    sseWatching = true;
    try {
      watchFile(fleetPath, { interval: 2000 }, () => {
        broadcastSse('fleet', buildFleetPayload(hiveRoot));
      });
    } catch {}
    try {
      watchFile(tasksPath, { interval: 2000 }, () => {
        broadcastSse('tasks', buildTasksPayload(hiveRoot));
        broadcastSse('ask_me', buildAskMePayload(hiveRoot));
      });
    } catch {}
    try {
      watchFile(boardPath, { interval: 5000 }, () => {
        broadcastSse('board', buildBoardPayload(hiveRoot));
      });
    } catch {}
  } else if (sseClients.size === 0 && sseWatching) {
    sseWatching = false;
    try { unwatchFile(fleetPath); } catch {}
    try { unwatchFile(tasksPath); } catch {}
    try { unwatchFile(boardPath); } catch {}
  }
}

// Claude Code PreToolUse hook endpoint. Receives { tool_name, tool_input,
// session_id } and returns an allow/block decision that routes edgentic
// delegation guards through TheHive instead of a WSL bash shell. Fails open:
// a malformed payload or unexpected error never blocks Claude Code.
async function handleHookRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== '/hooks/pre-tool') return false;

  const method = req.method?.toUpperCase() ?? 'GET';
  if (method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return true;
  }

  const startTs = Date.now();

  const respond = (decision: 'allow' | 'block', reason?: string, toolName?: string, fileOrArg?: string): true => {
    const hookSpecificOutput: Record<string, unknown> = {
      hookEventName: 'PreToolUse',
      permissionDecision: decision
    };
    if (reason) hookSpecificOutput.permissionDecisionReason = reason;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ hookSpecificOutput }));

    if (toolName) {
      const durationMs = Date.now() - startTs;
      const logDecision: 'delegated' | 'allowed' | 'blocked' =
        decision === 'block' ? 'delegated' : 'allowed';
      const truncatedFileOrArg = fileOrArg ? fileOrArg.slice(0, 80) : '';

      recordDelegationEntry({
        ts: Date.now(),
        tool: toolName,
        fileOrArg: truncatedFileOrArg,
        decision: logDecision,
        durationMs,
        resultSnippet: reason?.slice(0, 200)
      });
    }

    return true;
  };

  let body: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    body = await readJsonBody(req);
  } catch {
    return respond('allow');
  }

  const toolName = typeof body?.tool_name === 'string' ? body.tool_name : '';
  const toolInput = (body?.tool_input && typeof body.tool_input === 'object')
    ? (body.tool_input as Record<string, unknown>)
    : {};

  try {
    // Read of a large file -> redirect to edgentic-find. Bounded reads
    // (offset/limit) are exempt: those already avoid pulling the whole file.
    if (toolName === 'Read') {
      const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
      const bounded = toolInput.offset != null || toolInput.limit != null;
      if (filePath && !bounded && existsSync(filePath) && statSync(filePath).isFile()) {
        if (countLinesAtLeast(filePath, 350) >= 350) {
          return respond('block', `Redirect to edgentic: edgentic-find "your question" ${filePath}`, toolName, filePath);
        }
      }
      return respond('allow', undefined, toolName, filePath);
    }

    // Bash/Grep pulling context blocks (-A/-B/-C) -> redirect to edgentic-run.
    if (toolName === 'Bash' || toolName === 'Grep') {
      const text = [
        typeof toolInput.command === 'string' ? toolInput.command : '',
        typeof toolInput.pattern === 'string' ? toolInput.pattern : ''
      ].join(' ');
      if (/(?:^|\s)-[ABC](?:$|\s|=|\d)/.test(text)) {
        return respond('block', 'Redirect to edgentic: edgentic-run -- <cmd>', toolName, text);
      }
      return respond('allow', undefined, toolName, text);
    }
  } catch (err) {
    console.error('[hook] pre-tool guard error:', err);
    return respond('allow', undefined, toolName);
  }

  return respond('allow', undefined, toolName);
}

async function handleMobileApiRequest(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
  if (!pathname.startsWith('/api/')) return false;

  if (!isMobileAuthed(req, url)) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return true;
  }

  const method = req.method?.toUpperCase() ?? 'GET';
  const hiveRoot = hive.root() ?? (resolveHarnessHome() ? join(resolveHarnessHome()!, 'hive') : null);

  // GET /api/events (SSE Stream)
  if (pathname === '/api/events') {
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    sseClients.add(res);
    updateSseWatchers();

    // Send keepalive comment every 15s
    const keepaliveTimer = setInterval(() => {
      try {
        res.write(':\n\n');
      } catch {
        clearInterval(keepaliveTimer);
      }
    }, 15_000);

    // Immediately push initial state
    res.write(`event: fleet\ndata: ${JSON.stringify(buildFleetPayload(hiveRoot))}\n\n`);
    res.write(`event: tasks\ndata: ${JSON.stringify(buildTasksPayload(hiveRoot))}\n\n`);
    res.write(`event: board\ndata: ${JSON.stringify(buildBoardPayload(hiveRoot))}\n\n`);
    res.write(`event: ask_me\ndata: ${JSON.stringify(buildAskMePayload(hiveRoot))}\n\n`);

    res.on('close', () => {
      clearInterval(keepaliveTimer);
      sseClients.delete(res);
      updateSseWatchers();
    });

    return true;
  }

  // GET /api/health
  if (pathname === '/api/health') {
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    const uptimeSec = Math.floor(process.uptime());
    const payload = {
      ok: true,
      machine: hostname(),
      version: app.getVersion(),
      uptimeSec,
      hiveRoot: resolveHarnessHome()
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return true;
  }

  // GET /api/fleet
  if (pathname === '/api/fleet') {
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    const payload = buildFleetPayload(hiveRoot);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return true;
  }

  // GET /api/board
  if (pathname === '/api/board') {
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    const payload = buildBoardPayload(hiveRoot);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return true;
  }

  // GET /api/settings — governor + budget + KB config for the mobile settings screen
  if (pathname === '/api/settings' && method === 'GET') {
    const cfg = readConfig();
    const profiles = listRuntimeProfiles().map((p) => ({ id: p.id, name: p.name, model: p.model ?? null }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      costCapTokens: cfg.costCapTokens ?? null,
      knowledgeBaseSources: resolveKnowledgeBaseSources(cfg),
      // Legacy single-folder field, still sent so an older mobile build keeps working.
      knowledgeBasePath: cfg.knowledgeBasePath ?? '',
      governorOverride: cfg.governorPolicy?.manualOverride === 'force-green',
      defaultModel: cfg.defaultModel ?? null,
      profiles
    }));
    return true;
  }

  // POST /api/settings — patch a small, safe subset of config from mobile
  if (pathname === '/api/settings' && method === 'POST') {
    let sBody: { costCapTokens?: number; knowledgeBasePath?: string; knowledgeBaseSources?: unknown; governorOverride?: boolean; defaultModel?: string };
    try {
      sBody = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      return true;
    }
    const patch: Partial<HarnessConfig> = {};
    if (typeof sBody.costCapTokens === 'number' && Number.isFinite(sBody.costCapTokens) && sBody.costCapTokens >= 0) {
      patch.costCapTokens = Math.round(sBody.costCapTokens);
    }
    if (typeof sBody.knowledgeBasePath === 'string') patch.knowledgeBasePath = sBody.knowledgeBasePath.trim();
    if (Array.isArray(sBody.knowledgeBaseSources)) {
      patch.knowledgeBaseSources = (sBody.knowledgeBaseSources as unknown[])
        .filter((s): s is KnowledgeBaseSource =>
          !!s && typeof s === 'object'
          && ((s as KnowledgeBaseSource).type === 'folder' || (s as KnowledgeBaseSource).type === 'outline-mcp' || (s as KnowledgeBaseSource).type === 'custom-mcp')
          && typeof (s as KnowledgeBaseSource).value === 'string')
        .map((s) => ({ type: s.type, value: s.value.trim() }));
    }
    if (typeof sBody.defaultModel === 'string' && sBody.defaultModel.trim()) patch.defaultModel = sBody.defaultModel.trim();
    if (Object.keys(patch).length) writeConfig(patch);
    if (typeof sBody.governorOverride === 'boolean') applyGovernorOverride(sBody.governorOverride ? 'force-green' : undefined);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // GET /api/missions — scheduled auto-dispatch missions (the mobile Schedules tab)
  if (pathname === '/api/missions' && method === 'GET') {
    const now = Date.now();
    const missions = (readConfig().missions ?? []).map((m) => {
      const weekly = normalizeWeekly(m.weekly);
      const nextFireAt = weekly
        ? nextWeeklyFireMs(weekly, now)
        : m.lastFiredAt ? m.lastFiredAt + m.intervalMs : null;
      const whenLabel = m.kind === 'heartbeat'
        ? 'adaptive beat'
        : weekly ? formatWeekly(weekly) : fmtMissionInterval(m.intervalMs);
      return {
        id: m.id, label: m.label, to: m.to, body: m.body,
        enabled: !!m.enabled, kind: m.kind ?? 'dispatch',
        lastFiredAt: m.lastFiredAt ?? null, whenLabel, nextFireAt
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, missions }));
    return true;
  }

  // POST /api/missions/:id/toggle — flip (or set) a mission's enabled flag
  const missionToggleMatch = /^\/api\/missions\/([^/]+)\/toggle\/?$/.exec(pathname);
  if (missionToggleMatch && method === 'POST') {
    const id = decodeURIComponent(missionToggleMatch[1]);
    let tBody: { enabled?: boolean } = {};
    try { tBody = await readJsonBody(req); } catch { /* empty body ⇒ flip */ }
    const current = readConfig().missions ?? [];
    const target = current.find((m) => m.id === id);
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'No such mission' }));
      return true;
    }
    const next = typeof tBody.enabled === 'boolean' ? tBody.enabled : !target.enabled;
    writeConfig({ missions: current.map((m) => (m.id === id ? { ...m, enabled: next } : m)) });
    syncMissions();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, id, enabled: next }));
    return true;
  }

  // POST /api/missions — create a new interval-based scheduled mission
  if (pathname === '/api/missions' && method === 'POST') {
    let cBody: { label?: string; to?: string; intervalMs?: number; body?: string };
    try {
      cBody = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      return true;
    }
    const label = typeof cBody.label === 'string' ? cBody.label.trim() : '';
    const body = typeof cBody.body === 'string' ? cBody.body.trim() : '';
    const to = typeof cBody.to === 'string' && cBody.to.trim() ? cBody.to.trim() : 'god';
    const intervalMs = typeof cBody.intervalMs === 'number' && Number.isFinite(cBody.intervalMs) && cBody.intervalMs >= 60_000
      ? Math.round(cBody.intervalMs)
      : 3_600_000;
    if (!label || !body) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'label and body are required' }));
      return true;
    }
    const mission: ScheduledMission = {
      id: `m_${Date.now().toString(36)}`, label, intervalMs, to, body, enabled: true
    };
    writeConfig({ missions: [...(readConfig().missions ?? []), mission] });
    syncMissions();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, id: mission.id }));
    return true;
  }

  // GET /api/tasks
  if (pathname === '/api/tasks') {
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    const statusParam = url.searchParams.get('status');
    const payload = buildTasksPayload(hiveRoot, statusParam);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return true;
  }

  // GET /api/ask-me
  if (pathname === '/api/ask-me') {
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    const payload = buildAskMePayload(hiveRoot);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return true;
  }

  // POST /api/tasks/:id/qa/:index/answer
  const qaAnswerMatch = /^\/api\/tasks\/([^/]+)\/qa\/(\d+)\/answer\/?$/.exec(pathname);
  if (qaAnswerMatch) {
    if (method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    const taskId = decodeURIComponent(qaAnswerMatch[1]);
    const qaIndex = parseInt(qaAnswerMatch[2], 10);
    let body: { answer?: string };
    try {
      body = await readJsonBody<{ answer?: string }>(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      return true;
    }

    const answer = typeof body?.answer === 'string' ? body.answer.trim() : '';
    if (!answer) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Missing answer in request body' }));
      return true;
    }

    if (!hiveRoot || !existsSync(join(hiveRoot, 'tasks.json'))) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'tasks.json not found' }));
      return true;
    }

    const tasksFilePath = join(hiveRoot, 'tasks.json');
    let tasksJson: { tasks?: any[] };
    try {
      tasksJson = JSON.parse(readFileSync(tasksFilePath, 'utf8'));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Failed to read tasks.json' }));
      return true;
    }

    const tasks = Array.isArray(tasksJson.tasks) ? tasksJson.tasks : [];
    const task = tasks.find((t) => t && t.id === taskId);
    if (!task || !Array.isArray(task.humanQA) || !task.humanQA[qaIndex]) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Task or humanQA index not found' }));
      return true;
    }

    const qaItem = task.humanQA[qaIndex];
    qaItem.a = answer;
    qaItem.answeredAt = new Date().toISOString();

    try {
      atomicWriteJson(tasksFilePath, tasksJson);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Failed to save tasks.json' }));
      return true;
    }

    // Write inform message to god's inbox
    const nowIso = new Date().toISOString();
    const safeTimestamp = nowIso.replace(/[:.]/g, '-');
    const godInboxDir = join(hiveRoot, 'agents', 'god', 'inbox');
    const msgId = `${safeTimestamp}-qa-answered`;
    const informMessage = {
      id: msgId,
      from: 'human',
      to: 'god',
      act: 'inform',
      subject: `HUMAN ANSWER on task "${task.title || taskId}"`,
      body: `Q: ${qaItem.q || ''}\nA: ${answer}`,
      hops: 0,
      requires_reply: false,
      needs_human: false,
      created_at: nowIso
    };
    try {
      atomicWriteJson(join(godInboxDir, `${msgId}.json`), informMessage);
    } catch {
      // Best-effort inbox inform
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, taskId, index: qaIndex }));
    return true;
  }

  // POST /api/messages/send
  if (pathname === '/api/messages/send') {
    if (method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    let body: { to?: string; act?: string; subject?: string; body?: string; priority?: string };
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      return true;
    }

    const to = typeof body?.to === 'string' ? body.to.trim() : '';
    const messageBody = typeof body?.body === 'string' ? body.body : '';
    const act = typeof body?.act === 'string' && body.act.trim() ? body.act.trim() : 'inform';
    const subject = typeof body?.subject === 'string' && body.subject.trim() ? body.subject.trim() : 'Message from human';
    const priority = body?.priority === 'urgent' || body?.priority === 'backlog' || body?.priority === 'normal'
      ? body.priority
      : 'normal';

    if (!to) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Missing "to" field in request body' }));
      return true;
    }

    if (!hiveRoot) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Hive root not resolved' }));
      return true;
    }

    const nowIso = new Date().toISOString();
    const safeTimestamp = nowIso.replace(/[:.]/g, '-');
    const shortId = randomBytes(4).toString('hex');
    const messageId = `${safeTimestamp}-${shortId}`;

    // Route through god's inbox so the Overmind sees every mobile dispatch
    // and can add context before forwarding. If the message is already for god,
    // it lands there directly. The `to` field preserves the intended recipient.
    const routeTarget = to === 'god' ? 'god' : 'god';
    const routeSubject = to === 'god' ? subject : `Task from the human (for ${to}): ${subject}`;
    const inboxDir = join(hiveRoot, 'agents', routeTarget, 'inbox');

    const messagePayload = {
      id: messageId,
      from: 'human',
      to,
      act,
      subject: routeSubject,
      body: messageBody,
      priority,
      hops: 0,
      requires_reply: false,
      needs_human: false,
      created_at: nowIso
    };

    try {
      atomicWriteJson(join(inboxDir, `${messageId}.json`), messagePayload);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Failed to write message to inbox' }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, messageId, routedTo: to }));
    return true;
  }

  // PATCH /api/tasks/:id
  const taskPatchMatch = /^\/api\/tasks\/([^/]+)\/?$/.exec(pathname);
  if (taskPatchMatch) {
    if (method !== 'PATCH') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    const taskId = decodeURIComponent(taskPatchMatch[1]);
    let patch: Record<string, unknown>;
    try {
      patch = await readJsonBody<Record<string, unknown>>(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      return true;
    }

    if (!hiveRoot || !existsSync(join(hiveRoot, 'tasks.json'))) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'tasks.json not found' }));
      return true;
    }

    const tasksFilePath = join(hiveRoot, 'tasks.json');
    let tasksJson: { tasks?: any[] };
    try {
      tasksJson = JSON.parse(readFileSync(tasksFilePath, 'utf8'));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Failed to read tasks.json' }));
      return true;
    }

    const tasks = Array.isArray(tasksJson.tasks) ? tasksJson.tasks : [];
    const taskIndex = tasks.findIndex((t) => t && t.id === taskId);
    if (taskIndex === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Task not found' }));
      return true;
    }

    if (typeof patch.progress === 'number') {
      patch.progress = Math.max(0, Math.min(100, Math.round(patch.progress)));
    }

    tasks[taskIndex] = {
      ...tasks[taskIndex],
      ...patch,
      id: taskId,
      updatedAt: new Date().toISOString()
    };

    try {
      atomicWriteJson(tasksFilePath, tasksJson);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Failed to save tasks.json' }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, taskId }));
    return true;
  }

  // POST /api/agents/spawn
  if (pathname === '/api/agents/spawn') {
    if (method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    let body: {
      name?: string;
      objective?: string;
      cwd?: string;
      provider?: AgentProvider;
      model?: string;
      profile?: string;
      isolate?: boolean;
      character?: string;
      accent?: string;
    };
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      return true;
    }

    if (!hiveRoot) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Hive root not resolved' }));
      return true;
    }

    const name = typeof body?.name === 'string' ? body.name.trim() : 'worker';
    const objective = typeof body?.objective === 'string' ? body.objective.trim() : '';
    const cwd = typeof body?.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : (resolveHarnessHome() || process.cwd());

    const nowIso = new Date().toISOString();
    const safeTimestamp = nowIso.replace(/[:.]/g, '-');
    const cleanName = (name || 'worker').replace(/[^a-zA-Z0-9_-]/g, '_');
    const requestId = `${safeTimestamp}-${cleanName}`;

    const spawnDir = join(hiveRoot, 'spawn-requests');
    mkdirSync(spawnDir, { recursive: true });

    const spawnReq: SpawnRequest = {
      id: requestId,
      name,
      objective,
      cwd,
      provider: body?.provider,
      model: body?.model,
      profile: typeof body?.profile === 'string' && body.profile.trim() ? body.profile.trim() : undefined,
      isolate: body?.isolate !== false,
      character: body?.character,
      accent: body?.accent
    };

    try {
      atomicWriteJson(join(spawnDir, `${requestId}.json`), spawnReq);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Failed to write spawn-request' }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, requestId, status: 'queued' }));
    return true;
  }

  // POST /api/agents/:id/stop
  const stopMatch = /^\/api\/agents\/([^/]+)\/stop\/?$/.exec(pathname);
  if (stopMatch) {
    if (method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    const agentId = decodeURIComponent(stopMatch[1]);
    let body: { reason?: string; force?: boolean };
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }

    if (!hiveRoot) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Hive root not resolved' }));
      return true;
    }

    const nowIso = new Date().toISOString();
    const safeTimestamp = nowIso.replace(/[:.]/g, '-');
    const stopMsgId = `${safeTimestamp}-stop`;
    const inboxDir = join(hiveRoot, 'agents', agentId, 'inbox');

    const stopPayload = {
      id: stopMsgId,
      from: 'human',
      to: agentId,
      act: 'stop',
      subject: 'Stop requested from mobile',
      body: body?.reason || 'Stopped from Android',
      hops: 0,
      requires_reply: false,
      needs_human: false,
      created_at: nowIso
    };

    try {
      atomicWriteJson(join(inboxDir, `${stopMsgId}.json`), stopPayload);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Failed to write stop message to inbox' }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, agentId, status: 'stop-requested' }));
    return true;
  }

  // GET /api/workers/:id/tail
  const workerTailMatch = /^\/api\/workers\/([^/]+)\/tail\/?$/.exec(pathname);
  if (workerTailMatch) {
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    const agentId = decodeURIComponent(workerTailMatch[1]);
    const tail = getWorkerPtyTail(agentId);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, agentId, tail }));
    return true;
  }

  // GET /api/workers
  if (pathname === '/api/workers' || pathname === '/api/workers/') {
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    const cfg = readConfig();
    const defaultCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
      ? cfg.defaultWorkerTokenCap : 0;
    const now = Date.now();
    const live = [...liveWorkers.values()].map((rec) => {
      const idle = ptyManager.idleFor(rec.workerId);
      const effCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : (defaultCap > 0 ? defaultCap : 0);
      const tail = getWorkerPtyTail(rec.workerId);
      const isWorking = idle !== undefined && idle < 3000;
      return {
        workerId: rec.workerId,
        reqId: rec.reqId,
        name: rec.name ?? rec.workerId,
        baseBranch: rec.baseBranch,
        cwd: rec.cwd,
        objective: rec.objective,
        spawnedAt: rec.spawnedAt,
        ageMs: Math.max(0, now - rec.spawnedAt),
        idleMs: idle === undefined ? null : idle,
        tokensUsed: workerTokensUsed(rec.workerId),
        tokenCap: effCap > 0 ? effCap : null,
        hasSlack: !!rec.slack,
        releasing: !!rec.releasing,
        status: rec.releasing ? 'releasing' : (isWorking ? 'working' : 'idle'),
        tailPreview: tail.slice(-5)
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, live, recent: recentWorkers, maxWorkers: Math.max(1, cfg.maxConcurrentWorkers ?? 4) }));
    return true;
  }

  // GET /api/processes
  if (pathname === '/api/processes' || pathname === '/api/processes/') {
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    const now = Date.now();
    const processes = [...trackedProcesses.entries()].map(([id, p]) => ({
      processId: id,
      pid: p.pid,
      label: p.label,
      cwd: p.cwd,
      shell: p.shell,
      status: p.status,
      exitCode: p.exitCode,
      startedAt: p.startedAt,
      uptimeMs: p.status === 'running' ? Math.max(0, now - p.startedAt) : 0
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, processes }));
    return true;
  }

  // POST /api/processes
  if (pathname === '/api/processes' || pathname === '/api/processes/') {
    if (method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    let body: ProcessSpawnOptions;
    try {
      body = await readJsonBody<ProcessSpawnOptions>(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      return true;
    }

    const { cmd, args = [], cwd, label, shell } = body;
    if (!cmd || !cwd || !shell) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Missing required fields: cmd, cwd, shell' }));
      return true;
    }

    if (hasShellMetachars(cwd) || hasShellMetachars(cmd)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Path or command contains shell metacharacters' }));
      return true;
    }
    if (args.some(hasShellMetachars)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Arguments contain shell metacharacters' }));
      return true;
    }

    const processId = `proc-${++processIdSeq}`;
    const now = Date.now();

    try {
      let spawnCmd: string;
      let spawnArgs: string[];
      let spawnOpts: { cwd: string; shell: boolean };

      if (shell === 'wsl-bash') {
        const wslPath = convertToWslPath(cwd);
        spawnCmd = 'wsl.exe';
        spawnArgs = ['-d', 'Ubuntu', '--cd', wslPath, '--', 'bash'];
        spawnOpts = { cwd, shell: false };
      } else if (shell === 'powershell') {
        spawnCmd = 'powershell.exe';
        spawnArgs = ['-NoProfile', '-NoLogo', '-NonInteractive'];
        spawnOpts = { cwd, shell: false };
      } else if (shell === 'cmd') {
        spawnCmd = 'cmd.exe';
        spawnArgs = ['/Q'];
        spawnOpts = { cwd, shell: false };
      } else {
        spawnCmd = cmd;
        spawnArgs = args;
        spawnOpts = { cwd, shell: false };
      }

      const proc = spawn(spawnCmd, spawnArgs, spawnOpts);

      const tracked: TrackedProcess = {
        pid: proc.pid ?? 0,
        label: label || cmd,
        cmd,
        args,
        cwd,
        shell,
        startedAt: now,
        status: 'running'
      };

      trackedProcesses.set(processId, tracked);

      proc.on('exit', (code) => {
        const p = trackedProcesses.get(processId);
        if (p) {
          p.status = 'exited';
          p.exitCode = code ?? undefined;
        }
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, processId, pid: proc.pid }));
      return true;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
      return true;
    }
  }

  // DELETE /api/processes/:id
  const processKillMatch = /^\/api\/processes\/([^/]+)\/?$/.exec(pathname);
  if (processKillMatch && method === 'DELETE') {
    const processId = decodeURIComponent(processKillMatch[1]);
    const proc = trackedProcesses.get(processId);
    if (!proc) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Process not found' }));
      return true;
    }

    try {
      if (proc.status === 'running' && proc.pid) {
        process.kill(proc.pid);
        proc.status = 'exited';
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return true;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
      return true;
    }
  }

  // POST /api/agents/:id/message
  const agentMessageMatch = /^\/api\/agents\/([^/]+)\/message\/?$/.exec(pathname);
  if (agentMessageMatch && method === 'POST') {
    const agentId = decodeURIComponent(agentMessageMatch[1]);
    let body: { text?: string };
    try {
      body = await readJsonBody<{ text?: string }>(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      return true;
    }

    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Message text is required' }));
      return true;
    }

    if (!hiveRoot) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Hive root not resolved' }));
      return true;
    }

    const nowIso = new Date().toISOString();
    const safeTimestamp = nowIso.replace(/[:.]/g, '-');
    const msgId = `${safeTimestamp}-mobile-msg`;
    const inboxDir = join(hiveRoot, 'agents', agentId, 'inbox');

    const msgPayload = {
      id: msgId,
      from: 'human',
      to: agentId,
      act: 'message',
      subject: 'Message from mobile',
      body: text,
      hops: 0,
      requires_reply: false,
      needs_human: false,
      created_at: nowIso
    };

    try {
      atomicWriteJson(join(inboxDir, `${msgId}.json`), msgPayload);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Failed to write message to inbox' }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, messageId: msgId }));
    return true;
  }

  // POST /api/agents/:id/respawn — archive the session and start fresh from memory.md
  const respawnMatch = /^\/api\/agents\/([^/]+)\/respawn\/?$/.exec(pathname);
  if (respawnMatch && method === 'POST') {
    const agentId = decodeURIComponent(respawnMatch[1]);
    let result: { ok: boolean; error?: string };
    try {
      result = await respawnAgentById(agentId);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.ok ? { ok: true, agentId, status: 'respawn-requested' } : { error: result.error || 'respawn failed' }));
    return true;
  }

  // POST /api/agents/:id/input — write raw keystrokes straight to the agent's PTY
  const inputMatch = /^\/api\/agents\/([^/]+)\/input\/?$/.exec(pathname);
  if (inputMatch && method === 'POST') {
    const agentId = decodeURIComponent(inputMatch[1]);
    let inBody: { data?: string };
    try {
      inBody = await readJsonBody<{ data?: string }>(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      return true;
    }
    const data = typeof inBody?.data === 'string' ? inBody.data : '';
    if (!data) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'input data is required' }));
      return true;
    }
    const ptyId = ptyForAgent(agentId);
    if (!ptyId) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'agent has no live terminal' }));
      return true;
    }
    const wrote = ptyManager.write(ptyId, data);
    res.writeHead(wrote.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(wrote.ok ? { ok: true } : { error: wrote.error || 'write failed' }));
    return true;
  }

  // GET /api/agents/:id/pty-stream (SSE)
  const agentPtyStreamMatch = /^\/api\/agents\/([^/]+)\/pty-stream\/?$/.exec(pathname);
  if (agentPtyStreamMatch && method === 'GET') {
    const agentId = decodeURIComponent(agentPtyStreamMatch[1]);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const tail = getWorkerPtyTail(agentId);
    tail.forEach(line => {
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    });

    const keepaliveTimer = setInterval(() => {
      try {
        res.write(':\n\n');
      } catch {
        clearInterval(keepaliveTimer);
      }
    }, 15_000);

    const updateTimer = setInterval(() => {
      try {
        const currentTail = getWorkerPtyTail(agentId);
        if (currentTail.length > 0) {
          const lastLine = currentTail[currentTail.length - 1];
          res.write(`data: ${JSON.stringify({ line: lastLine })}\n\n`);
        }
      } catch {
        clearInterval(updateTimer);
        clearInterval(keepaliveTimer);
      }
    }, 2000);

    res.on('close', () => {
      clearInterval(keepaliveTimer);
      clearInterval(updateTimer);
    });

    return true;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not Found' }));
  return true;
}

function ensureBrowserServer(): Promise<string> {
  if (browserServerStart) return browserServerStart;

  browserServerStart = new Promise<string>((resolve, reject) => {
    if (!existsSync(BROWSER_SERVER_ROOT)) {
      const err = new Error(`Renderer assets not found at ${BROWSER_SERVER_ROOT}`);
      browserServerStart = null;
      reject(err);
      return;
    }

    const server = createHttpServer((req, res) => {
      if (!req.url) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }

      let url: URL;
      try {
        url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${BROWSER_SERVER_PORT}`}`);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }

      const pathname = decodeURIComponent(url.pathname);

      // Handle unauthenticated Mobile PWA static files (/mobile, /mobile/manifest.json, /mobile/sw.js, etc.)
      if (pathname === '/mobile' || pathname === '/mobile/' || pathname.startsWith('/mobile/')) {
        const method = req.method?.toUpperCase() ?? 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Method Not Allowed');
          return;
        }

        const subPath = pathname === '/mobile' || pathname === '/mobile/' ? 'index.html' : pathname.replace(/^\/mobile\/?/, '');

        // In dev, serve a passthrough SW that clears all caches so edits to
        // src/mobile/index.html are visible on the phone without a cache wipe.
        if (!app.isPackaged && subPath === 'sw.js') {
          const devSw = Buffer.from([
            "self.addEventListener('install', () => self.skipWaiting());",
            "self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))).then(() => self.clients.claim())));",
            "self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));"
          ].join('\n'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store', 'Content-Length': devSw.byteLength });
          if (method === 'HEAD') res.end();
          else res.end(devSw);
          return;
        }

        const resolved = resolveMobileStaticFile(subPath);
        if (resolved) {
          try {
            const content = readFileSync(resolved.filePath);
            res.writeHead(200, {
              'Content-Type': resolved.mime,
              'Cache-Control': 'no-cache',
              'Content-Length': content.byteLength
            });
            if (method === 'HEAD') res.end();
            else res.end(content);
            return;
          } catch (err) {
            console.error('[mobile-pwa] error reading static file:', resolved.filePath, err);
          }
        }

        // Fallback placeholder if index.html is missing
        if (subPath === 'index.html') {
          const placeholder = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TheHive Remote</title></head><body style="background:#121214;color:#f0f0f0;font-family:sans-serif;padding:32px;text-align:center;"><h2>TheHive Remote</h2><p>Mobile API ready. PWA loading...</p></body></html>';
          const buf = Buffer.from(placeholder, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.byteLength, 'Cache-Control': 'no-cache' });
          if (method === 'HEAD') res.end();
          else res.end(buf);
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      // Handle unauthenticated Claude Code PreToolUse hook endpoint
      if (pathname === '/hooks/pre-tool') {
        void handleHookRequest(req, res, pathname);
        return;
      }

      // Handle authenticated Mobile API endpoints
      if (pathname.startsWith('/api/')) {
        void handleMobileApiRequest(req, res, pathname, url);
        return;
      }

      const method = req.method?.toUpperCase() ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }

      let filePath = join(BROWSER_SERVER_ROOT, pathname === '/' ? 'index.html' : pathname);
      if (!filePath.startsWith(BROWSER_SERVER_ROOT)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      const hasExtension = extname(pathname) !== '';
      try {
        const stats = statSync(filePath);
        if (stats.isDirectory()) {
          filePath = join(filePath, 'index.html');
        }
      } catch {
        if (!hasExtension) {
          filePath = join(BROWSER_SERVER_ROOT, 'index.html');
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
      }

      let status = 200;
      let contentType = mimeTypeFor(extname(filePath));
      const cacheControl = contentType.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600';

      try {
        if (method === 'HEAD') {
          res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
          res.end();
          return;
        }
        // Inject browser-bridge.js into index.html — Vite strips the <script> tag
        // during build, so we add it back server-side before the page is served.
        if (contentType.startsWith('text/html')) {
          const html = readFileSync(filePath, 'utf8');
          const injected = html.includes('browser-bridge.js')
            ? html
            : html.replace('</head>', '<script type="module" src="/browser-bridge.js"></script></head>');
          const buf = Buffer.from(injected, 'utf8');
          res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': cacheControl, 'Content-Length': buf.byteLength });
          res.end(buf);
          return;
        }
        const stream = createReadStream(filePath);
        stream.once('open', () => {
          res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
        });
        stream.once('error', (err) => {
          console.error('[browser-server] stream error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          }
          res.end('Internal Server Error');
        });
        stream.pipe(res);
      } catch (err) {
        console.error('[browser-server] failed to read', filePath, err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error');
      }
    });

    setupBrowserSocketServer(server);

    const reset = (): void => {
      browserServer = null;
      browserServerUrl = null;
      browserServerStart = null;
      teardownBrowserSocketServer();
    };

    server.once('error', (err) => {
      console.error('[browser-server] failed to start:', err);
      server.close();
      reset();
      reject(err);
    });
    server.once('close', () => {
      reset();
    });

    server.listen(BROWSER_SERVER_PORT, BROWSER_SERVER_HOST, () => {
      const url = `http://127.0.0.1:${BROWSER_SERVER_PORT}/`;
      browserServerUrl = url;
      console.log('[browser-server] serving renderer at', url, `(listening on ${BROWSER_SERVER_HOST})`);
      resolve(url);
    });

    browserServer = server;
  });

  return browserServerStart;
}

async function openRendererInBrowser(): Promise<string> {
  try {
    const url = await ensureBrowserServer();
    await shell.openExternal(url);
    return url;
  } catch (err) {
    console.error('[browser-server] unable to open browser view:', err);
    throw err;
  }
}

// Keep the main process alive on an unexpected throw/rejection. The harness is a
// multi-agent supervisor — a single stray throw (e.g. node-pty's ConPTY console
// helper choking when a fast-exiting agent CLI's console is already gone) must
// NOT take the whole app and every running agent down with it. Log and continue
// rather than letting the default handler exit the process.
// (Restored during the #71 merge — the PR's rebase dropped these handlers.)
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException (kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection (kept alive):', reason);
});

const ptyManager = new PtyManager();

function runCodexDaemonCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolveResult) => {
    let settled = false;
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
    } catch (e) {
      resolveResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let timer: NodeJS.Timeout;
    const finish = (result: { ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk);
    });
    child.once('error', (e) => finish({ ok: false, error: e.message }));
    child.once('exit', (code) => {
      finish(code === 0
        ? { ok: true }
        : { ok: false, error: stderr.trim() || `Codex exited with code ${code ?? 'unknown'}` });
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish({ ok: false, error: `Codex daemon command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });
}

/** Start/enable one managed remote-control daemon for this isolated Codex home,
 * then point the TUI at its app-server socket. Failure is non-fatal: the worker
 * still starts as a normal local Codex session. */
async function enableCodexRemoteForSpawn(
  opts: SpawnOptions & { hive?: AgentMeta },
  agentId: string
): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const realHome = opts.env?.CODEX_HOME;
  if (!realHome) return false;
  try {
    const alias = codexRemoteAliasPath(realHome, agentId);
    // Bail before touching the filesystem if even the short alias would exceed
    // sun_path — the daemon would start and then die on bind, and the warning
    // below names the real reason instead of a generic readiness timeout.
    if (!codexRemoteSocketFits(alias)) {
      console.warn('[codex-remote] socket path exceeds sun_path; starting local TUI:', alias);
      return false;
    }
    const aliasRoot = dirname(alias);
    mkdirSync(aliasRoot, { recursive: true });
    if (existsSync(alias)) {
      const st = lstatSync(alias);
      if (!st.isSymbolicLink() || resolve(dirname(alias), readlinkSync(alias)) !== resolve(realHome)) {
        console.warn('[codex-remote] short home alias is occupied; starting local TUI:', alias);
        return false;
      }
    } else {
      symlinkSync(realHome, alias, 'dir');
    }

    const socket = join(alias, CODEX_REMOTE_SOCKET_RELATIVE);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.env ?? {}),
      CODEX_HOME: alias
    };
    // shellEnv's resolver mirrors PtyManager's (which is private + returns
    // {path, found}); the daemon just needs the best executable path.
    const executable = resolveCliCommand(opts.command);
    const started = await runCodexDaemonCommand(
      executable,
      ['app-server', 'daemon', 'start'],
      env
    );
    if (!started.ok) {
      console.warn('[codex-remote] daemon start failed; starting local TUI:', started.error);
      return false;
    }
    const enabled = await runCodexDaemonCommand(
      executable,
      ['app-server', 'daemon', 'enable-remote-control'],
      env
    );
    if (!enabled.ok) {
      console.warn('[codex-remote] enable failed; starting local TUI:', enabled.error);
      return false;
    }
    if (!existsSync(socket)) {
      console.warn('[codex-remote] daemon returned without a control socket; starting local TUI');
      return false;
    }
    opts.env = { ...(opts.env ?? {}), CODEX_HOME: alias };
    opts.args = withCodexRemoteArgs(opts.args ?? [], codexRemoteEndpoint(alias));
    return true;
  } catch (e) {
    console.warn('[codex-remote] setup failed; starting local TUI:',
      e instanceof Error ? e.message : e);
    return false;
  }
}
/** Live PTY id → its hive agent id, recorded at spawn. The pty:kill handler only
 *  gets the PTY id, so this lets a closed tab archive the right registry agent. */
const ptyToAgent = new Map<string, string>();
/** Rate-limit timestamps for fleet.json writes triggered by PTY activity. */
const lastFleetWriteMs = new Map<string, number>();
/** Epoch ms of the latest PTY stdout activity per agent. */
const lastAgentPtyActivityMs = new Map<string, number>();
/** Latest tool detected from PTY stdout or hooks per agent. */
const lastAgentTool = new Map<string, string>();
/** Derived working/idle status per agent. */
const lastAgentStatus = new Map<string, 'working' | 'idle'>();
/** Epoch-ms ceiling until which an agent counts as `compacting` (PreCompact hook
 *  set it; PostCompact / SessionStart / Stop clear it). The ceiling is a safety
 *  net so a compaction that never reports its end can't wedge the badge forever. */
const agentCompactingUntil = new Map<string, number>();
/** Longest a `compacting` badge may persist without a PostCompact — a /compact
 *  that finishes cleanly clears it immediately; this only bounds the stuck case. */
const COMPACTING_STATUS_MAX_MS = 5 * 60_000;
function isAgentCompacting(agentId: string): boolean {
  const until = agentCompactingUntil.get(agentId) ?? 0;
  if (until === 0) return false;
  if (Date.now() >= until) { agentCompactingUntil.delete(agentId); return false; }
  return true;
}
/** Debounce timers to transition agent to idle after 3s of silence. */
const agentIdleTimers = new Map<string, NodeJS.Timeout>();
/** Token counts parsed from PTY stdout for non-Claude agents. */
const lastAgentPtyTokens = new Map<string, number>();
/** Cost in USD parsed from PTY stdout for non-Claude agents. */
const lastAgentPtyCost = new Map<string, number>();
/** Context window percentage parsed from PTY stdout for non-Claude agents. */
const lastAgentPtyCtx = new Map<string, number>();
/** Quota-limited status per agent. */
const lastAgentQuotaLimited = new Map<string, boolean>();
/** Epoch ms when agent quota resets. */
const lastAgentQuotaResetsAt = new Map<string, number>();

const AGY_TOOL_RE = /(?:(?:\[?\b(?:Tool|Calling tool|Running tool|Executing|Tool call|Tool Call|Action)\b\]?)\s*[:\s]\s*([A-Za-z0-9_.:-]+)|●\s+([A-Za-z][A-Za-z0-9_]*))/i;
/** Parse token counts from PTY stdout. Matches: "tokens: 1234", "Used 1234 tokens", "1234 tokens", etc. */
const PTY_TOKENS_RE = /(?:tokens?|tok)(?:\s*used)?[:\s]+(\d+)|(?:used|consuming)\s+(\d+)\s+tokens?/i;
/** Parse cost from PTY stdout. Matches: "cost: $1.23", "$1.23", "Usage: $0.45", etc. */
const PTY_COST_RE = /(?:cost|usage|spent)[:\s]+\$?([\d.]+)|\$([\d.]+)/i;
/** Parse context window percentage from PTY stdout. Matches: "ctx 45%", "context: 67%", "45% of context", etc. */
const PTY_CTX_RE = /(?:ctx|context)[:\s]+(\d+)%|(\d+)%\s+(?:of\s+)?(?:ctx|context)/i;
/** Detect quota exhaustion. Matches: "Individual quota reached", "Rate limit reached", "quota exceeded". */
const PTY_QUOTA_RE = /Individual quota reached|Rate limit reached|quota exceeded/i;
/** Parse quota reset duration. Matches: "Resets in 1h12m", "Resets in 45m", etc. */
const PTY_QUOTA_RESET_RE = /Resets in (\d+h)?(\d+m)?/i;

function stripAnsiText(str: string): string {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/** Rolling 200-line PTY buffer per worker / agent. */
const workerPtyTail = new Map<string, string[]>();
const workerPtyPartial = new Map<string, string>();

function getWorkerPtyTail(id: string): string[] {
  const lines = [...(workerPtyTail.get(id) ?? [])];
  const partial = workerPtyPartial.get(id)?.replace(/\r/g, '').trimEnd();
  if (partial && partial.length > 0) {
    lines.push(partial);
  }
  return lines.slice(-200);
}

function notifyAgentPtyActivity(ptyId: string, chunk?: string): void {
  const agentId = ptyToAgent.get(ptyId);
  if (!agentId) return;
  const now = Date.now();
  lastAgentPtyActivityMs.set(agentId, now);
  lastAgentStatus.set(agentId, 'working');

  let detectedTool: string | null = null;
  if (chunk) {
    const plain = stripAnsiText(chunk);
    const m = AGY_TOOL_RE.exec(plain);
    if (m) {
      detectedTool = (m[1] || m[2] || '').trim();
      if (detectedTool) {
        lastAgentTool.set(agentId, detectedTool);
      }
    }

    // Parse token/cost/ctx data from PTY output for non-Claude agents
    const tokensMatch = PTY_TOKENS_RE.exec(plain);
    if (tokensMatch) {
      const tokens = parseInt(tokensMatch[1] || tokensMatch[2] || '0', 10);
      if (tokens > 0) {
        // Accumulate tokens across multiple outputs
        const existing = lastAgentPtyTokens.get(agentId) ?? 0;
        lastAgentPtyTokens.set(agentId, existing + tokens);
      }
    }

    const costMatch = PTY_COST_RE.exec(plain);
    if (costMatch) {
      const cost = parseFloat(costMatch[1] || costMatch[2] || '0');
      if (cost > 0) {
        // Accumulate cost across multiple outputs
        const existing = lastAgentPtyCost.get(agentId) ?? 0;
        lastAgentPtyCost.set(agentId, existing + cost);
      }
    }

    const ctxMatch = PTY_CTX_RE.exec(plain);
    if (ctxMatch) {
      const ctx = parseInt(ctxMatch[1] || ctxMatch[2] || '0', 10);
      if (ctx > 0 && ctx <= 100) {
        // Context % is a snapshot, not cumulative — keep the latest
        lastAgentPtyCtx.set(agentId, ctx);
      }
    }

    // Detect quota exhaustion. Act only on the RISING EDGE (the marker scrolls
    // past on every subsequent PTY chunk, so without this guard the flag would be
    // re-set and god's inbox spammed once per frame).
    const quotaMatch = PTY_QUOTA_RE.exec(plain);
    if (quotaMatch && !lastAgentQuotaLimited.get(agentId)) {
      lastAgentQuotaLimited.set(agentId, true);
      lastAgentTool.set(agentId, 'quota');

      // Parse reset duration when the message carries one ("Resets in 1h12m").
      let resetTime = 'an unknown time';
      const resetMatch = PTY_QUOTA_RESET_RE.exec(plain);
      if (resetMatch && (resetMatch[1] || resetMatch[2])) {
        const hours = resetMatch[1] ? parseInt(resetMatch[1], 10) : 0;
        const mins = resetMatch[2] ? parseInt(resetMatch[2], 10) : 0;
        const resetMs = Date.now() + (hours * 3600000) + (mins * 60000);
        lastAgentQuotaResetsAt.set(agentId, resetMs);
        resetTime = new Date(resetMs).toLocaleString();
      }

      // No per-agent fallback profile is configured to auto-switch to, so route
      // the agent back to the Overmind for a manual re-route (once, this edge).
      const warnMsg = {
        id: `quota-warn-${agentId}-${Date.now()}`,
        conversation: 'god',
        in_reply_to: null,
        from: 'system',
        to: 'god',
        act: 'warn',
        subject: `Agent quota — ${agentId}`,
        body: `Hit quota. Resets ${resetTime}. No fallback profile configured — Stop the agent or Respawn it on a different profile.`,
        priority: 'normal',
        hops: 0,
        requires_reply: false,
        needs_human: false,
        created_at: new Date().toISOString()
      };
      const godInboxPath = join(HIVE_ROOT, 'agents', 'god', 'inbox', `${warnMsg.id}.json`);
      try {
        writeFileSync(godInboxPath, JSON.stringify(warnMsg, null, 2), 'utf8');
      } catch (e) {
        console.error('[quota-warn] Failed to write to god inbox:', e);
      }
    }

    // Maintain 200-line rolling buffer per worker / agent
    const currentLines = workerPtyTail.get(agentId) ?? [];
    const prevPartial = workerPtyPartial.get(agentId) ?? '';
    const combined = prevPartial + plain;
    const parts = combined.split('\n');
    const newPartial = parts.pop() ?? '';
    workerPtyPartial.set(agentId, newPartial);
    if (ptyId && ptyId !== agentId) workerPtyPartial.set(ptyId, newPartial);
    for (const p of parts) {
      const cleanLine = p.replace(/\r/g, '');
      if (cleanLine.trim() || cleanLine.length > 0) {
        currentLines.push(cleanLine);
      }
    }
    if (currentLines.length > 200) {
      currentLines.splice(0, currentLines.length - 200);
    }
    workerPtyTail.set(agentId, currentLines);
    if (ptyId && ptyId !== agentId) {
      workerPtyTail.set(ptyId, currentLines);
    }
  }

  // Push live status update to the renderer
  const toolName = detectedTool || lastAgentTool.get(agentId);
  try {
    liveWebContents()?.send('hive:hookEvent', {
      agentId,
      event: 'PreToolUse',
      tool: toolName || 'working'
    });
  } catch { /* ignore */ }

  // Reset 3.5s idle debounce timer
  const existingTimer = agentIdleTimers.get(agentId);
  if (existingTimer) clearTimeout(existingTimer);
  const idleTimer = setTimeout(() => {
    agentIdleTimers.delete(agentId);
    if (Date.now() - (lastAgentPtyActivityMs.get(agentId) ?? 0) >= 3000) {
      lastAgentStatus.set(agentId, 'idle');
      try {
        liveWebContents()?.send('hive:hookEvent', {
          agentId,
          event: 'PostInvocation'
        });
      } catch { /* ignore */ }
      writeFleetSnapshot();
    }
  }, 3500);
  agentIdleTimers.set(agentId, idleTimer);

  const lastWrite = lastFleetWriteMs.get(agentId) ?? 0;
  if (now - lastWrite >= 2000) {
    lastFleetWriteMs.set(agentId, now);
    writeFleetSnapshot();
  }
}
/** PTY id → the spawn it should auto restart-and-continue into once a first-time
 *  CLI install finishes. The missing-CLI short-circuit runs the engine's installer
 *  in this PTY; when it exits cleanly the exit handler re-runs the SAME spawn (with
 *  install disabled) so the freshly-installed CLI launches in the SAME pty/window —
 *  no user click. Cleared the moment it's consumed, so it can never loop installs. */
const pendingInstallRelaunch = new Map<string, { opts: AgentSpawnOptions; owner: Electron.WebContents | null; bin: string }>();

interface DelegateLedgerState {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  usd: number;
  model: string;
  provider: string;
  sessionId: string;
}
const delegateLedgerTotals = new Map<string, DelegateLedgerState>();

interface DelegationEntry {
  ts: number;
  tool: string;
  fileOrArg: string;
  decision: 'delegated' | 'allowed' | 'blocked';
  durationMs: number;
  resultSnippet?: string;
}

interface DelegationStats {
  delegated: number;
  allowed: number;
  blocked: number;
}

const delegationLog: DelegationEntry[] = [];
const delegationStats: DelegationStats = { delegated: 0, allowed: 0, blocked: 0 };
const MAX_DELEGATION_LOG_ENTRIES = 200;

function recordDelegationEntry(entry: DelegationEntry): void {
  delegationLog.unshift(entry);
  if (delegationLog.length > MAX_DELEGATION_LOG_ENTRIES) {
    delegationLog.pop();
  }

  if (entry.decision === 'delegated') {
    delegationStats.delegated++;
  } else if (entry.decision === 'allowed') {
    delegationStats.allowed++;
  } else if (entry.decision === 'blocked') {
    delegationStats.blocked++;
  }

  const wc = liveWebContents();
  if (wc) {
    try {
      wc.send('hive:delegationEvent', entry);
    } catch {
      // ignore
    }
  }
}

function recordDelegateLedger(delegateId: string, usage: LdaUsageMetrics): void {
  const agentId = `delegate:${delegateId}`;
  let state = delegateLedgerTotals.get(agentId);
  if (!state) {
    state = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      usd: 0,
      model: usage.model ?? '',
      provider: usage.provider ?? '',
      sessionId: agentId
    };
    delegateLedgerTotals.set(agentId, state);
  }
  state.input += usage.inputTokens;
  state.output += usage.outputTokens;
  state.cacheRead += usage.cacheReadTokens;
  state.cacheCreation += usage.cacheWriteTokens;
  state.usd += usage.usd;
  if (usage.model) state.model = usage.model;
  if (usage.provider) state.provider = usage.provider;
  hive.appendCostLedger({
    agentId,
    sessionId: state.sessionId,
    ts: Date.now(),
    input: state.input,
    output: state.output,
    cacheRead: state.cacheRead,
    cacheCreation: state.cacheCreation,
    model: state.model,
    provider: state.provider,
    usd: state.usd
  });
}
const hive = new HiveManager(
  () => resolveHarnessHome(),
  (channel, payload) => {
    const wc = liveWebContents();
    if (!wc) return false;
    try { wc.send(channel, payload); return true; } catch { return false; }
  }
);
// #7C — operator control state (pause/gate/steer/halt), read by the HookServer
// when deciding hook returns.
const control = new ControlRegistry();
// Stage 7A — the live observability tap. Receives Claude Code's first-party OTel
// over loopback OTLP/JSON and exposes the locked usage-provider seam. resolveCwd
// lets the transcript fallback find an agent's cwd from the hive registry.
const telemetry = new TelemetryCollector({
  emit: (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } },
  resolveCwd: (agentId) => hive.registry().agents[agentId]?.cwd ?? null,
  // D11: scopes the transcript fallback to this agent's own session instead of
  // summing every transcript in a (routinely shared) cwd.
  resolveSessionId: (agentId) => hive.lastSession(agentId),
  resolveProvider: (agentId) => hive.registry().agents[agentId]?.provider ?? null
});
// Usage provider (Seam 1) — the INTEGRATION swap: Oscar's telemetry collector (#7)
// IS the provider, replacing Lane A's interim StubUsageProvider. Same
// getAgentUsage(agentId) pull seam, so the breaker + cost ledger consumers are
// untouched; telemetry has a transcript fallback built in, so it works before any
// live OTel arrives.
const usageProvider: UsageProvider = telemetry;
// Circuit breaker (Lane A #6.6b) — the REAL policy (replaces Lane C's interim
// glue). POLICY only; the heartbeat beat feeds it signals (via usageProvider) +
// enforces its decisions. Config read live so a settings change applies next beat.
const breaker = new CircuitBreaker(() => {
  const c = readConfig();
  return { ...(c.circuitBreaker ?? {}), costCapUsd: c.costCapUsd, costCapTokens: c.costCapTokens, agentTokenCaps: c.agentTokenCaps };
});
// Always-on beats (decoupled from the optional heartbeat): the live fleet snapshot
// Abathur reads + the breaker beat, so guardrails + monitoring work even when the
// heartbeat mission is disabled (it ships off).
let fleetTimer: ReturnType<typeof setInterval> | null = null;
let breakerBeatTimer: ReturnType<typeof setInterval> | null = null;
let governorBeatTimer: ReturnType<typeof setInterval> | null = null;
// Cross-device advisory-lock heartbeat: refreshes <hive>/.sync/owner.json so a
// second device can tell a live hive from a crashed one (see syncLock).
let lockHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
// Feed the breaker's api_error-storm trip from Oscar's OTel api_error spans —
// Jim's one breaker input with no on-branch source (telemetry.onApiError seam).
telemetry.onApiError((agentId) => breaker.recordError(agentId));
// Shared roster on disk — created early so HookServer can re-read standing goals
// on every UserPromptSubmit (Edit Agent saves land here via persistAgents).
const roster = new RosterStore(() => resolveHarnessHome());
function standingGoalFromRoster(agentId: string): string | null {
  const snap = roster.read();
  if (!snap || !Array.isArray(snap.agents)) return null;
  for (const entry of snap.agents) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as { id?: unknown; goal?: unknown };
    if (a.id !== agentId) continue;
    return typeof a.goal === 'string' && a.goal.trim() ? a.goal.trim() : null;
  }
  return null;
}
// Worker inbox-wake watchdog (#151): finds idle workers with undrained inbox mail
// and types the same guarded nudge the renderer would have (so a throttled
// background window can't leave a worker parked on an unread inbox forever).
// HookServer feeds it the hook stream so a permission/HITL prompt blocks nudges.
const workerWake = new WorkerWakeWatchdog();
// HookServer needs BOTH: Oscar's control registry (HITL pause/gate/steer/halt via
// hook returns) AND Jim's breaker (feed recordToolUse on each PostToolUse).
const hookServer = new HookServer(
  hive,
  () => liveWebContents(),
  () => readConfig(),
  control,
  breaker,
  standingGoalFromRoster,
  (agentId, event, message) => {
    workerWake.noteHook(agentId, event, message);
    // #5C — reflect mid-`/compact` in fleet.json so god's roster and the mobile
    // API read 'compacting' instead of a frozen-looking 'working'/'idle'. The
    // renderer floor already flips its badge off the live hookEvent stream; this
    // is the snapshot half. PreCompact opens the window; PostCompact — or any
    // fresh session, which makes an in-flight compaction moot — closes it.
    if (!agentId) return;
    if (event === 'PreCompact') {
      agentCompactingUntil.set(agentId, Date.now() + COMPACTING_STATUS_MAX_MS);
      writeFleetSnapshot();
    } else if (event === 'PostCompact' || event === 'SessionStart' || event === 'Stop') {
      if (agentCompactingUntil.delete(agentId)) writeFleetSnapshot();
    }
  }
);
const memory = new MemoryManager(
  () => resolveHarnessHome(),
  () => { const c = readConfig(); return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' }; }
);
// Enterprise Knowledge Graph — file-backed store + agent CLI (default OFF).
const knowledge = new KnowledgeManager();
/** Reads the reflect tunables from config each tick (defaults baked in here so a
 *  pre-existing config.json without the keys still gets sane values). */
function reflectSettings(): ReflectSettings {
  const c = readConfig();
  return {
    enabled: c.reflectEnabled !== false,
    intervalMs: c.reflectIntervalMs ?? 1_800_000,
    byteTriggerPct: c.reflectByteTriggerPct ?? 50,
    sectionTrigger: c.reflectSectionTrigger ?? 50,
    recentKeep: c.reflectRecentKeep ?? 12,
    minBytes: c.reflectMinBytes ?? 16_384
  };
}
// Finishes the janitor's missing condense half: bounds each agent's memory.md
// (Haiku tail-summary, backup→verify→atomic-swap) so it never grows unbounded.
const reflector = new MemoryReflector(
  () => resolveHarnessHome(),
  () => readConfig().defaultCommand ?? 'claude',
  () => memory.env(),
  reflectSettings,
  (event) => { try { hive.appendLog(event); } catch { /* best-effort */ } }
);
// Durable harness state (SQLite, main process). Phase A: window bounds (kv) +
// net-new command history. Opened in whenReady, closed in the teardown blocks.
const persist = new PersistStore();
/** The PRIMARY window — the one running the hive/god orchestration and the sink
 *  for process-global timer events (missions, breaker, Slack ingestion). It is
 *  the most-recently-focused live window, so global events follow the user.
 *  Additional "floor" windows are tracked in `allWindows` below. */
let mainWindow: BrowserWindow | null = null;
/** Every open window (primary + floors). A registry, not a single handle, so
 *  multi-window lifecycle (focus tracking, quit fan-out) is correct. */
const allWindows = new Set<BrowserWindow>();
/** Monotonic floor counter → a stable, unique session partition per floor so
 *  each floor's renderer state (localStorage: agents, queues, selection) is
 *  isolated from every other window's. */
let floorSeq = 0;

/** When true, skip the quit interceptor (user already confirmed). */
let allowQuit = false;

/** Agents spawned with `isolate: true` get a dedicated git worktree; this maps
 *  the agent/pty id → the worktree path so we can tear it down on kill. */
const worktreePaths = new Map<string, string>();
/** id → the original repo cwd the worktree was created from (needed to run
 *  `git worktree remove` from the parent tree, not the worktree itself). */
const worktreeOrigins = new Map<string, string>();

/** A live god-triggered ephemeral worker, tracked from spawn to teardown. */
interface WorkerRec {
  workerId: string;       // == the PTY id == hive agent id (`worker-<reqId>`)
  reqId: string;          // the spawn-request id
  name?: string;          // display name (for the worker tab)
  slack?: { channel: string; thread_ts: string };
  baseBranch: string;     // the branch its worktree was cut from (for ahead-of-base)
  cwd?: string;
  objective?: string;
  spawnedAt: number;      // epoch ms
  releasing?: boolean;    // kill issued; awaiting teardownPty (skip re-processing)
  /** Per-worker TOTAL-token cap from the spawn-request (overrides the config
   *  default). 0/undefined = no per-request cap. P4 plumbing — unlimited today. */
  tokenCap?: number;
  /** Set only for workers spawned by the auto-offload path: the target it ran on
   *  plus enough of the original spec to requeue it onto another target if it is
   *  reaped without signaling done (§6). Undefined for normal workers. */
  offload?: { targetId: string; spec: OffloadWorkSpec };
}
/** Live ephemeral workers by id. Populated by the spawn-request watcher; consulted
 *  by teardownPty so a finished/crashed/reaped worker's worktree is PRESERVED (not
 *  force-removed) when it holds unintegrated work — god is the sole integrator. */
const liveWorkers = new Map<string, WorkerRec>();

/** Workers already sent their 75%-of-tokenCap pre-reap warning this session.
 *  Rate-limits the warn to once — the loop re-checks every tick and the used/cap
 *  ratio only grows, so without this a worker parked at 76% gets spammed forever. */
const workerWarnedAt75 = new Set<string>();

interface TrackedProcess {
  pid: number;
  label: string;
  cmd: string;
  args: string[];
  cwd: string;
  shell: 'wsl-bash' | 'powershell' | 'cmd' | 'bash';
  startedAt: number;
  status: 'running' | 'exited';
  exitCode?: number;
  ptyId?: string;
}

const trackedProcesses = new Map<string, TrackedProcess>();
let processIdSeq = 0;

interface RecentWorkerSnapshot {
  workerId: string;
  reqId: string;
  name: string;
  baseBranch: string;
  cwd?: string;
  objective?: string;
  spawnedAt: number;
  endedAt: number;
  durationMs: number;
  tokensUsed: number;
  status: 'done' | 'reaped' | 'stopped' | 'failed';
  tailPreview: string[];
}
const recentWorkers: RecentWorkerSnapshot[] = [];
const recordedRecentWorkerIds = new Set<string>();

function recordRecentWorker(workerId: string, status: 'done' | 'reaped' | 'stopped' | 'failed'): void {
  if (recordedRecentWorkerIds.has(workerId)) return;
  recordedRecentWorkerIds.add(workerId);
  const rec = liveWorkers.get(workerId);
  const now = Date.now();
  const spawnedAt = rec?.spawnedAt ?? now;
  const tail = getWorkerPtyTail(workerId);
  const tokens = workerTokensUsed(workerId);
  const entry: RecentWorkerSnapshot = {
    workerId,
    reqId: rec?.reqId ?? workerId.replace(/^worker-/, ''),
    name: rec?.name ?? workerId,
    baseBranch: rec?.baseBranch ?? 'main',
    cwd: rec?.cwd,
    objective: rec?.objective,
    spawnedAt,
    endedAt: now,
    durationMs: Math.max(0, now - spawnedAt),
    tokensUsed: tokens,
    status,
    tailPreview: tail.slice(-5)
  };
  recentWorkers.unshift(entry);
  if (recentWorkers.length > 20) recentWorkers.splice(20);
}

/** The loopback secret broker (Phase 2). Workers reach registered integrations through
 *  it without ever seeing a credential. getRecord/getSecret are injected so the broker
 *  stays electron-free + unit-testable. Started in bootstrapHiveServices; each worker is
 *  granted a per-worker capability token at spawn (revoked in teardownPty). */
const integrationBroker = new IntegrationBroker({
  getRecord: integrations.getRecord,
  getSecret: integrations.getSecret
});

/** BYOK backend model-providers whose API keys the non-Claude CLI engines
 *  (OpenCode/Crush/pi/qwen) read from standard env vars. Keys are stored
 *  WRITE-ONLY in the same encrypted secret broker as integrations, under
 *  `apikey:<backend>`, and materialized MAIN-ONLY at spawn (never over IPC). */
const BACKEND_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY'
};
const providerKeyRef = (backend: string): string => `apikey:${backend}`;

/** A worker worktree that teardown PRESERVED because it held unintegrated work.
 *  Tracked so the GC sweep can reclaim it (+ its scratch dir) once the work lands
 *  in base or the worktree is removed by hand — see gcPreservedWorktrees(). */
interface PreservedWorktree {
  workerId: string;
  wtPath: string;
  origCwd: string;        // the parent repo to run `git worktree remove` from
  baseBranch: string;     // re-checked against this for "integrated yet?"
  scratchDir: string | null; // HIVE_ROOT/agents/<workerId> — removed alongside the worktree
  slack?: { channel: string; thread_ts: string };
  preservedAt: number;    // epoch ms
}
/** Preserved worker worktrees awaiting integration, keyed by worktree path. The GC
 *  sweep drains this: an entry is removed (worktree + scratch GC'd) only when the
 *  work is provably integrated, or when the worktree is already gone from disk. */
const preservedWorktrees = new Map<string, PreservedWorktree>();

/**
 * Tear down everything tied to a PTY id: archive its hive agent, remove its
 * isolated git worktree, and drop the bookkeeping-map entries. Runs on BOTH an
 * explicit `pty:kill` AND a natural PTY exit (the child finished, crashed, or
 * was killed externally) — without this the agent stays "active" (broadcasts
 * keep mailing a dead inbox), the worktree orphans (plus a dangling `git
 * worktree` registration in the user's real repo), and the maps leak an entry
 * per dead PTY.
 *
 * Idempotent: guarded on map presence and the already-idempotent
 * `hive.setArchived`, so a double call is a harmless no-op. NOTE: an explicit
 * `ptyManager.kill()` does NOT reach here via onExit — kill() deletes the
 * session synchronously, so node-pty's later async exit callback fails the
 * session-identity guard and is swallowed. Every kill site must therefore call
 * teardownPty itself right after the kill (all of them do). Best-effort — every
 * step is wrapped so a teardown error can never crash the caller (an IPC
 * handler or node-pty's onExit).
 */
function teardownPty(id: string): void {
  // Ephemeral-worker flag, read BEFORE the cleanup below deletes the entry. All
  // worker deaths (done-release, idle/token reap, manual stop, crash) funnel
  // through here, so this is the one place their floor card gets archived
  // (workers card via the hive:agentSpawned broadcast in processSpawnRequest).
  // pty id == worker id == agent id for workers.
  const wasWorker = liveWorkers.has(id);
  // 0) Revoke this id's broker capability (if any). Idempotent + harmless for a
  //    non-worker PTY; ensures a dead worker's token can never reach an integration.
  try { integrationBroker.revoke(id); } catch { /* best-effort */ }
  // 1) Archive the agent — retained + flagged; only live-PTY agents are active.
  const agentId = ptyToAgent.get(id);
  if (agentId) {
    ptyToAgent.delete(id);
    lastFleetWriteMs.delete(agentId);
    lastAgentPtyActivityMs.delete(agentId);
    lastAgentTool.delete(agentId);
    lastAgentStatus.delete(agentId);
    const timer = agentIdleTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      agentIdleTimers.delete(agentId);
    }
    // Drop watchdog state so a dead agent can't get nudged or leak its grace.
    try { workerWake.forget(agentId, id); } catch { /* best-effort */ }
    // Drop breaker state so a dead agent can't leak/zombie a tripped level.
    try { breaker.forget(agentId); } catch { /* best-effort */ }
    // Clear tool call counter so a respawned agent starts fresh.
    try { hookServer.clearToolCallCount(agentId); } catch { /* best-effort */ }
    // W1 — kill this agent's proxy-bridge sidecar (qwen), if any, so a dead
    // PTY never leaves an orphan loopback listener. No-op for non-proxy agents.
    try { hive.stopProxyBridge(agentId); } catch (e) { console.error('[hive] stopProxyBridge failed:', e); }
    if (hive.enabled()) {
      try { hive.setArchived(agentId, true); } catch (e) { console.error('[hive] setArchived failed:', e); }
    }
  }
  // 2) Remove the isolated worktree, if any. Non-blocking; errors are logged.
  const wtPath = worktreePaths.get(id);
  if (wtPath) {
    const origCwd = worktreeOrigins.get(id) ?? wtPath;
    worktreePaths.delete(id);
    worktreeOrigins.delete(id);
    // Ephemeral workers get a SAFETY-GATED teardown: never auto-remove a worktree
    // that holds unintegrated work. This sits INSIDE teardownPty so it covers ALL
    // teardown routes — a worker that finished (controller kill), crashed, or was
    // idle-reaped all land here. Normal agents keep the immediate force-remove.
    const worker = liveWorkers.get(id);
    if (worker) {
      recordRecentWorker(id, 'stopped');
      liveWorkers.delete(id);
      releaseOffloadSlot(worker.reqId); // G2: free the offload slot (no-op for normal workers)
      void finalizeWorkerWorktree(wtPath, origCwd, worker);
    } else {
      void removeWorktree(origCwd, wtPath)
        .then(r => { if (!r.ok) console.error('[worktree] removeWorktree failed:', r.error); })
        .catch(e => console.error('[worktree] removeWorktree threw:', e));
    }
  }
  // A worker whose isolation failed (non-repo cwd) has no worktree to gate above —
  // still clear its tracking entry so the controller stops watching a dead PTY.
  if (liveWorkers.has(id)) {
    recordRecentWorker(id, 'stopped');
    liveWorkers.delete(id);
    workerWarnedAt75.delete(id);
  }
  // Archive the dead worker's floor card (mirrors killAgent's voice-kill path;
  // the renderer's archiveAgent is a no-op if the card is already gone). NOT
  // done for regular agents: their kill flows already manage their own card.
  if (wasWorker) {
    try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* window torn down */ }
  }
  syncKeepAwake();
  writeFleetSnapshot();
}

/** Send an inform to the god agent (the human's proxy). The ephemeral-worker
 *  controller uses this to surface every terminal failure AND to carry the Slack
 *  {channel,thread_ts} so god can post a 'couldn't complete' reply — closing the
 *  Slack loop (the success path is the worker replying in-thread itself). */
function informGod(subject: string, body: string, slack?: { channel: string; thread_ts: string }): void {
  try {
    const slackLine = slack
      // The bundled-node launcher, spelled as an ABSOLUTE PATH — NOT bare `node`
      // (absent from the PATH of any machine whose node comes from nvm) and NOT
      // `$HIVE_NODE` (POSIX-only: cmd.exe/PowerShell expand it to nothing, so the
      // whole reply command was dead on Windows).
      ? `\n\n[SLACK] Close the loop — post a reply to channel ${slack.channel} thread ${slack.thread_ts} via:\n  "${hive.nodeCommand()}" "${slackReplyScriptPath()}" --channel ${slack.channel} --thread ${slack.thread_ts} --text "<your message>"`
      : '';
    hive.send({ to: 'god', act: 'inform', subject, body: body + slackLine }, 'ephemeral-worker');
  } catch (e) {
    console.error('[worker] informGod failed:', e);
  }
}

/** Gated worktree teardown for an ephemeral worker: remove it ONLY when it holds no
 *  unintegrated work; otherwise leave it (and its branch) in place and ping god, the
 *  sole integrator. Async + best-effort; on any uncertainty it KEEPS the worktree
 *  (fail-safe — never auto-discard possibly-valuable work). */
async function finalizeWorkerWorktree(wtPath: string, origCwd: string, worker: WorkerRec): Promise<void> {
  try {
    const work = await worktreeHasUnintegratedWork(wtPath, worker.baseBranch);
    if (work.keep) {
      console.warn(`[worker] PRESERVING worktree with unintegrated work: ${wtPath} (${work.detail})`);
      // Track it so the GC sweep can reclaim it (+ scratch dir) once integrated —
      // the worker is gone from liveWorkers by now, so its identity lives here.
      preservedWorktrees.set(wtPath, {
        workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
        scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
      });
      informGod(
        `[worker worktree preserved] ${worker.workerId}`,
        `Ephemeral worker ${worker.workerId} ended but its worktree holds unintegrated work, so it was NOT auto-removed (you are the sole integrator).\n`
        + `Worktree: ${wtPath}\nBranch: ${work.branch}\nState: ${work.detail}\n`
        + `Review/merge it — it will be auto-reclaimed once its work lands in ${worker.baseBranch}, or remove it now with: git -C "${origCwd}" worktree remove "${wtPath}"`,
        worker.slack
      );
      return;
    }
    const r = await removeWorktree(origCwd, wtPath);
    if (!r.ok) { console.error('[worker] removeWorktree failed:', r.error); return; }
    // Worktree is gone (clean/integrated at teardown), but DEFER its scratch-dir
    // cleanup to the throttled GC sweep rather than deleting it synchronously here:
    // HIVE_ROOT/agents/<id> holds the worker's memory.md and the MemPalace miner
    // ingests it asynchronously, so an immediate delete can beat the miner and
    // permanently lose the worker's durable notes from the shared palace. Register
    // it (its worktree path is now absent) so the sweep's path-gone branch reclaims
    // the scratch after a window — same throttled path the preserved case uses.
    preservedWorktrees.set(wtPath, {
      workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
      scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
    });
  } catch (e) {
    console.error('[worker] finalizeWorkerWorktree threw (worktree left in place):', e);
  }
}

/** The hive scratch dir for a worker (its inbox/outbox/memory): HIVE_ROOT/agents/<id>.
 *  Null when there's no hive root. */
function workerScratchDir(workerId: string): string | null {
  const root = hive.root();
  return root ? join(root, 'agents', workerId) : null;
}

/** Best-effort removal of a worker's scratch (hive agent) dir. Guarded to ONLY ever
 *  delete a path that resolves to exactly HIVE_ROOT/agents/<workerId> and never a
 *  still-live worker — so a crafted/mismatched id can't escape the agents root. */
function removeWorkerScratch(workerId: string): void {
  if (liveWorkers.has(workerId)) return; // never wipe a live worker's mailbox
  const dir = workerScratchDir(workerId);
  const root = hive.root();
  if (!dir || !root) return;
  const agentsRoot = join(root, 'agents');
  // Path-safety: the resolved dir must sit directly under agents/ with basename == id.
  if (resolve(dir) !== join(resolve(agentsRoot), basename(dir)) || basename(dir) !== workerId) return;
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) { console.error('[worker] removeWorkerScratch failed:', e); }
}
// A natural PTY exit must run the same teardown as an explicit kill — EXCEPT when
// the PTY was the missing-CLI installer: a clean exit there means the engine CLI was
// just installed, so auto restart-and-continue by re-running the SAME spawn into the
// SAME pty/window (no user click). Provider-agnostic. Idempotent by construction: the
// relaunch carries `noAutoInstall`, so the installer can never fire (let alone loop) a
// second time — a binary that's somehow still missing just spawns and exits normally.
ptyManager.setExitHandler((id, exitCode) => {
  const pending = pendingInstallRelaunch.get(id);
  if (pending) {
    pendingInstallRelaunch.delete(id);
    if (exitCode === 0) {
      // Re-arm the renderer's pooled terminal (clear the "process exited" line +
      // re-enable input) so the freshly-spawned CLI paints onto a clean, typeable
      // grid, then re-run the normal spawn — which now finds the installed binary.
      const wc = (pending.owner && !pending.owner.isDestroyed()) ? pending.owner : liveWebContents();
      try { wc?.send(`pty:relaunch:${id}`); } catch { /* window gone */ }
      void spawnAgentCore({ ...pending.opts, noAutoInstall: true }, pending.owner);
      return; // an install PTY has no agent/worktree to tear down
    }
    // Non-zero exit = install failed; leave its honest manual-fix message on screen.
  }
  teardownPty(id);
});

ptyManager.setDataHandler((id, data) => {
  notifyAgentPtyActivity(id, data);
});

/** Keep the system from suspending the harness while agents are running.
 *  Windows Modern Standby suspends desktop apps (and their child `claude`
 *  processes!) shortly after the display sleeps/locks — the whole hive froze
 *  mid-turn until unlock. `prevent-app-suspension` blocks exactly that while
 *  still letting the display turn off and the session lock. Held only while at
 *  least one PTY is alive, so an idle harness doesn't pin a laptop awake.
 *
 *  Opt-in `config.strongKeepalive` escalates to `prevent-display-sleep`, which on
 *  macOS ALSO blocks true system sleep (lid-close/idle) so timers & PTYs keep
 *  firing on time while away — at a battery cost. The default ('prevent-app-
 *  suspension') still lets the Mac truly sleep; we survive that and catch up once
 *  on resume (see onSystemResume). Re-evaluated on every call so toggling the
 *  flag while agents run swaps the blocker mode live. */
type KeepAwakeMode = 'prevent-app-suspension' | 'prevent-display-sleep';
let keepAwakeId: number | null = null;
let keepAwakeMode: KeepAwakeMode | null = null;
function syncKeepAwake(): void {
  const live = ptyManager.list().length > 0;
  const desired: KeepAwakeMode | null = live
    ? (readConfig().strongKeepalive ? 'prevent-display-sleep' : 'prevent-app-suspension')
    : null;
  if (desired === keepAwakeMode) return; // no change — avoid stop/start churn + log spam
  // Tear down the current blocker (mode change, or going idle with no agents).
  if (keepAwakeId !== null) {
    try { if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId); } catch { /* noop */ }
    keepAwakeId = null;
  }
  keepAwakeMode = desired;
  if (desired) {
    keepAwakeId = powerSaveBlocker.start(desired);
    console.log(`[power] keep-awake ON (${desired}) — agents running`);
  } else {
    console.log('[power] keep-awake off — no agents');
  }
}

/** A mission's live scheduler handles: the initial `setTimeout` that waits out
 *  the time remaining until its next due fire, and the steady `setInterval`
 *  armed once it has fired. Both are tracked so shutdown can clear whichever is
 *  pending. */
interface MissionTimer {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}

/** Active scheduler timers keyed by mission id. */
const missionTimers = new Map<string, MissionTimer>();

/** Clear and forget every armed mission timer (both the setTimeout and the
 *  setInterval handle). Safe to call from syncMissions and from shutdown
 *  teardown so a tick never fires into half-torn-down services. */
function clearMissionTimers(): void {
  for (const t of missionTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  missionTimers.clear();
}

/** "every 30m" / "every 2h" / "every 3d" for an interval mission's mobile row. */
function fmtMissionInterval(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `every ${mins}m`;
  if (mins % 1440 === 0) return `every ${mins / 1440}d`;
  if (mins % 60 === 0) return `every ${mins / 60}h`;
  return `every ${(mins / 60).toFixed(1)}h`;
}

/** Rebuild the scheduler from persisted config: clear every existing timer,
 *  then arm each enabled mission honoring its lastFiredAt — a setTimeout for the
 *  time remaining until its next due fire, which then settles into a steady
 *  interval. Each tick dispatches the mission to its target agent and stamps
 *  lastFiredAt back into config. Called on boot (after the router starts) and
 *  after every missions:save. */
function syncMissions(): void {
  clearMissionTimers();
  const missions = readConfig().missions ?? [];
  for (const m of missions) {
    if (!m.enabled) continue;
    // A weekly mission (day-of-week + time) is armed below and does NOT need an
    // interval, so the interval guard has to come after that branch — it used to
    // be folded into the line above and would have rejected every one of them.
    const weekly = m.kind === 'heartbeat' ? null : normalizeWeekly(m.weekly);
    if (!weekly && !(m.intervalMs > 0)) continue;
    // Heartbeat (Lane A #1) opts out of the fixed setInterval and self-reschedules
    // with an adaptive cadence. Registered into the same missionTimers map so
    // clearMissionTimers() tears it down identically on quit/reset.
    if (m.kind === 'heartbeat') { armHeartbeat(m); continue; }
    const fire = (): void => {
      try {
        // A 'compact' maintenance mission (maint-1) is compaction-ONLY: it carries
        // no dispatch body/target, so skip the hive.send and just fire auto-compact.
        // Gate on `kind!=='compact'` ALONE — that already excludes the compact mission;
        // we deliberately do NOT add `&& m.body`, so other (dispatch) missions keep
        // their prior behaviour, including the historical empty-body send (Pam N1).
        if (m.kind !== 'compact' && hive.enabled()) {
          hive.send({ to: m.to, act: 'request', subject: m.label, body: m.body }, 'scheduler');
        }
        // Auto-compact: do NOT jam /compact into busy terminals. Hand it to the
        // renderer, which queues a /compact per agent (deduped — never two at
        // once) and delivers it only when that agent goes idle (its drain loop),
        // so a working agent compacts between steps, never mid-step.
        //
        // The CADENCE now belongs to the context trigger, not to a mission — but
        // the legacy per-mission `autoCompact` flag keeps working, routed through
        // the same emit so there is exactly ONE path from main to the renderer.
        // It carries the context trigger's current rule so a mission-driven
        // compaction obeys the same pressure thresholds as a trigger-driven one.
        if (m.autoCompact || m.kind === 'compact') {
          emitContextTrigger('compact', contextRule('compact'));
        }
        const current = readConfig().missions ?? [];
        const next = current.map((x) =>
          x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x
        );
        writeConfig({ missions: next });
        // Let the SCHEDULES panel refresh its "last fired" without a reload (#2.3).
        try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
      } catch (e) {
        console.error('[scheduler] mission', m.id, e);
      }
    };
    const entry: MissionTimer = {};
    if (weekly) {
      // Weekly self-reschedules: there is no steady interval to settle into,
      // because the gap between two slots varies (Fri to Mon is not Mon to Wed,
      // and the week the clocks change is not 168 hours long).
      //
      // `justFired` is a spin guard, not a nicety. weeklyDelayMs returns 0 for a
      // slot that was missed and not yet run, and it learns "already run" from
      // the persisted lastFiredAt — so if fire()'s writeConfig ever failed, the
      // next computation would return 0 again, forever. Passing `now` as the
      // last-fired floor after a fire makes the catch-up branch unreachable, so
      // the worst case is a lost stamp rather than a hot loop.
      const rearm = (justFired: boolean): void => {
        const now = Date.now();
        const persisted = (readConfig().missions ?? []).find((x) => x.id === m.id)?.lastFiredAt ?? 0;
        const delay = weeklyDelayMs(weekly, now, justFired ? Math.max(persisted, now) : persisted);
        if (delay === null) return;
        entry.timeout = setTimeout(() => { fire(); rearm(true); }, delay);
      };
      rearm(false);
      missionTimers.set(m.id, entry);
      continue;
    }
    // Honor lastFiredAt so a partially-elapsed interval is not restarted from
    // zero on reboot or when an unrelated mission is edited: wait only the time
    // remaining until the next due fire, then settle into a steady interval.
    const remaining = Math.max(0, m.intervalMs - (Date.now() - (m.lastFiredAt ?? 0)));
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, m.intervalMs);
    }, remaining);
    missionTimers.set(m.id, entry);
  }
}

// ─── Context trigger (auto-compact / auto-clear own their own timers) ────────
// Compaction used to ride on a mission (`compact-maintenance`), which meant the
// operator had TWO competing controls for one behaviour — a schedule with an
// interval and a trigger with a cadence. The mission is retired (see the
// retirement migration in ensureDefaultMissions); these timers are the single
// remaining source of scheduled context maintenance.
//
// Main owns only the CADENCE. The pressure gate (`minContextPct`) needs each
// agent's live context usage, which only the renderer has, so the whole rule
// rides along in the event and the renderer decides which agents actually get
// the command. That split is why the payload carries the rule rather than a bare
// "go" signal.

/** Timers for the two halves, keyed by action. Same two-phase shape as
 *  `missionTimers` (a setTimeout for the remaining time, then a steady interval)
 *  so a partially-elapsed cadence survives a re-arm. */
const contextTimers = new Map<'compact' | 'clear', MissionTimer>();

/** `ContextRule` has no `lastFiredAt` (unlike `ScheduledMission`), so the last-run
 *  instants live in the durable kv store instead. Without them every re-arm —
 *  boot, a settings edit, a wake from sleep — would restart a 2h cadence from
 *  zero, and an operator who edits the rule twice a day would never see it fire. */
const CONTEXT_LAST_RUN_KV_KEY = 'triggers.context.lastRun';
let contextLastRun: Record<string, number> | null = null;

function contextRunMap(): Record<string, number> {
  if (!contextLastRun) {
    try { contextLastRun = persist.getKv<Record<string, number>>(CONTEXT_LAST_RUN_KV_KEY) ?? {}; }
    catch { contextLastRun = {}; }
  }
  return contextLastRun;
}

/** When the rule last ran. An UNRECORDED half is stamped NOW rather than read as
 *  the epoch: `remaining` would otherwise clamp to 0 and compact every terminal
 *  the instant the app boots. It is the same trap `ensureDefaultMissions` avoids
 *  by stamping `lastFiredAt` when it seeds a mission — a first launch should wait
 *  a full cadence, not open with an interruption. */
function contextLastRunAt(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const v = map[action];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return stampContextRun(action);
}

function stampContextRun(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const at = Date.now();
  map[action] = at;
  try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB best-effort */ }
  return at;
}

/** The live rule for one half, deep-filled. `readConfig` already fills both
 *  halves, so the default is only a belt-and-braces fallback. */
function contextRule(action: 'compact' | 'clear'): ContextRule {
  return readConfig().contextTrigger?.[action] ?? DEFAULT_CONTEXT_TRIGGER[action];
}

/** Clear and forget both context timers (setTimeout + setInterval handles). */
function clearContextTimers(): void {
  for (const t of contextTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  contextTimers.clear();
}

/** Ask the renderer to run one half of the context trigger.
 *
 *  Both callers funnel through here — the legacy per-mission `autoCompact` flag
 *  and the context trigger's own timer — so there is exactly one path from main
 *  to the renderer for each action. */
function emitContextTrigger(action: 'compact' | 'clear', rule: ContextRule): void {
  try { liveWebContents()?.send('trigger:context', { action, rule }); } catch { /* window gone */ }
  // TRANSITIONAL ALIAS: the renderer still carries the pre-Triggers
  // `mission:autoCompact` listener as a fallback. Both fire for compact until
  // every consumer has moved to `trigger:context`; then this line goes.
  if (action === 'compact') {
    try { liveWebContents()?.send('mission:autoCompact'); } catch { /* window gone */ }
  }
}

/** (Re)arm both context timers from persisted config. Clear-then-arm, so calling
 *  it after a settings change, on boot, or on wake from sleep can never stack
 *  duplicates. Honors elapsed-time-since-last-run exactly like mission arming:
 *  an overdue rule fires ONCE and then settles into its steady cadence. */
function syncContextTriggers(): void {
  clearContextTimers();
  for (const action of ['compact', 'clear'] as const) {
    const rule = contextRule(action);
    if (!rule.enabled || !(rule.everyMs > 0)) continue;
    const fire = (): void => {
      try {
        stampContextRun(action);
        // Re-read: the operator may have edited the message/thresholds since the
        // timer was armed, and the renderer should act on what's current.
        emitContextTrigger(action, contextRule(action));
      } catch (e) {
        console.error('[triggers] context', action, e);
      }
    };
    const remaining = Math.max(0, rule.everyMs - (Date.now() - contextLastRunAt(action)));
    const entry: MissionTimer = {};
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, rule.everyMs);
    }, remaining);
    contextTimers.set(action, entry);
  }
}

/** Startup migration (#57/#58): archive every agent entry that is `archived:false`
 *  but has NO live PTY. This runs in bootstrapHiveServices, BEFORE the renderer can
 *  respawn anything, so at this point NO agent owns a PTY — every `archived:false`
 *  entry is therefore a stale carry-over from a prior session that quit/crashed
 *  WITHOUT archiving (e.g. the pre-acc13a3 'assistant' Dwight entry). Left as-is
 *  they have no live PTY, so the breaker beat steers them and the steer bounces to
 *  GOD as a requires_reply GOD can't clear → inbox flood.
 *
 *  "No live PTY" = ptyForAgent(id) === undefined (ptyToAgent is populated only at
 *  spawn and pruned on teardown). God is never archived. A user's real agents are
 *  unaffected: the "restore team" flow respawns them through ensureAgent, which
 *  re-clears `archived` — restorability does not depend on the archived flag. */
function archiveOrphanedAgents(): void {
  if (!hive.enabled()) return;
  try {
    const reg = hive.registry();
    for (const [id, a] of Object.entries(reg.agents)) {
      if (a.archived) continue;
      if (id === reg.godId) continue;        // god is never archived
      if (ptyForAgent(id)) continue;         // has a live PTY → genuinely active
      hive.setArchived(id, true);            // stale archived:false orphan → archive
      console.log('[migration] archived orphaned agent (no live PTY):', id);
    }
  } catch (e) {
    console.error('[migration] archiveOrphanedAgents failed:', e);
  }
}

/** One-time migration: ensure the built-in hourly ops standup exists for installs
 *  that predate it. Guarded by `opsStandupSeeded` so a user who later deletes the
 *  mission doesn't get it re-added on every boot. Stamps lastFiredAt = now so the
 *  first standup waits a full interval instead of firing (and compacting every
 *  terminal) immediately on launch. */
function ensureDefaultMissions(): void {
  const cfg = readConfig();
  if (!cfg.opsStandupSeeded) {
    const missions = cfg.missions ?? [];
    const has = missions.some((m) => m.id === OPS_STANDUP_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...OPS_STANDUP_MISSION, lastFiredAt: Date.now() }],
      opsStandupSeeded: true
    });
  }
  // Seed the built-in heartbeat (Lane A #1) once. Shipped DISABLED, so it just
  // appears in the SCHEDULES panel for the user to turn on; lastFiredAt = now so
  // it doesn't fire on the very first launch after a user enables it.
  const cfg2 = readConfig();
  if (!cfg2.heartbeatSeeded) {
    const missions = cfg2.missions ?? [];
    const has = missions.some((m) => m.id === HEARTBEAT_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...HEARTBEAT_MISSION, lastFiredAt: Date.now() }],
      heartbeatSeeded: true
    });
  }

  // maint-1 RETIREMENT: `compact-maintenance` is no longer a mission. Scheduled
  // compaction is now the CONTEXT TRIGGER's job, so the operator has exactly one
  // control (a cadence + a pressure gate + an editable message) instead of two
  // that could disagree — a mission saying "hourly" while the trigger said "2h"
  // was a real, unresolvable conflict.
  //
  // The carry-over preserves the operator's decisions: whether compaction was ON
  // and how often. It runs at most once per install, and its guard is the
  // mission's own ABSENCE — nothing seeds `compact-maintenance` any more, so once
  // this has removed it there is nothing left to carry and a later hand-edit of
  // the trigger can never be clobbered. That keeps the `*Seeded` convention's
  // promise (exactly once, ever) without a config flag that would only ever be
  // read here; `compactMaintenanceSeeded` is left set so nothing re-seeds it.
  const cfg3 = readConfig();
  const missions3 = cfg3.missions ?? [];
  const retiring = missions3.find((m) => m.id === COMPACT_MAINTENANCE_MISSION.id);
  if (retiring) {
    const current = cfg3.contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
    writeConfig({
      missions: missions3.filter((m) => m.id !== COMPACT_MAINTENANCE_MISSION.id),
      contextTrigger: {
        ...current,
        compact: {
          ...current.compact,
          enabled: retiring.enabled,
          // A hand-tuned interval is a decision; only a missing/absurd one falls
          // back to whatever the trigger already carries.
          everyMs: retiring.intervalMs > 0 ? retiring.intervalMs : current.compact.everyMs
        }
      },
      compactMaintenanceSeeded: true
    });
    // …and its elapsed time, so retiring the mission mid-cycle doesn't restart a
    // 2h cadence from zero (the timers honour last-run exactly as arming did).
    if (typeof retiring.lastFiredAt === 'number' && retiring.lastFiredAt > 0) {
      const map = contextRunMap();
      map.compact = retiring.lastFiredAt;
      try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB best-effort */ }
    }
    console.log('[triggers] retired the compact-maintenance mission into contextTrigger.compact',
      `(enabled: ${retiring.enabled}, everyMs: ${retiring.intervalMs})`);
  }

  // autoCompact RETIREMENT: the flag above was only ever half-removed. Retiring
  // `compact-maintenance` left `autoCompact: true` sitting on the ops standup, so
  // a default install still asked for compaction on TWO cadences — hourly from the
  // standup, 2-hourly from the trigger — which is precisely the disagreement that
  // retirement claims to have ended. (config.ts even documented a migration that
  // strips this; it did not exist.)
  //
  // Strip it wherever it survives. This is a pure de-duplication, not a behaviour
  // change: contextTrigger.compact still runs, still on the user's own cadence and
  // pressure gate, and it is what actually performed every one of these
  // compactions already — both paths have called emitContextTrigger since Triggers
  // landed. Idempotent, so it costs one no-op scan per boot once clean.
  const cfg4 = readConfig();
  const missions4 = cfg4.missions ?? [];
  if (missions4.some((m) => m.autoCompact)) {
    writeConfig({
      missions: missions4.map(({ autoCompact, ...rest }) => {
        void autoCompact;
        return rest;
      })
    });
    console.log('[triggers] dropped the legacy per-mission autoCompact flag —',
      'contextTrigger.compact is now the only schedule that compacts');
  }
}

// ─── Heartbeat (Lane A #1) + circuit-breaker beat (#6.6b) ────────────────────

/** Is the floor quiet? Derived ONLY from signals the main process owns or can
 *  stat — log.jsonl mtime (the master signal: every routed msg/drain/spawn/task
 *  append touches it), each agent's inbox + outbox/.sent mtimes, and every live
 *  PTY's lastOutputAt (an agent printing/thinking counts as activity). Crucially
 *  NOT registry.status, which is written 'idle' once at spawn and never
 *  transitions in main — reading it would see the floor quiet forever. */
function isFloorQuiet(thresholdMs: number): boolean {
  const root = hive.root();
  if (!root) return false;
  const times: number[] = [];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  pushMtime(join(root, 'log.jsonl'));
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      pushMtime(join(agentsDir, id, 'inbox'));
      pushMtime(join(agentsDir, id, 'outbox', '.sent'));
    }
  }
  for (const t of ptyManager.list()) times.push(t.lastOutputAt);
  if (times.length === 0) return false; // nothing to judge → don't fire
  return Date.now() - Math.max(...times) > thresholdMs;
}

/** Newest coordination-file mtime for one agent (inbox + inbox/.done, outbox +
 *  outbox/.sent, memory.md) — FILES only, deliberately excluding PTY output, so
 *  "no-progress" means "not coordinating" even while the agent is busy printing
 *  tokens. inbox/.done and the outbox dir count because handling mail (moving a
 *  message to .done, drafting an outbox message) IS coordination — without them
 *  an inbox-ack turn reads as no-progress (issue #109's second trigger). */
function lastCoordinationAt(agentId: string): number {
  const root = hive.root();
  if (!root) return 0;
  const times: number[] = [0];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  const dir = join(root, 'agents', agentId);
  pushMtime(join(dir, 'inbox'));
  pushMtime(join(dir, 'inbox', '.done'));
  pushMtime(join(dir, 'outbox'));
  pushMtime(join(dir, 'outbox', '.sent'));
  pushMtime(join(dir, 'memory.md'));
  return Math.max(...times);
}

/** PTY id owning a given agent id, or undefined. */
function ptyForAgent(agentId: string): string | undefined {
  for (const [ptyId, a] of ptyToAgent) if (a === agentId) return ptyId;
  return undefined;
}

/** "Stuck" = some worker's PTY is actively printing (recent output) while its
 *  coordination files have gone stale — working-but-not-coordinating. Tightens
 *  the heartbeat cadence so we notice a wedged agent sooner. */
function looksStuck(windowMs: number): boolean {
  const reg = hive.registry();
  const now = Date.now();
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived || id === reg.godId) continue;
    const ptyId = ptyForAgent(id);
    if (!ptyId) continue;
    const idle = ptyManager.idleFor(ptyId) ?? Infinity;
    if (idle < 15_000 && now - lastCoordinationAt(id) > windowMs) return true;
  }
  return false;
}

/** Bounded digest for god — paths + counts, never full files (reference-passing,
 *  #6.2). A few hundred tokens at most. */
function buildHeartbeatDigest(quietMs: number, actionable = 0): string {
  const reg = hive.registry();
  const active = Object.entries(reg.agents).filter(([id, a]) => !a.archived && id !== reg.godId);
  const names = active.map(([, a]) => a.name).join(', ') || '—';
  const boardHead = hive.board().split('\n').slice(0, 10).join('\n').trim();
  const log = hive.logTail(8).map((e) => { try { return JSON.stringify(e); } catch { return ''; } }).filter(Boolean).join('\n');
  const withInbox = active.filter(([id]) => hive.inbox(id).length > 0).map(([, a]) => a.name);
  // When real agent/human mail is waiting, lead with an explicit call-to-action
  // instead of the "quiet" line — this beat fired BECAUSE of unread actionable
  // inbox, not because the floor went quiet, and god must read it now.
  const header = actionable > 0
    ? `Floor heartbeat — ${actionable} actionable inbox message(s) awaiting you (worker/human mail). Drain your inbox NOW and act on them.`
    : `Floor heartbeat — quiet ~${Math.round(quietMs / 60000)}m.`;
  return [
    header,
    `Active agents (${active.length}): ${names}.`,
    withInbox.length ? `Undrained inbox: ${withInbox.join(', ')}.` : 'No undrained inboxes.',
    '',
    'Board (head):',
    boardHead || '(empty)',
    '',
    'Recent log:',
    log || '(none)',
    '',
    'Re-engage anyone stalled or blocked and keep the board accurate — or rest if the work is genuinely done.'
  ].join('\n');
}

/** Senders whose mail is the scheduler's OWN noise (heartbeat beats, ops-standup
 *  via 'scheduler', breaker steers, generic 'system') — never a reason to wake
 *  god. Everything else (a worker agent id, 'webhook', a human reply) is real
 *  mail god must act on. Kept narrow so any future real sender counts by default. */
const SYSTEM_SENDERS = new Set(['heartbeat', 'scheduler', 'breaker', 'system']);

/** Count of UNREAD actionable messages in god's inbox — real agent/human mail,
 *  excluding the scheduler's own beats. Drives an inbox-aware re-engage so a
 *  worker's reply (or a human answer) doesn't sit unread while the floor is busy:
 *  the floor-quiet gate alone misses that case — any active agent keeps the floor
 *  "loud", so god was never re-engaged until everything else went idle. */
function godActionableInboxCount(): number {
  try {
    const godId = hive.registry().godId;
    if (!godId) return 0;
    return hive.inbox(godId).filter((m) => !SYSTEM_SENDERS.has(m.from)).length;
  } catch { return 0; }
}

/** Re-engage a quiet floor: drop a durable digest into god's inbox. We never
 *  type directly into god's PTY here — if he's busy that would jam mid-step. The
 *  inbox message is delivered by the renderer's busy-aware inbox-wake (it nudges
 *  god to read his inbox only once he's idle), so the heartbeat defers around a
 *  working god instead of interrupting him. */
function reengageGod(digest: string): void {
  if (!hive.enabled()) return;
  hive.send({ to: 'god', act: 'request', subject: 'Heartbeat', body: digest }, 'heartbeat');
}

/** A native toast for breaker constrain/stop, gated on the notifications setting. */
function breakerToast(title: string, body: string): void {
  if (!readConfig().notifications) return;
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); }
  catch { /* unsupported platform */ }
}

/** One circuit-breaker beat: pull a fresh usage sample per active agent, append
 *  it to the durable cost ledger (the SOLE durable cost store), tick the breaker,
 *  emit each BreakerState on control:breakerState (Seam 2), and enforce any
 *  escalation. God is in the LEDGER (cost visibility) but NOT the breaker inputs
 *  (the heartbeat manages god; we never auto-steer/kill the orchestrator). */
function runBreakerBeat(progressWindowMs: number): void {
  if (!hive.enabled()) return;
  const reg = hive.registry();
  const now = Date.now();
  const inputs: BreakerInput[] = [];
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived) continue;
    // #57/#58: skip assistant + orphaned shells. The breaker must only evaluate
    // live, real agents. An assistant entry (e.g. the pre-acc13a3 headless
    // 'Dwight') or any orphaned entry left archived:false with NO live PTY would
    // otherwise be steered, and that steer bounces to GOD as a requires_reply GOD
    // can't clear → inbox flood. ptyForAgent(id) === undefined means no live PTY.
    // God is exempt from this orphan check (it keeps its own flow + the godId skip
    // below) so its ledger row is unaffected. Live real agents always own a PTY
    // (ptyToAgent is set at spawn), so their breaker behavior is unchanged.
    if (a.isAssistant) continue;
    if (id !== reg.godId && !ptyForAgent(id)) continue;
    const sample = usageProvider.getAgentUsage(id);
    // #56: only append a ledger row for a LIVE session sample. A dead/orphaned
    // agent with a frozen transcript still yields a sample via the transcript
    // fallback, but with an EMPTY sessionId (aggregateLive returns null → no live
    // OTel session). Appending it every ~30s rewrote the identical row forever
    // (2,417 dupes observed). A truthy sessionId is set only by a live session
    // (aggregateLive picks the most-recent live session id), so this gates on
    // "is there a live session" without changing any live-agent behavior.
    if (sample?.sessionId) hive.appendCostLedger(sample); // ledger covers everyone incl. god
    // Second source for the resume key. recordSession() is otherwise reachable
    // ONLY from the hook shim, so any window where hooks don't land leaves the
    // registry with no sessionId and "Restart & Continue" refuses to continue —
    // while this very sample proves the app knew the live session id all along
    // (it was already being written to the cost ledger one line above). Same id,
    // same liveness gate; recordSession writes only on change, so this is a
    // no-op once the hooks are flowing.
    if (sample?.sessionId) hive.recordSession(id, sample.sessionId);
    if (id === reg.godId) continue;            // breaker skips god
    // Progress = fresh coordination files OR a recent OTel tool span. The span
    // leg closes the background-work blind spot: subagent/Workflow tool calls
    // never reach the parent session's PostToolUse hook (so the breaker's own
    // distinct-tool clock stays stale) but their spans DO flow through the
    // collector under this agent's id — an idle parent supervising a hard-
    // working background fleet is progressing, not wedged. Observed live: the
    // one residual no-progress false positive after the #109 fixes.
    const spans = telemetry.getSpans(id);
    const lastSpanAt = spans.length ? spans[spans.length - 1].ts : 0;
    inputs.push({
      agentId: id,
      sample,
      progressing: now - lastCoordinationAt(id) < progressWindowMs || now - lastSpanAt < progressWindowMs
    });
  }
  for (const d of breaker.tick(inputs, now)) {
    try { liveWebContents()?.send('control:breakerState', d.state); } catch { /* window gone */ }
    if (d.action === 'none') continue;
    const name = reg.agents[d.state.agentId]?.name ?? d.state.agentId;
    const reason = d.state.reason;
    if (d.action === 'steer') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: steer',
        body: `Automated guardrail: ${reason}. Re-check your approach — if you're looping or stuck, STOP repeating, summarize what you've tried, and ask Abathur for direction.` }, 'breaker');
    } else if (d.action === 'constrain') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: constrain',
        body: `Automated guardrail escalated: ${reason}. Stop active work now: switch to read-only/plan, write a short plan of your next step, and send it to Abathur for sign-off BEFORE running more tools.` }, 'breaker');
      breakerToast(`${name} constrained`, reason);
    } else if (d.action === 'stop') {
      const ptyId = ptyForAgent(d.state.agentId);
      if (ptyId) { try { ptyManager.kill(ptyId); } catch { /* already gone */ } teardownPty(ptyId); }
      breakerToast(`${name} stopped by circuit breaker`, reason);
    }
  }
}

/** Lifetime spend, folded from cost-ledger.jsonl. `telemetry`'s usd counter is
 *  cumulative-since-process-start and restarts at ~0 on every app restart, so
 *  it cannot answer "what has this agent cost us". See costLifetime.ts. */
const costTotals = new CostLedgerTotals();

/** Build + write the live fleet snapshot Abathur reads (`<hive>/fleet.json`).
 *  Always-on (independent of the heartbeat) since `claude agents` can't see the
 *  hive's sibling sessions. PII-free; never throws (called from a timer). */
function writeFleetSnapshot(): void {
  if (!hive.enabled()) return;
  try {
    const reg = hive.registry();
    const snap = telemetry.snapshot();
    const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
    const now = Date.now();
    // Async + incremental; returns immediately and never throws into the timer.
    const hiveRoot = hive.root();
    if (hiveRoot) void costTotals.refresh(join(hiveRoot, 'cost-ledger.jsonl'));
    const agents = Object.entries(reg.agents)
      .filter(([, a]) => !a.archived)
      .map(([id, a]) => {
        const u = usageById.get(id);
        const spans = snap.spans[id] ?? [];
        // For Claude agents, use telemetry data; for non-Claude agents (agy, etc.),
        // fall back to PTY-parsed data when telemetry is unavailable
        const telemetryTokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
        const ptyTokens = lastAgentPtyTokens.get(id) ?? 0;
        const tokens = telemetryTokens > 0 ? telemetryTokens : ptyTokens;
        // `usd` is LIFETIME (reset-corrected). Until the first fold completes we
        // fall back to the session figure rather than publishing a cold $0.
        const lifetime = costTotals.usdFor(id);
        const telemetryUsd = u ? Number(u.usd.toFixed(4)) : 0;
        const ptyUsd = lastAgentPtyCost.get(id) ?? 0;
        const sessionUsd = telemetryUsd > 0 ? telemetryUsd : ptyUsd;
        const ptyId = ptyForAgent(id);
        const ptyLastOutput = ptyId ? ptyManager.lastOutputAt(ptyId) : undefined;
        const lastPty = Math.max(ptyLastOutput ?? 0, lastAgentPtyActivityMs.get(id) ?? 0);
        const lastActiveMs = Math.max(u?.ts ?? 0, lastPty);
        const isWorking = lastActiveMs > 0 && (now - lastActiveMs) <= 3000;
        const agentStatus = isAgentCompacting(id)
          ? 'compacting'
          : isWorking ? 'working' : (lastAgentStatus.get(id) ?? (a.status || 'idle'));
        const agentLastTool = lastAgentTool.get(id) ?? (spans.length ? spans[spans.length - 1].tool : null);
        const ptyCtx = lastAgentPtyCtx.get(id);
        let quotaLimited = lastAgentQuotaLimited.get(id) ?? false;
        const quotaResetsAt = lastAgentQuotaResetsAt.get(id) ?? null;
        // Auto-recover: once the parsed reset time passes, clear the flag so the
        // badge and status drop on their own without waiting for fresh PTY output.
        if (quotaLimited && quotaResetsAt && now >= quotaResetsAt) {
          quotaLimited = false;
          lastAgentQuotaLimited.delete(id);
          lastAgentQuotaResetsAt.delete(id);
        }
        return {
          id,
          name: a.name,
          role: a.role ?? (a.isOvermind ? 'orchestrator' : 'agent'),
          cwd: a.cwd,
          isOvermind: !!a.isOvermind,
          breaker: breaker.levelFor(id),
          tokens,
          usd: lifetime === null ? sessionUsd : Number(lifetime.toFixed(4)),
          sessionUsd,
          status: agentStatus,
          lastTool: agentLastTool,
          lastActiveSecAgo: lastActiveMs > 0 ? Math.round((now - lastActiveMs) / 1000) : null,
          inboxBacklog: hive.inboxBacklog(id),
          onHold: !!a.onHold,
          profileId: a.profileId ?? null,
          provider: a.provider ?? 'claude',
          model: u?.model ?? null,
          ctxPct: ptyCtx ?? (u?.contextWindow?.percentage ? Math.round(u.contextWindow.percentage * 100) : null),
          quotaLimited,
          quotaResetsAt
        };
      });
    hive.writeFleetSnapshot({ ts: now, agents });
    // Push per-agent token data to renderer for non-Claude agents (Antigravity, Gemini)
    // that don't emit Claude Code hook events. The renderer uses this as fallback when
    // useFleetTelemetry samples are missing.
    const fleetTokenMap: Record<string, { tokens: number; ctxPct: number | null; usd: number; quotaLimited?: boolean; quotaResetsAt?: number | null }> = {};
    for (const a of agents) {
      fleetTokenMap[a.id] = { tokens: a.tokens, ctxPct: a.ctxPct, usd: a.sessionUsd, quotaLimited: a.quotaLimited, quotaResetsAt: a.quotaResetsAt };
    }
    try { liveWebContents()?.send('hive:fleetTokens', fleetTokenMap); } catch { /* window torn down */ }
  } catch (e) {
    console.error('[fleet] snapshot failed:', e);
  }
}

/** Arm the heartbeat with an adaptive, self-rescheduling cadence (recursive
 *  setTimeout instead of a fixed setInterval). Each beat runs the cost/breaker
 *  pass, re-engages a quiet floor, stamps lastFiredAt, then re-arms: ~base on a
 *  normal beat, base/4 (min 30s) when an agent looks stuck, base*2.5 right after
 *  a re-engage. Registered into missionTimers so shutdown tears it down. */
function armHeartbeat(m: ScheduledMission): void {
  const base = m.intervalMs;
  const quiet = m.quietThresholdMs ?? 300_000;
  const beat = (): void => {
    let next = base;
    try {
      // (the breaker beat + cost ledger now run on their own always-on timer)
      // Re-engage god when the floor is quiet OR when real agent/human mail is
      // waiting in god's inbox — the latter is independent of floor-quiet so a
      // worker's reply doesn't sit unread while other agents keep the floor busy.
      const actionable = godActionableInboxCount();
      if (isFloorQuiet(quiet) || actionable > 0) {
        reengageGod(buildHeartbeatDigest(quiet, actionable));
        next = Math.round(base * 2.5);            // back off after re-engaging
      } else if (looksStuck(quiet)) {
        next = Math.max(30_000, Math.round(base / 4)); // tighten when an agent is wedged
      }
      const cur = readConfig().missions ?? [];
      writeConfig({ missions: cur.map((x) => (x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x)) });
      try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
    } catch (e) {
      console.error('[heartbeat]', e);
    }
    const entry = missionTimers.get(m.id) ?? {};
    entry.timeout = setTimeout(beat, next);
    missionTimers.set(m.id, entry);
  };
  const remaining = Math.max(0, base - (Date.now() - (m.lastFiredAt ?? 0)));
  missionTimers.set(m.id, { timeout: setTimeout(beat, remaining) });
}

/** The live renderer webContents, or null if the window is gone/destroyed.
 *  Anything that emits to the renderer from a timer/socket/child callback must
 *  route through here — during quit the window can be destroyed while those
 *  callbacks are still in flight, and `.send()` on a destroyed webContents
 *  throws "Object has been destroyed" (the main-process crash dialog). */
function liveWebContents(): Electron.WebContents | null {
  const wc = mainWindow?.webContents;
  if (wc && !wc.isDestroyed()) return wc;
  // Primary gone (closed/destroyed): fall back to any other live window so a
  // global event still reaches a renderer instead of being silently dropped.
  for (const w of allWindows) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
  }
  return null;
}

// ─── Slack webhook server (Slack message → Abathur's queue) ──────────────────
/** The running Slack ingestion server, or null when disabled/stopped. */
let slackServer: SlackWebhookServer | null = null;
/** The loopback-only reply endpoint (lets the bundled helper post back to Slack
 *  without ever seeing the bot token). Lifecycle is tied to `slackServer`. */
let slackReplyServer: SlackReplyServer | null = null;
/** Last public tunnel URL handed out — persisted so Settings can re-show the
 *  Request URL after a reopen (Slack reuses it until the server is stopped). */
let lastSlackUrl: string | undefined;

/** AUTONOMOUS REQUEST PROTOCOL — built PER MESSAGE (not a static const) so it can
 *  embed the request's concrete `channel`, `thread_ts`, and the resolved helper
 *  path. Prepended (server-side, authoritatively) to the working instruction god
 *  reads for any Slack-origin request: there is no interactive human at the
 *  keyboard, so god must route fast, delegate WITH the exact reply command (so the
 *  worker posts its real result back into THIS thread itself), stay autonomous,
 *  and only block on enumerated high-severity actions. Prepended to god's PROMPT
 *  only — the human-facing kanban card TITLE stays the user's raw text (the
 *  renderer keeps them split). Trailing space is intentional so the user's message
 *  reads naturally after it. */
function buildAutonomousRequestProtocol(channel: string, threadTs: string, helperPath: string): string {
  return `[AUTONOMOUS REQUEST PROTOCOL — this request arrived via Slack; no interactive human is watching] Handle it under this protocol:
1. ROUTE FAST — triage and hand this to the single most-relevant agent right away. CHECK THE LIVE ROSTER FIRST (active agents in registry.json + their state in fleet.json) and prefer an EXISTING agent that fits — especially when the request names one ("ask Pam…", "have Jim…"): route to that agent and only spawn a new one if none is a sensible fit. Decompose only if it genuinely needs several. Don't sit on it.
2. DELEGATE WITH THE REPLY HANDLE — tell that agent to do the work autonomously AND to post its result back to THIS Slack thread itself when done, using exactly: "${hive.nodeCommand()}" "${helperPath}" --channel ${channel} --thread ${threadTs} --text "<substantive result>" (that first path is the harness's bundled Node, already resolved for this machine — pass it verbatim; bare "node" is not on the hook/agent PATH on many machines.)
3. AUTONOMOUS EXECUTION — no interactive questions. PAUSE/ask ONLY for high-severity actions: pushing to main or any remote; buying or spawning infrastructure or paid services; deleting an existing repo, file, or folder it did not create. Stay READ-ONLY at critical infrastructure and git-push-type changes unless explicitly approved.
4. DIRECT, SUBSTANTIVE REPLY — the agent posts a real Slack-mrkdwn answer (short *bold* headline + the actual outcome/specifics/links), NEVER a bare "done"/":white_check_mark:".
5. REPORT TO ABATHUR — the agent then tells you (Abathur) what it did.
6. ASYNC QUESTIONS — if a decision is genuinely needed, don't block: post the question + numbered OPTIONS to the thread via that reply command, and record {q, options, askedAt (ISO + day & time), thread_ts ${threadTs}} so the threaded human reply correlates back and resumes.
The user's message starts now: `;
}

// ─── Slack done-notifier (Slack-origin task → done → one summary reply) ───────
/** Polls the shared kanban (hive/tasks.json) for Slack-origin tasks that reach
 *  'done' and posts ONE summary reply into the originating thread. Lifecycle is
 *  tied to `slackServer`. OUTBOUND-only: it never touches inbound queue/lanes. */
let slackDoneTimer: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard so a slow post can't overlap the next tick. */
let slackDonePolling = false;
/** Task ids already notified — exactly-once across re-reads AND restarts. Lazily
 *  loaded from / persisted to `slackDoneNotifiedPath()`. */
let slackDoneNotified: Set<string> | null = null;
/** Ids already 'done' when the observer started — baselined (never notified) so a
 *  summary only ever fires on a live …→done transition, not on pre-existing dones. */
let slackDoneBaseline: Set<string> | null = null;
/** thread_ts values an agent has ALREADY answered directly via the loopback
 *  `/reply` endpoint. The done-summary poller skips these — the agent's own
 *  substantive reply already landed in-thread, so the poller is a fallback, not a
 *  duplicator (this is what stops the bare/duplicate `:white_check_mark:` posts). */
const directlyRepliedThreads = new Set<string>();

/** Absolute path to the bundled `md-slack-reply.cjs` helper. Packaged: under
 *  `process.resourcesPath` (electron-builder extraResources). Dev: the repo's
 *  `resources/` dir, resolved from the app path. */
function slackReplyScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'md-slack-reply.cjs')
    : join(app.getAppPath(), 'resources', 'md-slack-reply.cjs');
}

/** W3 — the bundled read-only `skills/` source dir copied into each agent's
 *  `.claude/skills/` at spawn. Same packaged/dev resolution as the helpers above.
 *  Tolerated-missing until lp-manifest (Kevin) populates it (the hive copy is a
 *  no-op on an absent dir). */
function skillsResourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills');
}

/** Where the helper discovers `{ port, token }` for the loopback endpoint. Kept
 *  under userData (NOT the git repo, NOT mined into MemPalace). */
function slackReplyConfigPath(): string {
  return join(app.getPath('userData'), 'slack-reply.json');
}

/** Ledger of task ids whose done-summary has already been posted. Ids ONLY — no
 *  secret ever lands here. Under userData (out of the repo, out of MemPalace). */
function slackDoneNotifiedPath(): string {
  return join(app.getPath('userData'), 'slack-done-notified.json');
}

/** Directory where downloaded Slack attachments are saved (out of repo, out of MemPalace). */
function slackFilesDir(): string {
  return join(app.getPath('userData'), 'slack-files');
}

/** Per-file download size cap — reject files larger than 10 MB before writing. */
const SLACK_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Sanitize a Slack filename: keep only the basename, replace non-safe chars,
 *  prefix with a random hex tag to prevent collisions and path-traversal attacks. */
function sanitizeSlackFilename(name: string | undefined, tag: string): string {
  const safe = (typeof name === 'string' && name)
    ? basename(name).replace(/[^\w.\-]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'file'
    : 'file';
  return `${tag}-${safe}`;
}

/**
 * Download a single Slack private file into slackFilesDir() using the bot token.
 * Returns the local path on success, null on any failure (size limit, network, etc.).
 * The bot token is used only in the Authorization header and is NEVER logged.
 */
function downloadSlackFile(
  file: SlackEventFile,
  botToken: string,
  destDir: string
): Promise<{ path: string; name: string; mimetype: string } | null> {
  return new Promise((resolve) => {
    const tag = randomBytes(4).toString('hex');
    const filename = sanitizeSlackFilename(file.name, tag);
    const destPath = join(destDir, filename);
    const name = file.name ?? filename;
    const mimetype = file.mimetype ?? 'application/octet-stream';

    try {
      mkdirSync(destDir, { recursive: true });
    } catch {
      resolve(null);
      return;
    }

    let urlObj: URL;
    try {
      urlObj = new URL(file.url_private);
    } catch {
      resolve(null);
      return;
    }
    if (urlObj.protocol !== 'https:') { resolve(null); return; }

    const req = httpsRequest(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET',
        headers: { authorization: `Bearer ${botToken}` } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume(); // drain response body
          resolve(null);
          return;
        }
        let written = 0;
        let aborted = false;
        const stream = createWriteStream(destPath);
        res.on('data', (chunk: Buffer) => {
          if (aborted) return;
          written += chunk.length;
          if (written > SLACK_FILE_MAX_BYTES) {
            aborted = true;
            stream.destroy();
            try { unlinkSync(destPath); } catch { /* best-effort cleanup */ }
            res.destroy();
            resolve(null);
            return;
          }
          stream.write(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          stream.end(() => resolve({ path: destPath, name, mimetype }));
        });
        res.on('error', () => { stream.destroy(); resolve(null); });
        stream.on('error', () => { res.destroy(); resolve(null); });
      }
    );
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Download all raw Slack files (up to cap) and return the local-path file list.
 * Failures are silently dropped — a partial list is still useful to the agent.
 */
async function downloadSlackFiles(
  rawFiles: SlackEventFile[],
  botToken: string | undefined
): Promise<{ path: string; name: string; mimetype: string }[]> {
  if (!rawFiles.length || !botToken) return [];
  const destDir = slackFilesDir();
  const results = await Promise.all(
    rawFiles.map((f) => downloadSlackFile(f, botToken, destDir))
  );
  return results.filter((r): r is { path: string; name: string; mimetype: string } => r !== null);
}

function loadSlackDoneNotified(): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(slackDoneNotifiedPath(), 'utf8'));
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch { /* missing/corrupt → start empty */ }
  return new Set();
}

function persistSlackDoneNotified(set: Set<string>): void {
  try { writeFileSync(slackDoneNotifiedPath(), JSON.stringify([...set])); }
  catch (e) { console.error('[slack] could not persist done-notify ledger:', e); }
}

/** Slack `chat.postMessage` errors that are permanent for this config — retrying
 *  can never make them succeed, so a failed post with one of these is recorded
 *  (not retried) to avoid flooding the log every 5s. Anything else is treated as
 *  transient and left to retry. */
const TERMINAL_SLACK_ERRORS = new Set<string>([
  'missing_scope', 'invalid_auth', 'not_authed', 'account_inactive',
  'token_revoked', 'token_expired', 'no_permission', 'channel_not_found',
  'not_in_channel', 'is_archived', 'restricted_action', 'org_login_required',
]);

/** The single in-thread summary for a finished task. Sourced from the task's
 *  result/description (falling back to the title), trimmed Slack-friendly. */
function slackDoneSummary(task: HiveTask): string {
  const body = (task.result ?? task.description ?? '').trim();
  const head = `:white_check_mark: *${task.title}*`;
  const text = body ? `${head}\n\n${body}` : head;
  return text.length > 2800 ? `${text.slice(0, 2799)}…` : text;
}

/** One observation pass over the kanban. Posts a summary for any Slack-origin
 *  task that has newly reached 'done'. Best-effort and self-guarding — it must
 *  never throw into the timer, and the bot token never leaves this function. */
async function pollSlackDoneTasks(): Promise<void> {
  if (slackDonePolling) return;
  const botToken = readConfig().slackBotToken;
  if (!botToken) return; // can't post without the token — nothing to do
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return; } // unreadable/missing tasks.json → skip this tick

  const notified = slackDoneNotified ?? (slackDoneNotified = loadSlackDoneNotified());

  // First tick seeds the baseline (ids already done) and posts nothing — so we
  // only ever fire on a transition observed live this session.
  if (slackDoneBaseline === null) {
    slackDoneBaseline = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    return;
  }
  const baseline = slackDoneBaseline;

  slackDonePolling = true;
  try {
    for (const t of tasks) {
      if (t.status !== 'done') continue;
      if (baseline.has(t.id) || notified.has(t.id)) continue; // already handled
      const slack = t.slack;
      if (!slack || !slack.channel || !slack.thread_ts) continue; // non-Slack-origin → leave alone
      // FALLBACK-ONLY: if the agent already posted a DIRECT reply into this thread
      // (loopback /reply), the human has its substantive answer — don't double-post.
      if (directlyRepliedThreads.has(slack.thread_ts)) { notified.add(t.id); persistSlackDoneNotified(notified); continue; }
      // Never post a bare `:white_check_mark: *title*` with no substance: if the card
      // carries neither a result nor a description, there is nothing meaningful to
      // deliver — skip it (still under the FALLBACK contract).
      if (!(t.result ?? t.description ?? '').trim()) { notified.add(t.id); persistSlackDoneNotified(notified); continue; }
      const res = await postSlackReply({
        botToken, channel: slack.channel, thread_ts: slack.thread_ts, text: slackDoneSummary(t)
      });
      if (res.ok) {
        notified.add(t.id);
        persistSlackDoneNotified(notified); // mark-on-success → exactly one delivered reply
      } else if (res.error && TERMINAL_SLACK_ERRORS.has(res.error)) {
        // A permanent config/auth error (e.g. the bot token lacks `chat:write`)
        // will NEVER succeed — record the id so we stop hammering every tick, and
        // log the reason once. Never log the token or message body.
        notified.add(t.id);
        persistSlackDoneNotified(notified);
        console.error('[slack] done-summary post for task', t.id,
          '— giving up (terminal error:', res.error + '). Fix the Slack bot scope/permissions; later tasks post once resolved.');
      } else {
        // Transient (network / rate-limit / unknown) → leave unmarked so a later
        // tick retries. Log the id + error only; never the token or message body.
        console.error('[slack] done-summary post failed for task', t.id, '-', res.error, '(will retry)');
      }
    }
  } finally {
    slackDonePolling = false;
  }
}

/** Begin watching the kanban for Slack-origin done-transitions (idempotent). */
function startSlackDoneObserver(): void {
  if (slackDoneTimer) return;
  slackDoneNotified = loadSlackDoneNotified();
  slackDoneBaseline = null; // re-seed on the first tick of this session
  slackDoneTimer = setInterval(() => { void pollSlackDoneTasks(); }, 5000);
}

/** Stop watching the kanban. Safe to call when not running. */
function stopSlackDoneObserver(): void {
  if (slackDoneTimer) { clearInterval(slackDoneTimer); slackDoneTimer = null; }
  slackDoneBaseline = null;
}

/** Build a SlackWebhookServer from the current config and start it, replacing
 *  any running instance, and return the start result (incl. the public tunnel
 *  URL the user pastes into Slack). No-op + error result when the integration is
 *  disabled or the signing secret is unset. */
async function startSlackServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) {
    return { ok: false, error: 'slack disabled or missing signing secret' };
  }
  slackServer?.stop();
  slackServer = new SlackWebhookServer({
    port: app.isPackaged ? (cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847) : 3947,
    signingSecret: cfg.slackSigningSecret,
    channelId: cfg.slackChannelId,
    // Fires from the HTTP server's event loop (not the IPC thread); route through
    // liveWebContents() so a message arriving during window teardown can't throw.
    // Downloads any file attachments (bot token stays in main; local paths go to IPC).
    onMessage: async (m) => {
      const localFiles = await downloadSlackFiles(
        m._rawFiles ?? [],
        readConfig().slackBotToken
      );
      // `text` stays the user's RAW Slack text → drives the readable kanban card
      // title. `autonomyPreamble` is the authoritative policy block the renderer
      // prepends ONLY to god's working instruction (his PTY prompt), keeping the
      // card title human-facing-clean. Built PER MESSAGE so the AUTONOMOUS REQUEST
      // PROTOCOL carries THIS request's concrete channel, thread_ts, and the
      // resolved helper path — god hands the worker an exact reply command.
      // Server-side so it applies to every session.
      const ipcMsg: { text: string; channel: string; ts: string; thread_ts: string; autonomyPreamble: string; files?: typeof localFiles } = {
        text: m.text, channel: m.channel, ts: m.ts, thread_ts: m.thread_ts,
        autonomyPreamble: buildAutonomousRequestProtocol(m.channel, m.thread_ts, slackReplyScriptPath())
      };
      if (localFiles.length > 0) ipcMsg.files = localFiles;
      try { liveWebContents()?.send('slack:incomingMessage', ipcMsg); }
      catch { /* window torn down */ }
    }
  });
  const res = await slackServer.start();
  // ok:false means we never bound the port → drop the instance. ok:true with no
  // url just means the tunnel is unavailable; the local handler is still live.
  if (!res.ok) { slackServer = null; return res; }
  if (res.url) lastSlackUrl = res.url;
  // Bring up the loopback reply endpoint (token-gated, never tunneled) and drop
  // the discovery file for the bundled helper. Best-effort: reply path being
  // unavailable must not sink ingestion.
  await startSlackReplyServer();
  // Begin watching the kanban for Slack-origin tasks that reach 'done', to post
  // their one summary reply in-thread. OUTBOUND-only; never touches ingestion.
  startSlackDoneObserver();
  analytics.trackFeature('slack_trigger');
  return res;
}

/** Start the loopback reply endpoint and write its `{ port, token }` to userData
 *  so `md-slack-reply.cjs` can reach it. The bot token is read lazily from config
 *  at reply time and never written to this file. */
async function startSlackReplyServer(): Promise<void> {
  slackReplyServer?.stop();
  const token = randomBytes(24).toString('hex');
  slackReplyServer = new SlackReplyServer({
    token,
    getBotToken: () => readConfig().slackBotToken,
    // An agent posted a DIRECT substantive reply into this thread → record it so the
    // done-summary poller skips it (the poller is a fallback, not a duplicator).
    onReplied: (thread_ts) => { directlyRepliedThreads.add(thread_ts); }
  });
  const r = await slackReplyServer.start();
  if (!r.ok || r.port === undefined) {
    console.error('[slack] reply endpoint failed to start:', r.error);
    slackReplyServer = null;
    return;
  }
  try {
    writeFileSync(slackReplyConfigPath(), JSON.stringify({ port: r.port, token }), { mode: 0o600 });
  } catch (e) {
    console.error('[slack] could not write reply config:', e);
  }
}

/** Stop and forget the Slack server (+ reply endpoint). Best-effort; safe to call
 *  when not running. The last tunnel URL is retained so Settings keeps showing it. */
function stopSlackServer(): void {
  try { slackServer?.stop(); } catch (e) { console.error('[slack] stop failed:', e); }
  slackServer = null;
  try { slackReplyServer?.stop(); } catch (e) { console.error('[slack] reply stop failed:', e); }
  slackReplyServer = null;
  stopSlackDoneObserver();
  try { if (existsSync(slackReplyConfigPath())) unlinkSync(slackReplyConfigPath()); } catch { /* noop */ }
}

// ─── Generic inbound webhook + status API (multi-endpoint) ───────────────────
/** The running generic-webhook server, or null when disabled/stopped. A PUBLIC
 *  (tunnel-forwarded) surface — secret-gated, unlike the loopback /reply. ONE
 *  server and ONE tunnel serve EVERY configured endpoint; the id in the request
 *  path picks which. Adding a webhook therefore costs no port and no tunnel, and
 *  never disturbs a caller already pointed at another endpoint's URL. */
let webhookServer: WebhookServer | null = null;
/** Last public tunnel URL handed out — retained so Settings can re-show the
 *  endpoint after a reopen (the tunnel rotates it per restart). */
let lastWebhookUrl: string | undefined;

/** Local port the shared server binds to. The port is a property of the SERVER,
 *  not of any one trigger — `webhookPort` stays the (legacy) override. */
const WEBHOOK_DEFAULT_PORT = 3849;

/** The endpoints the operator has switched on. A disabled webhook is not merely
 *  rejected at the door — it is never handed to the server, so its id does not
 *  exist on the wire and its secret is not in memory on the request path. */
function enabledWebhookEndpoints(): WebhookTrigger[] {
  return (readConfig().webhookTriggers ?? []).filter((t) => t.enabled && !!t.secret);
}

/** SHA-256 hex of a capability token. The raw token is returned to the caller
 *  exactly once (the POST response) and never persisted; only this digest lands
 *  on the kanban card, so a GET can match without the raw token ever resting. */
function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** tokenHash → id of the `pending` history entry it belongs to.
 *
 *  A message the mode gate held has NO kanban card (the card is what approval
 *  creates), so this map is the only way its caller's GET can be answered — and
 *  answered HONESTLY, as "awaiting-approval" rather than a lie about queued work.
 *  It stores the token's DIGEST, never the token, exactly like the card stamp,
 *  and it is mirrored into the durable kv store so a restart doesn't 404 every
 *  caller that is still politely waiting on the operator. */
let heldWebhookTokens: Map<string, string> | null = null;
const HELD_TOKENS_KV_KEY = 'triggers.webhook.heldTokens';

function heldTokens(): Map<string, string> {
  if (heldWebhookTokens) return heldWebhookTokens;
  let stored: Record<string, string> | undefined;
  try { stored = persist.getKv<Record<string, string>>(HELD_TOKENS_KV_KEY); }
  catch { stored = undefined; }
  const entries = stored && typeof stored === 'object' ? Object.entries(stored) : [];
  heldWebhookTokens = new Map(entries.filter((e): e is [string, string] => typeof e[1] === 'string'));
  return heldWebhookTokens;
}

function persistHeldTokens(): void {
  try { persist.setKv(HELD_TOKENS_KV_KEY, Object.fromEntries(heldTokens())); }
  catch (e) { console.error('[webhook] could not persist held-token map:', e); }
}

/** Drop mappings whose history entry has aged out of the (capped) ledger — the
 *  operator can no longer decide them, so their tokens are dead weight. */
function pruneHeldTokens(): void {
  const map = heldTokens();
  if (map.size === 0) return;
  const live = new Set(listTriggerHistory().map((e) => e.id));
  let changed = false;
  for (const [hash, entryId] of [...map]) {
    if (!live.has(entryId)) { map.delete(hash); changed = true; }
  }
  if (changed) persistHeldTokens();
}

/** The token digest a held history entry was accepted under, if we still have it. */
function heldTokenHashFor(entryId: string): string | undefined {
  for (const [hash, id] of heldTokens()) if (id === entryId) return hash;
  return undefined;
}

/** Tell the Triggers tab its ledger moved, so history live-refreshes instead of
 *  waiting for the operator to re-open the tab. */
function notifyTriggerHistoryUpdated(): void {
  try { liveWebContents()?.send('triggerHistory:updated'); } catch { /* window gone */ }
}

/**
 * Create the stamped kanban card for an inbound message and route it to god.
 *
 * Split out of `handleWebhookMessage` because the APPROVAL path takes exactly
 * this route later — an operator saying yes must produce the same card and the
 * same god request an auto-allowed message would have, or the two paths drift
 * and "approved" quietly means something weaker than "allowed".
 *
 * Returns false only when the card — the thing the caller polls — could not be
 * written. The god routing is best-effort: the card already exists and is
 * pollable even if the send hiccups.
 */
function dispatchWebhookWork(arg: {
  taskId: string;
  title: string;
  message: string;
  /** Stamped onto the card so a GET can match the caller's token. */
  tokenHash?: string;
  /** 'webhook' | 'org' — only for the subject line and the god-facing note. */
  origin: 'webhook' | 'org';
}): boolean {
  try {
    const card: HiveTask = {
      id: arg.taskId,
      title: arg.title,
      description: arg.message,
      status: 'todo',
      dependsOn: [],
      priority: 1,
      createdAt: new Date().toISOString(),
      ...(arg.tokenHash ? { webhook: { tokenHash: arg.tokenHash } } : {})
    };
    // addTask appends against the latest on-disk ledger and is idempotent by task
    // id, so a concurrent card writer (Slack, god, voice, another webhook) can't
    // have its card lost to our stale whole-ledger overwrite. (writeTasks(...existing)
    // recreated exactly that race.) A fresh taskId never collides, so this always adds.
    hive.addTask(card);
  } catch (e) {
    console.error('[webhook] could not create task card:', e instanceof Error ? e.message : e);
    return false;
  }
  // Body carries ONLY the sender's message + the card id (so whoever finishes it
  // updates that card's status/result for the caller's GET) — never the secret,
  // never the raw token.
  try {
    hive.send({
      to: 'god',
      act: 'request',
      subject: `[${arg.origin}] ${arg.title}`,
      body: `${arg.message}\n\n(Inbound via the generic ${arg.origin} API, tracked as kanban card ${arg.taskId}. When this work is finished, set that card's status to 'done' and fill its 'result' so the caller's status check reflects the outcome.)`,
      requires_reply: false
    }, 'webhook');
  } catch (e) {
    console.error('[webhook] could not route to god:', e instanceof Error ? e.message : e);
  }
  return true;
}

/**
 * A verified POST, run through the endpoint's TriggerMode.
 *
 * `isAutoAllowed(mode, kind)` is the whole gate. When it says yes this behaves
 * exactly as the single-endpoint server always did — card, god request, capability
 * token. When it says no NOTHING reaches the hive: the message is written to the
 * ledger as `pending` and sits there until the operator decides, and the caller
 * is handed its token plus a 202 so it can watch the hold rather than believe
 * work started.
 *
 * Either way an `inbound` history row is recorded. The secret never reaches here
 * (the server hands over `{id,name}` only) and no credential is ever written to
 * the ledger.
 */
function handleWebhookMessage(msg: WebhookInbound, endpoint: WebhookEndpointRef): WebhookDispatch | null {
  // 192-bit unguessable token, returned once; only its hash is stored.
  const token = randomBytes(24).toString('hex');
  const tokenHash = hashWebhookToken(token);
  const full = msg.title ?? msg.message;
  const title = full.length > 80 ? `${full.slice(0, 79)}…` : full;

  const trigger = (readConfig().webhookTriggers ?? []).find((t) => t.id === endpoint.id);
  // An endpoint that vanished between the request and this lookup falls back to
  // the STRICTEST mode, never the most permissive one.
  const mode: TriggerMode = trigger?.mode ?? DEFAULT_TRIGGER_MODE;
  // The caller's own declaration wins; `classifyInboundKind` is the conservative
  // guess for callers that don't declare (it leans 'directive' on purpose).
  const kind: InboundKind = msg.kind ?? classifyInboundKind(msg.message);
  const peer = msg.from?.trim() || endpoint.name || endpoint.id;
  // Minted here, not derived from the task id, because a HELD message has no task
  // id yet and must still be pairable with the reply it eventually earns.
  const correlationId = randomBytes(8).toString('hex');

  const base = {
    source: 'webhook' as const,
    sourceId: endpoint.id,
    sourceName: endpoint.name,
    direction: 'inbound' as const,
    peer,
    title,
    body: msg.message,
    kind,
    correlationId
  };

  if (!isAutoAllowed(mode, kind)) {
    const entry = appendTriggerHistory({ ...base, decision: 'pending' });
    heldTokens().set(tokenHash, entry.id);
    persistHeldTokens();
    notifyTriggerHistoryUpdated();
    return { token, pending: true };
  }

  const taskId = `webhook-${randomBytes(8).toString('hex')}`;
  if (!dispatchWebhookWork({ taskId, title, message: msg.message, tokenHash, origin: 'webhook' })) return null;
  appendTriggerHistory({ ...base, decision: 'auto-allowed', taskId });
  notifyTriggerHistoryUpdated();
  return { token, taskId, pending: false };
}

/** Resolve a capability token to its task's public status — scoped to the ONE
 *  card (or the ONE held message) whose stored hash matches; never lists or leaks
 *  any other task. Returns null for any non-match (the server answers 404 either
 *  way, so a probe can't tell "unknown" from "malformed"). */
function lookupWebhookStatus(token: string): WebhookTaskStatus | null {
  const hash = hashWebhookToken(token);

  // Held messages first — they have no card, and the O(1) hit keeps the common
  // "still waiting" poll off the task scan entirely.
  const heldEntryId = heldTokens().get(hash);
  if (heldEntryId) {
    const entry = listTriggerHistory().find((e) => e.id === heldEntryId);
    if (!entry) { heldTokens().delete(hash); persistHeldTokens(); return null; }
    if (entry.decision === 'pending') {
      return { status: 'awaiting-approval', title: entry.title ?? '' };
    }
    if (entry.decision === 'rejected') {
      return { status: 'rejected', title: entry.title ?? '' };
    }
    // Approved: the release stamped this hash onto a real card, so fall through.
  }

  const wanted = Buffer.from(hash);
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return null; }
  for (const t of tasks) {
    const h = t.webhook?.tokenHash;
    if (!h) continue;
    const have = Buffer.from(h);
    // Both are fixed-length sha-256 hex; compare in constant time defensively.
    if (have.length === wanted.length && timingSafeEqual(have, wanted)) {
      return { status: t.status, title: t.title, result: t.result };
    }
  }
  return null;
}

// ─── Webhook done-observer (the OUTBOUND half of the trigger ledger) ─────────
// Mirrors `pollSlackDoneTasks`: watch the kanban for webhook-origin cards that
// reach 'done' and write the reply side of the conversation, tagged with the
// inbound row's correlationId so the UI can pair request ↔ response.
//
// Unlike the Slack poller there is no "baseline" of already-done ids: the LEDGER
// is the record of what we've already paired, so a card that finished while the
// app was closed still gets its outbound row on the next boot, and re-seeding
// from the ledger makes a duplicate impossible.
let webhookDoneTimer: ReturnType<typeof setInterval> | null = null;
let webhookOutboundRecorded: Set<string> | null = null;

function seedWebhookOutbound(): Set<string> {
  const seen = new Set<string>();
  try {
    for (const e of listTriggerHistory()) {
      if (e.direction === 'outbound' && e.taskId) seen.add(e.taskId);
    }
  } catch { /* unreadable ledger → treat as empty; appends are still deduped by taskId */ }
  return seen;
}

function pollWebhookDoneTasks(): void {
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return; } // unreadable/missing tasks.json → skip this tick
  const done = tasks.filter((t) =>
    t.status === 'done' && (t.webhook != null || t.id.startsWith('webhook-')));
  if (done.length === 0) return;
  const recorded = webhookOutboundRecorded ?? (webhookOutboundRecorded = seedWebhookOutbound());
  const fresh = done.filter((t) => !recorded.has(t.id));
  if (fresh.length === 0) return;

  const history = listTriggerHistory();
  let wrote = false;
  for (const t of fresh) {
    const inbound = history.find((e) => e.direction === 'inbound' && e.taskId === t.id);
    // No inbound row = a card from before the ledger existed. Nothing to pair it
    // with, so mark it handled rather than writing a half of a conversation.
    if (!inbound) { recorded.add(t.id); continue; }
    appendTriggerHistory({
      source: inbound.source,
      sourceId: inbound.sourceId,
      sourceName: inbound.sourceName,
      direction: 'outbound',
      peer: inbound.peer,
      title: t.title,
      body: (t.result ?? '').trim() || '(finished with no result recorded)',
      kind: inbound.kind,
      correlationId: inbound.correlationId,
      taskId: t.id
    });
    recorded.add(t.id);
    wrote = true;
  }
  if (wrote) notifyTriggerHistoryUpdated();
}

/** Begin watching the kanban for webhook-origin done-transitions (idempotent). */
function startWebhookDoneObserver(): void {
  if (webhookDoneTimer) return;
  webhookOutboundRecorded = seedWebhookOutbound();
  webhookDoneTimer = setInterval(() => {
    try { pollWebhookDoneTasks(); } catch (e) { console.error('[webhook] done-observer:', e); }
  }, 5000);
}

/** Stop watching the kanban. Safe to call when not running. */
function stopWebhookDoneObserver(): void {
  if (webhookDoneTimer) { clearInterval(webhookDoneTimer); webhookDoneTimer = null; }
  webhookOutboundRecorded = null;
}

/** Build the shared WebhookServer from the enabled endpoints and start it. A
 *  server that is already up is RE-POINTED rather than restarted (see
 *  `reconcileWebhookServer`): restarting would mint a fresh tunnel URL and break
 *  every other endpoint's caller. The public tunnel is opened only here — never
 *  on a default; a webhook reaches the wire only once the operator enables it. */
async function startWebhookServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const endpoints = enabledWebhookEndpoints();
  if (endpoints.length === 0) return { ok: false, error: 'no enabled webhook endpoints' };
  if (webhookServer) {
    webhookServer.setEndpoints(endpoints);
    return { ok: true, url: webhookServer.publicUrl() ?? lastWebhookUrl };
  }
  pruneHeldTokens();
  const cfg = readConfig();
  const server = new WebhookServer({
    port: cfg.webhookPort && cfg.webhookPort > 0 ? cfg.webhookPort : WEBHOOK_DEFAULT_PORT,
    endpoints,
    onMessage: handleWebhookMessage,
    lookupStatus: lookupWebhookStatus
  });
  webhookServer = server;
  const res = await server.start();
  // ok:false covers BOTH "never bound the port" (fatal → drop the instance) and
  // "bound fine, tunnel unavailable" (the security boundary is live and must stay
  // reachable/stoppable — dropping it there would leak an unstoppable listener).
  if (!res.ok && !server.listening()) { webhookServer = null; return res; }
  analytics.trackFeature('webhook_trigger');
  if (res.url) lastWebhookUrl = res.url;
  startWebhookDoneObserver();
  return res;
}

/** Bring the running server in line with config after any webhook mutation.
 *  Live endpoint swap when it's up, start when the enabled set becomes non-empty,
 *  stop when it empties. Never restarts a healthy server. */
function reconcileWebhookServer(): void {
  const endpoints = enabledWebhookEndpoints();
  if (endpoints.length === 0) { stopWebhookServer(); return; }
  if (webhookServer) { webhookServer.setEndpoints(endpoints); return; }
  void startWebhookServer().then((r) => {
    if (!r.ok) console.error('[webhook] start failed:', r.error);
    else console.log('[webhook] listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
  });
}

/** Per-endpoint public URLs for the settings surface's copy button. Empty string
 *  when no tunnel has ever come up — the UI shows the endpoint, just not a URL
 *  it could hand out yet. */
function webhookEndpointUrls(): { id: string; url: string }[] {
  const base = (webhookServer?.publicUrl() ?? lastWebhookUrl ?? '').replace(/\/+$/, '');
  return (readConfig().webhookTriggers ?? []).map((t) => ({
    id: t.id,
    url: base ? `${base}/${encodeURIComponent(t.id)}` : ''
  }));
}

/** Stop and forget the webhook server. Best-effort; safe when not running. The
 *  last tunnel URL is retained so Settings keeps showing it. */
function stopWebhookServer(): void {
  try { webhookServer?.stop(); } catch (e) { console.error('[webhook] stop failed:', e); }
  webhookServer = null;
  // The done-observer deliberately OUTLIVES the server (it is a ledger concern,
  // not a transport one) — it is torn down with the process/hive, not here.
}

/** The persisted main-window geometry (kv key `window.bounds`). */
interface WindowBounds { x?: number; y?: number; width: number; height: number }

const DEFAULT_WIN = { width: 1440, height: 900 };
const MIN_WIN = { width: 1280, height: 800 };

/** Validate + clamp restored bounds: enforce the minimum size, and drop a
 *  position that no longer lands on any connected display (monitor unplugged) so
 *  the window can't open off-screen. Returns null for unusable input. */
function clampBounds(b: unknown): WindowBounds | null {
  if (!b || typeof b !== 'object') return null;
  const r = b as Partial<WindowBounds>;
  if (typeof r.width !== 'number' || typeof r.height !== 'number') return null;
  const width = Math.max(MIN_WIN.width, Math.round(r.width));
  const height = Math.max(MIN_WIN.height, Math.round(r.height));
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return { width, height };
  const x = Math.round(r.x), y = Math.round(r.y);
  // Keep the position only if the window rect overlaps some display's work area.
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return x < wa.x + wa.width && x + width > wa.x && y < wa.y + wa.height && y + height > wa.y;
  });
  return onScreen ? { x, y, width, height } : { width, height };
}

/** Minimal trailing-edge debounce for the move/resize flood. */
function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
}

/** Cascade a new floor off the focused window so it doesn't stack exactly on
 *  top, clamped on-screen (clampBounds drops an off-display position). */
function floorCascade(): WindowBounds | null {
  const base = (mainWindow && !mainWindow.isDestroyed())
    ? mainWindow
    : [...allWindows].find((w) => !w.isDestroyed());
  if (!base) return null;
  const b = base.getBounds();
  const OFFSET = 36;
  return clampBounds({ x: b.x + OFFSET, y: b.y + OFFSET, width: b.width, height: b.height });
}

// ─── Shareable hires: thehive:// deep link + file import ──────────────
// A hire manifest NEVER auto-spawns: it is validated, then handed to the
// renderer, which pre-fills the Add-Agent modal for human review. See
// src/shared/hire.ts for the spec + security model.

/** Manifests that arrived before the renderer was ready to receive them.
 *  The renderer PULLS these via hire:drainPending once its subscription is
 *  mounted — main never pushes blind, so a fast-loading packaged renderer
 *  can't lose a deep link to a startup race. */
const pendingHires: HireManifest[] = [];
let rendererReadyForHires = false;

function deliverHire(manifest: HireManifest): void {
  if (rendererReadyForHires && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('hire:import', manifest);
  } else {
    pendingHires.push(manifest);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
}

async function handleHireLink(link: string): Promise<void> {
  const src = parseHireDeepLink(link);
  if (!src) { console.warn('[hire] ignoring malformed deep link'); return; }
  const res = await fetchHireManifest(src);
  if (!res.ok) {
    console.error('[hire] deep link rejected:', res.error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hire:error', { error: res.error });
    }
    return;
  }
  deliverHire(res.manifest);
  analytics.trackFeature('hire_install');
}

// Register the protocol. In dev (electron .) Windows needs the explicit
// exe+args form or the registration points at electron.exe with no entry.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('thehive', process.execPath, [resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('thehive');
}

// Deep links on Windows/Linux arrive as the argv of a SECOND process — take the
// single-instance lock and forward them to the running instance. (macOS gets
// the 'open-url' event instead.) The lock also rules out two harnesses fighting
// over the same hive, which was previously possible but never useful.
if (!app.isPackaged) {
  const prodUserData = app.getPath('userData');
  const devUserData = prodUserData + '-dev';
  app.setPath('userData', devUserData);
  // Bootstrap dev config from packaged app's config on first dev launch
  const devConfig = join(devUserData, 'config.json');
  const prodConfig = join(prodUserData, 'config.json');
  if (!existsSync(devConfig) && existsSync(prodConfig)) {
    mkdirSync(devUserData, { recursive: true });
    copyFileSync(prodConfig, devConfig);
  }
}
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  allowQuit = true;
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const link = argv.find((a) => a.startsWith('thehive://'));
    if (link) void handleHireLink(link);
  });
}

app.on('open-url', (evt, url) => {
  evt.preventDefault();
  void handleHireLink(url);
});

// IPC: the renderer signals readiness and PULLS anything queued (deep links
// that arrived before the window/subscription existed, incl. cold starts).
ipcMain.handle('hire:drainPending', () => {
  rendererReadyForHires = true;
  const out = pendingHires.splice(0, pendingHires.length);
  return out;
});

// IPC: "import hires…" file picker in the Add-Agent modal. Every selected file
// is validated independently; valid neighbours survive an invalid manifest.
ipcMain.handle('hire:openFile', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Import hire manifests',
    filters: [{ name: 'Hire manifest', extensions: ['json'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled || res.filePaths.length === 0) {
    return { ok: false, manifests: [], errors: [], error: 'cancelled' };
  }
  const batch = readHireManifestFiles(res.filePaths);
  return {
    ok: batch.manifests.length > 0,
    ...batch,
    error: batch.manifests.length === 0 ? 'no valid hire manifests selected' : undefined
  };
});

/**
 * Create a window. The PRIMARY window (no opts) restores saved geometry, uses
 * the default session, runs the hive, and keeps the existing app-quit warning.
 * A FLOOR window (`{ floor: true }`) gets its own persistent session partition
 * — isolating its renderer state (agents/queues/selection) from every other
 * window — cascades its position, and on close stops only its OWN terminals
 * while the app keeps running.
 */
function createWindow(opts: { floor?: boolean } = {}): BrowserWindow {
  const isFloor = opts.floor === true;

  // Primary restores saved geometry; floors cascade off the focused window.
  let saved: WindowBounds | null = null;
  if (!isFloor) { try { saved = clampBounds(persist.getKv('window.bounds')); } catch { saved = null; } }
  const cascade = isFloor ? floorCascade() : null;
  const geom = cascade ?? saved;

  const win = new BrowserWindow({
    width: geom?.width ?? DEFAULT_WIN.width,
    height: geom?.height ?? DEFAULT_WIN.height,
    ...(geom && geom.x !== undefined && geom.y !== undefined ? { x: geom.x, y: geom.y } : {}),
    minWidth: MIN_WIN.width,
    minHeight: MIN_WIN.height,
    title: isFloor ? 'The Hive — Floor' : 'The Hive',
    backgroundColor: '#FFF8E7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Keep Chromium's OS renderer sandbox active; privileged work stays behind
      // the narrow contextBridge/IPC surface owned by the main process.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer runs the hive's heartbeat loops (inbox nudge, message
      // flush, telemetry polls). Chromium throttles timers in occluded windows
      // — incl. behind the LOCK SCREEN — which silently stalls the hive while
      // the user is away. Don't.
      backgroundThrottling: false,
      // Each floor gets its OWN persistent session partition → isolated
      // localStorage so floors never share or stomp each other's office state.
      // The primary keeps the DEFAULT session so existing persisted state loads.
      ...(isFloor ? { partition: `persist:floor-${++floorSeq}` } : {})
    }
  });

  attachBrowserBridge(win.webContents);

  // Capture the webContents once: after 'closed' the window is gone, but this
  // reference stays valid as the per-PTY ownership key.
  const wc = win.webContents;

  // Hot-reload the RENDERER without restarting the app: Ctrl/Cmd+Shift+R reloads
  // just this window's web contents, so CSS/renderer changes apply while the
  // main-process PTYs (and every live agent session) keep running. Registered
  // here so it works regardless of the app menu (that menu, with its Force Reload
  // role, only installs when multiWindow is on).
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (mod && input.shift && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      wc.reload();
    }
  });

  allWindows.add(win);
  // Global timer events follow the user — the most-recently-focused window is
  // primary. The primary is also seeded synchronously so boot events route now.
  win.on('focus', () => { mainWindow = win; });
  if (!isFloor) mainWindow = win;

  // Permission gate for the renderer (our own trusted, local content). The only
  // permission we constrain is microphone capture: it's allowed ONLY while a mic
  // feature is actually live — Free Flow dictation (`freeflowEnabled`) OR a
  // Realtime Abathur voice session (`realtimeVoiceEnabled`, flipped on by the
  // session at start() before getUserMedia, off at stop()). With both flags off,
  // there's zero mic access even at the Electron layer. We deliberately do NOT
  // gate on OpenAI-key presence: that key (`apikey:openai`) is shared with the CLI
  // engines, so a CLI-only user must not have the mic gate opened. Every other
  // permission keeps the app's prior permissive behavior (e.g. clipboard for
  // xterm/editor copy must keep working).
  const micFeatureLive = (): boolean => {
    const cfg = readConfig();
    return cfg.freeflowEnabled === true || cfg.realtimeVoiceEnabled === true;
  };
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const mediaTypes = details && 'mediaTypes' in details ? details.mediaTypes : undefined;
      const wantsAudio = !mediaTypes || mediaTypes.includes('audio');
      callback(micFeatureLive() && wantsAudio);
      return;
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media') return micFeatureLive();
    return true;
  });

  // Only the primary persists geometry (kv `window.bounds`); floors cascade
  // fresh each launch. Skip while maximized/minimized so a restore doesn't save
  // the fullscreen rect.
  if (!isFloor) {
    const saveBounds = debounce(() => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
      try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
    }, 400);
    win.on('resized', saveBounds);
    win.on('moved', saveBounds);
    win.on('close', () => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
      try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
    });
  }


  win.once('ready-to-show', () => win.show());

  // Diagnostics: if the renderer or a helper process dies (e.g. a WebGL/GPU
  // crash on interaction), print WHY before window-all-closed quits the app.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer-gone]', details.reason, 'exitCode=', details.exitCode);
  });
  win.webContents.on('unresponsive', () => console.error('[renderer] unresponsive'));

  // Never opens a window; hands the URL to the OS browser instead.
  //
  // Scheme-checked, because this is now reachable from AUTHOR-CONTROLLED markup:
  // a release drop's iframe has `allow-popups`, so a target="_blank" link in a
  // release body arrives here. http(s) only — an unguarded openExternal will
  // happily launch file://, or a registered custom scheme, on the user's machine.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Close interception when live PTYs exist. The red-X destroys the window;
  // intercept it the same way before-quit does so PTY users aren't surprised.
  win.on('close', (e) => {
    if (allowQuit) return;
    if (isFloor) {
      // A floor's close is NOT an app quit — confirm only its OWN terminals,
      // via a self-contained native dialog (no renderer modal). Confirming lets
      // the window close; its PTYs are stopped in the 'closed' handler.
      const owned = ptyManager.countByOwner(wc);
      if (owned > 0) {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'warning',
          buttons: ['Close floor', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: `Close this floor? ${owned} running terminal${owned === 1 ? '' : 's'} on it will be stopped.`,
          detail: 'Other floors keep running.'
        });
        if (choice === 1) e.preventDefault();
      }
      return;
    }
    // Primary window: existing app-wide quit warning (renderer modal).
    const count = ptyManager.list().length;
    if (count === 0) return;
    e.preventDefault();
    win.focus();
    wc.send('app:closeRequested', { ptyCount: count });
  });

  // The primary is the default PTY sink; floors route purely by per-PTY owner.
  if (!isFloor) ptyManager.attachWebContents(wc);

  // A main-frame reload unmounts the renderer's hire subscription — queue again
  // until the fresh renderer drains. Guard on isMainFrame: a stray sub-frame
  // navigation must NOT flip readiness off (the renderer only drains on mount,
  // so a later deep link would otherwise queue and sit until a full reload).
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) rendererReadyForHires = false;
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    allWindows.delete(win);
    // A closed floor must not leave its terminals running headless. (Natural
    // onExit teardown — archive + worktree cleanup — still runs per PTY.)
    if (isFloor) { try { ptyManager.killByOwner(wc); } catch { /* best-effort */ } }
    if (mainWindow === win) {
      mainWindow = null;
      for (const w of allWindows) { if (!w.isDestroyed()) { mainWindow = w; break; } }
    }
    syncKeepAwake();
  });

  return win;
}

/** Open a new floor window — gated by the multiWindow flag. Returns the window,
 *  or null when the feature is off (the entry points are hidden in that case,
 *  but the IPC stays defensive). */
function openFloor(): BrowserWindow | null {
  if (!readConfig().multiWindow) return null;
  return createWindow({ floor: true });
}

/** Build + install the application menu. Only called when multiWindow is on, so
 *  flag-off keeps Electron's default menu (zero behavior change). Uses standard
 *  role-based items so copy/paste/quit/etc. work per-platform, and adds the
 *  "New Floor" item (Cmd/Ctrl+Shift+N). */
function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const newFloorItem = {
    label: 'New Floor',
    accelerator: 'CmdOrCtrl+Shift+N',
    click: () => { openFloor(); }
  };
  const openBrowserItem = {
    label: 'Open in Browser',
    accelerator: 'CmdOrCtrl+Shift+B',
    click: () => {
      void openRendererInBrowser().catch((err) => {
        console.error('[browser-server] menu launch failed:', err);
        dialog.showErrorBox('Open in Browser failed', err instanceof Error ? err.message : String(err));
      });
    }
  } satisfies Electron.MenuItemConstructorOptions;
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: isMac
        ? [openBrowserItem, newFloorItem, { type: 'separator' as const }, { role: 'close' as const }]
        : [openBrowserItem, newFloorItem, { type: 'separator' as const }, { role: 'quit' as const }]
    },
    // The Edit menu is spelled out rather than `{ role: 'editMenu' }` for one
    // reason: `registerAccelerator: false` on the clipboard items.
    //
    // A registered accelerator is claimed by the MENU, which then replays the
    // action through `webContents.paste()` — an async hop that runs a beat after
    // the keystroke. Dictation tools (Muesli, Wispr Flow, …) insert text by
    // stashing the clipboard, writing the transcript, sending the paste key, and
    // restoring the old clipboard immediately; the menu's late paste therefore
    // read the RESTORED clipboard and typed the user's previous copy instead of
    // what they had just said. It hit the terminal and the composer alike,
    // because both were downstream of the same replay.
    //
    // With registerAccelerator false the item still shows its shortcut, but the
    // key is left for the focused element to handle inline — xterm's own paste
    // handler and the textarea's native paste event both read the clipboard
    // synchronously, inside the keystroke, before any restore can land.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const, registerAccelerator: false },
        { role: 'redo' as const, registerAccelerator: false },
        { type: 'separator' as const },
        { role: 'cut' as const, registerAccelerator: false },
        { role: 'copy' as const, registerAccelerator: false },
        { role: 'paste' as const, registerAccelerator: false },
        { role: 'selectAll' as const, registerAccelerator: false }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


// ─── IPC: pty lifecycle ─────────────────────────────────────────────────────
/** Codex stores its rollout transcripts under a PER-AGENT CODEX_HOME
 *  (<hive>/agents/<id>/.codex/sessions/<Y>/<M>/<D>/rollout-*-<sessionId>.jsonl).
 *  A NEWLY added agent gets an empty CODEX_HOME, so `codex resume <sid>` finds
 *  nothing and silently opens a BLANK session — which is exactly what the Add
 *  Agent "resume session" field looked like it was doing. Find the agent whose
 *  CODEX_HOME owns this rollout and RETURN that home so the resumed agent can be
 *  pointed at it (the rollout AND its state_5.sqlite index live there together). */
function findCodexHomeForSession(sessionId: string, siblingsRoot: string): string | null {
  try {
    if (!sessionId || !/^[0-9a-fA-F][0-9a-fA-F-]{15,}$/.test(sessionId)) return null;
    let fallbackHome: string | null = null;
    // Walk each sibling agent's CODEX_HOME (<agent>/.codex) looking for the
    // rollout that owns this session. We RETURN that home rather than copy the
    // rollout out of it: Codex indexes sessions in its state_5.sqlite, so a lone
    // rollout file in a fresh home is invisible to `codex resume`. Pointing the
    // resumed agent at the OWNING home gives it the rollout AND the index.
    let agents: Array<{ name: string; isDirectory(): boolean }>;
    try {
      agents = readdirSync(siblingsRoot, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>;
    } catch { return null; }
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      const home = join(siblingsRoot, a.name, '.codex');
      const sessions = join(home, 'sessions');
      if (!existsSync(sessions)) continue;
      const stack = [sessions];
      let hasRollout = false;
      while (stack.length && !hasRollout) {
        const d = stack.pop() as string;
        let ents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
          ents = readdirSync(d, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        } catch { continue; }
        for (const e of ents) {
          const pth = join(d, e.name);
          if (e.isDirectory()) stack.push(pth);
          else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) { hasRollout = true; break; }
        }
      }
      if (!hasRollout) continue;
      // Prefer the home whose Codex state DB actually INDEXES this session — a
      // fresh/seeded home may carry only a stray rollout copy (no index), which
      // `codex resume` can't open. Match the id as raw bytes in state_5.sqlite
      // (+ its WAL). Homes with the rollout but no index are a last-resort fallback.
      const idBuf = Buffer.from(sessionId);
      let indexed = false;
      for (const db of ['state_5.sqlite', 'state_5.sqlite-wal']) {
        try { if (readFileSync(join(home, db)).includes(idBuf)) { indexed = true; break; } } catch { /* no db */ }
      }
      if (indexed) return home;
      if (!fallbackHome) fallbackHome = home;
    }
    return fallbackHome;
  } catch (e) {
    console.error('[resume] findCodexHomeForSession failed:', e);
    return null;
  }
}

/** Spawn options shared by the `pty:spawn` IPC handler and the god-triggered
 *  ephemeral-worker watcher. */
type AgentSpawnOptions = SpawnOptions & { hive?: AgentMeta; isolate?: boolean; resume?: boolean; requireResume?: boolean; resumeSessionId?: string; provider?: AgentProvider; noAutoInstall?: boolean };

/** 1on1-resume: a permanent 1:1 agent (not god, not an ephemeral `worker-*`)
 *  whose workspace carries a .remember/remember.md handoff is nudged ~15s after
 *  spawn (past Claude's boot, mirroring the worker spawn nudge) to read the
 *  handoff and continue where its previous session left off. No handoff file,
 *  no nudge. Best-effort: a dead PTY or a throw here never affects the spawn. */
function maybeScheduleResumeNudge(opts: AgentSpawnOptions): void {
  const meta = opts.hive;
  if (!meta || meta.isOvermind) return;
  if (typeof meta.id === 'string' && meta.id.startsWith('worker-')) return;
  const ptyId = opts.id;
  const rememberPath = join(opts.cwd, '.remember', 'remember.md');
  setTimeout(() => {
    try {
      if (!existsSync(rememberPath)) return;
      // Text first, Enter a tick later (the submitToPty pattern): a single-chunk
      // write lands the "\r" inside the input box and never submits (see nudgeWorker).
      const wrote = ptyManager.write(ptyId, '\nYour last session handoff is in .remember/remember.md. Read it now and resume your previous work.\n');
      if (!wrote.ok) { console.warn(`[resume-nudge] write failed for ${ptyId}: ${wrote.error}`); return; }
      setTimeout(() => {
        try { ptyManager.write(ptyId, '\r'); }
        catch (e) { console.error('[resume-nudge] submit threw:', e); }
      }, 140);
    } catch (e) {
      console.error('[resume-nudge] failed:', e);
    }
  }, 15_000);
}

ipcMain.handle('pty:spawn', async (evt, opts: AgentSpawnOptions) => {
  if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
  }
  // Record the spawning window as the PTY's owner so its output routes ONLY back
  // to that floor, then run the shared spawn core.
  const owner = BrowserWindow.fromWebContents(evt.sender)?.webContents ?? null;
  return spawnAgentCore(opts, owner);
});

/** Runtime-profiles v1 — resolve an agent's profile to the per-account
 *  CLAUDE_CONFIG_DIR to spawn it under. Returns undefined (operator default login)
 *  unless the resolved provider is Claude AND the profile pins a `claudeConfigDir`.
 *  `~` is expanded so the spawn env carries an absolute login path. */
function resolveProfileClaudeConfigDir(profileId: string | undefined, provider: AgentProvider): string | undefined {
  if (!profileId || !isClaudeProvider(provider)) return undefined;
  const profile = getRuntimeProfile(profileId);
  if (!profile?.claudeConfigDir) return undefined;
  return expandTilde(profile.claudeConfigDir);
}

/** Core agent-spawn logic — provider inference, the missing-CLI installer
 *  short-circuit, git-worktree isolation, hive provisioning, model/resume flags,
 *  and the final PTY spawn. Extracted VERBATIM from the `pty:spawn` IPC handler so
 *  it can ALSO be invoked by the god-triggered ephemeral-worker watcher (which has
 *  no renderer `evt`). `owner` is the window that should receive this PTY's output
 *  (null → the primary window). Behavior-identical to the prior inline handler. */
async function spawnAgentCore(opts: AgentSpawnOptions, owner: Electron.WebContents | null): Promise<{ ok: boolean; error?: string; cwd?: string; worktreePath?: string; resumeNotFound?: boolean; resumed?: boolean; seedPrompt?: string }> {
  // ── cwd INGESTION — expand `~` exactly once, here ───────────────────────────
  // This is the single door every agent spawn comes through (`pty:spawn` IPC and
  // the god-triggered ephemeral-worker watcher), so it is where a user-typed
  // `~/dev/foo` becomes an absolute path. Only a shell expands `~`; Node treats it
  // as a literal dir, so without this every downstream existsSync/statSync fails
  // with `cwd does not exist`. Expanding BEFORE hive provisioning is what makes the
  // registry store an ABSOLUTE cwd (and `cwdValid: true`). The resolved value is
  // returned to the caller so the renderer records the same absolute path.
  opts.cwd = expandTilde(opts.cwd);
  if (opts.hive) opts.hive = { ...opts.hive, cwd: expandTilde(opts.hive.cwd) };
  // Profile command override (D2): if a profile pins a specific engine binary and
  // the passed command is still the global default (user didn't override it), swap
  // in the profile's command. Explicit modal/opts.command always wins.
  const runtimeProfile = opts.hive?.profileId ? getRuntimeProfile(opts.hive.profileId) : undefined;
  if (runtimeProfile?.command && opts.command === readConfig().defaultCommand) {
    opts.command = runtimeProfile.command;
  }
  // Which CLI is this? Explicit wins; else inferred from the binary
  // (claude/codex/grok/agy). Non-Claude providers skip every Claude-only spawn step
  // below. Persist the resolved provider onto opts (+ hive meta) so the registry
  // record and downstream provider-aware steps agree on one value.
  const provider = inferAgentProvider(opts.command, opts.provider ?? opts.hive?.provider);
  const claudeProvider = isClaudeProvider(provider);
  opts.provider = provider;
  if (opts.hive) opts.hive = { ...opts.hive, provider };
  // ── Usage governor: block new Claude spawns when RED ─────────────────────────
  // The governor pauses EXISTING agents and blocks new ones. Workers/hive agents
  // are blocked just like user-initiated spawns (no free pass; the whole hive
  // should degrade when the window is critical). Ephemeral-worker spawns go through
  // spawnAgentCore too, so this gate covers all paths.
  if (claudeProvider && governorMode === 'red') {
    const cfg0 = readConfig();
    if ((cfg0.governorPolicy?.enabled ?? true) && cfg0.governorPolicy?.manualOverride !== 'force-green') {
      const profileState = governorProfileState(opts.hive?.profileId ?? null);
      if (profileState.mode === 'red') {
        const profileLabel = runtimeProfile?.name ?? opts.hive?.profileId ?? 'default Claude account';
        const reasonSuffix = profileState.reason ? ` — ${profileState.reason}` : '';
        return { ok: false, error: `Usage governor: Claude spawn blocked for ${profileLabel}${reasonSuffix}. Use edgentic or Azure delegate.` };
      }
    }
  }
  // ── Missing engine CLI → run its installer visibly (pre-spawn) ───────────────
  // If the agent's engine binary (claude/codex/…) isn't installed, spawning it
  // just dies with "— process exited (code 1) —" and the user has no idea why.
  // Detect the absent binary BEFORE spawning and, in this SAME terminal, print a
  // banner + RUN the provider's install command so the user can watch it (and
  // complete any interactive sign-in). On a CLEAN install exit the PTY-exit handler
  // auto restart-and-continues — it re-runs THIS spawn (with noAutoInstall) so the
  // freshly-installed CLI launches in the SAME pty/window, no user click. STRICTLY
  // pre-spawn: a non-zero exit from a CLI that DID start never reaches here, so there
  // is no install loop; and the relaunch's noAutoInstall guarantees the installer
  // can't fire twice. Providers with no known installer get a manual hint only (and
  // are NOT armed for relaunch) — nothing arbitrary is ever auto-run. We short-circuit
  // BEFORE worktree/hive/Claude-flag setup: ptyToAgent + worktreePaths stay unset for
  // this id, so when the install PTY exits teardownPty is a harmless no-op (the agent
  // isn't archived and no worktree is torn down) before the relaunch takes over.
  {
    const bin = opts.command.trim().split(/\s+/)[0] || opts.command;
    if (bin && !opts.noAutoInstall && !ptyManager.isCommandAvailable(bin)) {
      // The installer commands are `npm install -g …`. Probe for npm the same way
      // we probe for the engine CLI, so a no-Node machine gets the node-free rung
      // (or an honest manual hint) instead of watching `npm: not found` scroll by.
      // An npm whose Node is BELOW the floor counts as unavailable: founder rule
      // (2026-08-07) is "their Node newer than ours → leave it alone; absent or
      // older → install the latest stable for them".
      const npmAvailable =
        ptyManager.isCommandAvailable('npm') &&
        nodeIsUsable(detectNodeVersion(ptyManager.commandPath('node')));
      // Only reach the network when we actually need to (npm missing/too old);
      // resolveNodeInstaller is timeout-bounded and returns null offline, which
      // simply drops the ladder to the native/manual rung.
      const nodeInstaller = npmAvailable ? null : await resolveNodeInstaller();
      const rung = chooseInstallRung(installInfoForProvider(provider), npmAvailable, nodeInstaller);
      const res = ptyManager.spawn(
        {
          id: opts.id,
          cwd: opts.cwd,
          command: bin,
          cols: opts.cols,
          rows: opts.rows,
          shellScript: buildMissingCliScript(bin, provider, npmAvailable, process.platform, nodeInstaller)
        },
        owner
      );
      // Arm auto restart-and-continue: when this installer PTY exits cleanly, the
      // exit handler re-runs the spawn so the just-installed CLI launches in place
      // (no user click). Only when an installer actually RAN (a provider with no
      // bundled installer just prints a manual hint and exits 0 — relaunching there
      // would spawn the still-missing binary and die) and the PTY actually started.
      // …keyed on the RUNG, not on `installCommand`: the manual rung prints a hint
      // and exits 0, and relaunching there would just respawn the still-missing
      // binary and die with the bare "process exited (code 1)" this whole path exists
      // to replace.
      if (res.ok && rung.command) {
        pendingInstallRelaunch.set(opts.id, { opts, owner, bin });
      }
      syncKeepAwake();
      return res;
    }
  }
  // Git isolation: when requested and the cwd is a real repo, give this agent
  // its own worktree on an `agent/<id>` branch so it can't clobber other agents'
  // (or the user's) working tree. Best-effort — a failure falls back to the
  // shared cwd rather than blocking the spawn.
  // NOTE (tracked, not yet hardened): the restore flow passes isolate:false and
  // re-enters the existing worktree by cwd, so it never reaches here. But a stale
  // `isolate:true` recipe spawned against an already-existing worktree path would
  // make addWorktree below conflict (path/branch exists) and fall back to the base
  // cwd — reuse-existing-worktree handling here is the follow-up.
  if (opts.isolate === true && await isRepo(opts.cwd)) {
    try {
      const origCwd = opts.cwd;
      const wtRoot = join(resolveHarnessHome() ?? origCwd, 'worktrees');
      // The id is renderer-supplied (validated only as a string). Slugify it so a
      // crafted id can't inject path separators, then assert the resolved path
      // stays under the worktrees root (defends against bare '..' that slugify
      // leaves intact). If it would escape, bail isolation → fall back to cwd.
      const seg = (opts.hive?.id ?? opts.id).replace(/[^A-Za-z0-9._-]/g, '-');
      const wtPath = join(wtRoot, seg);
      if (!resolve(wtPath).startsWith(resolve(wtRoot) + sep)) {
        console.error('[worktree] refusing unsafe worktree path for id:', opts.hive?.id ?? opts.id);
      } else {
        const br = await getBranch(origCwd);
        const baseBranch = 'current' in br && br.current ? br.current : 'main';
        const wt = await addWorktree(origCwd, wtPath, baseBranch);
        if (wt.ok) {
          opts.cwd = wtPath;
          worktreePaths.set(opts.id, wtPath);
          worktreeOrigins.set(opts.id, origCwd);
        } else {
          console.error('[worktree] addWorktree failed:', wt.error);
        }
      }
    } catch (e) {
      console.error('[worktree] isolation failed:', e);
    }
  }
  // Proxy-tier CLIs (qwen/crush) route their LLM traffic through a loopback sidecar
  // whose UPSTREAM is read from the preset's bridge.baseUrlEnv inside hive.ensureAgent.
  // For the local-LLM path, feed the user's configured base URL as that upstream so the
  // proxy forwards to their endpoint (Ollama/LM Studio/vLLM). Set on process.env BEFORE
  // ensureAgent reads it. (Crush's baseUrlEnv is an inert sentinel used ONLY as this
  // upstream source; its real routing is the per-agent CRUSH_GLOBAL_CONFIG base_url.)
  if (opts.hive && (provider === 'crush' || provider === 'qwen')) {
    const bridge = providerPreset(provider).bridge;
    const baseUrl = readConfig().providerBaseUrls?.[provider];
    if (bridge && bridge.kind === 'proxy' && baseUrl) process.env[bridge.baseUrlEnv] = baseUrl;
  }
  // If the agent carries hive metadata, provision its workspace and add
  // provider-specific spawn injection. Non-Claude providers get shared AGENT_*
  // env only; Claude Code also gets prompt/settings hook args.
  // Protocol seed that must be TYPED into a bare TUI after boot (Crush —
  // seedDelivery:'type-into-tui') rather than passed on argv. Surfaced in the spawn
  // result so the renderer types it through the per-pty write-chain. (ondev-b)
  let seedPrompt: string | undefined;
  if (opts.hive && hive.enabled()) {
    try {
      const inj = await hive.ensureAgent(
        { ...opts.hive, cwd: opts.cwd, provider },
        {
          semanticMemory: memory.active(),
          knowledgeGraph: knowledge.active(),
          // Bake the ABSOLUTE KG CLI path into the agent's prompt. The prompt used
          // to spell it `$KG_CLI`, which is POSIX-only: under cmd.exe/PowerShell it
          // expands to nothing, so every knowledge-graph instruction was dead on a
          // Windows floor. Empty when the KG is off (the line isn't emitted then).
          kgCliPath: knowledge.env().KG_CLI,
          knowledgeBaseSources: resolveKnowledgeBaseSources(readConfig()),
          theme: readConfig().terminalTheme ?? 'light',
          // W3 — default-MCP consent state + the bundled skills source dir.
          mcpDefaults: readConfig().mcpDefaults,
          skillsDir: skillsResourceDir(),
          // Runtime-profiles v1 — resolve this agent's profile MAIN-side and hand
          // ensureAgent the profile's per-account Claude login dir (Claude only;
          // undefined for other engines / no profile → unchanged behavior).
          claudeConfigDir: resolveProfileClaudeConfigDir(opts.hive?.profileId, provider)
        }
      );
      opts.args = [...(opts.args ?? []), ...inj.args];
      // Belt-and-suspenders: renderer (buildSpawnCommand) and hive preArgs
      // (installCodexHooks) both inject --dangerously-bypass-hook-trust. Dedup
      // pure-boolean flags so codex never sees a flag twice (exit 2 on duplicate).
      { const seen = new Set<string>();
        opts.args = opts.args.filter(a => {
          if (a !== '--dangerously-bypass-hook-trust' && a !== '--dangerously-bypass-approvals-and-sandbox') return true;
          if (seen.has(a)) return false;
          seen.add(a); return true;
        }); }
      seedPrompt = inj.seedPrompt;
      const agentDir = (hive.enabled() && opts.hive?.id) ? join(hive.root() || '', 'agents', opts.hive.id) : undefined;
      const rememberHandoff = hive.readRememberHandoff(agentDir, opts.cwd);
      if (rememberHandoff && seedPrompt && !seedPrompt.includes(rememberHandoff)) {
        seedPrompt = `## Previous Session Handoff (.remember/remember.md)\n${rememberHandoff}\n\n${seedPrompt}`;
      }
      // Point the agent's mempalace CLI at the shared palace + the `kg` CLI at the
      // enterprise knowledge store (both no-ops / empty when their flags are off).
      opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env(), ...knowledge.env() };
    } catch (e) {
      // Hive provisioning is best-effort; never block a spawn on it.
      console.error('[hive] ensureAgent failed:', e);
    }
  }
  // Long-run guardrails + tiering (Lane A #6.4/#6.6). All additive to the args
  // already assembled (incl. the hive injection); an explicit choice always wins.
  // Set when an explicit Add Agent "resume session" id couldn't be located and we
  // silently fell back to a fresh session — returned so the dialog can surface it.
  let resumeNotFound = false;
  // Set when `--resume` was actually attached (explicit id or restore-on-restart),
  // so the renderer can skip re-orienting a god/assistant that resumed its thread.
  let didResume = false;
  // Claude-only — these are Claude Code flags; other CLIs carry their own flags
  // in the command string the renderer already built.
  if (opts.hive && claudeProvider) {
    const cfg = readConfig();
    // Permission posture (D9): only a GUI hire (Add Agent) builds its command
    // through buildSpawnCommand, which bakes autoMode's bypass flag into the
    // command STRING before this function ever sees it. A main-only spawn (the
    // ephemeral-worker watcher, a voice hire) skips that step entirely, so it
    // previously reached here with neither the flag nor any equivalent — every
    // other Claude spawn path got the user's autoMode posture and this one
    // didn't. argsWithAutoModeFlag is idempotent (a GUI spawn's args already has
    // the flag, so this is a no-op for it) and is the SAME check spawnAgentCore
    // already applies for opencode/crush et al a few lines below via
    // HIVE_AUTO_APPROVE — one global toggle, one posture, every spawn path.
    // Confirmed live: a worker spawned without this flag deadlocked — a
    // cross-session message to it came back "held for the recipient user's
    // approval" with no surface for anyone to ever grant that approval.
    const args = argsWithAutoModeFlag(opts.args ?? [], cfg.autoMode, provider);
    // Model precedence: explicit --model in opts.args wins; else profile.model (D2);
    // else cfg.defaultModel; else the role-based tier. Overmind always uses its own
    // engine config (overmindProvider/overmindModel) via modelForRole.
    if (!args.includes('--model')) {
      const profileModel = runtimeProfile?.model;
      const m = opts.hive.isOvermind
        ? modelForRole(opts.hive, cfg)
        : profileModel ?? cfg.defaultModel ?? modelForRole(opts.hive, cfg);
      if (m) args.push('--model', m);
    }
    // Name the Remote Control session after the agent (Abathur, Jim, Dev1…) so it
    // is identifiable in claude.ai / the mobile app. Otherwise Claude defaults the
    // prefix to the machine hostname (e.g. "vyapaks-macbook-pro-…"), which is
    // opaque when several agents run at once — especially with remoteControlAtStartup
    // on, where RC auto-enables for every session. Slugify the friendly name into a
    // single safe token; Claude still appends its own random suffix for uniqueness.
    if (!args.includes('--remote-control-session-name-prefix')) {
      const label = (opts.hive.name || opts.hive.id || '')
        .trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
      if (label) args.push('--remote-control-session-name-prefix', label);
    }
    // Coarse runaway cap.
    if (typeof cfg.maxTurns === 'number' && cfg.maxTurns > 0 && !args.includes('--max-turns')) {
      args.push('--max-turns', String(cfg.maxTurns));
    }
    // Resume: an explicit session id (Add Agent "resume session" field, #2) wins,
    // else this agent's last recorded session (#1 restore-on-restart / #6.6a).
    // Seed the transcript into the target cwd's Claude project dir first — Claude
    // keys sessions by cwd, so a session started elsewhere is invisible until its
    // `.jsonl` is copied across. Only attach `--resume` if the transcript is
    // actually present (already or after the copy); otherwise fall back to a fresh
    // session rather than launching a `--resume` against a missing id.
    const explicitSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    const sid = explicitSid || (opts.resume === true ? hive.lastSession(opts.hive.id) : undefined);
    if (sid && !args.includes('--resume')) {
      if (seedSessionTranscript(opts.cwd, sid)) {
        args.push('--resume', sid);
        didResume = true;
      } else if (explicitSid) {
        // The user typed a session id in the Add Agent dialog but it isn't in any
        // Claude project dir — we fall back to a FRESH session rather than a broken
        // `--resume`. Make that non-silent: warn on the floor and flag it back to
        // the renderer so the dialog can tell the user 'started fresh'.
        console.warn(`[resume] session "${explicitSid}" not found in any Claude project dir — starting a fresh session`);
        resumeNotFound = true;
      }
    }
    opts.args = args;
  }
  // Idempotent session resume on respawn (#6.6a) — provider-aware: Claude
  // `--resume <sid>`, Grok `--resume <sid>`, Antigravity `--conversation <id>`.
  // The recorded session id comes from hook payloads, so
  // a restored worker continues its prior CLI session. Only when requested AND a
  // prior id exists for this agent.
  // Claude resume — incl. transcript seeding + only-attach-when-present — is
  // handled in the Claude-only block above; this generic flag path covers the
  // other CLIs (it must not blindly attach `--resume` when the seed failed).
  if (opts.hive && !claudeProvider) {
    const preset = providerPreset(provider);
    const cfg2 = readConfig();
    // Auto-mode flags — same idempotent logic as the Claude block (D9). GUI spawns
    // already have the flag baked in by buildSpawnCommand; main-only spawns do not.
    const ncArgs = argsWithAutoModeFlag(opts.args ?? [], cfg2.autoMode, provider);
    // Profile model (D2 mirror for non-Claude): explicit --model in opts.args wins;
    // else profile.model; else no injection (CLI defaults to its configured model).
    // The Claude block has the same guard; non-Claude providers need it too so that
    // a profile's model is honoured even when the command string omits --model.
    if (!ncArgs.includes('--model') && preset.supportsModel && preset.modelFlag) {
      const profileModel2 = runtimeProfile?.model;
      if (profileModel2) ncArgs.push(preset.modelFlag, profileModel2);
    }
    opts.args = ncArgs;
    const rf = preset.resumeFlag;
    const rsub = preset.resumeSubcommand;
    // An id typed into Add Agent's "resume session" field wins; otherwise fall
    // back to this agent's own recorded session (restart-in-place). Previously
    // resumeSessionId was read ONLY in the Claude branch, so a Codex agent
    // silently ignored it and started a brand-new empty session.
    const typedSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    const sid = typedSid || (opts.resume === true ? hive.lastSession(opts.hive.id) : undefined);
    if (sid && rf) {
      const args = opts.args ?? [];
      if (!args.includes(rf)) { args.push(rf, sid); opts.args = args; didResume = true; }
    } else if (sid && rsub) {
      // Subcommand form (Codex): `codex resume [OPTIONS] [SESSION_ID]` — the
      // subcommand MUST be argv[0], the id trails the flags. Codex indexes
      // sessions in state_5.sqlite, so a fresh agent's empty CODEX_HOME can't
      // resume by id. If this agent's own home already has the session, resume in
      // place; otherwise point CODEX_HOME at the agent home that OWNS it (that
      // home has both the rollout and the sqlite index).
      const myHome = (opts.env ?? {}).CODEX_HOME;
      const agentsRoot = myHome ? dirname(dirname(myHome)) : '';
      const ownerHome = agentsRoot ? findCodexHomeForSession(sid, agentsRoot) : null;
      if (!ownerHome) {
        console.warn(`[resume] codex session "${sid}" not found in any agent CODEX_HOME - starting fresh`);
        if (typedSid) resumeNotFound = true;
      } else {
        if (ownerHome !== myHome) opts.env = { ...(opts.env ?? {}), CODEX_HOME: ownerHome };
        const args = opts.args ?? [];
        // Positional order matters: `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`.
        // The hive identity prompt rides in `args` as a POSITIONAL (codex has no
        // prompt flag), so the id must come BEFORE it — appending the id last made
        // codex read the prompt as SESSION_ID ("No saved session found with ID
        // You are \"Dev2\"…") and the id as the prompt.
        if (args[0] !== rsub) { opts.args = [rsub, sid, ...args]; didResume = true; }
        console.log('[resume] codex resume', sid, 'in', ownerHome);
      }
    }
  }
  if (opts.requireResume === true && !didResume) {
    return {
      ok: false,
      error: 'Existing session could not be resumed; no replacement process was started.',
      ...(resumeNotFound ? { resumeNotFound: true } : {})
    };
  }
  // Remember which agent owns this PTY so closing the tab can archive it. A
  // live terminal means active — ensureAgent above already cleared `archived`.
  if (opts.hive?.id) {
    ptyToAgent.set(opts.id, opts.hive.id);
    // Worker inbox-wake watchdog (#151): boot grace starts at spawn so the
    // initial orientation prompt is never mistaken for an idle agent.
    workerWake.noteSpawn(opts.id);
  }
  // Pre-accept Claude Code's bypass-mode warning + folder-trust dialog so the
  // agent (spawned with --permission-mode bypassPermissions) doesn't stall on an
  // interactive prompt it can't answer and exit code 1. Best-effort, never blocks.
  // Claude-only — other CLIs handle their own permission UX.
  if (claudeProvider) {
    try { ensureClaudePermissionsAccepted(opts.cwd); } catch { /* never block spawn */ }
  }
  // Suppress first-run interactive prompts for providers that need it (e.g. Codex
  // directory-trust gate via CODEX_NON_INTERACTIVE). Merges into any env already
  // set on opts.
  const nonInteractiveEnv = nonInteractiveEnvForProvider(provider);
  if (Object.keys(nonInteractiveEnv).length > 0) {
    opts.env = { ...(opts.env ?? {}), ...nonInteractiveEnv };
  }
  // ── BYOK keys + per-provider config for the non-Claude CLI engines (v0.3.1) ──
  // OpenCode / Crush / pi / qwen read BYOK API keys from standard env vars and, for
  // the local-LLM path, a per-provider base URL. Keys are write-only in the broker
  // (read MAIN-ONLY here, never logged); base URLs ride HarnessConfig. Claude/codex
  // use their own login, so they skip this. Pam guardrails #3/#4/#5.
  if (opts.hive && (provider === 'opencode' || provider === 'crush' || provider === 'pi' || provider === 'qwen')) {
    const cfg = readConfig();
    const extra: Record<string, string> = {};
    // 1) BYOK keys — LEAST-PRIVILEGE (Pam/Jim NIT-2): inject ONLY the key for the
    //    spawned model's provider prefix when we can identify it; fall back to all
    //    stored keys when the model/prefix is unknown (default model, qwen slugs,
    //    custom). Reduces the blast radius vs handing every CLI all keys.
    const modelIdx = (opts.args ?? []).indexOf('--model');
    const modelSlug = modelIdx >= 0 ? (opts.args?.[modelIdx + 1] ?? '') : '';
    const prefix = modelSlug.includes('/') ? modelSlug.split('/')[0].toLowerCase() : '';
    const PREFIX_BACKEND: Record<string, string> = {
      anthropic: 'anthropic', openai: 'openai', google: 'google', gemini: 'google', groq: 'groq', openrouter: 'openrouter'
    };
    const scoped = PREFIX_BACKEND[prefix];
    const backends = scoped ? [scoped] : Object.keys(BACKEND_KEY_ENV);
    for (const backend of backends) {
      const key = integrations.getSecret(providerKeyRef(backend));
      if (!key) continue;
      extra[BACKEND_KEY_ENV[backend]] = key;
      // OpenCode/AI-SDK's Google provider reads GOOGLE_GENERATIVE_AI_API_KEY, not
      // GEMINI_API_KEY — inject both so google/* authenticates (Jim NIT #1).
      if (backend === 'google') extra.GOOGLE_GENERATIVE_AI_API_KEY = key;
    }
    // 2) Floor auto-state for pi's bundled extension auto-allow (guardrail #5): it
    //    only auto-approves tool calls when this is '1' (i.e. floor auto mode on).
    extra.HIVE_AUTO_APPROVE = cfg.autoMode ? '1' : '0';
    // 3) OpenCode's auto-approve + local provider live in its single config-injection
    //    env var, built dynamically so permission:allow is GATED on autoMode (#2).
    if (provider === 'opencode') {
      const oc: Record<string, unknown> = { autoupdate: false };
      if (cfg.autoMode) oc.permission = { edit: 'allow', bash: 'allow', webfetch: 'allow' };
      const baseUrl = cfg.providerBaseUrls?.opencode;
      if (baseUrl) {
        // Register the model id the user actually selects (the part after 'local/')
        // so `--model local/<id>` resolves; default to 'local'. Without this the
        // dropdown's `local/llama3` failed against a config that only declared model
        // 'local' (Jim verify-opencode MUST-FIX #2).
        const localModel = (prefix === 'local' && modelSlug.slice(6)) || 'local';
        oc.provider = {
          local: { npm: '@ai-sdk/openai-compatible', name: 'Local (self-hosted)', options: { baseURL: baseUrl }, models: { [localModel]: { name: localModel } } }
        };
      }
      extra.OPENCODE_CONFIG_CONTENT = JSON.stringify(oc);
    }
    opts.env = { ...(opts.env ?? {}), ...extra };
  }
  // ── Profile cloud endpoint (v2): OPENAI_BASE_URL + OPENAI_API_KEY ─────────
  // When a runtime profile pins a cloud OpenAI-compatible endpoint (e.g. Azure AI
  // Foundry), inject the URL and the decrypted key into the spawn env so the CLI
  // (e.g. codex) routes all API calls to that endpoint. MAIN-ONLY — key never
  // crosses IPC; baseUrl is already validated by isSafeHttpUrl at profile save.
  if (opts.hive?.profileId) {
    if (runtimeProfile?.baseUrl && runtimeProfile.apiKeyRef) {
      // Re-validate at spawn time: a stale or tampered config.json could carry a URL
      // that passed validation when saved but now targets a private or unsafe host.
      if (isSafeHttpUrl(runtimeProfile.baseUrl, runtimeProfile.allowPrivate ?? false)) {
        const cloudKey = integrations.getSecret(runtimeProfile.apiKeyRef);
        if (cloudKey) {
          opts.env = {
            ...(opts.env ?? {}),
            OPENAI_BASE_URL: runtimeProfile.baseUrl,
            OPENAI_API_KEY: cloudKey
          };
        }
      } else {
        console.warn(`[spawn] profile ${runtimeProfile.id} baseUrl failed SSRF check at spawn — endpoint not injected`);
      }
    }
  }
  // Codex Remote is daemon-based (there is no `/remote-control` slash command).
  // Start/enable the daemon under this agent's isolated CODEX_HOME and connect
  // the TUI to it so the thread is visible in ChatGPT mobile. Best-effort: an
  // unavailable/older Codex install still gets a normal local terminal.
  if (provider === 'codex' && opts.hive?.id) {
    await enableCodexRemoteForSpawn(opts, opts.hive.id);
  }
  // Codex 0.149.1 shows two first-run gates in headless/ephemeral spawns:
  //   (a) Directory trust — "Do you trust the contents of this directory?"
  //   (b) Sandbox setup — "Set up the Codex agent sandbox to protect your files"
  // Primary fix: installCodexHooks seeds state_5.sqlite (trust) and .sandbox_migration
  // (sandbox) into the per-agent CODEX_HOME so neither prompt fires.
  // Belt-and-suspenders: autoWriteOnPattern auto-answers both in the PTY if the
  // seed somehow fails (e.g. first spawn before installCodexHooks runs, or race).
  // Choice '1' trusts the directory; choice '2' picks non-admin sandbox (works
  // without Administrator privileges, matching --dangerously-bypass-approvals-and-sandbox intent).
  if (provider === 'codex') {
    opts.autoWriteOnPattern = [
      { needle: 'Do you trust the contents of this directory', response: '1\r' },
      { needle: 'Set up the Codex agent sandbox', response: '2\r' },
      // Belt-and-suspenders for the per-command approval prompt. Primary fix:
      // installCodexHooks seeds approval_policy="never" in config.toml so this
      // dialog never fires. Fallback: answer '1' (yes, proceed) in the PTY.
      { needle: 'Would you like to run the following command', response: '1\r' }
    ];
  }
  const res = ptyManager.spawn(opts, owner);
  if (res.ok) {
    analytics.track('agent_spawned', { provider });
    maybeScheduleResumeNudge(opts);
  }
  syncKeepAwake(); // arm the power-save blocker while ≥1 agent PTY is alive (#18)
  // Hand the resolved worktree path back to the renderer so it can persist it on
  // the agent (only set when isolation actually provisioned a worktree above).
  // The restore flow re-enters this exact worktree (cwd = worktreePath) so a
  // restored isolated agent resumes in the CORRECT checkout, not the base repo.
  const worktreePath = worktreePaths.get(opts.id);
  // `cwd` echoes back the TILDE-EXPANDED absolute path so the renderer's agent
  // record matches what the registry and the PTY actually used.
  return { ...res, cwd: opts.cwd, ...(worktreePath ? { worktreePath } : {}), ...(resumeNotFound ? { resumeNotFound: true } : {}), ...(didResume ? { resumed: true } : {}), ...(seedPrompt ? { seedPrompt } : {}) };
}
ipcMain.handle('pty:write', (_evt, id: string, data: string) => {
  if (typeof id !== 'string' || typeof data !== 'string') return { ok: false, error: 'invalid args' };
  return ptyManager.write(id, data);
});
ipcMain.handle('pty:resize', (_evt, id: string, cols: number, rows: number) => {
  if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return { ok: false, error: 'invalid args' };
  return ptyManager.resize(id, cols, rows);
});
ipcMain.handle('pty:redraw', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  return ptyManager.redraw(id);
});
ipcMain.handle('pty:kill', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  // Kill the process, then run the shared lifecycle teardown (archive the agent,
  // remove its isolated worktree, drop the maps). teardownPty is idempotent, so
  // node-pty firing onExit once the child actually dies is a harmless no-op.
  const res = ptyManager.kill(id);
  teardownPty(id);
  return res;
});
ipcMain.handle('pty:list', () => ptyManager.list());

// Respawn an agent: archive the current session and queue a fresh one that
// resumes from the agent's memory.md. Treats the Overmind like any other agent
// (no special-casing). The reconstructed config comes from the registry entry,
// so the new session keeps the same name, cwd, provider, and runtime profile.
// Shared respawn: archive the outgoing session and start a fresh one that resumes
// from memory.md. Called by the agent:respawn IPC (desktop) and the mobile route.
async function respawnAgentById(id: string, senderWc?: Electron.WebContents): Promise<{ ok: boolean; error?: string }> {
  const root = hive.root();
  if (!root) return { ok: false, error: 'hive root unavailable' };
  try {
    const entry = hive.registry().agents[id];
    if (!entry) return { ok: false, error: `agent "${id}" not found in registry` };

    // 1) Ask the outgoing session to persist anything durable before it dies.
    try {
      hive.send({
        to: id,
        act: 'inform',
        subject: 'Respawn requested — wrap up',
        body: 'You are being respawned. Save anything durable to your memory.md now; a fresh session will resume from it.'
      }, 'system');
    } catch (e) { console.error('[respawn] inbox notice failed:', e); }

    // 2) Kill the live PTY (if any) and run the shared teardown, which archives
    //    the agent. setArchived is a belt-and-suspenders no-op when it had no PTY.
    for (const [ptyId, mappedAgent] of ptyToAgent.entries()) {
      if (mappedAgent === id) { ptyManager.kill(ptyId); teardownPty(ptyId); break; }
    }
    hive.setArchived(id, true);

    const harnessHome = entry.isOvermind ? resolveHarnessHome() : null;
    if (entry.isOvermind && !harnessHome) return { ok: false, error: 'harnessHome unavailable' };
    const overmindAgentDir = entry.isOvermind && harnessHome ? join(harnessHome, 'agents', 'god') : undefined;
    const memPath = entry.isOvermind && overmindAgentDir
      ? join(overmindAgentDir, 'memory.md')
      : join(root, 'agents', id, 'memory.md');
    const spawnCwd = entry.isOvermind && overmindAgentDir ? overmindAgentDir : (entry.cwd || root);

    // 3) Overmind case: spawn directly via spawnAgentCore so the Queen comes back
    //    with her exact identity, godId, CLAUDE.md, and skills, rather than an
    //    unwatched spawn-request that would otherwise spawn an ephemeral worker.
    if (entry.isOvermind) {
      hive.setArchived(id, false);
      const cfg = readConfig();
      const profile = getRuntimeProfile(entry.profileId);
      const effectiveProvider = (entry.provider || profile?.provider || cfg.godProvider || 'claude') as AgentProvider;
      const launch = buildWorkerLaunch({
        requestCommand: (entry as unknown as { command?: string }).command || profile?.command,
        requestProvider: effectiveProvider,
        requestModel: cfg.godModel || profile?.model,
        defaultCommand: cfg.defaultCommand,
        autoMode: !!cfg.autoMode
      });
      const webContents = senderWc ?? liveWebContents();
      const spawnOpts: AgentSpawnOptions = {
        id,
        cwd: spawnCwd,
        command: launch.bin,
        args: launch.args,
        cols: 100,
        rows: 30,
        resume: false,
        provider: effectiveProvider,
        isolate: false,
        hive: {
          id,
          name: 'BeeYoncé',
          provider: effectiveProvider,
          cwd: spawnCwd,
          isOvermind: true,
          role: 'Queen'
        }
      };
      const res = await spawnAgentCore(spawnOpts, webContents);
      if (!res.ok) return { ok: false, error: res.error ?? 'failed to spawn Overmind' };
      setTimeout(() => {
        try {
          ptyManager.write(id, `You are resuming as BeeYoncé, the Overmind, after a respawn. Read your memory at ${memPath} and your inbox, then continue orchestrating the floor as described in your CLAUDE.md and PROTOCOL.md.\r`);
        } catch { /* best-effort */ }
      }, 1500);
      return { ok: true };
    }

    // 4) Worker case: queue a fresh spawn-request and immediately process it so
    //    an operator-initiated respawn runs even if orchestratorMaySpawn is false.
    const dir = spawnRequestsDir();
    if (!dir) return { ok: false, error: 'spawn-requests dir unavailable' };
    mkdirSync(dir, { recursive: true });
    const reqId = `respawn-${id}-${Date.now().toString(36)}`;
    const objective = `You are a respawn of ${entry.name || id}. First read your prior session's memory at ${memPath}, then resume that work where the previous session left off.${entry.role ? ` Role: ${entry.role}.` : ''}`;
    const req: SpawnRequest = {
      id: reqId,
      name: entry.name || id,
      objective,
      cwd: spawnCwd,
      provider: entry.provider,
      profile: entry.profileId,
      isolate: false
    };
    const reqFile = join(dir, `${reqId}.json`);
    writeFileSync(reqFile, JSON.stringify(req, null, 2), 'utf8');
    void processSpawnRequest(reqFile).catch((e) => console.error('[respawn] processSpawnRequest failed:', e));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
ipcMain.handle('agent:respawn', async (evt, agentId: unknown) => {
  if (typeof agentId !== 'string' || !agentId.trim()) return { ok: false, error: 'invalid agentId' };
  const senderWc = evt.sender ? BrowserWindow.fromWebContents(evt.sender)?.webContents ?? undefined : undefined;
  return respawnAgentById(agentId.trim(), senderWc);
});

// Resolve a pasted Claude session id to the cwd it originally ran in, so the Add
// Agent dialog can auto-fill the folder for a resume (#2 zero-step resume). Reads
// the cwd from a transcript record; null when the id is invalid/unknown.
ipcMain.handle('session:resolveCwd', (_evt, sessionId: unknown) =>
  (typeof sessionId === 'string' ? resolveSessionCwd(sessionId) : null));

// ─── IPC: clipboard ─────────────────────────────────────────────────────────
ipcMain.handle('app:copyToClipboard', (_evt, text: unknown) => {
  if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
  try { clipboard.writeText(text); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('app:readClipboard', () => {
  try { return clipboard.readText(); } catch { return ''; }
});
// Same read, SYNCHRONOUS, for the terminal's paste shortcut.
//
// Dictation tools (muesli.works, Wispr Flow, …) type by stashing the user's
// clipboard, writing the transcript, sending the paste key, then restoring the
// old clipboard immediately. An `invoke` read returns a tick or two later — by
// which point the restore has already landed and we paste the PREVIOUS text.
// A `sendSync` read completes inside the keydown handler, before the tool gets
// a chance to put the old contents back.
ipcMain.on('app:readClipboardSync', (evt) => {
  try { evt.returnValue = clipboard.readText(); } catch { evt.returnValue = ''; }
});
// NOTE: the terminal theme is mirrored into each agent's per-session Claude
// settings at spawn (hive.ensureAgent theme option) — deliberately NOT via
// `claude config set -g theme`, which would also restyle the user's own
// Claude sessions outside the app.

// ─── IPC: AI text improvement ───────────────────────────────────────────────
// Routes through `claude --print` so no separate API key is needed — uses the
// same authentication as the running agent sessions.
ipcMain.handle('ai:improveText', async (_evt, text: unknown, context: unknown) => {
  if (typeof text !== 'string' || typeof context !== 'string') {
    return { ok: false, error: 'text and context must be strings' };
  }
  // Completion-template format: Claude fills in the blank after "IMPROVED:" which
  // prevents it from asking clarifying questions. Run in os.tmpdir() so no CLAUDE.md
  // or git repo is picked up and Claude stays in pure text-transformation mode.
  // Delimit the user's text with backticks so Claude treats it as content to transform,
  // never as an instruction (even if the text itself is a verb like "Rewrite").
  const prompt = `You are a text editor for AI agent configuration. The user has typed the following as an agent ${context}. Rewrite it to be specific, clear, and actionable. Output ONLY the improved version — no commentary, no preamble, no quotes.\n\nText to improve:\n\`\`\`\n${text}\n\`\`\`\n\nImproved version:`;
  return new Promise<{ ok: boolean; result?: string; error?: string }>((resolve) => {
    // Pipe prompt via stdin to avoid shell argument mangling (newlines, backticks).
    // On Windows, .cmd files require cmd.exe — spawn them directly to avoid EINVAL.
    // We invoke cmd.exe /c claude --print with stdio:pipe so the prompt flows through
    // stdin without touching argv, keeping special characters intact.
    const [cmd, args] = process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'claude', '--print']]
      : ['claude', ['--print']];
    const child = spawn(cmd, args, {
      shell: false,
      cwd: require('node:os').tmpdir(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      const result = stdout.trim();
      if (code === 0 && result) {
        resolve({ ok: true, result });
      } else {
        resolve({ ok: false, error: stderr.trim() || `claude exited with code ${code}` });
      }
    });
    child.on('error', (e: Error) => resolve({ ok: false, error: e.message }));
    setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: 'timed out after 30s' });
    }, 30000);
  });
});

// ─── IPC: folder picker ─────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Pick a folder'
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, path: res.filePaths[0] };
});

// ─── IPC: Knowledge base (shared .md/.txt folders) ──────────────────────────
// Read-only window into the folder-type entries of config.knowledgeBaseSources.
// list/read/search let the app browse them; agents get the folder PATHS in their
// orientation and use their own file tools (see PROTOCOL.md). Files are keyed
// `<sourceIndex>/<relpath>` so multiple folders can be browsed as one. MCP-type
// sources have no local folder — the app cannot browse them, only agents query
// them via the `hive-kb-<n>` MCP servers. Every read is contained to its root.
const KB_EXTS = new Set(['.md', '.txt', '.markdown']);
/** Folder-source roots that exist on disk, in config order. */
function kbFolderRoots(): string[] {
  return resolveKnowledgeBaseSources(readConfig())
    .filter((s) => s.type === 'folder' && s.value.trim() && existsSync(s.value))
    .map((s) => resolve(s.value));
}
/** The message kb:* handlers return when there is no browsable local folder — it
 *  distinguishes an unconfigured KB from an MCP-only KB the app cannot list. */
function kbUnavailableError(): string {
  const mcp = resolveKnowledgeBaseSources(readConfig()).filter((s) => s.type !== 'folder');
  if (mcp.length) {
    return `knowledge base has only MCP source(s) (${mcp.map((s) => s.value).join(', ')}); agents query them via the hive-kb-* MCP servers`;
  }
  return 'no knowledge base configured';
}
function kbListOne(root: string, idx: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let ents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try { ents = readdirSync(dir, { withFileTypes: true }) as unknown as typeof ents; } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && KB_EXTS.has(extname(e.name).toLowerCase())) {
        out.push(`${idx}/${full.slice(root.length + 1).replace(/\\/g, '/')}`);
      }
    }
  };
  walk(root, 0);
  return out.sort();
}
function kbListAll(roots: string[]): string[] {
  return roots.flatMap((root, idx) => kbListOne(root, idx));
}
/** Resolve a caller-supplied `<idx>/<rel>` key to an absolute path INSIDE the
 *  matching root (blocks ../ escape and an out-of-range index). */
function kbResolveKey(roots: string[], key: string): string | null {
  const m = /^(\d+)\/(.*)$/.exec(key);
  if (!m) return null;
  const root = roots[Number(m[1])];
  if (!root) return null;
  const full = resolve(root, m[2]);
  return (full === root || full.startsWith(root + sep)) ? full : null;
}

ipcMain.handle('kb:list', () => {
  const roots = kbFolderRoots();
  if (!roots.length) return { ok: false as const, error: kbUnavailableError() };
  return { ok: true as const, roots, files: kbListAll(roots) };
});
ipcMain.handle('kb:read', (_evt, rel: unknown) => {
  const roots = kbFolderRoots();
  if (!roots.length) return { ok: false as const, error: kbUnavailableError() };
  if (typeof rel !== 'string' || !rel.trim()) return { ok: false as const, error: 'invalid path' };
  const full = kbResolveKey(roots, rel);
  if (!full || !existsSync(full) || !statSync(full).isFile()) return { ok: false as const, error: 'not found' };
  if (!KB_EXTS.has(extname(full).toLowerCase())) return { ok: false as const, error: 'unsupported file type' };
  try { return { ok: true as const, path: rel, content: readFileSync(full, 'utf8') }; }
  catch (e) { return { ok: false as const, error: String(e) }; }
});
ipcMain.handle('kb:search', (_evt, query: unknown) => {
  const roots = kbFolderRoots();
  if (!roots.length) return { ok: false as const, error: kbUnavailableError() };
  if (typeof query !== 'string' || !query.trim()) return { ok: false as const, error: 'empty query' };
  const q = query.toLowerCase();
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const key of kbListAll(roots)) {
    const full = kbResolveKey(roots, key);
    if (!full) continue;
    let text: string;
    try { text = readFileSync(full, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        hits.push({ file: key, line: i + 1, text: lines[i].trim().slice(0, 240) });
        if (hits.length >= 100) return { ok: true as const, hits };
      }
    }
  }
  return { ok: true as const, hits };
});

// ─── IPC: Open system terminal at a folder ───────────────────────────────────
ipcMain.handle('terminal:openAtFolder', async (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'invalid cwd' };
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let cmd: string, args: string[], opts: Record<string, unknown>;
    if (process.platform === 'win32') {
      // Try Windows Terminal first, fall back to PowerShell
      cmd = 'cmd.exe';
      args = ['/c', 'start', 'pwsh.exe', '-NoExit', '-Command', `cd '${cwd}'`];
      opts = { shell: false };
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = ['-a', 'Terminal', cwd];
      opts = {};
    } else {
      cmd = 'xterm';
      args = ['-e', `cd '${cwd}' && bash`];
      opts = {};
    }
    const p = spawn(cmd, args, { ...opts, detached: true, stdio: 'ignore' });
    p.unref();
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    resolve({ ok: true });
  });
});

// ─── IPC: integrations (Phase 2 registry — backend for Ryan's Settings UI) ────
// Records are metadata only (config-backed); secrets are encrypted at rest and NEVER
// returned over IPC. `list` redacts secretRef to a `hasSecret` boolean.
ipcMain.handle('integrations:list', () => integrations.listRecordsRedacted());
ipcMain.handle('integrations:templates', () => INTEGRATION_TEMPLATES);
ipcMain.handle('integrations:upsert', (_evt, record: unknown) => integrations.upsertRecord(record));
ipcMain.handle('integrations:setSecret', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown; secret?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  if (typeof p.secret !== 'string' || !p.secret) return { ok: false, error: 'secret required' };
  return integrations.setSecret(secretRefFor(p.id), p.secret);
});
ipcMain.handle('integrations:remove', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  return integrations.removeRecord(p.id);
});
// ─── IPC: per-CLI-provider BYOK keys (write-only) ────────────────────────────
// API keys for the backend model-providers the non-Claude CLIs use are stored
// WRITE-ONLY under `apikey:<backend>` in the same encrypted broker. The renderer
// can SET a key and ASK whether one is set (boolean) — it can never read the
// plaintext back. Keys are materialized MAIN-ONLY at spawn (spawnAgentCore). Base
// URLs are non-secret and ride HarnessConfig.providerBaseUrls (normal config save).
ipcMain.handle('providerKey:set', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { backend?: unknown; key?: unknown };
  if (typeof p.backend !== 'string' || !(p.backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
  if (typeof p.key !== 'string' || !p.key) return { ok: false, error: 'key required' };
  return integrations.setSecret(providerKeyRef(p.backend), p.key);
});
ipcMain.handle('providerKey:has', (_evt, backend: unknown) =>
  typeof backend === 'string' ? integrations.hasSecret(providerKeyRef(backend)) : false);
ipcMain.handle('providerKey:clear', (_evt, backend: unknown) => {
  if (typeof backend !== 'string' || !(backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
  try { integrations.deleteSecret(providerKeyRef(backend)); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
// Probe an integration's reachability through the broker's own auth path (admin-only;
// runs in main, so the secret is used but never returned — only the upstream status).
ipcMain.handle('integrations:test', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown; path?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  const rec = integrations.getRecord(p.id);
  if (!rec) return { ok: false, error: 'unknown integration' };
  const probe = validateBaseUrl(rec.baseUrl);
  if (!probe.ok) return { ok: false, error: probe.error };
  // Confine the probe path through the SAME gate as the worker forward() path, so an
  // absolute URL / backslash-host / traversal in p.path can't override the origin and
  // exfiltrate the secret to an attacker host. Resolve (and reject) BEFORE the secret
  // is ever materialized, so a bad path never even decrypts it.
  const target = resolveUpstreamUrl(rec.baseUrl, typeof p.path === 'string' ? p.path : '');
  if (!target) return { ok: false, error: 'path escapes the integration baseUrl', code: 'bad_request' };
  const secret = integrations.getSecret(rec.secretRef);
  const headers = buildAuthHeaders(rec.authType, rec.authHeader, secret);
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    const r = await fetch(target, { method: 'GET', headers, redirect: 'manual', signal: ac.signal });
    clearTimeout(timer);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: config ────────────────────────────────────────────────────────────
ipcMain.handle('config:get', (): HarnessConfig => {
  const c = readConfig();
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const accountBadge: 'WORK' | 'PERSONAL' = basename(configDir) === '.claude-personal' ? 'PERSONAL' : 'WORK';
  const billingMode: 'subscription' | 'api' = process.env.ANTHROPIC_API_KEY ? 'api' : 'subscription';
  return { ...c, accountBadge, billingMode };
});
ipcMain.handle('fleet:rateLimitsSnapshot', () => hookServer.allRateLimits());
// Pull the current governor mode (cold-start / reconnect backfill).
ipcMain.handle('fleet:governorSnapshot', () => {
  if (governorLastPayload) {
    return { ...governorLastPayload, mode: governorMode, pausedAgents: [...governorPausedAgents] };
  }
  return {
    mode: governorMode,
    reason: governorMode === 'green' ? 'all clear' : undefined,
    fiveHour: null,
    sevenDay: null,
    profiles: [],
    pausedAgents: [...governorPausedAgents]
  };
});
// Manual override: 'force-green' bypasses pace triggers; undefined clears it.
// Shared by the governor:setOverride IPC (desktop) and the mobile settings route.
function applyGovernorOverride(v: 'force-green' | undefined): void {
  const cfg = readConfig();
  writeConfig({ governorPolicy: { ...(cfg.governorPolicy ?? {}), manualOverride: v } });
  if (v === 'force-green') {
    if (governorMode !== 'green') {
      governorMode = 'green';
      recoverGovernorAgents();
    } else {
      recoverGovernorAgents();
    }
    const payload: GovernorBroadcastPayload = {
      mode: 'green',
      reason: 'manual override: force-green',
      fiveHour: governorLastPayload?.fiveHour ?? null,
      sevenDay: governorLastPayload?.sevenDay ?? null,
      profiles: governorLastPayload?.profiles ?? [],
      override: 'force-green',
      pausedAgents: []
    };
    governorLastPayload = payload;
    try { liveWebContents()?.send('hive:governorMode', payload); } catch { /* */ }
  } else {
    if (governorLastPayload) {
      governorLastPayload = {
        ...governorLastPayload,
        override: undefined,
        mode: governorMode,
        pausedAgents: [...governorPausedAgents]
      };
      try { liveWebContents()?.send('hive:governorMode', governorLastPayload); } catch { /* */ }
    }
  }
}
ipcMain.handle('governor:setOverride', (_evt, override: unknown) => {
  applyGovernorOverride(override === 'force-green' ? 'force-green' : undefined);
  return { ok: true };
});
ipcMain.handle('config:update', (_evt, patch: Partial<HarnessConfig>) => {
  // FIRST RUN: every hive-bound service is started by bootstrapHiveServices(),
  // which runs once at app-ready and early-returns on `!hive.enabled()` — i.e.
  // whenever harnessHome is still null, which is exactly the state a fresh
  // install boots in. Onboarding then sets harnessHome through THIS handler and
  // nothing re-bootstrapped, so the hook server, message router, telemetry
  // collector and mission scheduler all stayed dead for the rest of the session.
  //
  // Symptom: agents spawn and run (the PTY is not hive-bound), but no hook ever
  // reaches the app — no `hooks.sock` on disk, so no SessionStart, which means
  // recordSession() is never called and "Restart & Continue" fails with "No
  // recorded session ID"; the cards also sit on "ctx no status tick yet" and 0
  // tool calls. Everything healed on the next app launch, which is what hid it.
  //
  // changeHome() has always handled this by relaunching; onboarding does not
  // relaunch, so bootstrap here on the null → set transition. Gated on the
  // transition so ordinary config writes never re-enter it.
  const hiveWasEnabled = hive.enabled();
  // When runtimeProfiles is replaced, clean up safeStorage secrets for any removed
  // profiles that had an apiKeyRef (same discipline as lda:remove deleteSecret).
  if (patch.runtimeProfiles !== undefined) {
    const prevProfiles = listRuntimeProfiles();
    const nextIds = new Set<string>();
    for (const p of patch.runtimeProfiles) {
      if (p && typeof (p as { id?: unknown }).id === 'string') nextIds.add(((p as { id: string }).id).trim());
    }
    for (const prev of prevProfiles) {
      if (!nextIds.has(prev.id) && prev.apiKeyRef) {
        try { integrations.deleteSecret(prev.apiKeyRef); } catch { /* best-effort */ }
      }
    }
    // Reject any incoming profile whose baseUrl fails the SSRF guard — same guard
    // upsertRuntimeProfile enforces, closing the bypass where config:update wrote
    // profiles directly without re-validation.
    for (const p of patch.runtimeProfiles) {
      if (p && typeof (p as { baseUrl?: unknown }).baseUrl === 'string') {
        const { baseUrl, allowPrivate } = p as { baseUrl: string; allowPrivate?: boolean };
        if (baseUrl && !isSafeHttpUrl(baseUrl, allowPrivate ?? false)) {
          return { ok: false, error: 'invalid or unsafe baseUrl in runtimeProfiles' };
        }
      }
    }
  }
  const next = writeConfig(patch);
  // Live opt-in/out from Settings → Privacy (TELEMETRY.md).
  if (typeof patch?.telemetryEnabled === 'boolean') analytics.setEnabled(patch.telemetryEnabled);
  // Keep the hive's mirror of the spawn gate current. The queue itself reads
  // config per tick so it gates immediately; this is for the PROMPT, which is
  // built per spawn, so flipping the toggle reaches god the next time he starts.
  if (typeof patch?.orchestratorMaySpawn === 'boolean') hive.setOrchestratorMaySpawn(patch.orchestratorMaySpawn);
  if (!hiveWasEnabled && hive.enabled()) {
    console.log('[hive] harnessHome configured — bootstrapping hive services');
    try { bootstrapHiveServices(); } catch (e) { console.error('[hive] bootstrap after onboarding:', e); }
  }
  return next;
});
ipcMain.handle('config:setAgentTokenCap', (_evt, agentId: unknown, tokenCap: unknown) =>
  setAgentTokenCap(agentId, tokenCap)
);
// Renderer needs both to build the pairing URL: the LAN/Tailscale hostname the
// phone will actually reach (window.location.hostname is useless here — the
// renderer loads over file:// or a dev-server localhost, neither of which the
// phone can dial into).
ipcMain.handle('config:getMobileApiSecret', (): { secret: string; hostname: string; port: number } => ({
  secret: ensureMobileApiSecret(),
  hostname: hostname(),
  port: BROWSER_SERVER_PORT
}));
ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
  return ensureHarnessHome(path);
});

// Change the harnessHome folder. Because every derived path (hive root, palace,
// sock, agent dirs) resolves lazily through getHome(), the only real work is
// optionally MOVING the existing hive + palace and relaunching so every service
// re-binds against the new root. mode: 'move' copies the data (old kept as a
// safety net), 'fresh' just re-points and bootstraps an empty home.
ipcMain.handle('config:changeHome', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { newHome?: unknown; mode?: unknown };
  if (typeof p.newHome !== 'string' || !p.newHome) return { ok: false, error: 'invalid newHome' };
  const mode: 'move' | 'fresh' = p.mode === 'fresh' ? 'fresh' : 'move';
  // expandTilde BEFORE resolve: both UI callers feed a folder-dialog result
  // (always absolute), but the hive picker's recents list can serve a literal
  // "~/…" persisted by a pre-#140 build — resolve() would anchor that at cwd
  // and the app would relaunch against a real directory named "~". Same
  // defence-in-depth-at-the-consumer rule as expandTilde's own doc.
  const newHome = resolve(expandTilde(p.newHome));
  const oldRaw = readConfig().harnessHome;
  const oldHome = oldRaw ? resolve(oldRaw) : null;

  // Guard against same-folder / nested-folder (a move would self-copy forever).
  if (oldHome) {
    if (newHome === oldHome) return { ok: false, error: 'That is already the current home folder.' };
    const a = newHome + sep, b = oldHome + sep;
    if (a.startsWith(b) || b.startsWith(a)) {
      return { ok: false, error: 'Pick a folder that is not inside (or a parent of) the current home.' };
    }
  }

  const ensured = ensureHarnessHome(newHome);
  if (!ensured.ok) return ensured;

  // Tear down everything bound to the OLD root before copying, so nothing writes
  // mid-copy — a live git commit into hive/.git would otherwise be copied as a
  // half-written object and corrupt the moved repo.
  try { clearMissionTimers(); } catch (e) { console.error('[changeHome] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[changeHome] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[changeHome] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[changeHome] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[changeHome] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[changeHome] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[changeHome] hookServer.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[changeHome] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[changeHome] webhook.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[changeHome] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[changeHome] reflector.stop:', e); }

  if (mode === 'move' && oldHome) {
    try {
      // The roster now lives INSIDE hive/ (device-sync), so copying 'hive' already
      // carries it; only its append-only backups need to ride along separately.
      // (A legacy pre-migration roster.json at the old root, if any, is picked up
      // by migrateRosterLocation on the next read against newHome.)
      for (const sub of ['hive', 'palace', 'roster-backups']) {
        const src = join(oldHome, sub);
        if (!existsSync(src)) continue;
        // cpSync copies the whole tree incl. .git and is cross-device safe (unlike
        // renameSync, which throws EXDEV across volumes). We COPY, never delete —
        // the old folder stays as a safety net the user removes manually.
        cpSync(src, join(newHome, sub), { recursive: true, force: true, dereference: false });
      }
    } catch (e) {
      // Copy failed: recover IN PLACE against the unchanged old home (config never
      // repointed) so the user loses nothing, and surface the error — no relaunch.
      bootstrapHiveServices();
      const cfg = readConfig();
      if (cfg.slackEnabled && cfg.slackSigningSecret) void startSlackServer();
      reconcileWebhookServer();
      return { ok: false, error: `Could not copy data: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Repoint config and relaunch so every service re-bootstraps against newHome.
  // (Identical recovery path to resetAll — relaunch is the clean re-bind.)
  allowQuit = true;
  writeConfig({ harnessHome: newHome });
  try { ptyManager.killAll(); } catch (e) { console.error('[changeHome] killAll:', e); }
  app.relaunch();
  app.exit(0);
  return { ok: true as const }; // unreachable (process exits) — typed for the renderer
});

// ─── IPC: filesystem (sandboxed to a root) ──────────────────────────────────
ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return listDir(root, rel);
});
ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileText(root, rel);
});
// Raw bytes for files the text reader refuses (images). The renderer cannot
// load them off disk itself — the CSP has no `file:` source and no file
// protocol is registered — so the bytes come through here and become a `blob:`
// URL on the other side. Same root confinement as every other fs handler.
ipcMain.handle('fs:readBinary', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileBinary(root, rel);
});
ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return writeFileText(root, rel, content);
});
// v0.3.4: existence check for the terminal ⌘-click markdown flow (metadata only).
ipcMain.handle('fs:statAbs', (_evt, p: unknown) => {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) {
    return { exists: false, isFile: false, path: '' };
  }
  return statAbs(p);
});

/** Reveal a path in the OS file browser — Finder, Explorer, or whatever the
 *  Linux desktop registers. Backs ⌘-click on a terminal path we cannot open
 *  ourselves (an image, an archive, an unknown extension).
 *
 *  `showItemInFolder`, NEVER `shell.openPath`, for a file. The path arrives
 *  from agent output, and openPath hands an arbitrary file to its default
 *  application: a printed `installer.dmg` or `.desktop` would be one click from
 *  executing. Revealing only ever opens a file browser, so the worst an agent
 *  can achieve by printing a path is a window at a folder the user could
 *  already open themselves.
 *
 *  openPath IS used for a directory, and only after statAbs has confirmed it is
 *  one — a directory has no default application to launch, so the execution
 *  argument above does not apply, and revealing a folder inside its parent is
 *  not what "open this folder" means to anyone. */
ipcMain.handle('fs:revealPath', async (_evt, p: unknown) => {
  if (typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) {
    return { ok: false, error: 'bad request' };
  }
  const st = await statAbs(p);
  if (!st.exists) return { ok: false, error: 'not found' };
  if (st.isFile) { shell.showItemInFolder(st.path); return { ok: true }; }
  const err = await shell.openPath(st.path);
  return err ? { ok: false, error: err } : { ok: true };
});

// ─── IPC: artifact review queue ───────────────────────────────────────────────
// Human review of agent-generated artifacts dropped into <hive>/artifacts/.
// See src/main/artifacts.ts and hive/artifacts/README.md.
function artifactsHiveRoot(): string | null {
  return hive.root() ?? (resolveHarnessHome() ? join(resolveHarnessHome()!, 'hive') : null);
}

let artifactsWatchStarted = false;
/** Start the artifacts directory watcher once the hive root is known, pushing
 *  `hive:artifactsChanged` to the renderer on every change so the queue and its
 *  tab badge stay live. Idempotent. */
function ensureArtifactsWatcher(): void {
  if (artifactsWatchStarted) return;
  const root = artifactsHiveRoot();
  if (!root) return;
  artifactsWatchStarted = true;
  artifacts.startWatch(root, () => {
    try { liveWebContents()?.send('hive:artifactsChanged'); } catch { /* window torn down */ }
  });
}

ipcMain.handle('artifacts:list', async () => {
  const root = artifactsHiveRoot();
  if (!root) return [];
  ensureArtifactsWatcher();
  return artifacts.list(root);
});
ipcMain.handle('artifacts:approve', async (_evt, id: unknown, note: unknown) => {
  const root = artifactsHiveRoot();
  if (!root) return { ok: false, error: 'no hive root' };
  if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid id' };
  const res = await artifacts.decide(root, id, 'approved', typeof note === 'string' ? note : undefined);
  if (res.ok) { try { liveWebContents()?.send('hive:artifactsChanged'); } catch { /* window gone */ } }
  return res;
});
ipcMain.handle('artifacts:reject', async (_evt, id: unknown, note: unknown) => {
  const root = artifactsHiveRoot();
  if (!root) return { ok: false, error: 'no hive root' };
  if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid id' };
  const res = await artifacts.decide(root, id, 'rejected', typeof note === 'string' ? note : undefined);
  if (res.ok) { try { liveWebContents()?.send('hive:artifactsChanged'); } catch { /* window gone */ } }
  return res;
});
ipcMain.handle('artifacts:readFile', async (_evt, id: unknown) => {
  const root = artifactsHiveRoot();
  if (!root) return { ok: false, error: 'no hive root' };
  if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid id' };
  return artifacts.readText(root, id);
});
ipcMain.handle('artifacts:readImage', async (_evt, id: unknown) => {
  const root = artifactsHiveRoot();
  if (!root) return { ok: false, error: 'no hive root' };
  if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid id' };
  return artifacts.readImage(root, id);
});
// Reveal the artifact file in the OS browser (the `design` preview's open button).
// showItemInFolder only — never shell.openPath on a file — same reasoning as
// fs:revealPath above: the path is agent-authored and openPath would launch it.
ipcMain.handle('artifacts:reveal', async (_evt, id: unknown) => {
  const root = artifactsHiveRoot();
  if (!root) return { ok: false, error: 'no hive root' };
  if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid id' };
  const p = await artifacts.filePathOf(root, id);
  if (!p) return { ok: false, error: 'artifact not found' };
  const st = await statAbs(p);
  if (!st.exists) return { ok: false, error: 'file not found' };
  if (st.isFile) { shell.showItemInFolder(st.path); return { ok: true }; }
  const err = await shell.openPath(st.path);
  return err ? { ok: false, error: err } : { ok: true };
});

// ─── IPC: git ───────────────────────────────────────────────────────────────
ipcMain.handle('git:isRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return false;
  return isRepo(cwd);
});

// The repo a cwd belongs to, following a linked worktree back to its main
// checkout — the renderer groups the agent roster by this.
ipcMain.handle('git:mainRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || !cwd) return null;
  return mainRepoRoot(cwd);
});
ipcMain.handle('git:branch', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranch(cwd);
});
ipcMain.handle('git:status', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getStatus(cwd);
});
ipcMain.handle('git:log', (_evt, cwd: unknown, n: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  const count = typeof n === 'number' ? Math.min(500, Math.max(1, n)) : 50;
  return getLog(cwd, count);
});
ipcMain.handle('git:branches', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranches(cwd);
});
ipcMain.handle('git:aheadBehind', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getAheadBehind(cwd);
});
ipcMain.handle('git:diff', (_evt, cwd: unknown, relPath: unknown) => {
  if (typeof cwd !== 'string' || typeof relPath !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return getDiff(cwd, relPath);
});
// ─── v0.3.4: history / compare / checkout (git visualization) ───────────────
ipcMain.handle('git:logGraph', (_evt, cwd: unknown, n: unknown, skip: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid args' };
  const count = Math.min(500, Math.max(1, typeof n === 'number' ? n : 200));
  const off = Math.max(0, typeof skip === 'number' ? skip : 0);
  return getLogGraph(cwd, count, off);
});
ipcMain.handle('git:commitFiles', (_evt, cwd: unknown, sha: unknown) => {
  if (typeof cwd !== 'string' || typeof sha !== 'string') return { error: 'invalid args' };
  return getCommitFiles(cwd, sha);
});
ipcMain.handle('git:showFile', (_evt, cwd: unknown, rev: unknown, relPath: unknown) => {
  if (typeof cwd !== 'string' || typeof rev !== 'string' || typeof relPath !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return getFileAtRev(cwd, rev, relPath);
});
ipcMain.handle('git:compareRefs', (_evt, cwd: unknown, base: unknown, head: unknown, mode: unknown) => {
  if (typeof cwd !== 'string' || typeof base !== 'string' || typeof head !== 'string') {
    return { error: 'invalid args' };
  }
  return compareRefs(cwd, base, head, mode === 'two' ? 'two' : 'three');
});
ipcMain.handle('git:worktrees', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid args' };
  return listWorktrees(cwd);
});
ipcMain.handle('git:checkout', async (_evt, cwd: unknown, ref: unknown, detach: unknown) => {
  if (typeof cwd !== 'string' || typeof ref !== 'string') return { ok: false, error: 'invalid args' };
  // Guard: never swap files under an actively-working agent. Objective signal
  // owned by main — any live pty whose cwd sits in this tree and emitted output
  // in the last 10s is treated as mid-run. (Idle-but-open terminals are fine:
  // checkoutRef additionally requires a clean tree, and TUIs redraw on fs
  // changes gracefully.)
  const busy = ptyManager.list().find((p) =>
    (p.cwd === cwd || p.cwd.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)) &&
    Date.now() - p.lastOutputAt < 10_000
  );
  if (busy) {
    return { ok: false, error: `an agent is actively working in this repo (${busy.id}) — try again when it goes quiet` };
  }
  return checkoutRef(cwd, ref, detach === true);
});

// ─── IPC: roster mirror (shared between dev and a packaged build) ───────────
// The renderer's store is built synchronously at module load, before any async
// IPC could resolve, so the read is `ipcMain.on` + `returnValue` — one blocking
// round trip at boot, in exchange for the roster being correct on first paint
// instead of flashing an empty floor and then filling in.
// (`roster` itself is constructed earlier so HookServer can read standing goals.)
ipcMain.on('roster:readSync', (evt) => { evt.returnValue = roster.read(); });
ipcMain.handle('roster:read', () => roster.read());
ipcMain.handle('roster:write', (_evt, snap: unknown) => roster.write(snap));

// ─── IPC: hive (multi-agent coordination) ───────────────────────────────────
ipcMain.handle('hive:registry', () => hive.registry());
ipcMain.handle('hive:renameAgent', (_evt, id: unknown, name: unknown) => {
  if (typeof id !== 'string' || typeof name !== 'string') {
    return { ok: false, error: 'Invalid rename request' };
  }
  return hive.renameAgent(id, name);
});
ipcMain.handle('hive:setAgentHold', (_evt, id: unknown, hold: unknown) => {
  if (typeof id !== 'string' || typeof hold !== 'boolean') {
    return { ok: false, error: 'Invalid hold request' };
  }
  return hive.setAgentHold(id, hold);
});
ipcMain.handle('hive:board', () => hive.board());
ipcMain.handle('hive:tasks', () => hive.tasks());
ipcMain.handle('hive:log', (_evt, n: unknown) => hive.logTail(typeof n === 'number' ? n : 200));
ipcMain.handle('hive:memory', (_evt, id: unknown) => (typeof id === 'string' ? hive.memory(id) : ''));
ipcMain.handle('hive:inbox', (_evt, id: unknown) => (typeof id === 'string' ? hive.inbox(id) : []));
// Voice read-layer: recent message CONTENT (inbox/outbox bodies), REDACTED
// main-side by hive.voiceMessages(). The renderer/voice layer never sees a raw
// body — secrets are stripped here, before the result crosses IPC.
ipcMain.handle('hive:messages', (_evt, opts: unknown) =>
  hive.voiceMessages(opts && typeof opts === 'object' ? (opts as Parameters<typeof hive.voiceMessages>[0]) : {})
);
ipcMain.handle('hive:send', (_evt, partial: Partial<HiveMessage>, from: unknown) => {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const msg = hive.send(partial ?? {}, typeof from === 'string' ? from : 'system');
  return { ok: true, message: msg };
});
ipcMain.handle('hive:addTask', (_evt, task: unknown) => {
  if (!task || typeof task !== 'object' || Array.isArray(task)
    || typeof (task as { id?: unknown }).id !== 'string') {
    return { ok: false, error: 'invalid task' };
  }
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: hive.addTask(task as HiveTask) };
});
ipcMain.handle('hive:patchTask', (_evt, id: unknown, patch: unknown) => {
  if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'invalid task patch' };
  }
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>) };
});
ipcMain.handle('hive:deleteTask', (_evt, id: unknown) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid task id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const res = hive.deleteTask(id);
  broadcastHumanQAChanged();
  return { ok: res };
});

function broadcastHumanQAChanged(): void {
  try {
    liveWebContents()?.send('hive:humanQAChanged');
    broadcastBrowserEvent('hive:humanQAChanged', []);
  } catch { /* best effort */ }
}

let tasksJsonWatchPath: string | null = null;
function setupTasksJsonWatcher(): void {
  const root = hive.root();
  if (!root) return;
  const target = join(root, 'tasks.json');
  if (tasksJsonWatchPath === target) return;
  if (tasksJsonWatchPath) {
    try { unwatchFile(tasksJsonWatchPath); } catch { /* best effort */ }
  }
  tasksJsonWatchPath = target;
  try {
    watchFile(target, { interval: 1000 }, () => {
      broadcastHumanQAChanged();
    });
  } catch (e) {
    console.error('[tasksWatcher] error watching tasks.json:', e);
  }
}

ipcMain.handle('tasks:openHumanQA', () => {
  setupTasksJsonWatcher();
  if (!hive.enabled()) return [];
  const ledger = hive.tasks() as { tasks?: HiveTask[] };
  const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  const openItems: Array<{
    taskId: string;
    taskTitle: string;
    assignee: string | null;
    question: string;
    priority?: 'urgent' | 'normal' | 'backlog';
    askedAt: string;
  }> = [];

  for (const t of tasks) {
    if (!t) continue;
    const taskPriority: 'urgent' | 'normal' | 'backlog' =
      (t.priority === 1 || t.priority === 'urgent' || (t as any).isUrgent) ? 'urgent' :
      (t.priority === 3 || t.priority === 'backlog') ? 'backlog' : 'normal';

    const qaList = Array.isArray(t.humanQA) ? t.humanQA : [];
    for (const qa of qaList) {
      if (qa && qa.q && !qa.a) {
        const itemPriority = qa.priority === 'urgent' ? 'urgent' : qa.priority === 'backlog' ? 'backlog' : taskPriority;
        openItems.push({
          taskId: t.id,
          taskTitle: t.title || t.id,
          assignee: t.assignee ?? null,
          question: qa.q,
          priority: itemPriority,
          askedAt: qa.askedAt || t.createdAt || new Date().toISOString()
        });
      }
    }
  }
  openItems.sort((a, b) => {
    if (a.priority === 'urgent' && b.priority !== 'urgent') return -1;
    if (b.priority === 'urgent' && a.priority !== 'urgent') return 1;
    return 0;
  });
  return openItems;
});

ipcMain.handle('tasks:answerHumanQA', async (_evt, taskId: unknown, question: unknown, verdict: unknown, note?: unknown) => {
  if (typeof taskId !== 'string' || !taskId) return { ok: false, error: 'invalid taskId' };
  if (typeof question !== 'string' || !question) return { ok: false, error: 'invalid question' };
  const v = verdict === 'FAIL' ? 'FAIL' : 'PASS';
  const n = typeof note === 'string' && note.trim() ? note.trim() : undefined;
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };

  const ledger = hive.tasks() as { tasks?: HiveTask[] };
  const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  const taskIndex = tasks.findIndex((t) => t?.id === taskId);
  if (taskIndex < 0) return { ok: false, error: `task ${taskId} not found` };

  const task = { ...tasks[taskIndex] };
  const qaList = Array.isArray(task.humanQA) ? [...task.humanQA] : [];
  let qaIndex = qaList.findIndex((qa) => qa.q === question && !qa.a);
  if (qaIndex < 0) {
    qaIndex = qaList.findIndex((qa) => qa.q === question);
  }
  const answerText = n ? `${v}: ${n}` : v;
  const nowIso = new Date().toISOString();

  if (qaIndex >= 0) {
    qaList[qaIndex] = {
      ...qaList[qaIndex],
      a: answerText,
      answeredAt: nowIso
    };
  } else {
    qaList.push({
      q: question,
      a: answerText,
      askedAt: nowIso,
      answeredAt: nowIso
    });
  }

  task.humanQA = qaList;
  if (v === 'PASS') {
    task.status = 'done';
  } else {
    task.status = 'doing';
  }

  const updatedTasks = [...tasks];
  updatedTasks[taskIndex] = task;
  hive.writeTasks(updatedTasks);

  if (task.assignee) {
    try {
      if (v === 'PASS') {
        hive.send({
          to: task.assignee,
          act: 'inform',
          subject: 'UAT passed',
          body: `Your task "${task.title}" passed UAT. Task is closed.`
        }, 'human');
      } else {
        hive.send({
          to: task.assignee,
          act: 'warn',
          subject: 'UAT failed',
          body: `Your task "${task.title}" failed UAT: ${n || 'No details provided'}. Fix and report done again.`
        }, 'human');
      }
    } catch (e) {
      console.error('[humanQA] failed to send notification to assignee:', e);
    }
  }

  broadcastHumanQAChanged();
  return { ok: true };
});

ipcMain.handle('tasks:dismissHumanQA', async (_evt, taskId: unknown, question: unknown) => {
  if (typeof taskId !== 'string' || !taskId) return { ok: false, error: 'invalid taskId' };
  if (typeof question !== 'string' || !question) return { ok: false, error: 'invalid question' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };

  const ledger = hive.tasks() as { tasks?: HiveTask[] };
  const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  const taskIndex = tasks.findIndex((t) => t?.id === taskId);
  if (taskIndex < 0) return { ok: false, error: `task ${taskId} not found` };

  const task = { ...tasks[taskIndex] };
  const qaList = Array.isArray(task.humanQA) ? [...task.humanQA] : [];
  let qaIndex = qaList.findIndex((qa) => qa.q === question && !qa.a);
  if (qaIndex < 0) {
    qaIndex = qaList.findIndex((qa) => qa.q === question);
  }
  const nowIso = new Date().toISOString();

  if (qaIndex >= 0) {
    qaList[qaIndex] = {
      ...qaList[qaIndex],
      a: 'dismissed by user',
      dismissedAt: nowIso,
      answeredAt: nowIso
    };
  } else {
    qaList.push({
      q: question,
      a: 'dismissed by user',
      askedAt: nowIso,
      dismissedAt: nowIso,
      answeredAt: nowIso
    });
  }

  task.humanQA = qaList;
  const updatedTasks = [...tasks];
  updatedTasks[taskIndex] = task;
  hive.writeTasks(updatedTasks);

  broadcastHumanQAChanged();
  liveWebContents()?.send('hive:tasksChanged');
  broadcastBrowserEvent('hive:tasksChanged', []);
  return { ok: true };
});
ipcMain.handle('hive:setArchived', (_evt, id: unknown, archived: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  hive.setArchived(id, archived === true);
  return { ok: true };
});
ipcMain.handle('hive:patchAgentRole', (_evt, id: unknown, role: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (typeof role !== 'string') return { ok: false, error: 'invalid role' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return hive.patchAgentRole(id, role);
});
ipcMain.handle('hive:patchAgentEngine', (_evt, id: unknown, patch: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid patch' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const { provider, profileId } = patch as { provider?: AgentProvider | null; profileId?: string | null };
  return hive.patchAgentEngine(id, { provider: provider ?? undefined, profileId: profileId ?? undefined });
});

// ─── IPC: Settings hero payload (remote data, cached) ───────────────────────
/** Plan copy and sponsor, fetched from the repo so they can change without a
 *  release. Validated in shared/heroPayload before it reaches the renderer. */
ipcMain.handle('hero:payload', async (_evt, force: unknown) =>
  loadHero(join(app.getPath('userData'), 'hero.json'), { force: force === true }));

// ─── IPC: skills (installed locally, and the browsable catalog) ─────────────
/** Skills the CLIs on this machine can already use. Scans the registered repos
 *  plus the agent's own cwd, so a project-scoped skill shows up where it applies. */
ipcMain.handle('skills:local', (_evt, cwd: unknown): LocalSkill[] => {
  const cfg = readConfig();
  const cwds = [
    ...(typeof cwd === 'string' && cwd ? [cwd] : []),
    ...(cfg.registeredRepos ?? [])
  ];
  try {
    return listLocalSkills({ cwds, bundledDir: skillsResourceDir() });
  } catch (e) {
    console.error('[skills] local scan failed:', e);
    return [];
  }
});
/** The skills catalog, parsed from its README and cached in userData.
 *  `force` is the explicit refresh button; everything else is served from a
 *  day-old cache so opening the tab never waits on the network. */
ipcMain.handle('skills:catalog', async (_evt, force: unknown) => {
  const cachePath = join(app.getPath('userData'), 'skill-catalog.json');
  return loadCatalog(cachePath, { force: force === true });
});

/** Install one catalog skill into ~/.claude/skills. Structured refusals, never a
 *  throw: the UI distinguishes "not installable" from "install failed". */
ipcMain.handle('skills:install', async (_evt, url: unknown, name: unknown) => {
  if (typeof url !== 'string' || typeof name !== 'string') {
    return { ok: false as const, error: 'bad request' };
  }
  return installSkill(url, name);
});
/** Delete an installed skill. The guard rails live in uninstallSkill — it refuses
 *  any path it cannot prove is a skill folder inside a skills root. */
ipcMain.handle('skills:uninstall', (_evt, path: unknown) => {
  if (typeof path !== 'string') return { ok: false as const, error: 'bad request' };
  const cfg = readConfig();
  return uninstallSkill(path, { cwds: cfg.registeredRepos ?? [] });
});
/** Reveal a skill on disk. `openExternal` is deliberately https-only, so a
 *  file:// URL cannot (and should not) be smuggled through it. */
ipcMain.handle('skills:reveal', (_evt, path: unknown) => {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, error: 'bad request' };
  const skillRoots = [join(homedir(), '.claude', 'skills'), join(homedir(), '.config', 'opencode')];
  const target = resolve(path);
  const inRoot = skillRoots.some((r) => target.startsWith(resolve(r) + sep))
    || (readConfig().registeredRepos ?? []).some((c) => target.startsWith(resolve(c) + sep));
  if (!inRoot) return { ok: false, error: 'outside a managed skills directory' };
  shell.showItemInFolder(target);
  return { ok: true };
});

// ─── IPC: setup catalog (which external tools are actually here) ────────────
/**
 * Probe every catalog row against THIS machine.
 *
 * Presence is a PATH resolution, not a spawn: running each candidate to read a
 * --version would be a dozen process launches on every panel open, and several of
 * these CLIs boot a TUI when invoked bare. `resolveCommand` returns its input
 * unchanged when it finds nothing, so "resolved to a real, existing path that is
 * not just the bare name" is the found test.
 *
 * mempalace is the one row that does NOT come from PATH: the memory subsystem
 * already resolves it (including uv/pip locations PATH may not carry for a
 * Finder-launched app) and knows whether the palace is initialised, so it is
 * authoritative and reused rather than re-probed differently here.
 */
ipcMain.handle('tools:status', (): ToolStatus[] => {
  const win = process.platform === 'win32';
  const mem = (() => { try { memory.resetBinCache(); return memory.status(); } catch { return null; } })();
  return toolCatalog().map((spec): ToolStatus => {
    const installCommand = win ? spec.install.win32 : spec.install.posix;
    if (spec.id === 'mempalace') {
      return {
        ...spec,
        installCommand,
        found: !!mem?.available,
        path: mem?.bin ?? null,
        detail: mem?.available
          ? (mem.initialized ? 'palace initialised' : 'installed — palace not built yet')
          : undefined
      };
    }
    if (!spec.bin) return { ...spec, installCommand, found: false, path: null };
    let path: string | null = null;
    try {
      const resolved = resolveCliCommand(spec.bin);
      if (resolved !== spec.bin && existsSync(resolved)) path = resolved;
    } catch { /* a probe must never take the panel down */ }
    return { ...spec, installCommand, found: !!path, path };
  });
});

// ─── IPC: semantic memory (MemPalace CLI) ───────────────────────────────────
// refresh() = resetBinCache + an idempotent start(). The poll is the one thing
// that reliably notices mempalace being installed after boot, so it is what arms
// the mine loop that boot's start() had to skip — otherwise the pill reads
// "getting ready" until the app is restarted.
ipcMain.handle('hive:memoryStatus', () => memory.refresh());
ipcMain.handle('hive:searchMemory', (_evt, query: unknown, wing: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, output: '', error: 'empty query' };
  return memory.search(query, { wing: typeof wing === 'string' ? wing : undefined });
});
ipcMain.handle('hive:memoryWakeUp', (_evt, wing: unknown) =>
  memory.wakeUp(typeof wing === 'string' ? wing : undefined));
ipcMain.handle('hive:mineNow', () => { memory.mineNow(); return { ok: true }; });
// Condense memory.md on demand: an explicit id condenses that one agent (skips
// the size trigger — a "condense now" button); no id runs a full threshold scan.
ipcMain.handle('memory:reflectNow', (_evt, id: unknown) =>
  reflector.reflectNow(typeof id === 'string' && id ? id : undefined));

// ─── IPC: enterprise Knowledge Graph (multimodal context for agents) ─────────
ipcMain.handle('kg:status', () => knowledge.status());
ipcMain.handle('kg:list', () => knowledge.list());
ipcMain.handle('kg:search', (_evt, query: unknown, limit: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return [];
  return knowledge.search(query, typeof limit === 'number' ? limit : undefined);
});
ipcMain.handle('kg:get', (_evt, id: unknown) =>
  (typeof id === 'string' && id ? knowledge.get(id) : null));
ipcMain.handle('kg:remove', (_evt, id: unknown) =>
  ({ ok: typeof id === 'string' && id ? knowledge.remove(id) : false }));
// Ingest one or more files from disk. Best-effort per file; returns per-file
// results so the UI can report partial success.
ipcMain.handle('kg:ingestFiles', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { paths?: unknown; tags?: unknown };
  const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : [];
  const tags = Array.isArray(p.tags) ? p.tags.filter((x): x is string => typeof x === 'string') : undefined;
  const results = paths.map((srcPath) => {
    try {
      const r = knowledge.ingestFile(srcPath, { tags });
      return { ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount };
    } catch (e) {
      return { ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { results };
});
// Open a multi-file picker and ingest the chosen artifacts in one round-trip.
ipcMain.handle('kg:addFiles', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: 'Add documents to the Knowledge Graph'
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  const results = res.filePaths.map((srcPath) => {
    try {
      const r = knowledge.ingestFile(srcPath);
      return { ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount };
    } catch (e) {
      return { ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { ok: true as const, results };
});

// ─── IPC: composer attachments (images + arbitrary files, attached by PATH) ──
// The message queue pipes raw text into a Claude CLI PTY, so attachments travel
// as a file PATH the agent reads with its Read tool (same convention as Slack).
// Picker offers an Images group + All Files.
ipcMain.handle('dialog:attachFiles', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach files',
    // Any file type — All Files is the default; the Images group is a convenience
    // shortcut, not a restriction.
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tiff', 'avif'] }
    ]
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return {
    ok: true as const,
    files: res.filePaths.map((p) => {
      let size: number | undefined;
      try { size = statSync(p).size; } catch { /* unreadable — omit size */ }
      return { path: p, name: basename(p), size };
    })
  };
});

// Persist the current native clipboard image to a temp PNG so a pasted
// screenshot can be attached by PATH. Returns an error result when the
// clipboard holds no image (e.g. a normal text paste).
ipcMain.handle('clipboard:saveImage', async () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return { ok: false as const, error: 'no image in clipboard' };
    const dir = join(app.getPath('temp'), 'cth-pastes');
    mkdirSync(dir, { recursive: true });
    const name = `paste-${Date.now()}.png`;
    const dest = join(dir, name);
    writeFileSync(dest, img.toPNG());
    return { ok: true as const, file: { path: dest, name } };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: command history (SQLite — every prompt submitted to an agent) ──────
ipcMain.handle('history:add', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { agentId?: unknown; cwd?: unknown; text?: unknown };
  if (typeof p.agentId !== 'string' || typeof p.text !== 'string') return { ok: false, error: 'invalid args' };
  try {
    persist.addHistory({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text });
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('history:list', (_evt, agentId: unknown, limit: unknown) =>
  persist.listHistory(
    typeof agentId === 'string' && agentId ? agentId : undefined,
    typeof limit === 'number' ? limit : undefined
  ));
ipcMain.handle('history:search', (_evt, query: unknown, limit: unknown) =>
  persist.searchHistory(typeof query === 'string' ? query : '', typeof limit === 'number' ? limit : undefined));

let saveStatePending = false;

function broadcastSaveStateToActiveAgents(): void {
  try {
    const hiveRoot = hive.root();
    if (!hiveRoot) return;
    const activeAgentIds = [...new Set(ptyToAgent.values())];
    if (activeAgentIds.length === 0) return;
    const now = new Date();
    const created_at = now.toISOString();
    const ts = created_at.replace(/[:.]/g, '-');
    for (const agentId of activeAgentIds) {
      const inboxDir = join(hiveRoot, 'agents', agentId, 'inbox');
      if (!existsSync(inboxDir)) {
        try { mkdirSync(inboxDir, { recursive: true }); } catch { /* best-effort */ }
      }
      const msgId = randomUUID();
      const payload = {
        id: msgId,
        from: 'system',
        to: agentId,
        act: 'save_state',
        subject: 'App closing — save your session now',
        body: 'Write your session handoff to .remember/remember.md immediately.',
        created_at
      };
      try {
        atomicWriteJson(join(inboxDir, `${ts}-save-exit.json`), payload);
      } catch (err) {
        console.error(`[quit] failed writing save_state to ${agentId}:`, err);
      }
    }
  } catch (err) {
    console.error('[quit] broadcastSaveStateToActiveAgents failed:', err);
  }
}

// ─── IPC: quit confirmation ─────────────────────────────────────────────────
/** Tear the harness down and quit. Shared by the hard "kill all & quit" path
 *  and the closing-time conclusion (after the god confirmed the floor saved). */
function teardownAndQuit(): void {
  allowQuit = true;
  // Each teardown step is best-effort: a throw here (e.g. a dying child or a
  // half-torn-down socket) must never abort the quit or pop a crash dialog.
  try { clearMissionTimers(); } catch (e) { console.error('[quit] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[quit] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[quit] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[quit] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[quit] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[quit] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[quit] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[quit] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[quit] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[quit] webhook.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[quit] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[quit] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[quit] persist.close:', e); }
  try { hive.stopAllProxyBridges(); } catch (e) { console.error('[quit] stopAllProxyBridges:', e); }
  try { if (browserServer) browserServer.close(); } catch (e) { console.error('[quit] browserServer.close:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[quit] killAll:', e); }
  // Release the cross-device advisory lock, then (best-effort) push the released
  // hive so the next device sees "free" and no stale-owner TTL wait is needed.
  try { const r = hive.root(); if (r) syncLock.release(r); } catch (e) { console.error('[quit] sync lock release:', e); }
  try { const r = hive.root(); if (r) sync.syncOnQuit(r); } catch (e) { console.error('[quit] syncOnQuit:', e); }
  app.quit();
}
ipcMain.handle('app:confirmClose', () => {
  closingTime.cancel(); // a hard quit overrides a closing time in progress
  if (!saveStatePending && ptyManager.list().length > 0) {
    saveStatePending = true;
    broadcastSaveStateToActiveAgents();
    setTimeout(() => {
      teardownAndQuit();
    }, 8000);
  } else {
    teardownAndQuit();
  }
});
ipcMain.handle('app:cancelClose', () => {
  // The modal closes on the renderer side. The one thing main owes anybody here
  // is the truth about a restart-to-install: if this quit was one, it has just
  // been called off, and whoever is waiting on it needs to hear that rather than
  // sit disabled forever waiting for a process that is not going to die.
  abortPendingRestart();
});

// Open a new floor (independent office window). Gated by the multiWindow flag
// inside openFloor(); returns whether a window opened so a renderer button can
// reflect availability. The app-menu "New Floor" item calls openFloor() directly.
ipcMain.handle('window:newFloor', () => {
  const win = openFloor();
  return { ok: win != null };
});

// ─── IPC: closing time (graceful, data-loss-free shutdown) ──────────────────
// The third quit-dialog button. The god broadcasts closing time, every worker
// saves its memory and ACKs, the god concludes with CLOSING-TIME-COMPLETE —
// only then does the harness tear down. See closingTime.ts for the protocol.
const closingTime = new ClosingTimeController(
  hive,
  // Roster source: agents with a live PTY right now (ptyToAgent is pruned on
  // every teardown). The registry alone would include ghost workers from
  // sessions that ended with a hard quit — never archived, never able to ACK.
  () => [...new Set(ptyToAgent.values())],
  () => liveWebContents(),
  () => teardownAndQuit(),
  // #7C.2 steering — the graceful interrupt that reaches deeply busy agents
  // at their next hook boundary instead of waiting for a Stop.
  control
);
hive.setRoutedObserver((msg, targets) => {
  closingTime.onRouted(msg, targets);
  // Electron toast for FAIL/BLOCK activity updates, gated on the notifications
  // setting (same guard as breakerToast above). Lives here, not in hive.ts,
  // because hive.ts intentionally has no config import.
  if (msg.surface_activity && (msg.activity_badge === 'FAIL' || msg.activity_badge === 'BLOCK')) {
    if (readConfig().notifications) {
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: msg.activity_headline ?? msg.subject,
            body: msg.body.slice(0, 200)
          }).show();
        }
      } catch { /* notification unsupported */ }
    }
  }
});
ipcMain.handle('app:startClosingTime', () => closingTime.start());
ipcMain.handle('app:cancelClosingTime', () => closingTime.cancel());

// ─── IPC: full reset (wipe data + config, relaunch into onboarding) ──────────
ipcMain.handle('app:resetAll', () => {
  allowQuit = true;
  // Tear everything down first so nothing writes back into the dirs we wipe.
  try { clearMissionTimers(); } catch (e) { console.error('[reset] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[reset] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[reset] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[reset] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[reset] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[reset] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[reset] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[reset] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[reset] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[reset] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[reset] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[reset] persist.close:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[reset] killAll:', e); }
  // Erase the hive (Abathur's + every agent's memory, inboxes, tasks, board,
  // git history) and the semantic-memory palace. Only these harness-created
  // subdirs are removed — never the user's whole harnessHome folder.
  for (const dir of [hive.root(), memory.palacePath()]) {
    if (!dir) continue;
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('[reset] rm', dir, e); }
  }
  // The roster is the renderer's half of the same state, so it retires with the
  // hive — archived into roster-backups/ rather than deleted, and cleared as the
  // active file so re-selecting this folder later doesn't resurrect agents whose
  // sessions and memory are gone.
  try { roster.archive(); }
  catch (e) { console.error('[reset] roster.archive:', e); }
  // Back to first-run defaults, then relaunch clean so all in-memory services
  // re-bootstrap from scratch and the renderer lands on onboarding.
  resetConfig();
  app.relaunch();
  app.exit(0);
});

// ─── IPC: token telemetry (real usage + est. cost from CC transcripts) ───────
// Reconciler/fallback path: per-cwd transcript sum, now priced PER MODEL (cost
// bug #1 fixed in pricing.ts). Kept for back-compat with the existing UsageRow.
ipcMain.handle('hive:agentUsage', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? readAgentUsage(cwd) : null);
// Current context size (tokens) of an agent's LIVE session — the transcript
// path is learned from the agent's hook payloads (SessionStart fires right at
// spawn), so this works even when several agents share one cwd. Null until the
// first hook fires; a known-but-empty transcript reads as 0 so a freshly
// (re)started session zeroes the gauge instead of leaving a stale value up.
ipcMain.handle('hive:agentContext', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  const tp = hookServer.transcriptPath(agentId);
  if (!tp) return null;
  return readContextTokens(tp) ?? 0;
});

// A consolidated, NON-SENSITIVE per-agent directory for the voice read-layer
// (Realtime Abathur's get_agent_detail / list_agents). One read that joins
// everything the office-floor sidebar + telemetry know per agent: the registry
// record (name/role/provider/cwd/status/archived/isOvermind/isAssistant/sessionId/
// cwdValid), live token + breaker + last-tool telemetry, and the current context
// window fill. Includes ARCHIVED agents (unlike the heartbeat's fleet.json, which
// is live-only) so Abathur can speak to inactive agents — their cwd and memory
// stay reachable. PII-free: no secrets, env, or API keys ever leave main; cost is
// carried as tokens (+ a usd field the voice layer deliberately never speaks).
ipcMain.handle('hive:agentDirectory', () => {
  if (!hive.enabled()) return { godId: null, agents: [] };
  const reg = hive.registry();
  const snap = telemetry.snapshot();
  const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
  const now = Date.now();
  const agents = Object.entries(reg.agents).map(([id, a]) => {
    const u = usageById.get(id);
    const spans = snap.spans[id] ?? [];
    const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
    const ctx = hookServer.contextFor(id);
    const ptyId = ptyForAgent(id);
    const ptyLastOutput = ptyId ? ptyManager.lastOutputAt(ptyId) : undefined;
    const lastPty = Math.max(ptyLastOutput ?? 0, lastAgentPtyActivityMs.get(id) ?? 0);
    const lastActiveMs = Math.max(u?.ts ?? 0, lastPty);
    const isWorking = lastActiveMs > 0 && (now - lastActiveMs) <= 3000;
    const agentStatus = isAgentCompacting(id)
      ? 'compacting'
      : isWorking ? 'working' : (lastAgentStatus.get(id) ?? (a.status || 'idle'));
    const agentLastTool = lastAgentTool.get(id) ?? (spans.length ? spans[spans.length - 1].tool : null);
    return {
      id,
      name: a.name,
      role: a.role ?? (a.isOvermind ? 'orchestrator' : 'agent'),
      provider: a.provider ?? 'claude',
      model: u?.model ?? null,
      status: agentStatus,
      cwd: a.cwd ?? null,
      cwdValid: a.cwdValid ?? null,
      archived: !!a.archived,
      isOvermind: !!a.isOvermind,
      isAssistant: !!a.isAssistant,
      sessionId: a.sessionId ?? null,
      hasMemory: hive.hasMemory(id),
      inboxBacklog: hive.inboxBacklog(id),
      breaker: breaker.levelFor(id),
      tokens,
      usd: u ? Number(u.usd.toFixed(4)) : 0,
      lastTool: agentLastTool,
      lastActiveSecAgo: lastActiveMs > 0 ? Math.round((now - lastActiveMs) / 1000) : null,
      contextTokens: ctx?.tokens ?? null,
      contextLimit: ctx?.limit ?? null,
      contextPct: ctx && ctx.limit > 0 ? Math.round((ctx.tokens / ctx.limit) * 100) : null,
      profileId: a.profileId ?? null
    };
  });
  return { godId: reg.godId, agents };
});

// ─── IPC: live telemetry (the OTel collector — the locked usage-provider seam) ─
// The fleet grid + span waterfall (#7B) read these; Lane A's breaker (#6)
// consumes getAgentUsage in-process via the provider, not over IPC.
ipcMain.handle('telemetry:usage', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getAgentUsage(agentId) : null);
ipcMain.handle('telemetry:spans', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getSpans(agentId) : []);
ipcMain.handle('telemetry:snapshot', () => telemetry.snapshot());

// ─── IPC: circuit-breaker state (Lane A #6 policy → this lane's avatars/meter) ─
// Lane A's breaker calls this with a BreakerState; we fan it out to the renderer
// on `control:breakerState`, where the avatar adapter gives it precedence over
// hook-derived status (#5C looping/zombie). Defined here so the channel exists
// before Jim's policy lands; he produces, this lane consumes.
ipcMain.handle('control:setBreakerState', (_evt, state: unknown) => {
  try { liveWebContents()?.send('control:breakerState', state); } catch { /* window tore down */ }
  return { ok: true };
});

// ─── IPC: operator control over agents (#7C.1–7C.3) ─────────────────────────
// All return the agent's fresh control snapshot so the UI can reflect state.
ipcMain.handle('control:pause', (_evt, agentId: unknown, on: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.pause(agentId, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:autoDelivery', (_evt, agentId: unknown, paused: unknown) => {
  if (typeof agentId !== 'string') return null;
  const on = paused === true;
  control.pauseAutoDelivery(agentId, on);
  const current = new Set(readConfig().autoDeliveryPausedAgents ?? []);
  if (on) current.add(agentId); else current.delete(agentId);
  writeConfig({ autoDeliveryPausedAgents: Array.from(current).sort() });
  return control.snapshot(agentId);
});
ipcMain.handle('control:resume', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.resume(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:gateTool', (_evt, agentId: unknown, tool: unknown, on: unknown) => {
  if (typeof agentId !== 'string' || typeof tool !== 'string') return null;
  control.gateTool(agentId, tool, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:steer', (_evt, agentId: unknown, text: unknown) => {
  if (typeof agentId !== 'string' || typeof text !== 'string') return null;
  control.steer(agentId, text);
  return control.snapshot(agentId);
});
ipcMain.handle('control:halt', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.halt(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:snapshot', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? control.snapshot(agentId) : null);

// ─── IPC: scheduled missions (recurring auto-dispatch) ──────────────────────
ipcMain.handle('missions:list', () => readConfig().missions ?? []);
ipcMain.handle('missions:save', (_evt, missions) => {
  // lastFiredAt is scheduler-owned. The renderer loads missions once and later
  // sends back a STALE array, so a wholesale write would clobber every
  // lastFiredAt the scheduler has stamped since. Merge by id and keep the newer
  // lastFiredAt (almost always the persisted one) so the UI can never erase it.
  const incoming = (Array.isArray(missions) ? missions : []) as ScheduledMission[];
  const persistedById = new Map(
    (readConfig().missions ?? []).map((m) => [m.id, m] as const)
  );
  const merged = incoming.map((m) => {
    const prevLastFired = persistedById.get(m.id)?.lastFiredAt ?? 0;
    const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
    return { ...m, lastFiredAt };
  });
  writeConfig({ missions: merged });
  syncMissions();
  return { ok: true };
});

// ─── IPC: full-text search across hive files (board, tasks, memory) ──────────
ipcMain.handle('hive:textSearch', (_evt, query: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [] };
  const root = hive.root();
  if (!root) return { ok: false, results: [] };
  const q = query.toLowerCase();
  const results: Array<{ source: string; excerpt: string }> = [];
  // Each target file is (path, readable label). agents/<id>/memory.md is expanded below.
  const targets: Array<{ path: string; source: string }> = [
    { path: join(root, 'board.md'), source: 'board.md' },
    { path: join(root, 'tasks.json'), source: 'tasks.json' }
  ];
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      targets.push({ path: join(agentsDir, id, 'memory.md'), source: `${id}/memory.md` });
    }
  }
  for (const { path, source } of targets) {
    if (!existsSync(path)) continue;
    let hits = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (hits >= 3) break;
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      // ~40 chars of context on either side of the match.
      const excerpt = line.slice(Math.max(0, idx - 40), idx + q.length + 40).trim();
      results.push({ source, excerpt });
      hits++;
    }
  }
  return { ok: true, results };
});

// ─── IPC: GitHub issue ingestion (gh CLI) ────────────────────────────────────
ipcMain.handle('github:issues', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listIssues(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: GitHub CI status watcher (gh CLI) ──────────────────────────────────
ipcMain.handle('github:ciRuns', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listCIRuns(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: desktop notifications toggle ──────────────────────────────────────
ipcMain.handle('app:setNotifications', (_evt, val) => writeConfig({ notifications: val === true }));

// ─── IPC: onboarding reliability — open Settings deep-link + login-item toggle ─
/** Open a System Settings deep-link (or https URL) in the OS default handler.
 *  Restricted to Settings panes / https so the renderer can't shell arbitrary
 *  schemes. Used by the onboarding "Permissions & reliability" step. */
ipcMain.handle('app:openExternal', async (_evt, url: unknown) => {
  if (typeof url !== 'string' || !/^(x-apple\.systempreferences:|https:\/\/)/.test(url)) {
    return { ok: false, error: 'blocked url' };
  }
  await shell.openExternal(url);
  return { ok: true };
});
/** Toggle macOS "Open at Login" — fully programmatic, no permission prompt.
 *  Returns the resulting state so the renderer toggle reflects reality. */
ipcMain.handle('app:setLoginItem', (_evt, enabled: unknown) => {
  app.setLoginItemSettings({ openAtLogin: enabled === true });
  return app.getLoginItemSettings().openAtLogin;
});

// ─── IPC: Slack integration ─────────────────────────────────────────────────
ipcMain.handle('slack:start', () => startSlackServer());
ipcMain.handle('slack:stop', () => { stopSlackServer(); return { ok: true }; });
/** Current connection state + last Request URL — lets Settings hydrate the
 *  "Connected" badge and re-show the persisted tunnel URL on reopen. */
ipcMain.handle('slack:status', () => ({ running: slackServer != null, url: lastSlackUrl }));
/** Absolute path to the bundled reply helper, for the prompt the office worker
 *  runs to post its summary back in-thread. No secret crosses this boundary. */
ipcMain.handle('slack:replyScriptPath', () => slackReplyScriptPath());
/** Renderer's immediate "queued" ack into the triggering Slack thread. The bot
 *  token stays in main — only channel/thread/text cross IPC. */
ipcMain.handle('slack:reply', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { channel?: unknown; thread_ts?: unknown; text?: unknown };
  const cfg = readConfig();
  // CLAUSE-3 (human: "stop posting into Slack by default"): this is the ONLY
  // app/voice-INITIATED proactive Slack post (the renderer's "queued" ack). It is
  // OFF unless the user opts in via Settings → Slack. The Slack-ORIGIN done-reply
  // round-trip (done-poller) and an agent's own direct /reply are NOT routed
  // through here, so they are unaffected and always stay on.
  if (!cfg.slackProactivePosting) return { ok: false, error: 'app-initiated Slack posting disabled (enable in Settings → Slack)' };
  const botToken = cfg.slackBotToken;
  if (!botToken) return { ok: false, error: 'no bot token' };
  if (typeof p.channel !== 'string' || typeof p.thread_ts !== 'string' || typeof p.text !== 'string') {
    return { ok: false, error: 'channel, thread_ts, text required' };
  }
  // CLAUSE-1 (fix-slack-integration): an app-initiated send must target an
  // EXPLICIT thread — reject a blank/whitespace channel or thread rather than
  // letting it fall through to an implicit destination (the channel root).
  if (!p.channel.trim() || !p.thread_ts.trim()) {
    return { ok: false, error: 'explicit channel + thread_ts required' };
  }
  return postSlackReply({ botToken, channel: p.channel, thread_ts: p.thread_ts, text: p.text });
});
ipcMain.handle('slack:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as {
    signingSecret?: unknown; botToken?: unknown; channelId?: unknown; port?: unknown; enabled?: unknown;
    proactivePosting?: unknown;
  };
  const next: Partial<HarnessConfig> = {};
  // Trim string fields; an emptied field clears back to undefined.
  if (typeof p.signingSecret === 'string') next.slackSigningSecret = p.signingSecret.trim() || undefined;
  if (typeof p.botToken === 'string') next.slackBotToken = p.botToken.trim() || undefined;
  if (typeof p.channelId === 'string') next.slackChannelId = p.channelId.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.slackPort = p.port;
  if (typeof p.enabled === 'boolean') next.slackEnabled = p.enabled;
  if (typeof p.proactivePosting === 'boolean') next.slackProactivePosting = p.proactivePosting;
  writeConfig(next);
  // Reconcile the running server: disabling (or clearing the secret) stops it. We
  // deliberately do NOT auto-(re)start here — the user presses Start in Settings
  // to fetch the fresh (ephemeral) tunnel URL.
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) stopSlackServer();
  return { ok: true };
});

// ─── IPC: Triggers — context (auto-compact / auto-clear) ────────────────────
ipcMain.handle('triggers:getContext', () => readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER);
ipcMain.handle('triggers:setContext', (_evt, arg: unknown) => {
  const current = readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
  const p = (arg ?? {}) as Partial<ContextTriggerConfig>;
  const next: ContextTriggerConfig = {
    compact: sanitizeContextRule(p.compact, current.compact),
    clear: sanitizeContextRule(p.clear, current.clear)
  };
  writeConfig({ contextTrigger: next });
  // The timers ARE the setting — a cadence saved but not re-armed would keep
  // firing on the old rhythm until the next boot.
  syncContextTriggers();
  return next;
});

/** Clamp one half of the context trigger. The renderer is not trusted with the
 *  arming maths: a zero/negative/NaN `everyMs` would arm a runaway timer, and an
 *  out-of-range percentage would silently disable (or permanently trip) the
 *  pressure gate. */
function sanitizeContextRule(patch: Partial<ContextRule> | undefined, current: ContextRule): ContextRule {
  const p = (patch ?? {}) as Partial<ContextRule>;
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    everyMs: num(p.everyMs, current.everyMs, 60_000, 86_400_000),
    minContextPct: num(p.minContextPct, current.minContextPct, 0, 100),
    minContextPctLargeWindow: num(p.minContextPctLargeWindow, current.minContextPctLargeWindow, 0, 100),
    message: typeof p.message === 'string' ? p.message : current.message
  };
}

// ─── IPC: Triggers — webhooks (many endpoints, one server, one tunnel) ──────
ipcMain.handle('webhooks:list', () => readConfig().webhookTriggers ?? []);
ipcMain.handle('webhooks:save', (_evt, arg: unknown) => {
  const incoming = Array.isArray(arg) ? arg : [];
  const existing = readConfig().webhookTriggers ?? [];
  const list: WebhookTrigger[] = [];
  const seen = new Set<string>();
  for (const raw of incoming) {
    const t = sanitizeWebhookTrigger(raw, existing);
    if (!t || seen.has(t.id)) continue; // an id is a URL path segment — one owner each
    seen.add(t.id);
    list.push(t);
  }
  writeConfig({ webhookTriggers: list });
  reconcileWebhookServer();
  return list;
});
ipcMain.handle('webhooks:delete', (_evt, arg: unknown) => {
  const id = typeof arg === 'string' ? arg : '';
  const list = (readConfig().webhookTriggers ?? []).filter((t) => t.id !== id);
  writeConfig({ webhookTriggers: list });
  // Revoking one endpoint must not disturb the others: the live server is
  // re-pointed, not restarted, so every remaining caller's URL keeps working.
  reconcileWebhookServer();
  return list;
});
/** Mint a strong (256-bit) secret for the operator to paste into their caller.
 *  Not persisted here — it belongs to whichever endpoint the UI saves it onto. */
ipcMain.handle('webhooks:generateSecret', () => randomBytes(32).toString('hex'));
/** Server state + the tunnel root + one public URL per configured endpoint (the
 *  UI offers a copy button per webhook, so the root alone isn't enough). */
ipcMain.handle('webhooks:status', () => ({
  running: webhookServer != null,
  url: lastWebhookUrl,
  endpoints: webhookEndpointUrls()
}));

/** Normalise one endpoint coming back from the renderer. Unknown/blank fields
 *  fall back to what is already persisted, so a UI that round-trips a partially
 *  filled row can never blank a live secret or silently widen a mode. */
function sanitizeWebhookTrigger(raw: unknown, existing: WebhookTrigger[]): WebhookTrigger | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<WebhookTrigger>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  // The id is spliced into a public URL path. Restrict it to a boring charset
  // rather than escaping later: no slashes (which would forge a nested route),
  // no encoded traversal, nothing that could make two endpoints alias.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return null;
  const prior = existing.find((t) => t.id === id);
  const secret = typeof r.secret === 'string' && r.secret.trim() ? r.secret.trim() : prior?.secret ?? '';
  const mode = isTriggerMode(r.mode) ? r.mode : prior?.mode ?? DEFAULT_TRIGGER_MODE;
  return {
    id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : prior?.name ?? id,
    secret,
    // A secretless endpoint can never be enabled — it would be an open door.
    enabled: secret ? (typeof r.enabled === 'boolean' ? r.enabled : prior?.enabled ?? false) : false,
    mode,
    schema: typeof r.schema === 'string' && r.schema.trim() ? r.schema : prior?.schema ?? DEFAULT_WEBHOOK_SCHEMA,
    createdAt: typeof r.createdAt === 'number' && r.createdAt > 0 ? r.createdAt : prior?.createdAt ?? Date.now()
  };
}

function isTriggerMode(v: unknown): v is TriggerMode {
  return v === 'strict' || v === 'allow-all' || v === 'communication-only';
}

// ─── IPC: Triggers — organisation (persistence only; no transport yet) ──────
ipcMain.handle('org:getTrigger', () => readConfig().orgTrigger ?? DEFAULT_ORG_TRIGGER);
ipcMain.handle('org:setTrigger', (_evt, arg: unknown) => {
  const current = readConfig().orgTrigger ?? DEFAULT_ORG_TRIGGER;
  const p = (arg ?? {}) as Partial<OrgTriggerConfig>;
  // PERSIST ONLY — the peer messaging service does not exist yet, so nothing
  // reads `apiKey` beyond the settings surface that shows it. Deliberately no
  // start/stop, no network, no side effect of any kind.
  const next: OrgTriggerConfig = {
    apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : current.apiKey,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    mode: isTriggerMode(p.mode) ? p.mode : current.mode
  };
  writeConfig({ orgTrigger: next });
  return next;
});

// ─── IPC: Device sync (v1 — git-based, one device at a time) ─────────────────
// All inert until a remote is configured. Secrets never travel (the sync unit is
// the hive repo only; secrets live in userData, outside it).
ipcMain.handle('sync:getStatus', () => {
  const hr = hive.root();
  return hr ? sync.getStatus(hr) : null;
});
ipcMain.handle('sync:setRemote', (_evt, arg: unknown) => {
  const hr = hive.root();
  if (!hr) return { ok: false, error: 'hive not configured' };
  const url = typeof arg === 'string' ? arg : '';
  const res = sync.setRemote(hr, url);
  // First push is explicit so a bad URL/credential surfaces now, not at quit.
  if (res.ok && url.trim()) { try { sync.syncOnQuit(hr); } catch { /* reported via next status */ } }
  return res;
});
ipcMain.handle('sync:now', () => {
  const hr = hive.root();
  if (!hr) return { ok: false, error: 'hive not configured' };
  // Quiesce = pause auto-delivery for every agent during the git op, then restore
  // the prior paused set (never touches halted/paused flags).
  const ids = Object.keys(hive.registry().agents ?? {});
  const prior = ids.filter((id) => control.isAutoDeliveryPaused(id));
  return sync.syncNow(
    hr,
    () => control.replaceAutoDeliveryPauses(ids),
    () => control.replaceAutoDeliveryPauses(prior)
  );
});

// ─── IPC: Hive profiles (multiple isolated hives) + cross-device join ────────
// A profile = a named {harnessHome, userData}. Both axes must differ for two
// hives to run at once (userData carries the single-instance lock + harness.db).
ipcMain.handle('profiles:list', () => profiles.listProfiles());
ipcMain.handle('profiles:current', () => profiles.currentProfile(resolveHarnessHome(), app.getPath('userData')));
ipcMain.handle('profiles:create', (_evt, arg: unknown) => {
  const a = (arg ?? {}) as { name?: unknown; harnessHome?: unknown; userData?: unknown };
  const home = typeof a.harnessHome === 'string' ? expandTilde(a.harnessHome.trim()) : '';
  if (!home) return { ok: false, error: 'harnessHome required' };
  const userData = typeof a.userData === 'string' && a.userData.trim() ? expandTilde(a.userData.trim()) : undefined;
  return { ok: true, profile: profiles.createProfile(typeof a.name === 'string' ? a.name : 'hive', home, { userData }) };
});
// Launch a profile as a NEW isolated instance (detached child). Best-effort — the
// child is a full second app; runtime validation of the launch UX is Dylan's.
ipcMain.handle('profiles:launch', (_evt, arg: unknown) => {
  const id = typeof arg === 'string' ? arg : '';
  const profile = profiles.getProfile(id);
  if (!profile) return { ok: false, error: 'unknown profile' };
  try {
    const spec = profiles.launchSpec(profile, app.isPackaged, app.getAppPath(), process.execPath);
    const child = spawn(spec.exec, spec.args, { detached: true, stdio: 'ignore', env: spec.env });
    child.unref();
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
// Cross-device JOIN: clone a hive's remote into a new profile's home, then the
// renderer can launch it. Independent of every other hive (per-hive lock).
ipcMain.handle('profiles:delete', (_evt, arg: unknown) => {
  const id = typeof arg === 'string' ? arg : '';
  if (!id) return { ok: false, error: 'profile id required' };
  profiles.removeProfile(id); // removes the registry entry only; on-disk hive/userData are left for the user
  return { ok: true };
});
ipcMain.handle('sync:joinHive', (_evt, arg: unknown) => {
  const a = (arg ?? {}) as { remoteUrl?: unknown; name?: unknown; harnessHome?: unknown };
  const url = typeof a.remoteUrl === 'string' ? a.remoteUrl : '';
  const home = typeof a.harnessHome === 'string' ? expandTilde(a.harnessHome.trim()) : '';
  if (!home) return { ok: false, error: 'harnessHome (target dir) required' };
  return profiles.joinHive(url, typeof a.name === 'string' ? a.name : 'joined hive', home);
});
// Let the renderer's join form reuse the EXACT same URL guard the backend enforces
// (no duplicated regex to drift), for immediate feedback before a submit.
ipcMain.handle('sync:isSafeRemote', (_evt, arg: unknown) => sync.isSafeGitUrl(typeof arg === 'string' ? arg : ''));

// ─── IPC: Local delegate agents ──────────────────────────────────────────────
ipcMain.handle('lda:list', () => listLocalDelegates());
ipcMain.handle('lda:upsert', (_evt, arg: unknown) => upsertLocalDelegate(arg));
ipcMain.handle('lda:remove', (_evt, arg: unknown) => {
  // Clean up API key when delegate is removed
  const id = typeof arg === 'string' ? arg.trim() : '';
  if (id) integrations.deleteSecret(`lda:${id}:apikey`);
  return removeLocalDelegate(arg);
});
ipcMain.handle('lda:health', (_evt, arg: unknown) => ldaRunner.health(typeof arg === 'string' ? arg : ''));
ipcMain.handle('lda:invoke', async (_evt, arg: unknown) => {
  const req = arg as Parameters<typeof ldaRunner.invoke>[0];
  const result = await ldaRunner.invoke(req);
  if (result.usage) recordDelegateLedger(req.delegateId, result.usage);
  hive.appendLog({
    kind: 'lda-call',
    delegateId: req.delegateId,
    capability: req.args.capability,
    ok: result.ok,
    durationMs: result.durationMs
  });
  return result;
});
// API key write — MAIN-ONLY, never echoed back. Stores encrypted via safeStorage.
// Called with two separate args (id, key) matching the preload ldaSetApiKey signature.
ipcMain.handle('lda:setApiKey', (_evt, id: unknown, key: unknown) => {
  if (typeof id !== 'string' || !id.trim() || typeof key !== 'string' || !key) {
    return { ok: false, error: 'id and key required' };
  }
  const ref = `lda:${id.trim()}:apikey`;
  try {
    integrations.setSecret(ref, key);
    // Patch secretRef into the delegate config so the runner knows where to look
    const cfg = listLocalDelegates().find((d) => d.id === id.trim());
    if (cfg && !cfg.secretRef) upsertLocalDelegate({ ...cfg, secretRef: ref });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});
// API key remove — clears from secret store + clears secretRef on the delegate.
ipcMain.handle('lda:removeApiKey', (_evt, arg: unknown) => {
  const id = typeof arg === 'string' ? arg.trim() : '';
  if (!id) return { ok: false, error: 'id required' };
  integrations.deleteSecret(`lda:${id}:apikey`);
  const cfg = listLocalDelegates().find((d) => d.id === id);
  if (cfg?.secretRef) upsertLocalDelegate({ ...cfg, secretRef: undefined });
  return { ok: true };
});
// Whether a key is stored — never returns the key itself.
ipcMain.handle('lda:hasApiKey', (_evt, arg: unknown) => {
  const id = typeof arg === 'string' ? arg.trim() : '';
  const cfg = listLocalDelegates().find((d) => d.id === id);
  return { hasKey: !!(cfg?.secretRef && integrations.getSecret(cfg.secretRef)) };
});

// ─── IPC: Runtime profile cloud endpoint keys ────────────────────────────────
// API key for a profile's cloud OpenAI-compatible endpoint — MAIN-ONLY write/check,
// never returned over IPC. Pattern mirrors lda:setApiKey/removeApiKey/hasApiKey.
ipcMain.handle('profile:setApiKey', (_evt, id: unknown, key: unknown) => {
  if (typeof id !== 'string' || !id.trim() || typeof key !== 'string' || !key) {
    return { ok: false, error: 'id and key required' };
  }
  const ref = `profile:${id.trim()}:apikey`;
  try {
    integrations.setSecret(ref, key);
    const profile = getRuntimeProfile(id.trim());
    if (profile && !profile.apiKeyRef) upsertRuntimeProfile({ ...profile, apiKeyRef: ref });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});
ipcMain.handle('profile:removeApiKey', (_evt, arg: unknown) => {
  const id = typeof arg === 'string' ? arg.trim() : '';
  if (!id) return { ok: false, error: 'id required' };
  integrations.deleteSecret(`profile:${id}:apikey`);
  const profile = getRuntimeProfile(id);
  if (profile?.apiKeyRef) upsertRuntimeProfile({ ...profile, apiKeyRef: undefined });
  return { ok: true };
});
ipcMain.handle('profile:hasApiKey', (_evt, arg: unknown) => {
  const id = typeof arg === 'string' ? arg.trim() : '';
  const profile = getRuntimeProfile(id);
  return { hasKey: !!(profile?.apiKeyRef && integrations.getSecret(profile.apiKeyRef)) };
});
// Renderer-callable URL safety check — same guard as upsertRuntimeProfile uses at
// save time, so the form can give immediate feedback without a separate regex.
ipcMain.handle('profile:isSafeUrl', (_evt, url: unknown, allowPrivate: unknown) =>
  typeof url === 'string' ? isSafeHttpUrl(url, allowPrivate === true) : false
);

// ─── IPC: Triggers — history ledger + the approval gate ─────────────────────
ipcMain.handle('triggerHistory:list', () => listTriggerHistory());
ipcMain.handle('triggerHistory:clear', (_evt, arg: unknown) => {
  const source = arg === 'webhook' || arg === 'org' ? arg : undefined;
  clearTriggerHistory(source);
  pruneHeldTokens();
  notifyTriggerHistoryUpdated();
  return { ok: true };
});
/**
 * The operator's verdict on a held message.
 *
 * 'approved' RELEASES it: it takes the identical path an auto-allowed message
 * would have taken (card + god request), then the entry flips. 'rejected' just
 * flips — nothing is ever dispatched.
 *
 * Idempotent by construction: only an entry still sitting at `pending` can be
 * decided, so a double-click (or two windows deciding at once) cannot dispatch
 * the same message twice.
 */
ipcMain.handle('triggerHistory:decide', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { id?: unknown; decision?: unknown };
  const id = typeof p.id === 'string' ? p.id : '';
  const decision = p.decision === 'approved' ? 'approved' : p.decision === 'rejected' ? 'rejected' : null;
  if (!id || !decision) return null;
  const entry: TriggerHistoryEntry | undefined = listTriggerHistory().find((e) => e.id === id);
  if (!entry) return null;
  if (entry.decision !== 'pending') return entry; // already decided → no-op, not a re-dispatch

  if (decision === 'rejected') {
    const next = updateTriggerHistory(id, { decision: 'rejected' });
    notifyTriggerHistoryUpdated();
    return next;
  }

  const taskId = `webhook-${randomBytes(8).toString('hex')}`;
  const tokenHash = heldTokenHashFor(id);
  const title = entry.title ?? (entry.body.length > 80 ? `${entry.body.slice(0, 79)}…` : entry.body);
  if (!dispatchWebhookWork({ taskId, title, message: entry.body, tokenHash, origin: entry.source })) {
    // The card is what the caller polls and what god works from. Leave the entry
    // pending so the operator can approve again once the hive is writable.
    return entry;
  }
  // The hash now lives on the card, so the caller's GET resolves through the
  // normal task lookup from here on.
  if (tokenHash) { heldTokens().delete(tokenHash); persistHeldTokens(); }
  const next = updateTriggerHistory(id, { decision: 'approved', taskId });
  pruneHeldTokens();
  notifyTriggerHistoryUpdated();
  return next;
});

// ─── IPC: Generic webhook (LEGACY single-endpoint channels) ─────────────────
// Kept alive for Settings → Webhook, which still speaks the one-secret shape.
// They are now THIN SHIMS over the multi-endpoint engine: the legacy secret and
// enabled flag map onto the `legacy` WebhookTrigger the config migration created,
// so the two surfaces can never disagree about whether the endpoint is live.
ipcMain.handle('webhook:start', () => startWebhookServer());
ipcMain.handle('webhook:stop', () => { stopWebhookServer(); return { ok: true }; });
/** Current state + last public endpoint URL, for the Settings badge/URL field. */
ipcMain.handle('webhook:status', () => ({ running: webhookServer != null, url: lastWebhookUrl }));
/** Mint a strong (256-bit) secret, persist it, and return it so Settings can show
 *  it for the user to copy into their client. The previous secret is replaced. */
ipcMain.handle('webhook:generateSecret', () => {
  const secret = randomBytes(32).toString('hex');
  writeConfig({ webhookSecret: secret });
  upsertLegacyWebhookTrigger({ secret });
  return { ok: true, secret };
});
ipcMain.handle('webhook:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as { secret?: unknown; port?: unknown; enabled?: unknown };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.secret === 'string') next.webhookSecret = p.secret.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.webhookPort = p.port;
  if (typeof p.enabled === 'boolean') next.webhookEnabled = p.enabled;
  writeConfig(next);
  upsertLegacyWebhookTrigger({
    secret: typeof p.secret === 'string' ? p.secret.trim() : undefined,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined
  });
  // Disabling (or clearing the secret) stops the public surface immediately; the
  // reconcile also picks up the case where OTHER endpoints are still enabled, in
  // which case the server stays up minus the legacy one.
  reconcileWebhookServer();
  return { ok: true };
});

/** Mirror a legacy `webhook:setConfig` / `webhook:generateSecret` edit onto the
 *  `legacy` WebhookTrigger. Creates the row only once a secret exists — an
 *  enabled endpoint without a secret would be an open door, so a bare "enable"
 *  against a never-configured webhook is deliberately a no-op. */
function upsertLegacyWebhookTrigger(patch: { secret?: string; enabled?: boolean }): void {
  const list = readConfig().webhookTriggers ?? [];
  const prior = list.find((t) => t.id === 'legacy');
  const secret = patch.secret !== undefined ? patch.secret : prior?.secret ?? '';
  if (!secret) return;
  const row: WebhookTrigger = {
    id: 'legacy',
    name: prior?.name ?? 'Default webhook',
    secret,
    enabled: patch.enabled !== undefined ? patch.enabled : prior?.enabled ?? false,
    mode: prior?.mode ?? DEFAULT_TRIGGER_MODE,
    schema: prior?.schema ?? DEFAULT_WEBHOOK_SCHEMA,
    createdAt: prior?.createdAt ?? Date.now()
  };
  writeConfig({
    webhookTriggers: prior ? list.map((t) => (t.id === 'legacy' ? row : t)) : [...list, row]
  });
}

// ─── IPC: Free Flow (voice dictation → message queue) ────────────────────────
// Entry point B is hold-Option-to-talk, handled entirely in the renderer
// (capture-phase key listeners) — no globalShortcut here. macOS doesn't deliver
// the Fn key to Electron (electron#16714) and a faithful native Fn helper
// (CGEventTap) is deferred; hold-Option is the human-chosen v1 activation.

ipcMain.handle('freeflow:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as { enabled?: unknown; apiKey?: unknown; model?: unknown };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.enabled === 'boolean') next.freeflowEnabled = p.enabled;
  // Trim string fields; an emptied key clears back to undefined.
  if (typeof p.apiKey === 'string') next.groqApiKey = p.apiKey.trim() || undefined;
  if (typeof p.model === 'string') next.freeflowModel = p.model.trim() || DEFAULT_GROQ_MODEL;
  writeConfig(next);
  return { ok: true };
});

/** Transcribe one captured audio clip via Groq. Gated on the flag + a key being
 *  present, so a disabled feature can NEVER reach the network. The Groq key stays
 *  in main — only the audio bytes cross IPC inbound and the transcript outbound. */
ipcMain.handle('freeflow:transcribe', async (_evt, arg: unknown) => {
  const cfg = readConfig();
  if (!cfg.freeflowEnabled) return { ok: false, error: 'Free Flow is disabled' };
  if (!cfg.groqApiKey) return { ok: false, error: 'no Groq API key set' };
  const a = (arg ?? {}) as { audio?: unknown; mimeType?: unknown; filename?: unknown; language?: unknown };
  if (!(a.audio instanceof ArrayBuffer) && !(a.audio instanceof Uint8Array)) {
    return { ok: false, error: 'no audio' };
  }
  const out = await transcribeWithGroq({
    apiKey: cfg.groqApiKey,
    audio: a.audio,
    mimeType: typeof a.mimeType === 'string' ? a.mimeType : undefined,
    filename: typeof a.filename === 'string' ? a.filename : undefined,
    model: cfg.freeflowModel || DEFAULT_GROQ_MODEL,
    language: typeof a.language === 'string' && a.language ? a.language : undefined
  });
  if (out.ok) analytics.trackFeature('voice_dictation');
  return out;
});

// ─── IPC: Realtime Abathur (voice orchestrator — ephemeral token mint, rt-1) ──
// MAIN owns the BYOK OpenAI key (encrypted broker, apikey:openai) and mints a
// short-lived EPHEMERAL client secret; the real key never crosses IPC. All wiring
// lives in ./realtime so this stays a single registration line.
registerRealtimeIpc();

// ─── IPC: Realtime Abathur voice ACTIONS (rt-5, Phase 2) ─────────────────────
// Thin adapters over the SAME main fns the god PTY already uses. ALL of the safety
// spine — soft-vs-destructive tiering, the two-step verbal echo-back confirm, the
// distinct-token rule, the hard allowlist (kill-god / mass-ops forbidden), and the
// abathur-voice attribution — lives in ./realtimeActions. This site only injects
// the existing functions; it adds NO new orchestration logic.
// ─── IPC: Realtime Abathur completion watcher (rt-12, Phase 2) ───────────────
// Jim's net-new engine (realtimeCompletionWatcher.ts) detects a voice-dispatched
// task finishing (card→done OR a done-reply in abathur-voice's inbox) and EMITS it;
// I own the seam — inject the hive read deps, push completions to the live session
// (so Abathur speaks them unprompted), and bridge waitFor / queue-drain over IPC.
const completionWatcher = initCompletionWatcher({
  readTasks: () => { const t = hive.tasks() as { tasks?: TaskCard[] }; return Array.isArray(t?.tasks) ? t.tasks : []; },
  // Voice dispatches go out as from:abathur-voice, so assignee done-replies land here.
  readInbox: () => {
    // Voice dispatches go out from:abathur-voice, so done-replies normally land in its
    // inbox — but an assignee may address god out of habit. Merge both inboxes (de-dupe
    // by id) so a god-addressed completion isn't missed; the detector filters by sender.
    try {
      const mv = hive.inbox('abathur-voice') as unknown as InboxMessage[];
      const godId = hive.registry().godId;
      const god = godId ? (hive.inbox(godId) as unknown as InboxMessage[]) : [];
      const seen = new Set<string>();
      return [...mv, ...god].filter((m) => !!m?.id && !seen.has(m.id) && seen.add(m.id) !== undefined);
    } catch {
      return [];
    }
  },
  readRegistry: () => hive.registry(),
  onNotify: (evt) => {
    try {
      if (Notification.isSupported()) {
        const reg = hive.registry();
        const agentName = reg.agents[evt.targetAgentId]?.name ?? (evt.targetAgentId === 'god' || evt.targetAgentId === reg.godId ? (reg.agents[reg.godId ?? 'god']?.name ?? 'BeeYoncé') : evt.targetAgentId);
        const title = agentName || 'Agent';
        const body = evt.summary || (evt.objective ? `Finished "${evt.objective}"` : 'Task completed');
        new Notification({ title, body }).show();
      }
    } catch { /* best-effort */ }
  }
});

registerRealtimeActionIpc({
  hiveEnabled: () => hive.enabled(),
  hiveSend: (partial, from) => hive.send(partial, from),
  hiveTasks: () => hive.tasks(),
  hiveWriteTasks: (tasks) => hive.writeTasks(tasks),
  hiveRegistry: () => hive.registry(),
  hiveLog: (event) => hive.appendLog(event),
  controlPause: (id, on) => control.pause(id, on),
  controlSteer: (id, text) => control.steer(id, text),
  controlHalt: (id) => control.halt(id),
  controlSnapshot: (id) => control.snapshot(id),
  killAgent: (id) => {
    const r = ptyManager.kill(id);
    teardownPty(id);
    // A voice (MAIN-initiated) kill: the renderer never removed the card itself
    // (unlike a UI kill), so tell the floor to archive it. Mirrors hive:agentSpawned.
    try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* window torn down */ }
    return r;
  },
  spawnAgent: async (opts) => {
    const o = opts as AgentSpawnOptions;
    const res = await spawnAgentCore(o, null);
    // The renderer roster is only mutated by renderer-initiated hires (AddAgentModal),
    // so a MAIN-initiated spawn is invisible on the floor until we broadcast it. The
    // renderer (useHive) builds the Agent card from this descriptor; addAgent is
    // idempotent so a renderer-initiated hire is never double-carded.
    if (res.ok) {
      try {
        liveWebContents()?.send('hive:agentSpawned', {
          id: o.id,
          name: o.hive?.name ?? o.id,
          provider: o.provider ?? o.hive?.provider ?? 'claude',
          cwd: res.worktreePath ?? o.cwd,
          command: o.command,
          role: o.hive?.role,
          worktreePath: res.worktreePath
        });
      } catch { /* window torn down */ }
    }
    return res;
  },
  listMissions: () => readConfig().missions ?? [],
  // The spec carries lastFiredAt through from listMissions(), so a wholesale write
  // preserves the scheduler's stamps; edit_schedule is deliberate + rare.
  saveMissions: (missions) => { writeConfig({ missions }); },
  // rt-12: register each voice dispatch so the watcher can detect its completion.
  trackDispatch: (d) => { try { completionWatcher.track({ ...d, kind: 'dispatch' }); } catch { /* watcher unavailable */ } },
  // ── v0.3.4 full-control extensions ──
  controlResume: (id) => control.resume(id),
  controlAutoDelivery: (id, paused) => control.pauseAutoDelivery(id, paused),
  controlGateTool: (id, toolName, on) => control.gateTool(id, toolName, on),
  setArchived: (id, archived) => {
    if (!hive.enabled()) return { ok: false, error: 'hive disabled' };
    hive.setArchived(id, archived);
    try { liveWebContents()?.send(archived ? 'hive:agentArchived' : 'hive:agentSpawned', { id }); } catch { /* window gone */ }
    return { ok: true };
  },
  // clear_context: hand the text to the renderer's queue so delivery rides every
  // existing gate (idle-only, boot grace, draft/picker safety).
  enqueueToAgent: (id, text) => {
    try { liveWebContents()?.send('realtime:enqueue', { agentId: id, text }); } catch { /* window gone */ }
  },
  getConfigValue: (key) => (readConfig() as unknown as Record<string, unknown>)[key],
  patchConfig: (patch) => { writeConfig(patch as Partial<HarnessConfig>); }
});

// rt-12 seam: push detected completions to the live floor; bridge live-flag, queue
// drain (closed-session warm-start), and wait_for over IPC. Then start polling.
completionWatcher.onCompletion((evt) => { try { liveWebContents()?.send('realtime:completion', evt); } catch { /* window gone */ } });
// v0.3.4: the floor delta watcher shares the session-live flag — while a voice
// session is open it pushes coalesced floor updates the renderer injects as
// silent conversation items (snapshot-at-connect + append-only deltas).
const floorWatcher = new RealtimeFloorWatcher({
  enabled: () => hive.enabled(),
  registry: () => hive.registry(),
  tasks: () => hive.tasks(),
  ptys: () => ptyManager.list().map((p) => ({ id: p.id, lastOutputAt: p.lastOutputAt })),
  push: (text) => { try { liveWebContents()?.send('realtime:floorDelta', { text }); } catch { /* window gone */ } }
});
floorWatcher.start();
ipcMain.handle('realtime:setSessionLive', (_e, live: unknown) => {
  completionWatcher.setSessionLive(live === true);
  floorWatcher.setSessionLive(live === true);
  return { ok: true };
});
// v0.3.4: app self-knowledge for the voice get_app_info tool — version + the
// newest CHANGELOG sections. Read-only; ships CHANGELOG.md with the app.
ipcMain.handle('app:info', () => {
  let changelog = '';
  for (const p of [join(app.getAppPath(), 'CHANGELOG.md'), join(process.cwd(), 'CHANGELOG.md')]) {
    try { changelog = readFileSync(p, 'utf8'); if (changelog) break; } catch { /* try next */ }
  }
  const top = changelog
    ? changelog.split(/\n## /).slice(1, 3).map((s) => `## ${s}`).join('\n').slice(0, 8000)
    : '';
  return { version: app.getVersion(), changelog: top };
});
ipcMain.handle('app:openInBrowser', async () => {
  try {
    const url = await openRendererInBrowser();
    return { ok: true as const, url };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : String(err)
    };
  }
});
ipcMain.handle('realtime:drainCompletions', () => completionWatcher.drainQueuedCompletions());
ipcMain.handle('realtime:waitFor', (_e, taskId: unknown, timeoutMs: unknown) =>
  typeof taskId === 'string'
    ? completionWatcher.waitFor(taskId, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120_000)
    : Promise.resolve({ timedOut: true as const, taskId: '' }));
completionWatcher.start();

// ─── god-triggered ephemeral Slack workers ──────────────────────────────────
// god drops a spawn-request JSON into HIVE_ROOT/spawn-requests/; MAIN polls that
// queue (same cadence + atomic-rename archival as the hive router — reliability
// over latency, no fs.watch/dedup needed), spins up a FRESH ISOLATED worker via
// the shared spawnAgentCore, dispatches the objective through the standard inbox
// path, then watches each worker for a terminal `act:"done"` (success → release)
// or excessive idleness (reap). All teardown flows through teardownPty's
// safety-gate, so a worker's worktree is never auto-removed while it holds
// unintegrated work. Every terminal failure informs god WITH the Slack coords so
// god closes the Slack loop; the success path is the worker replying in-thread.

/** A spawn-request god drops into HIVE_ROOT/spawn-requests/<id>.json. god authors
 *  these directly; `objective` and `cwd` are the only required fields. */
interface SpawnRequest {
  id?: string;
  objective?: string;
  command?: string;                                   // engine CLI; default = config.defaultCommand
  provider?: AgentProvider;                           // optional explicit provider
  model?: string;                                     // optional --model override (Claude)
  profile?: string;                                   // optional runtime-profile id (engine+account+model bundle)
  cwd?: string;                                        // repo the worker (and its worktree) runs in
  name?: string;                                       // display name
  slack?: { channel: string; thread_ts: string };     // reply target + where failures surface
  isolate?: boolean;                                   // default true (fresh worktree)
  tokenCap?: number;                                   // optional per-worker token cap (advisory P1)
  offloadEligible?: boolean;                           // opt-in: MAY be routed to a non-Claude endpoint when RED (default false)
  hive?: { offload?: { target?: string; accountKey?: string } }; // provenance stamped by createOffloadSpawnRequest
  // Appearance on the office floor. Both optional and both validated renderer-side
  // against the real cast and accent lists, so a bad value degrades to the default
  // rather than breaking the card.
  //
  // Naming a worker after a cast member ALREADY gets you their avatar: the floor
  // card infers it from the name. These two exist for the case that inference
  // cannot express, an agent called something else that should still look like a
  // particular character, and picking the accent instead of taking the one hashed
  // from the worker id.
  character?: string;
  accent?: string;
}

/** Polling cadence — matches the hive router. */
const WORKER_TICK_MS = 1500;
let workerWatchTimer: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard so a slow tick (await spawn / git checks) never overlaps. */
let workerTickRunning = false;

/** HIVE_ROOT/spawn-requests — the queue dir god drops requests into. */
function spawnRequestsDir(): string | null {
  const root = hive.root();
  return root ? join(root, 'spawn-requests') : null;
}

/** Move a processed request out of the queue so it's never reprocessed. */
function archiveRequest(filePath: string, sub: '.done' | '.failed'): void {
  const queue = spawnRequestsDir();
  try {
    if (!queue) throw new Error('no hive root');
    const dir = join(queue, sub);
    mkdirSync(dir, { recursive: true });
    renameSync(filePath, join(dir, basename(filePath)));
  } catch (e) {
    // Last resort: delete it so a poison file can't loop forever.
    try { unlinkSync(filePath); } catch { /* noop */ }
    console.error('[worker] archiveRequest failed:', e);
  }
}

/** Did this worker post a terminal `act:"done"` yet? Scans its own outbox AND
 *  outbox/.sent (the router archives delivered mail there ~every 1.5s), so the
 *  signal is caught whether or not it's been routed out yet.
 *
 *  Stale-done guard: agent dirs persist after teardown, so REUSING a reqId would
 *  leave a PRIOR worker's `done` sitting in this same dir. Without a guard that
 *  stale signal would release the new worker on its very first tick — before it
 *  does anything or replies — causing a silent Slack hang. So we only count a
 *  `done` authored AFTER this worker spawned: by its `created_at` (the message's
 *  own timestamp), falling back to the file's mtime when `created_at` is missing
 *  or unparseable. When neither yields a usable timestamp we DON'T count it
 *  (fail toward keeping the worker alive — the idle reaper is the backstop). */
function workerSignaledDone(workerId: string, spawnedAt: number): boolean {
  const root = hive.root();
  if (!root) return false;
  const base = join(root, 'agents', workerId, 'outbox');
  for (const dir of [base, join(base, '.sent')]) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = join(dir, f);
      try {
        const msg = JSON.parse(readFileSync(fp, 'utf8')) as { act?: string; created_at?: string };
        if (msg.act !== 'done') continue;
        let ts = Date.parse(msg.created_at ?? '');
        if (!Number.isFinite(ts)) {
          try { ts = statSync(fp).mtimeMs; } catch { ts = NaN; }
        }
        if (Number.isFinite(ts) && ts > spawnedAt) return true;
      } catch { /* skip unreadable/partial */ }
    }
  }
  return false;
}

/** Spin up one ephemeral worker from a spawn-request. Terminal failures (bad
 *  request, missing CLI, spawn error) archive to .failed and inform god WITH the
 *  Slack coords so god can post a 'couldn't start' reply. On success the worker is
 *  registered (for done-scan / reaping / safe teardown) and dispatched its
 *  objective via the standard inbox path. */
async function processSpawnRequest(filePath: string): Promise<void> {
  let raw: SpawnRequest;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as SpawnRequest;
  } catch (e) {
    console.error('[worker] unparseable spawn-request:', filePath, e);
    informGod('[worker spawn rejected] unparseable request', `Could not parse spawn-request ${basename(filePath)} — ${String(e)}`);
    archiveRequest(filePath, '.failed');
    return;
  }
  const slack = raw.slack && typeof raw.slack.channel === 'string' && typeof raw.slack.thread_ts === 'string'
    ? { channel: raw.slack.channel, thread_ts: raw.slack.thread_ts } : undefined;
  const fail = (reason: string): void => {
    // An offload request reserved its concurrency slot when it was WRITTEN; a spawn
    // that never becomes a live worker would leak it (teardownPty never runs), so
    // free it here. No-op for normal requests.
    if (raw.hive?.offload?.target && typeof raw.id === 'string') releaseOffloadSlot(raw.id);
    informGod(`[worker spawn rejected] ${reason}`, `Spawn-request ${basename(filePath)} rejected: ${reason}.`, slack);
    archiveRequest(filePath, '.failed');
  };

  const objective = typeof raw.objective === 'string' ? raw.objective.trim() : '';
  if (!objective) { fail('missing "objective"'); return; }

  const reqId = (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : basename(filePath).replace(/\.json$/i, ''))
    .replace(/[^A-Za-z0-9._-]/g, '-');
  const workerId = `worker-${reqId}`;
  if (liveWorkers.has(workerId)) { fail(`worker "${workerId}" already running`); return; }

  // Worker request files are hand/LLM-authored, so `~/…` shows up here too — expand
  // before the existence check (Node reads `~` literally).
  const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? expandTilde(raw.cwd) : '';
  if (!cwd || !existsSync(cwd)) { fail(`"cwd" missing or not found (${cwd || 'unset'})`); return; }

  // Request line → executable + argv (auto-mode inheritance, tokenization,
  // model-flag dedupe). Pure and unit-tested — see workerLaunch.ts for why this
  // translation earned a test.
  const cfgSpawn = readConfig();

  // Auto-offload producer (G1), DARK by default. When the feature is ON and this
  // request is explicitly offload-eligible AND its owning Claude account is RED,
  // route it to a healthy non-Claude endpoint instead of spawning a Claude worker
  // here. Gated HARD on enabled===true (default false), so this is a pure
  // pass-through today and current spawns are byte-identical. The already-offloaded
  // guard (hive.offload.target) stops a codex-bound request looping back through.
  // Per-profile RED is derived from LIVE agent rate-limit samples, which stop
  // arriving once that account's Claude workers are paused — i.e. exactly when
  // offload should fire. So we also accept the GLOBAL governor being RED as the
  // trigger (offload is opt-in per request via offloadEligible, so this can only
  // reroute work the caller already marked). Tightening this back to strict
  // per-profile precision needs the staleness-aware governor from
  // governor-policy-config (keep last-known RED across stale windows).
  if (cfgSpawn.governorPolicy?.global?.autoOffload?.enabled === true
      && raw.offloadEligible === true
      && !raw.hive?.offload?.target
      && (governorProfileState(raw.profile).mode === 'red' || governorMode === 'red')) {
    const accountKey = claudeAccountKey(raw.profile);
    const resolvedAutoOffload = resolveProfileSettings(cfgSpawn.governorPolicy, typeof raw.profile === 'string' ? raw.profile : null);
    const mergedAutoOffload = resolvedAutoOffload?.autoOffloadMerged;
    const offloadTokenCap = typeof raw.tokenCap === 'number' && Number.isFinite(raw.tokenCap) && raw.tokenCap > 0 ? raw.tokenCap : undefined;
    queueOffloadObjective({
      objective, cwd,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      slack,
      model: typeof raw.model === 'string' ? raw.model : undefined,
      tokenCap: offloadTokenCap,
      isolate: raw.isolate !== false,
      accountKey
    });
    void attemptGovernorOffloads({
      policy: mergedAutoOffload ?? cfgSpawn.governorPolicy?.global?.autoOffload,
      hiveRoot: hive.root(),
      redProfiles: [accountKey],
      profileConfigs: mergedAutoOffload ? { [accountKey]: mergedAutoOffload } : undefined,
      notify: (subject, body) => informGod(subject, body, slack)
    });
    console.log(`[worker] offloaded ${reqId} (owning account RED) — not spawning Claude`);
    archiveRequest(filePath, '.done');
    return;
  }

  // Runtime-profiles v1 — an optional `profile` on the request names a saved
  // engine+account+model bundle. Its engine/model/command fill in ONLY where the
  // request stays silent (an explicit request field always wins), and its
  // per-account Claude login dir is applied later in spawnAgentCore via profileId.
  const profile = getRuntimeProfile(raw.profile);
  const effectiveProvider = (typeof raw.provider === 'string' && raw.provider.trim()) ? raw.provider : profile?.provider;
  const launch = buildWorkerLaunch({
    requestCommand: (typeof raw.command === 'string' && raw.command.trim()) ? raw.command : profile?.command,
    requestProvider: effectiveProvider,
    requestModel: (typeof raw.model === 'string' && raw.model.trim()) ? raw.model : profile?.model,
    defaultCommand: cfgSpawn.defaultCommand,
    autoMode: !!cfgSpawn.autoMode
  });
  const bin = launch.bin;
  // A profile may carry extra argv flags with no command of its own; append them.
  if (profile?.extraArgs?.length) launch.args = [...launch.args, ...profile.extraArgs];
  // Missing-CLI → FAIL FAST. A headless worker has no human to watch an installer,
  // so we never run the cc49e1e install banner here — we reject and tell god.
  if (!ptyManager.isCommandAvailable(bin)) { fail(`engine CLI "${bin}" is not installed`); return; }

  const isolate = raw.isolate !== false; // default true
  // Base branch the worktree will be cut from (for the ahead-of-base safety check).
  let baseBranch = 'main';
  try { const br = await getBranch(cwd); if ('current' in br && br.current) baseBranch = br.current; } catch { /* keep default */ }

  const displayName = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Worker ${reqId.slice(0, 12)}`;
  // Duplicate-name guard: block a spawn whose display name matches an already-active
  // (non-archived) agent, so we never end up with "3 Jims" on the floor. Respawns
  // archive the outgoing agent before requeuing, so this never blocks them. god gets
  // the reason and can route to the existing agent instead.
  const nameClash = Object.entries(hive.registry().agents)
    .find(([id, a]) => !a.archived && id !== workerId && (a.name ?? '').trim().toLowerCase() === displayName.toLowerCase());
  if (nameClash) {
    fail(`an active agent named "${displayName}" already exists (${nameClash[0]}) — route to it or rename this spawn`);
    return;
  }

  const meta: AgentMeta = {
    id: workerId,
    name: displayName,
    provider: effectiveProvider,
    profileId: profile?.id,
    role: 'worker',
    cwd
  };
  // Phase 2: grant this worker a broker capability over the currently-enabled
  // integrations and inject the broker URL + a per-worker capability TOKEN (a handle,
  // never a secret) into its env, so it can reach registered REST integrations through
  // the loopback secret broker without ever seeing a credential. Only when the broker
  // is up; the grant is revoked in teardownPty (and below if the spawn fails).
  const brokerEnv: Record<string, string> = {};
  if (integrationBroker.running()) {
    const token = integrationBroker.grant(workerId, integrations.enabledIds());
    brokerEnv.MD_BROKER_URL = integrationBroker.url();
    brokerEnv.MD_BROKER_TOKEN = token;
  }
  const spawnOpts: AgentSpawnOptions = {
    id: workerId, cwd, command: bin, cols: 120, rows: 32,
    args: launch.args,
    hive: meta, isolate, provider: effectiveProvider, env: brokerEnv
  };

  let res: { ok: boolean; error?: string; worktreePath?: string };
  try {
    res = await spawnAgentCore(spawnOpts, liveWebContents());
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (!res.ok) { integrationBroker.revoke(workerId); fail(`spawn failed — ${res.error ?? 'unknown error'}`); return; }

  // A god-hired worker is a MAIN-initiated spawn, so the renderer would never
  // card it on its own (same reason as the voice-spawn broadcast): without this
  // the worker is invisible on the floor, never enters the roster, and after a
  // restart nothing offers to restore it. The card rides the normal agent
  // lifecycle from here — teardownPty broadcasts the matching archive. A card
  // RESTORED after an app quit revives through the renderer's normal spawn path
  // and never re-enters liveWorkers: ephemerality is a property of the hiring,
  // not of the card, so a restored worker is a regular agent (no reaping).
  try {
    liveWebContents()?.send('hive:agentSpawned', {
      id: workerId,
      name: meta.name,
      provider: raw.provider ?? 'claude',
      cwd: res.worktreePath ?? cwd,
      command: launch.command,
      role: meta.role,
      worktreePath: res.worktreePath,
      character: typeof raw.character === 'string' ? raw.character : undefined,
      accent: typeof raw.accent === 'string' ? raw.accent : undefined
    });
  } catch { /* window torn down */ }

  // Register for done-scan / idle-reap / token-cap / safe teardown (pty id == workerId).
  // tokenCap is optional plumbing (default unlimited) — only a positive finite cap is kept.
  const tokenCap = typeof raw.tokenCap === 'number' && Number.isFinite(raw.tokenCap) && raw.tokenCap > 0
    ? raw.tokenCap : undefined;
  // Offload provenance (§6): if this worker was spawned by the auto-offload path,
  // keep the target + a minimal spec so a reap-without-done can requeue it onto
  // another target. Reconstructed from the request the offload path wrote.
  const offloadTarget = raw.hive?.offload?.target;
  const offload = offloadTarget
    ? {
        targetId: offloadTarget,
        spec: {
          objective, cwd,
          name: typeof raw.name === 'string' ? raw.name : undefined,
          slack,
          model: typeof raw.model === 'string' ? raw.model : undefined,
          profile: typeof raw.profile === 'string' ? raw.profile : undefined,
          tokenCap,
          accountKey: raw.hive?.offload?.accountKey,
          excludeTargets: [offloadTarget]
        } as OffloadWorkSpec
      }
    : undefined;
  liveWorkers.set(workerId, { workerId, reqId, name: meta.name, slack, baseBranch, spawnedAt: Date.now(), tokenCap, offload, cwd, objective });

  // Dispatch the objective via the standard inbox path (zero new transport),
  // reusing the autonomous-request preamble so the worker gets the exact Slack
  // reply command + autonomy policy. `from: god` so the worker treats it as a god
  // dispatch per its protocol.
  try {
    const prefix = slack
      ? buildAutonomousRequestProtocol(slack.channel, slack.thread_ts, slackReplyScriptPath())
      : '[AUTONOMOUS WORKER TASK — no interactive human is watching. Work autonomously; do not ask interactive questions.] The task starts now: ';
    const suffix = `\n\n[CAPABILITIES] Before you start, consult your capability catalog — run the \`/capabilities\` skill (or read \`$AGENT_DIR/.claude/skills/capabilities/SKILL.md\`). It lists your temporal date-range skills (\`/today\`, \`/last30Days\`, \`/lastQuarter\`, …) and the integrations available to you (reached via the loopback broker) and how to call each. For any time-scoped work, resolve the dates with those skills instead of computing them by hand.\n\n[WORKER COMPLETION] When finished, signal done by sending ONE outbox message to Abathur with "to":"god", "act":"done" and a short result summary — that releases this ephemeral worker (terminal closed; your branch is handed to Abathur). Do NOT push to any remote; Abathur is the sole integrator.`;
    hive.send({ to: workerId, conversation: `worker-${reqId}`, act: 'request', subject: meta.name, body: `${prefix}${objective}${suffix}` }, 'god');
  } catch (e) {
    console.error('[worker] dispatch send failed:', e);
  }

  // The renderer's inbox-wake can fire too early (Claude still booting) and
  // ack the nudge out of the queue before Claude's readline is ready.  Fire a
  // main-process nudge at 10s — well past Claude's boot — so the task actually
  // lands.  The watchdog's 35s boot grace is too long for a first wake.
  setTimeout(() => {
    if (!liveWorkers.has(workerId)) return;
    const pending = hive.inbox(workerId).map((m) => m.id).filter(Boolean);
    if (!pending.length) return;
    nudgeWorker(workerId, pending);
  }, 10_000);

  console.log(`[worker] spawned ${workerId} (cwd=${cwd}, base=${baseBranch}${slack ? ', slack' : ''})`);
  archiveRequest(filePath, '.done');
}

/** Total tokens (input+output+cache) a worker has burned so far, from the usage
 *  provider — 0 when unknown. Mirrors the breaker's `tokensOf`. Used only by the
 *  (default-off) per-worker token cap. */
function workerTokensUsed(workerId: string): number {
  const s = usageProvider.getAgentUsage(workerId);
  return s ? s.input + s.output + s.cacheRead + s.cacheCreation : 0;
}

/** Throttle for the GC sweep — git checks are cheap but pointless every 1.5s tick. */
const GC_SWEEP_MS = 60_000;
let lastGcSweepAt = 0;
let gcSweepRunning = false;

/** Reclaim preserved worker worktrees (+ their scratch dirs) whose work is now
 *  integrated, or whose worktree was already removed by hand. Fail-safe: a worktree
 *  is removed ONLY when `worktreeIsGcSafe` proves it clean AND integrated; any doubt
 *  KEEPS it (never discards un-integrated work — god is the sole integrator). Runs
 *  inside the worker tick, throttled to GC_SWEEP_MS, and is a no-op when nothing is
 *  preserved (the common case → zero cost). */
async function gcPreservedWorktrees(): Promise<void> {
  if (gcSweepRunning || preservedWorktrees.size === 0) return;
  gcSweepRunning = true;
  try {
    for (const [key, e] of [...preservedWorktrees]) {
      // A worker id that is live again (reqId reuse) → never GC its worktree or
      // scratch out from under the new run; leave the stale entry for a later sweep.
      if (liveWorkers.has(e.workerId)) continue;
      // (a) Worktree already gone (removed at clean teardown, or god removed it by
      //     hand per the preserve note) → just reclaim the scratch dir + drop tracking.
      if (!existsSync(e.wtPath)) {
        removeWorkerScratch(e.workerId);
        preservedWorktrees.delete(key);
        console.log(`[worker gc] ${e.workerId}: worktree already gone — reclaimed scratch`);
        continue;
      }
      // (b) Still on disk → reclaim ONLY when provably integrated + clean.
      let safe: { gc: boolean; detail: string };
      try { safe = await worktreeIsGcSafe(e.wtPath, e.baseBranch); }
      catch (err) { console.error('[worker gc] gc-safe check threw (keeping):', err); continue; }
      if (!safe.gc) continue; // keep — fail-safe
      const r = await removeWorktree(e.origCwd, e.wtPath);
      if (!r.ok) { console.error(`[worker gc] removeWorktree failed (keeping ${e.workerId}):`, r.error); continue; }
      removeWorkerScratch(e.workerId);
      preservedWorktrees.delete(key);
      console.log(`[worker gc] reclaimed ${e.workerId} (${safe.detail})`);
      informGod(
        `[worker worktree reclaimed] ${e.workerId}`,
        `The preserved worktree for ${e.workerId} is now integrated (${safe.detail}), so it and its scratch dir were garbage-collected.\nWorktree: ${e.wtPath}`,
        e.slack
      );
    }
  } finally {
    gcSweepRunning = false;
  }
}

/** One controller tick: (1) finish/reap live workers (frees slots), then (2) pull
 *  new requests up to the concurrency cap. Order matters so a freed slot is reused
 *  the same tick. */
async function ephemeralWorkerTick(): Promise<void> {
  if (workerTickRunning) return;
  workerTickRunning = true;
  try {
    const cfg = readConfig();
    const maxWorkers = Math.max(1, cfg.maxConcurrentWorkers ?? 4);
    const idleTimeoutMs = Math.max(1, cfg.workerIdleTimeoutMinutes ?? 20) * 60_000;
    // Per-worker token cap. 0 = UNLIMITED (the default — wired but never throttles
    // unless a positive cap is set per-request or via defaultWorkerTokenCap).
    const defaultTokenCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
      ? cfg.defaultWorkerTokenCap : 0;

    // (1) Finish or reap. Each release calls teardownPty EXPLICITLY after the
    //     kill, like every other kill site: ptyManager.kill() deletes the session
    //     synchronously, so when node-pty's async onExit later fires it fails the
    //     session-identity guard and the global exit handler (→ teardownPty)
    //     never runs. Relying on onExit here left released workers un-torn-down:
    //     no hive archive, no hive:agentArchived, frozen floor cards, and god
    //     kept mailing dead agents (seen live 2026-08-16 with worker-business/
    //     worker-qa/worker-bizreview). A double teardown is a harmless no-op.
    for (const [workerId, rec] of [...liveWorkers]) {
      if (rec.releasing) continue;
      if (workerSignaledDone(workerId, rec.spawnedAt)) {
        // Success: the worker already replied in-thread; just release it.
        rec.releasing = true;
        recordRecentWorker(workerId, 'done');
        console.log(`[worker] ${workerId} signaled done — releasing`);
        ptyManager.kill(workerId);
        teardownPty(workerId);
        continue;
      }
      // Token-cap reap (default-off plumbing). An effective cap > 0 → reap when the
      // worker's cumulative token use exceeds it; its committed work is preserved.
      const tokenCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : defaultTokenCap;
      if (tokenCap > 0) {
        const used = workerTokensUsed(workerId);
        // Pre-reap warning at 75%: workers were getting reaped at the cap without
        // ever committing in-progress work. A nudge into their own inbox — sent
        // once per worker (workerWarnedAt75 rate-limits it) — gives them a chance
        // to commit before the hard reap below.
        if (used >= tokenCap * 0.75 && !workerWarnedAt75.has(workerId)) {
          workerWarnedAt75.add(workerId);
          const pct = Math.floor((used / tokenCap) * 100);
          try {
            hive.send({
              to: workerId,
              act: 'warn',
              subject: 'Token cap approaching — commit your work now',
              body: `You have used ${pct}% of your token cap. Commit any in-progress work immediately. You will be reaped at 100%.`
            }, 'system');
          } catch (e) {
            console.error('[worker] pre-reap warning failed:', e);
          }
        }
        if (used > tokenCap) {
          rec.releasing = true;
          recordRecentWorker(workerId, 'reaped');
          console.warn(`[worker] reaping ${workerId} — token cap (${used.toLocaleString()} > ${tokenCap.toLocaleString()})`);
          informGod(
            `[worker reaped — token cap] ${workerId}`,
            `Worker ${workerId} used ${used.toLocaleString()} tokens (> its cap of ${tokenCap.toLocaleString()}) and was reaped. Any committed work on its branch is preserved for you.`,
            rec.slack
          );
          ptyManager.kill(workerId);
          teardownPty(workerId);
          continue;
        }
      }
      const idleMs = ptyManager.idleFor(workerId);
      if (idleMs === undefined) continue; // PTY already gone; teardownPty cleans up
      if (idleMs > idleTimeoutMs) {
        rec.releasing = true;
        recordRecentWorker(workerId, 'reaped');
        console.warn(`[worker] reaping idle ${workerId} (${Math.round(idleMs / 60000)}min idle)`);
        informGod(
          `[worker reaped — idle] ${workerId}`,
          `Worker ${workerId} produced no output for ${Math.round(idleMs / 60000)} min (> the ${Math.round(idleTimeoutMs / 60000)} min cap) and never signaled done, so it was reaped. Any committed work on its branch is preserved for you.`,
          rec.slack
        );
        ptyManager.kill(workerId);
        teardownPty(workerId);
      }
    }

    // (2) Process new requests, honoring the concurrency cap (backpressure: leave
    //     the rest in the queue for a later tick).
    //
    //     Gated on config.orchestratorMaySpawn (default OFF): letting the
    //     orchestrator spin up agents unprompted is a SPEND decision, so the
    //     operator opts in. The gate sits HERE, on intake, and not on the watcher
    //     itself, because step (1) above owns the lifecycle of workers that are
    //     already running — reaping, teardown, the Slack failure notice — and
    //     turning the toggle off mid-flight must not strand them.
    //
    //     Declining also means declining to CONSUME. A request dropped in while
    //     this is off stays in the queue and runs when it is turned on, rather
    //     than being eaten and failed for a reason god never asked about.
    const dir = readConfig().orchestratorMaySpawn ? spawnRequestsDir() : null;
    if (dir && existsSync(dir)) {
      let files: string[] = [];
      try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { /* dir vanished */ }
      for (const f of files) {
        if (liveWorkers.size >= maxWorkers) break;
        await processSpawnRequest(join(dir, f));
      }
    }

    // (3) GC preserved worktrees whose work has since integrated. Throttled to
    //     GC_SWEEP_MS and a no-op when nothing is preserved (the common case).
    const now = Date.now();
    if (preservedWorktrees.size > 0 && now - lastGcSweepAt >= GC_SWEEP_MS) {
      lastGcSweepAt = now;
      await gcPreservedWorktrees();
    }
  } catch (e) {
    console.error('[worker] tick error:', e);
  } finally {
    workerTickRunning = false;
  }
}

function startEphemeralWorkerWatcher(): void {
  if (workerWatchTimer || !hive.enabled()) return;
  const dir = spawnRequestsDir();
  if (dir) { try { mkdirSync(dir, { recursive: true }); } catch { /* noop */ } }
  workerWatchTimer = setInterval(() => { void ephemeralWorkerTick(); }, WORKER_TICK_MS);
}

function stopEphemeralWorkerWatcher(): void {
  if (workerWatchTimer) { clearInterval(workerWatchTimer); workerWatchTimer = null; }
}

/** Snapshot of one live ephemeral worker for the renderer Workers tab. */
interface WorkerSnapshot {
  workerId: string;
  reqId: string;
  name: string;
  baseBranch: string;
  cwd?: string;
  objective?: string;
  spawnedAt: number;
  ageMs: number;
  idleMs: number | null;        // null = PTY already gone
  tokensUsed: number;
  tokenCap: number | null;      // effective cap (per-request or config default); null = unlimited
  hasSlack: boolean;
  releasing: boolean;
  status: 'releasing' | 'working' | 'idle';
  tailPreview: string[];
}
/** Snapshot of a preserved-but-not-yet-GC'd worktree for the tab. */
interface PreservedSnapshot {
  workerId: string;
  wtPath: string;
  baseBranch: string;
  preservedAt: number;
}

/** List live ephemeral workers (+ preserved worktrees awaiting GC) for the tab. */
ipcMain.handle('workers:list', (): {
  live: WorkerSnapshot[];
  recent: RecentWorkerSnapshot[];
  preserved: PreservedSnapshot[];
  maxWorkers: number;
} => {
  const cfg = readConfig();
  const defaultCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
    ? cfg.defaultWorkerTokenCap : 0;
  const now = Date.now();
  const live: WorkerSnapshot[] = [...liveWorkers.values()].map((rec) => {
    const idle = ptyManager.idleFor(rec.workerId);
    const effCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : (defaultCap > 0 ? defaultCap : 0);
    const tail = getWorkerPtyTail(rec.workerId);
    const isWorking = idle !== undefined && idle < 3000;
    return {
      workerId: rec.workerId,
      reqId: rec.reqId,
      name: rec.name ?? rec.workerId,
      baseBranch: rec.baseBranch,
      cwd: rec.cwd,
      objective: rec.objective,
      spawnedAt: rec.spawnedAt,
      ageMs: Math.max(0, now - rec.spawnedAt),
      idleMs: idle === undefined ? null : idle,
      tokensUsed: workerTokensUsed(rec.workerId),
      tokenCap: effCap > 0 ? effCap : null,
      hasSlack: !!rec.slack,
      releasing: !!rec.releasing,
      status: rec.releasing ? 'releasing' : (isWorking ? 'working' : 'idle'),
      tailPreview: tail.slice(-5)
    };
  });
  const preserved: PreservedSnapshot[] = [...preservedWorktrees.values()].map((e) => ({
    workerId: e.workerId, wtPath: e.wtPath, baseBranch: e.baseBranch, preservedAt: e.preservedAt
  }));
  return { live, recent: recentWorkers, preserved, maxWorkers: Math.max(1, cfg.maxConcurrentWorkers ?? 4) };
});

/** Return the rolling PTY buffer for a worker / agent. */
ipcMain.handle('workers:getTail', (_evt, agentId: unknown): string[] => {
  if (typeof agentId !== 'string' || !agentId) return [];
  return getWorkerPtyTail(agentId);
});

/** Manually stop a live ephemeral worker. Mirrors the done-release path: mark
 *  releasing, then kill + teardownPty runs the SAFETY-GATED worktree teardown
 *  (committed work is preserved, never force-discarded). Idempotent. */
ipcMain.handle('workers:stop', (_evt, workerId: string): { ok: boolean; error?: string } => {
  if (typeof workerId !== 'string' || !workerId) return { ok: false, error: 'invalid worker id' };
  const rec = liveWorkers.get(workerId);
  if (!rec) return { ok: false, error: 'no such live worker' };
  if (rec.releasing) return { ok: true }; // already stopping
  rec.releasing = true;
  console.log(`[worker] manual stop requested for ${workerId}`);

  // Write stop message to worker's inbox for graceful shutdown
  const root = hive.root();
  if (root) {
    const nowIso = new Date().toISOString();
    const safeTimestamp = nowIso.replace(/[:.]/g, '-');
    const stopMsgId = `${safeTimestamp}-stop`;
    const inboxDir = join(root, 'agents', workerId, 'inbox');
    try {
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(join(inboxDir, `${stopMsgId}.json`), JSON.stringify({
        id: stopMsgId,
        from: 'human',
        to: workerId,
        act: 'stop',
        subject: 'Stop requested',
        body: 'Stop active work and finish safely',
        hops: 0,
        requires_reply: false,
        needs_human: false,
        created_at: nowIso
      }, null, 2), 'utf8');
    } catch { /* best-effort */ }
  }

  recordRecentWorker(workerId, 'stopped');
  try { ptyManager.kill(workerId); } catch (e) { return { ok: false, error: String(e) }; }
  teardownPty(workerId);
  return { ok: true };
});

interface ProcessSpawnOptions {
  cmd: string;
  args?: string[];
  cwd: string;
  label?: string;
  shell: 'wsl-bash' | 'powershell' | 'cmd' | 'bash';
}

function convertToWslPath(windowsPath: string): string {
  return windowsPath.replace(/^([A-Z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/');
}

function hasShellMetachars(s: string): boolean {
  return /[&|;<>"'`$\n<>%]/.test(s);
}

ipcMain.handle('process:spawn', (_evt, opts: unknown): { ok: boolean; processId?: string; error?: string } => {
  if (!opts || typeof opts !== 'object') return { ok: false, error: 'invalid options' };
  const { cmd, args = [], cwd, label, shell } = opts as ProcessSpawnOptions;
  if (!cmd || !cwd || !shell) return { ok: false, error: 'missing required fields' };

  if (hasShellMetachars(cwd) || hasShellMetachars(cmd)) {
    return { ok: false, error: 'path or command contains shell metacharacters' };
  }
  if ((args as string[]).some(hasShellMetachars)) {
    return { ok: false, error: 'arguments contain shell metacharacters' };
  }

  const processId = `proc-${++processIdSeq}`;
  const now = Date.now();

  try {
    let spawnCmd: string;
    let spawnArgs: string[];
    let spawnOpts: { cwd: string; shell: boolean };

    if (shell === 'wsl-bash') {
      const wslPath = convertToWslPath(cwd);
      spawnCmd = 'wsl.exe';
      spawnArgs = ['-d', 'Ubuntu', '--cd', wslPath, '--', 'bash'];
      spawnOpts = { cwd, shell: false };
    } else if (shell === 'powershell') {
      spawnCmd = 'powershell.exe';
      spawnArgs = ['-NoProfile', '-NoLogo', '-NonInteractive'];
      spawnOpts = { cwd, shell: false };
    } else if (shell === 'cmd') {
      spawnCmd = 'cmd.exe';
      spawnArgs = ['/Q'];
      spawnOpts = { cwd, shell: false };
    } else {
      spawnCmd = cmd;
      spawnArgs = args as string[];
      spawnOpts = { cwd, shell: false };
    }

    const proc = spawn(spawnCmd, spawnArgs, spawnOpts);

    const tracked: TrackedProcess = {
      pid: proc.pid ?? 0,
      label: label || cmd,
      cmd,
      args: args as string[],
      cwd,
      shell,
      startedAt: now,
      status: 'running'
    };

    trackedProcesses.set(processId, tracked);

    proc.on('exit', (code) => {
      const p = trackedProcesses.get(processId);
      if (p) {
        p.status = 'exited';
        p.exitCode = code ?? undefined;
      }
    });

    console.log(`[process] spawned ${processId}: ${label || cmd} (pid ${proc.pid})`);
    return { ok: true, processId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('process:kill', (_evt, processId: string): { ok: boolean; error?: string } => {
  if (typeof processId !== 'string' || !processId) return { ok: false, error: 'invalid process id' };
  const proc = trackedProcesses.get(processId);
  if (!proc) return { ok: false, error: 'no such process' };

  try {
    if (proc.status === 'running' && proc.pid) {
      process.kill(proc.pid);
      proc.status = 'exited';
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('process:list', () => {
  const now = Date.now();
  return [...trackedProcesses.entries()].map(([id, p]) => ({
    processId: id,
    pid: p.pid,
    label: p.label,
    cwd: p.cwd,
    shell: p.shell,
    status: p.status,
    exitCode: p.exitCode,
    startedAt: p.startedAt,
    uptimeMs: p.status === 'running' ? Math.max(0, now - p.startedAt) : 0
  }));
});

ipcMain.handle('delegations:list', () => ({
  log: delegationLog,
  stats: delegationStats
}));

ipcMain.handle('delegations:clear', () => {
  delegationLog.length = 0;
  delegationStats.delegated = 0;
  delegationStats.allowed = 0;
  delegationStats.blocked = 0;
  return { ok: true };
});

/** Start every hive-bound background service against the current harnessHome.
 *  Called on boot, and again to recover in place if a folder-change copy fails
 *  (config:changeHome tears these down before copying). No-op without a home. */
function bootstrapHiveServices(): void {
  if (!hive.enabled()) return;
  hive.ensureHive();
  // Claim the cross-device advisory lock (see syncLock). The start-time REFUSAL
  // gate — when a FOREIGN device holds a live lock — runs in the sync pull path
  // (syncOnStart) BEFORE this bootstrap; here we simply record this device as the
  // current owner and warn if a foreign live owner is somehow still present.
  try {
    const hr = hive.root();
    if (hr) {
      const foreign = syncLock.foreignLiveOwner(hr);
      if (foreign) console.warn(`[sync-lock] hive appears active on ${foreign.host} (device ${foreign.device}); proceeding but a sync push may conflict`);
      if (hr) syncLock.acquire(hr, app.getVersion());
    }
  } catch (e) { console.error('[hive] sync lock acquire:', e); }
  // Tell the hive what it is running inside, BEFORE anything spawns: the prompt
  // builder reads this, so an agent spawned earlier would never learn it.
  hive.setRuntimeInfo({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData') });
  hive.setOrchestratorMaySpawn(readConfig().orchestratorMaySpawn === true);
  // An app-start marker in the event log. log.jsonl had twelve event kinds and
  // none of them meant "the app restarted", so a relaunch, and more importantly a
  // switch between a packaged build and a local one, was invisible to every agent
  // reading the feed. That gap cost a multi-hour investigation whose answer was
  // exactly this: a local build inherits the launching shell's umask, a
  // Finder-launched app does not.
  hive.appendLog({
    kind: 'app-start',
    version: app.getVersion(),
    packaged: app.isPackaged,
    // WHICH bundle, not just which version. Version plus packaged is not enough
    // to tell two builds apart: a stale copy in /Applications and a fresh one in
    // dist/ can report the same version and both be packaged, and picking the
    // wrong one by habit looks exactly like the new build being broken. Cost us
    // twice before this line existed.
    appPath: app.getAppPath(),
    exePath: process.execPath,
    electron: process.versions.electron,
    platform: process.platform
  });
  control.replaceAutoDeliveryPauses(readConfig().autoDeliveryPausedAgents ?? []);
  archiveOrphanedAgents(); // #57/#58: archive stale archived:false entries with no live PTY
  hive.startRouter();
  ensureArtifactsWatcher(); // watch <hive>/artifacts/ for the human review queue
  startEphemeralWorkerWatcher(); // poll HIVE_ROOT/spawn-requests → ephemeral workers
  // Phase 2: the loopback secret broker. Bind it BEFORE workers spawn so each spawn can
  // be granted a capability token + the broker URL in its env. Loopback-only, idempotent.
  void integrationBroker.start().then((r) => {
    if (r.ok) console.log('[broker] integration broker listening on', integrationBroker.url());
    else console.error('[broker] failed to start:', r.error);
  });
  ensureDefaultMissions(); // one-time: seed the built-in hourly ops standup
  syncMissions(); // arm recurring auto-dispatch missions now the router is live
  syncContextTriggers(); // …and the context trigger's own compact/clear cadences
  // Pair replies to inbound webhook messages in the ledger. Tied to the FEATURE
  // (any endpoint configured), not to the server: an approved message's card can
  // finish long after the operator switched the public surface back off, and its
  // reply still belongs in the history.
  if ((readConfig().webhookTriggers ?? []).length > 0) startWebhookDoneObserver();
  hookServer.start();
  // Bind the telemetry collector BEFORE the renderer spawns any agent, then point
  // the hive at it so every subsequent spawn is instrumented. Best-effort — a bind
  // failure just leaves telemetry off (transcript reconciler stays). No breaker.start():
  // the breaker is POLICY-only, ticked by the heartbeat beat (#1, ships disabled).
  void telemetry.start().then((r) => {
    if (r.ok && r.endpoint) { hive.setOtelEndpoint(r.endpoint); console.log('[telemetry] collector listening', r.endpoint); }
    else console.error('[telemetry] collector failed to start:', r.error);
  });
  memory.start(); // init shared palace + mine loop (no-op without mempalace)
  reflector.start(); // bound oversized memory.md files on a timer (no-op until threshold)

  armAlwaysOnBeats();
}

/** Cadence of the worker inbox-wake watchdog (#151). Well under the renderer's
 *  own nudge cooldown so a throttled window is caught within ~15s of a stall. */
const WORKER_WAKE_POLL_MS = 15_000;
let workerWakeTimer: ReturnType<typeof setInterval> | null = null;

/** Type the renderer's guarded nudge into one worker's PTY — text first, Enter a
 *  tick later (the exact submitToPty pattern: a single-chunk write would land the
 *  "\r" inside the input box and never submit). Best-effort + never throws. */
function nudgeWorker(ptyId: string, ids: string[] = []): void {
  // Same text the renderer queues (#187's inboxNudgeText), so the two wake paths
  // produce byte-identical nudges: the queue's one-pending rule recognises either
  // via isInboxNudge, and a watchdog nudge names its ids so the agent can still
  // tell "I filed this last turn" from "woken for nothing".
  const wrote = ptyManager.write(ptyId, inboxNudgeText(ids));
  if (!wrote.ok) { console.warn(`[worker-wake] write failed for ${ptyId}: ${wrote.error}`); return; }
  setTimeout(() => {
    try {
      const submitted = ptyManager.write(ptyId, '\r');
      if (!submitted.ok) console.warn(`[worker-wake] submit failed for ${ptyId}: ${submitted.error}`);
    } catch (e) { console.error('[worker-wake] submit threw:', e); }
  }, 140);
}

/** Main-process inbox-wake beat (issue #151, fix A): the renderer's idle nudge
 *  (useHive.ts) is the only path that wakes a worker parked on an undrained
 *  inbox — and it lives on a setInterval in the renderer, which a throttled or
 *  occluded window stops honoring. This beat is the renderer-INDEPENDENT fallback:
 *  it gathers live-worker facts (PTY quiescence, inbox depth, control flags) and
 *  lets WorkerWakeWatchdog.decide apply the exact renderer guards (idle-only,
 *  post-boot-grace, not paused/halted, no pending HITL, cooldown), then types the
 *  same nudge the renderer would have. God is never a candidate (its heartbeat
 *  path already re-engages it). */
function runWorkerWakeBeat(): void {
  if (!hive.enabled()) return;
  const reg = hive.registry();
  if (!reg?.agents || !reg.godId) return;
  const now = Date.now();
  const facts: WorkerWakeFacts[] = [];
  for (const [agentId, a] of Object.entries(reg.agents)) {
    if (agentId === reg.godId || a?.archived) continue;
    const ptyId = ptyForAgent(agentId);
    if (!ptyId) continue;
    const snap = control.snapshot(agentId);
    facts.push({
      agentId,
      isOvermind: agentId === reg.godId,
      ptyId,
      lastOutputAt: ptyManager.lastOutputAt(ptyId) ?? 0,
      inboxCount: hive.inbox(agentId).length,
      autoDeliveryPaused: snap.autoDeliveryPaused,
      paused: snap.paused,
      halted: snap.halted
    });
  }
  for (const agentId of workerWake.decide(facts, now)) {
    const ptyId = ptyForAgent(agentId);
    if (!ptyId) continue;
    // Re-read at delivery time, not from the facts snapshot: the agent may have
    // drained the mail during the beat, and a nudge naming ids it already filed
    // is the exact staleness #187 exists to stop.
    const ids = hive.inbox(agentId).map((m) => m.id).filter(Boolean);
    if (!ids.length) { console.log(`[worker-wake] ${agentId} drained before delivery, skipping`); continue; }
    console.log(`[worker-wake] nudging ${agentId} on ${ptyId} (${ids.length} pending)`);
    nudgeWorker(ptyId, ids);
  }
}

/** (Re)arm the always-on beats (decoupled from the optional heartbeat): the live
 *  fleet snapshot Abathur reads (~8s) + the breaker/cost-ledger beat (~30s).
 *  Guarded (clear-then-set) so a re-bootstrap (changeHome recovery) OR a
 *  powerMonitor resume can't stack duplicate timers — these are setInterval
 *  handles that freeze during true system sleep and must be re-armed on wake. */
/** Window lengths for the two Claude rate-limit windows. */
const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;

type GovernorLevel = 'green' | 'yellow' | 'red';

type GovernorWindowSnapshot = { pct: number; resetsAt: string; level?: GovernorLevel; reason?: string };
type WindowUsage = { pct: number; resetsAt: string };
type GovernorUsageProfiles = Record<string, { fiveHour: WindowUsage | null; sevenDay: WindowUsage | null }>;
type GovernorUsage = { fiveHour: WindowUsage | null; sevenDay: WindowUsage | null; profiles?: GovernorUsageProfiles };
type GovernorBroadcastProfile = { profileId: string; mode: GovernorLevel; reason: string };
type GovernorBroadcastPayload = {
  mode: GovernorLevel;
  reason?: string;
  fiveHour: GovernorWindowSnapshot | null;
  sevenDay: GovernorWindowSnapshot | null;
  profiles: GovernorBroadcastProfile[];
  override?: 'force-green';
  pausedAgents: string[];
};

/** Current governor mode (persisted across beats; IPC-pushed to renderer). */
let governorMode: GovernorLevel = 'green';
let governorLastPayload: GovernorBroadcastPayload | null = null;
/** Agent ids paused by the governor (so we can un-pause on recovery). */
const governorPausedAgents = new Set<string>();
/** Per-profile governor severity (rebuilt each beat). */
const governorProfileStates = new Map<string, { mode: GovernorLevel; reason: string }>();
const DEFAULT_CLAUDE_PROFILE_KEY = '__default_claude_profile__';

type ResolvedWindowSettings = ResolvedGovernorWindowSettings;
type ResolvedProfileSettings = ResolvedGovernorProfileSettings;

const resolveProfileSettings = resolveGovernorPolicy;

function claudeAccountKey(profileId?: string | null): string {
  if (typeof profileId === 'string') {
    const trimmed = profileId.trim();
    if (trimmed) return trimmed;
  }
  return DEFAULT_CLAUDE_PROFILE_KEY;
}

function profileIdFromKey(key: string): string | null {
  return key === DEFAULT_CLAUDE_PROFILE_KEY ? null : key;
}

function governorProfileState(profileId?: string | null): { mode: GovernorLevel; reason?: string } {
  return governorProfileStates.get(claudeAccountKey(profileId)) ?? { mode: 'green' };
}

/** Rate-limit usage is fed by LIVE Claude request hooks and is in-memory only, so
 *  a fresh app restart boots the governor GREEN until an agent makes a request —
 *  which never happens while everything is paused, leaving offload unable to fire.
 *  We persist the last-known window usage (global + per-profile) and reload it on
 *  beats with no live data, discarding any window already past its reset. */
function governorUsagePath(): string | null {
  const home = resolveHarnessHome();
  return home ? join(home, 'governor-usage.json') : null;
}
function persistGovernorUsage(u: GovernorUsage): void {
  const p = governorUsagePath();
  if (!p) return;
  const profiles = u.profiles && Object.keys(u.profiles).length > 0 ? u.profiles : undefined;
  const payload: GovernorUsage = {
    fiveHour: u.fiveHour ?? null,
    sevenDay: u.sevenDay ?? null,
    profiles
  };
  try { writeFileSync(p, JSON.stringify(payload)); } catch { /* best-effort */ }
}
function loadGovernorUsage(): GovernorUsage | null {
  const p = governorUsagePath();
  if (!p || !existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

    const normalizeWindow = (value: unknown): WindowUsage | null => {
      if (!value || typeof value !== 'object') return null;
      const record = value as Record<string, unknown>;
      const pct = Number(record.pct);
      const resetsAt = typeof record.resetsAt === 'string' ? record.resetsAt : '';
      if (!Number.isFinite(pct) || !resetsAt) return null;
      return { pct, resetsAt };
    };

    const fiveHour = normalizeWindow(raw.fiveHour);
    const sevenDay = normalizeWindow(raw.sevenDay);

    let profiles: GovernorUsageProfiles | undefined;
    if (raw.profiles && typeof raw.profiles === 'object') {
      const entries = Object.entries(raw.profiles as Record<string, unknown>);
      const acc: GovernorUsageProfiles = {};
      for (const [key, value] of entries) {
        if (typeof key !== 'string' || !key) continue;
        if (!value || typeof value !== 'object') continue;
        const item = value as Record<string, unknown>;
        const five = normalizeWindow(item.fiveHour);
        const seven = normalizeWindow(item.sevenDay);
        if (!five && !seven) continue;
        acc[key] = { fiveHour: five, sevenDay: seven };
      }
      if (Object.keys(acc).length > 0) profiles = acc;
    }

    if (!fiveHour && !sevenDay && !profiles) return null;
    return { fiveHour: fiveHour ?? null, sevenDay: sevenDay ?? null, profiles };
  } catch { return null; }
}

/** One governor beat: evaluate pace vs usage for both rate-limit windows, set the
 *  floor mode (GREEN/YELLOW/RED), pause/unblock Claude agents, and push the mode
 *  to the renderer for the StatusBar chip. 60s cadence (always-on). */
function runGovernorBeat(): void {
  if (!hive.enabled()) return;
  const cfg = readConfig();
  const policy = cfg.governorPolicy ?? {};
  if (policy.enabled === false) {
    if (governorMode !== 'green') {
      governorMode = 'green';
      recoverGovernorAgents();
      try { liveWebContents()?.send('hive:governorMode', { mode: 'green' }); } catch { /* */ }
    }
    return;
  }
  if (policy.manualOverride === 'force-green') {
    if (governorMode !== 'green') {
      governorMode = 'green';
      recoverGovernorAgents();
      try { liveWebContents()?.send('hive:governorMode', { mode: 'green', override: 'force-green' }); } catch { /* */ }
    }
    return;
  }

  const baselineSettings = resolveProfileSettings(policy, null);
  const recentMs = baselineSettings.recentAgentWindowMs;
  const allLimits = hookServer.allRateLimits();
  const now = Date.now();
  const limitEntries = Object.entries(allLimits);
  const reg = hive.registry();
  const runtimeProfiles = new Map((cfg.runtimeProfiles ?? []).map((p) => [p.id, p]));
  const profileSettingsCache = new Map<string, ResolvedProfileSettings>();
  profileSettingsCache.set(DEFAULT_CLAUDE_PROFILE_KEY, baselineSettings);

  const profileUsage = new Map<string, { settings: ResolvedProfileSettings; fiveHour: WindowUsage | null; sevenDay: WindowUsage | null }>();
  const profileCostUsage = new Map<string, { settings: ResolvedProfileSettings; usd: number }>();
  let maxFiveHour: WindowUsage | null = null;
  let maxSevenDay: WindowUsage | null = null;

  const getProfileSettings = (profileId: string | null): ResolvedProfileSettings => {
    const key = claudeAccountKey(profileId);
    let settings = profileSettingsCache.get(key);
    if (!settings) {
      settings = resolveProfileSettings(policy, profileId);
      profileSettingsCache.set(key, settings);
    }
    return settings;
  };

  for (const [agentId, entry] of limitEntries) {
    if (now - entry.ts > recentMs) continue;
    const meta = reg.agents?.[agentId];
    if (!meta) continue;
    const provider = (meta.provider as AgentProvider | undefined) ?? 'claude';
    if (!isClaudeProvider(provider)) continue;

    const settings = getProfileSettings(meta.profileId ?? null);
    if (!settings.enabled) continue;
    if (settings.mode === 'costCap') continue;
    if (settings.spawnGate.exemptAgents.has(agentId)) continue;

    const runtimeProfile = meta.profileId ? runtimeProfiles.get(meta.profileId) : undefined;
    const usageSample = telemetry.getAgentUsage(agentId);
    const modelSlug = usageSample?.model?.trim().toLowerCase() ?? runtimeProfile?.model?.trim().toLowerCase() ?? '';
    if (settings.spawnGate.governModels.length && (!modelSlug || !settings.spawnGate.governModels.includes(modelSlug))) continue;

    if (entry.fiveHour) {
      if (!maxFiveHour || entry.fiveHour.pct > maxFiveHour.pct) maxFiveHour = entry.fiveHour;
    }
    if (entry.sevenDay) {
      if (!maxSevenDay || entry.sevenDay.pct > maxSevenDay.pct) maxSevenDay = entry.sevenDay;
    }

    const key = claudeAccountKey(meta.profileId);
    let usageState = profileUsage.get(key);
    if (!usageState) {
      usageState = { settings, fiveHour: null, sevenDay: null };
      profileUsage.set(key, usageState);
    }
    if (entry.fiveHour && (!usageState.fiveHour || entry.fiveHour.pct > usageState.fiveHour.pct)) usageState.fiveHour = entry.fiveHour;
    if (entry.sevenDay && (!usageState.sevenDay || entry.sevenDay.pct > usageState.sevenDay.pct)) usageState.sevenDay = entry.sevenDay;
  }

  const saved = loadGovernorUsage();
  const reviveWindow = (usage: WindowUsage | null | undefined): WindowUsage | null => {
    if (!usage) return null;
    const resetMs = new Date(usage.resetsAt).getTime();
    if (!Number.isFinite(resetMs) || resetMs <= now) return null;
    return usage;
  };

  if (saved) {
    const savedFive = reviveWindow(saved.fiveHour);
    if (savedFive && (!maxFiveHour || savedFive.pct > maxFiveHour.pct)) maxFiveHour = savedFive;
    const savedSeven = reviveWindow(saved.sevenDay);
    if (savedSeven && (!maxSevenDay || savedSeven.pct > maxSevenDay.pct)) maxSevenDay = savedSeven;

    // Global fallback: the persisted fleet-wide window carries no profile
    // attribution, so it governs the DEFAULT bucket (no-profile spawns). This
    // keeps a cold start pacing default work until fresh per-profile samples
    // arrive; real per-profile buckets are seeded below and never inherit this.
    if (savedFive || savedSeven) {
      let dflt = profileUsage.get(DEFAULT_CLAUDE_PROFILE_KEY);
      if (!dflt) {
        dflt = { settings: baselineSettings, fiveHour: null, sevenDay: null };
        profileUsage.set(DEFAULT_CLAUDE_PROFILE_KEY, dflt);
      }
      if (savedFive && (!dflt.fiveHour || savedFive.pct > dflt.fiveHour.pct)) dflt.fiveHour = savedFive;
      if (savedSeven && (!dflt.sevenDay || savedSeven.pct > dflt.sevenDay.pct)) dflt.sevenDay = savedSeven;
    }

    if (saved.profiles) {
      for (const [key, value] of Object.entries(saved.profiles)) {
        const savedProfileFive = reviveWindow(value?.fiveHour);
        const savedProfileSeven = reviveWindow(value?.sevenDay);
        if (!savedProfileFive && !savedProfileSeven) continue;
        let usageState = profileUsage.get(key);
        if (!usageState) {
          usageState = { settings: getProfileSettings(profileIdFromKey(key)), fiveHour: null, sevenDay: null };
          profileUsage.set(key, usageState);
        }
        if (savedProfileFive && (!usageState.fiveHour || savedProfileFive.pct > usageState.fiveHour.pct)) usageState.fiveHour = savedProfileFive;
        if (savedProfileSeven && (!usageState.sevenDay || savedProfileSeven.pct > usageState.sevenDay.pct)) usageState.sevenDay = savedProfileSeven;
        if (savedProfileFive && (!maxFiveHour || savedProfileFive.pct > maxFiveHour.pct)) maxFiveHour = savedProfileFive;
        if (savedProfileSeven && (!maxSevenDay || savedProfileSeven.pct > maxSevenDay.pct)) maxSevenDay = savedProfileSeven;
      }
    }
  }

  for (const [agentId, meta] of Object.entries(reg.agents ?? {})) {
    if (!meta || meta.archived || meta.isOvermind) continue;
    const settings = getProfileSettings(meta.profileId ?? null);
    if (!settings.enabled) continue;
    if (settings.mode !== 'costCap') continue;
    if (settings.spawnGate.exemptAgents.has(agentId)) continue;
    const runtimeProfile = meta.profileId ? runtimeProfiles.get(meta.profileId) : undefined;
    const usageSample = telemetry.getAgentUsage(agentId);
    let modelSlug = runtimeProfile?.model?.trim().toLowerCase() ?? '';
    if (usageSample?.model) {
      const normalized = usageSample.model.trim().toLowerCase();
      if (normalized) modelSlug = normalized;
    }
    if (settings.spawnGate.governModels.length && (!modelSlug || !settings.spawnGate.governModels.includes(modelSlug))) continue;
    const key = claudeAccountKey(meta.profileId);
    let costState = profileCostUsage.get(key);
    if (!costState) {
      costState = { settings, usd: 0 };
      profileCostUsage.set(key, costState);
    }
    const usd = usageSample && Number.isFinite(usageSample.usd) ? usageSample.usd : 0;
    costState.usd += usd;
  }

  if (!maxFiveHour && !maxSevenDay && profileUsage.size === 0 && profileCostUsage.size === 0) return;

  const profilesToPersist: GovernorUsageProfiles = {};
  for (const [key, usageState] of profileUsage.entries()) {
    const five = usageState.fiveHour;
    const seven = usageState.sevenDay;
    if (!five && !seven) continue;
    profilesToPersist[key] = {
      fiveHour: five ? { pct: five.pct, resetsAt: five.resetsAt } : null,
      sevenDay: seven ? { pct: seven.pct, resetsAt: seven.resetsAt } : null
    };
  }

  persistGovernorUsage({
    fiveHour: maxFiveHour ?? null,
    sevenDay: maxSevenDay ?? null,
    profiles: Object.keys(profilesToPersist).length > 0 ? profilesToPersist : undefined
  });

  const evaluateWindowUsage = (usage: WindowUsage, windowMs: number, threshold: ResolvedWindowSettings): { level: GovernorLevel; reason: string } => {
    if (!threshold.enabled) return { level: 'green', reason: 'window disabled' };
    const resetMs = new Date(usage.resetsAt).getTime();
    if (!Number.isFinite(resetMs)) return { level: 'green', reason: 'invalid reset timestamp' };
    const windowStart = resetMs - windowMs;
    const elapsed = Math.max(0, Math.min(100, ((now - windowStart) / windowMs) * 100));
    const absolute = threshold.absoluteBackstopPct ?? DEFAULT_GOVERNOR_ABSOLUTE_BACKSTOP;

    if (threshold.tripMode !== 'pace-only' && usage.pct >= absolute) {
      return { level: 'red', reason: `usage ${usage.pct.toFixed(1)}% >= cap ${absolute}%` };
    }
    if (threshold.tripMode === 'absolute-only') {
      return { level: 'green', reason: `usage ${usage.pct.toFixed(1)}% < cap ${absolute}%` };
    }
    const floor = threshold.earlyWindowFloorPct ?? DEFAULT_GOVERNOR_EARLY_FLOOR;
    if (usage.pct < floor) {
      return { level: 'green', reason: `usage ${usage.pct.toFixed(1)}% < floor ${floor}%` };
    }
    const paceMargin = threshold.paceMarginPts ?? DEFAULT_GOVERNOR_PACE_MARGIN;
    const yellowMargin = threshold.yellowMarginPts ?? DEFAULT_GOVERNOR_YELLOW_MARGIN;
    if (usage.pct >= elapsed + paceMargin) {
      return { level: 'red', reason: `usage ${usage.pct.toFixed(1)}% >= pace ${elapsed.toFixed(1)}% (+${paceMargin}pt margin)` };
    }
    if (usage.pct >= elapsed + paceMargin - yellowMargin) {
      return { level: 'yellow', reason: `usage ${usage.pct.toFixed(1)}% approaching pace ${elapsed.toFixed(1)}%` };
    }
    return { level: 'green', reason: `usage ${usage.pct.toFixed(1)}% < pace ${elapsed.toFixed(1)}%` };
  };

  const evaluateCostCap = (usd: number, cap: number | null): { level: GovernorLevel; reason: string } => {
    if (cap == null || !Number.isFinite(cap) || cap <= 0) {
      return { level: 'green', reason: 'cost cap disabled' };
    }
    const spend = Number.isFinite(usd) ? Math.max(0, usd) : 0;
    if (spend >= cap) {
      return { level: 'red', reason: `cost $${spend.toFixed(2)} >= cap $${cap.toFixed(2)}` };
    }
    if (spend >= cap * 0.8) {
      return { level: 'yellow', reason: `cost $${spend.toFixed(2)} nearing cap $${cap.toFixed(2)}` };
    }
    return { level: 'green', reason: `cost $${spend.toFixed(2)} < cap $${cap.toFixed(2)}` };
  };

  const fiveEval = maxFiveHour ? evaluateWindowUsage(maxFiveHour, WINDOW_5H_MS, baselineSettings.windows.fiveHour) : null;
  const sevenEval = maxSevenDay ? evaluateWindowUsage(maxSevenDay, WINDOW_7D_MS, baselineSettings.windows.sevenDay) : null;

  const rank = (l: GovernorLevel | undefined) => l === 'red' ? 2 : l === 'yellow' ? 1 : 0;

  const profileStates = new Map<string, { level: GovernorLevel; reason: string }>();
  const redProfiles: string[] = [];
  const profileAutoOffloadConfigs: Record<string, AutoOffloadConfig> = {};

  for (const [key, usageState] of profileUsage.entries()) {
    const settings = usageState.settings;
    const fiveState = usageState.fiveHour ? evaluateWindowUsage(usageState.fiveHour, WINDOW_5H_MS, settings.windows.fiveHour) : null;
    const sevenState = usageState.sevenDay ? evaluateWindowUsage(usageState.sevenDay, WINDOW_7D_MS, settings.windows.sevenDay) : null;
    let best = fiveState;
    if (!best || (sevenState && rank(sevenState.level) > rank(best.level))) best = sevenState;
    if (!best) continue;
    profileStates.set(key, { level: best.level, reason: best.reason });
    if (settings.autoOffloadMerged) profileAutoOffloadConfigs[key] = settings.autoOffloadMerged;
    if (best.level === 'red') redProfiles.push(key);
  }

  for (const [key, costState] of profileCostUsage.entries()) {
    const { settings, usd } = costState;
    const evaluation = evaluateCostCap(usd, settings.costCapUsd);
    profileStates.set(key, { level: evaluation.level, reason: evaluation.reason });
    if (settings.autoOffloadMerged) profileAutoOffloadConfigs[key] = settings.autoOffloadMerged;
    if (evaluation.level === 'red' && !redProfiles.includes(key)) redProfiles.push(key);
  }

  governorProfileStates.clear();
  for (const [key, value] of profileStates.entries()) {
    if (value.level === 'green') continue;
    governorProfileStates.set(key, { mode: value.level, reason: value.reason });
  }

  // Floor mode = the worst per-profile state, where each profile was evaluated
  // against its OWN window overrides, never a cross-profile aggregate. A profile
  // tripping its own cap must not drag an unrelated, well-under-cap profile into
  // RED. The DEFAULT bucket holds the global fallback for no-profile usage and
  // is ranked here alongside the real profiles.
  let newMode: GovernorLevel = 'green';
  let reason = 'all clear';
  for (const [key, value] of profileStates.entries()) {
    if (rank(value.level) <= rank(newMode)) continue;
    newMode = value.level;
    const label = key === DEFAULT_CLAUDE_PROFILE_KEY ? 'default' : (runtimeProfiles.get(key)?.name ?? key);
    reason = `${label}: ${value.reason}`;
  }

  const prevMode = governorMode;
  governorMode = newMode;

  if (newMode === 'red') {
    const redSet = new Set(redProfiles);
    if (prevMode !== 'red') {
      for (const [id, a] of Object.entries(reg.agents)) {
        if (a.archived || a.isOvermind) continue;
        const settings = getProfileSettings(a.profileId ?? null);
        if (!settings.enabled) continue;
        if (settings.spawnGate.exemptAgents.has(id)) continue;
        if (!redSet.has(claudeAccountKey(a.profileId))) continue;
        const provider = inferAgentProvider(a.command, a.provider ?? undefined);
        if (settings.mode === 'windows' && !isClaudeProvider(provider)) continue;
        const runtimeProfile = a.profileId ? runtimeProfiles.get(a.profileId) : undefined;
        const usageSample = telemetry.getAgentUsage(id);
        let modelSlug = runtimeProfile?.model?.trim().toLowerCase() ?? '';
        if (usageSample?.model) {
          const normalized = usageSample.model.trim().toLowerCase();
          if (normalized) modelSlug = normalized;
        }
        if (settings.spawnGate.governModels.length && (!modelSlug || !settings.spawnGate.governModels.includes(modelSlug))) continue;
        if (!ptyForAgent(id)) continue;
        try { control.pause(id, true); governorPausedAgents.add(id); } catch { /* */ }
      }
      hive.send({
        to: 'god',
        act: 'inform',
        subject: 'Usage governor: RED — degrading to budget',
        body: `Rate-limit pace exceeded (${reason}). Claude agents paused; new Claude spawns blocked. Route new work to delegate/edgentic until the window resets.`
      }, 'system');
      console.log('[governor] RED:', reason);
    }
    void attemptGovernorOffloads({
      policy: baselineSettings.autoOffloadMerged,
      hiveRoot: hive.root(),
      redProfiles,
      profileConfigs: Object.keys(profileAutoOffloadConfigs).length ? profileAutoOffloadConfigs : undefined
    });
  } else {
    if (prevMode === 'red') {
      recoverGovernorAgents();
      console.log('[governor] recovered to', newMode);
    }
  }

  try {
    const profilesPayload = Array.from(profileSettingsCache.entries()).map(([profileId, _settings]) => {
      const state = profileStates.get(profileId);
      return {
        profileId,
        mode: state?.level ?? 'green',
        reason: state?.reason ?? 'all clear'
      };
    });
    const broadcast: GovernorBroadcastPayload = {
      mode: newMode,
      reason,
      fiveHour: maxFiveHour ? { pct: maxFiveHour.pct, resetsAt: maxFiveHour.resetsAt, ...(fiveEval ?? {}) } : null,
      sevenDay: maxSevenDay ? { pct: maxSevenDay.pct, resetsAt: maxSevenDay.resetsAt, ...(sevenEval ?? {}) } : null,
      profiles: profilesPayload,
      override: policy.manualOverride === 'force-green' ? 'force-green' : undefined,
      pausedAgents: [...governorPausedAgents]
    };
    governorLastPayload = broadcast;
    liveWebContents()?.send('hive:governorMode', broadcast);
  } catch { /* window gone */ }
}
function recoverGovernorAgents(): void {
  for (const id of governorPausedAgents) {
    try { control.pause(id, false); } catch { /* */ }
  }
  governorPausedAgents.clear();
}

function armAlwaysOnBeats(): void {
  if (fleetTimer) clearInterval(fleetTimer);
  writeFleetSnapshot();
  fleetTimer = setInterval(writeFleetSnapshot, 3_000);
  if (breakerBeatTimer) clearInterval(breakerBeatTimer);
  breakerBeatTimer = setInterval(() => { try { runBreakerBeat(300_000); } catch (e) { console.error('[breaker beat]', e); } }, 30_000);
  if (governorBeatTimer) clearInterval(governorBeatTimer);
  governorBeatTimer = setInterval(() => { try { runGovernorBeat(); } catch (e) { console.error('[governor beat]', e); } }, 60_000);
  if (workerWakeTimer) clearInterval(workerWakeTimer);
  workerWakeTimer = setInterval(() => { try { runWorkerWakeBeat(); } catch (e) { console.error('[worker-wake beat]', e); } }, WORKER_WAKE_POLL_MS);
  runWorkerWakeBeat(); // catch-up on arm — power-resume re-arms and drains the backlog
  if (lockHeartbeatTimer) clearInterval(lockHeartbeatTimer);
  lockHeartbeatTimer = setInterval(() => {
    try { const r = hive.root(); if (r) syncLock.heartbeat(r, app.getVersion()); } catch (e) { console.error('[sync-lock beat]', e); }
  }, 60_000);
}

/** Wall-clock instant we last observed the machine suspend or lock, so a resume
 *  can report how long we were out. Best-effort context for the renderer follow-on
 *  (auto-revive); null until the first suspend/lock of the session. */
let lastSuspendAt: number | null = null;
/** Single pending post-resume PTY health check, so overlapping resume+unlock
 *  events collapse to ONE check (the latest) instead of stacking. */
let resumeHealthTimer: NodeJS.Timeout | null = null;

/** After the machine wakes, probe each live PTY for liveness and surface any that
 *  didn't survive. macOS can wedge a child `claude` process/socket across a long
 *  sleep while node-pty still holds the fd (its exit event never fired) — so a
 *  dead PTY can linger in our list. `process.kill(pid, 0)` is a pure existence
 *  probe (signal 0 never touches the process); ESRCH means the process is gone.
 *  We only LOG + NOTIFY here (no auto-kill/respawn — true revive is renderer-owned
 *  via pty:spawn) and emit `power:resume` as the integration point for the
 *  follow-on renderer auto-revive card. */
function healthCheckPtys(reason: string, awayMs: number | null): void {
  const ptys = ptyManager.list();
  const dead: string[] = [];
  for (const p of ptys) {
    if (typeof p.pid === 'number' && p.pid > 0) {
      try { process.kill(p.pid, 0); }   // liveness probe only — never kills
      catch { dead.push(p.id); }        // ESRCH: process gone but PTY still registered
    }
  }
  const away = awayMs != null ? ` (away ~${Math.round(awayMs / 1000)}s)` : '';
  if (dead.length) {
    console.warn(`[power] ${reason}${away}: ${dead.length}/${ptys.length} PTY(s) look wedged (process gone):`, dead.join(', '));
    breakerToast('Agents need a restart', `${dead.length} agent terminal(s) didn't survive sleep — re-open them to resume.`);
  } else {
    console.log(`[power] ${reason}${away}: ${ptys.length} PTY(s) healthy`);
  }
  // Single integration point for the (separate) renderer auto-revive card: it can
  // listen for 'power:resume' and respawn the `dead` PTYs with --resume.
  try { liveWebContents()?.send('power:resume', { reason, awayMs, dead, total: ptys.length }); } catch { /* window gone */ }
}

/** Re-arm everything that runs on a frozen libuv timer after the machine slept,
 *  and surface any PTY that didn't survive. macOS pauses setTimeout/setInterval
 *  during true system sleep (the monotonic clock halts) — on wake they resume
 *  where they paused, shifted by the whole sleep, so missions due during sleep
 *  never fired and never replay. We rebuild the scheduler (syncMissions reuses its
 *  remaining=max(0,…) semantics → each overdue mission fires exactly ONCE then
 *  re-settles, never N replays), re-arm the always-on beats, re-evaluate the
 *  power blocker, then — after a short grace for PTYs to wake their pipes —
 *  health-check the terminals. Idempotent: overlapping resume+unlock events
 *  collapse safely (clear-then-arm everywhere; at most one catch-up fire). */
function onSystemResume(reason: string): void {
  console.log(`[power] ${reason} — re-arming scheduler, beats, router, keep-awake`);
  try { syncMissions(); } catch (e) { console.error('[power] syncMissions on resume', e); }
  // Same freeze, same catch-up: the context timers honour elapsed-time-since-last-
  // run, so a compact/clear that came due while the machine slept fires ONCE here
  // rather than being lost or replayed N times.
  try { syncContextTriggers(); } catch (e) { console.error('[power] syncContextTriggers on resume', e); }
  try { armAlwaysOnBeats(); } catch (e) { console.error('[power] armAlwaysOnBeats on resume', e); }
  // The hive message router (outbox→inbox drain) is a setInterval that freezes
  // during true system sleep exactly like the beats above — but it was the one
  // always-on timer never re-armed on wake. Symptom: after a long sleep the
  // scheduler→god path recovered (it injects straight into god's inbox), while
  // every agent's outbox silently stopped draining, so god→worker and
  // worker↔worker mail piled up undelivered. Re-arm the poll loop (clear-then-set,
  // idempotent) and immediately drain the backlog that accrued while we were out
  // instead of waiting for the first post-wake tick. The renderer's idle inbox-wake
  // nudge (useHive.ts) then wakes each parked recipient once its mail lands.
  try {
    hive.stopRouter();
    hive.startRouter();
    const drained = hive.routeOnce();
    if (drained > 0) console.log(`[power] ${reason} — flushed ${drained} queued hive message(s)`);
  } catch (e) { console.error('[power] router re-arm on resume', e); }
  try { syncKeepAwake(); } catch (e) { console.error('[power] syncKeepAwake on resume', e); }
  const awayMs = lastSuspendAt != null ? Date.now() - lastSuspendAt : null;
  // Give PTYs a beat to resume their pipes before judging them wedged; reset any
  // pending check so a resume quickly followed by unlock runs the probe just once.
  if (resumeHealthTimer) clearTimeout(resumeHealthTimer);
  resumeHealthTimer = setTimeout(() => {
    resumeHealthTimer = null;
    healthCheckPtys(reason, awayMs);
  }, 15_000);
}

// On a Wayland desktop (COSMIC, GNOME, KDE, and WSLg) Electron defaults to
// XWayland, which on several compositors gives a window that paints but
// mishandles pointer input and GPU vsync — dead clicks, and crashes once input
// does land. The fix is the native Wayland Ozone backend: 'auto' selects it when
// a Wayland socket is present and falls back to X11 otherwise, so it is safe on
// pure-X11 sessions too. This keeps the real GPU on (disabling it forces
// SwiftShader, which is what actually crashed on click). Must run before ready.
// Escape hatches: THEHIVE_OZONE=x11 to force XWayland; THEHIVE_DISABLE_GPU=1 to
// fall back to CPU rendering if a specific GPU driver misbehaves.
if (process.platform === 'linux' && !app.commandLine.hasSwitch('ozone-platform-hint')) {
  // 'auto' is meant to pick Wayland when available, but on COSMIC it falls back
  // to XWayland (the broken path — verified: 'auto' logs the vsync failure,
  // explicit 'wayland' does not). So force 'wayland' whenever a Wayland session
  // is present, and let 'auto' handle pure-X11 sessions. THEHIVE_OZONE overrides.
  const hint = process.env.THEHIVE_OZONE || (process.env.WAYLAND_DISPLAY ? 'wayland' : 'auto');
  app.commandLine.appendSwitch('ozone-platform-hint', hint);
}
if (process.env.THEHIVE_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

app.whenReady().then(() => {
  // Realtime Abathur mic-gate hygiene (rt-8 / Pam rt-10 nit): the voice session
  // opens the mic permission gate by persisting realtimeVoiceEnabled=true and
  // closes it on disconnect — but a hard crash/reload mid-session skips that
  // teardown, leaving the flag stuck true so the gate would boot PRE-OPEN with no
  // live session. Force it closed at startup (a real session re-opens it via
  // setMicGate(true)); macOS TCC stays a second gate regardless.
  if (readConfig().realtimeVoiceEnabled) writeConfig({ realtimeVoiceEnabled: false });

  // Anonymous product analytics (PostHog) — the full contract lives in
  // TELEMETRY.md. No-op unless a build-time key was injected (official releases
  // only), and gated on DO_NOT_TRACK + the telemetryEnabled config (opt-out).
  analytics.init({
    stateDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    enabled: readConfig().telemetryEnabled !== false
  });

  // A cold-start deep link (Windows/Linux) rides in on OUR argv.
  const startupHireLink = process.argv.find((a) => a.startsWith('thehive://'));
  if (startupHireLink) void handleHireLink(startupHireLink);

  // Hand every spawned agent the path to the Slack reply discovery file via the
  // inherited env (pty merges process.env). The path is stable whether or not the
  // server is running; the FILE only exists while it is, so the helper degrades
  // to "endpoint not running" cleanly. NO secret is in the env — only the path.
  process.env.MD_SLACK_REPLY_CONFIG = slackReplyConfigPath();
  // Open the durable store first — createWindow() reads the saved window bounds.
  // Guarded: a DB failure (e.g. a bad native build) must degrade to defaults,
  // never block app startup.
  try { persist.open(); } catch (e) { console.error('[db] open failed:', e); }
  // Auto-update from GitHub releases (packaged builds only; gated on the
  // `autoUpdate` config flag). Download-in-background + restart-to-apply toast;
  // never restarts on its own. Falls back to a notify-only releases/latest
  // check where native updating isn't possible (win-portable, dev-ish builds).
  initAutoUpdater(() => liveWebContents());
  // Device-sync: pull the hive from its remote BEFORE bootstrap (inert unless a
  // remote is configured). Fast-forward only; a foreign live lock or a non-ff
  // divergence is surfaced to the renderer. We still bootstrap afterwards so this
  // path — which is off by default and untested at runtime here — can never brick
  // the app; the single-instance lock and the advisory-lock warnings remain the
  // guardrails, and a hard-refuse is a gated follow-up once the UX is validated.
  try {
    const hr = hive.root();
    if (hr) {
      const res = sync.syncOnStart(hr);
      if (!res.ok) console.error('[sync] start pull:', res.error);
      if (res.blocked) {
        console.warn(`[sync] hive appears active on ${res.blocked.host} (device ${res.blocked.device})`);
        try { liveWebContents()?.send('sync:foreignActive', res.blocked); } catch { /* window not up yet */ }
      }
    }
  } catch (e) { console.error('[sync] syncOnStart:', e); }
  // Bootstrap the hive (if harnessHome is configured) and start the message router.
  bootstrapHiveServices();
  // Survive sleep/lock. macOS freezes libuv timers during true system sleep, so a
  // locked/idle/slept Mac stops firing schedules and can wedge PTYs. On wake we
  // re-arm the scheduler (catching up missed missions ONCE) + beats + keep-awake,
  // then health-check terminals. App-lifetime listeners — powerMonitor outlives
  // every window, so there is nothing to tear down on quit.
  powerMonitor.on('resume', () => onSystemResume('resume'));
  powerMonitor.on('unlock-screen', () => onSystemResume('unlock-screen'));
  powerMonitor.on('suspend', () => { lastSuspendAt = Date.now(); console.log('[power] suspend — system sleeping'); });
  powerMonitor.on('lock-screen', () => { lastSuspendAt = Date.now(); console.log('[power] lock-screen'); });
  // Multi-window floors (opt-in): install the menu carrying "New Floor". When
  // off, the app keeps Electron's default menu — zero behavior change.
  if (readConfig().multiWindow) installAppMenu();
  createWindow();
  // Auto-start the Slack webhook server when configured. Best-effort: a tunnel
  // failure (offline) is logged, not fatal. The tunnel URL is ephemeral and
  // changes per restart, so the user re-pastes it via Settings → Start.
  const slackCfg = readConfig();
  if (slackCfg.slackEnabled && slackCfg.slackSigningSecret) {
    void startSlackServer().then((r) => {
      if (!r.ok) console.error('[slack] auto-start failed:', r.error);
      else console.log('[slack] webhook listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  // Auto-start the generic webhook only for endpoints the user has explicitly
  // enabled (each with its own secret) — never a default-on public surface.
  // Opt-in, like Slack; an install with no enabled endpoint opens no tunnel.
  if (enabledWebhookEndpoints().length > 0) {
    void startWebhookServer().then((r) => {
      if (!r.ok) console.error('[webhook] auto-start failed:', r.error);
      else console.log('[webhook] listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  // Mobile API secret & background HTTP server startup (bound on 0.0.0.0:48003 for Tailscale)
  const mobileSecret = ensureMobileApiSecret();
  console.log('[mobile-api] secret:', mobileSecret);
  void ensureBrowserServer().catch((err) => console.error('[browser-server] auto-start failed:', err));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Diagnostics: a GPU/utility helper dying (common on broken graphics stacks)
// takes the window with it, which then trips window-all-closed → quit. Log the
// culprit so a "quits the moment I click" report has a concrete reason.
app.on('child-process-gone', (_e, d) => {
  console.error('[child-process-gone]', d.type, d.reason, 'exitCode=', d.exitCode, d.name ?? '');
});

// before-quit covers Cmd-Q / dock-quit; the per-window close handler covers
// the red close button. Both routes hit the same warning UX.
app.on('before-quit', (e) => {
  if (allowQuit) return;
  const count = ptyManager.list().length;
  if (count === 0) {
    allowQuit = true;
    return;
  }
  e.preventDefault();
  if (!saveStatePending) {
    saveStatePending = true;
    broadcastSaveStateToActiveAgents();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      mainWindow.webContents.send('app:closeRequested', { ptyCount: count });
    }
    setTimeout(() => {
      allowQuit = true;
      teardownAndQuit();
    }, 8000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Full teardown, not a bare killAll: this path must also stop the proxy
    // sidecars and helper servers — on Windows a child is NOT killed when its
    // parent exits, so anything skipped here outlives the app.
    teardownAndQuit();
  }
});

// Final analytics flush (session_ended + drain the send queue), bounded so a
// hung network can never wedge quit: preventDefault ONCE, race the flush
// against a short timeout, then exit hard.
//
// finish MUST be app.exit(), not a re-entrant app.quit(): when the quit was
// initiated while a window was still open (the "kill all & quit" confirm path
// calls teardownAndQuit → app.quit() and the window closes DURING that quit),
// Electron is left with its internal is-quitting state set after this
// preventDefault, and the later app.quit() is silently a no-op — no before-quit,
// no will-quit, no quit; the main process idles forever with zero windows. On
// Windows that stranded the whole Electron process group (main + GPU + network
// service) after every agents-running quit. By this point teardown has already
// run and the flush has finished or timed out, so an unconditional exit is
// exactly what's left to do.
let analyticsFlushed = false;
app.on('will-quit', (e) => {
  if (analyticsFlushed) return;
  analyticsFlushed = true;
  e.preventDefault();
  const finish = (): void => app.exit(0);
  Promise.race([
    analytics.endSession(),
    new Promise<void>((r) => setTimeout(r, 1200))
  ]).then(finish, finish);
});






