/**
 * HookServer — the bridge between `claude` lifecycle hooks and the harness.
 *
 * Each spawned agent is launched with `--settings` pointing its hooks at a tiny
 * shim (see HOOK_SHIM in hive.ts) that forwards the hook payload to the Unix
 * domain socket this server listens on. We then:
 *   - drive avatar state from PreToolUse/PostToolUse/Notification/etc., and
 *   - report lifecycle boundaries while renderer-side guarded queues deliver
 *     inbox work only after the session reaches a safe idle prompt.
 *
 * Runs in the Electron main process.
 */
import { createServer, type Server } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { Notification, type WebContents } from 'electron';
import { showFocusNotification } from './notify';
import type { HiveManager } from './hive';
import type { HarnessConfig } from './config';
import type { ControlRegistry } from './control';
import type { CircuitBreaker } from './breaker';
import { estimateCostUsd } from './pricing';

interface HookPayload {
  hook_event_name?: string;
  agent_id?: string | null;
  session_id?: string;
  transcript_path?: string;
  /** Status-line payloads only: the session's live context accounting. */
  context_window?: { total_input_tokens?: number; context_window_size?: number };
  /** Status-line payloads only: per-account rate-limit windows from CC.
   *  CC sends resets_at as a Unix epoch SECONDS integer, not an ISO string. */
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number | string };
    seven_day?:  { used_percentage?: number; resets_at?: number | string };
  };
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  /** Present on PreToolUse/PostToolUse in current Claude Code builds; absent on
   *  older ones and on the agy/grok/gemini shims. Used only to pair a subagent's
   *  start with its stop — see subagentQueue below. */
  tool_use_id?: string;
  stop_hook_active?: boolean;
  prompt?: string;
  source?: string;
  notification_type?: string;
  /** Notification hook text, e.g. "Claude is waiting for your input" (idle) vs a
   *  permission request. Used to tell "needs you" from "just done / lingering". */
  message?: string;
  /** CostSample payloads carry a flat model id (string), fed to the cost ledger.
   *  Status payloads carry Claude Code's statusline model object ({ id }). */
  model?: string | { id?: string; display_name?: string };
  provider?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_creation?: number;
}

export type TouchedVerb = 'create' | 'write' | 'edit' | 'delete';

export interface TouchedLedgerEntry {
  path: string;
  verb: TouchedVerb;
  ts: string;
  insideRepo: boolean;
  relativePath?: string;
}

const MAX_TOUCHED_ENTRIES = 200;

export class HookServer {
  private server: Server | null = null;
  /** agentId → the live session's transcript file, learned from hook payloads.
   *  Lets the harness read per-agent telemetry (e.g. current context size)
   *  even when several agents share one cwd. */
  private transcriptPaths = new Map<string, string>();
  /** agentId → the latest context-window accounting from the statusLine shim
   *  (current tokens + the REAL window size — 200k vs 1M, which nothing else
   *  exposes). The renderer already gets this pushed live on `hive:contextUpdate`;
   *  we also retain the last value here so a main-side read (the voice read-layer's
   *  get_agent_detail / list_agents) can report "how full is each agent's context"
   *  without depending on a renderer round-trip. */
  private contextById = new Map<string, { tokens: number; limit: number; ts: number }>();
  private rateLimitsById = new Map<string, {
    fiveHour: { pct: number; resetsAt: string } | null;
    sevenDay:  { pct: number; resetsAt: string } | null;
    ts: number;
  }>();
  /** agentId → total tool call count for this session (circuit breaker enforcement). */
  private toolCallCounts = new Map<string, number>();
  /** agentId → the tool call count at which we last sent a warning (rate-limit warnings). */
  private lastWarningAt = new Map<string, number>();
  /** agentId → last tool executed (for descriptive idle notifications). */
  private lastToolById = new Map<string, string>();
  /** agentId → last model id seen on the statusline; dedupes hive:modelUpdate so
   *  the store is written only when a manual /model change actually flips it. */
  private lastModelById = new Map<string, string>();
  /** agentId → most recent touched-ledger entries (bounded) */
  private touchedLedgerById = new Map<string, TouchedLedgerEntry[]>();
  /** agentIds whose touched-ledger file has been loaded into memory */
  private touchedLoaded = new Set<string>();
  /** agentId → ids of its currently in-flight Agent-tool (subagent) calls,
   *  oldest first. Used to pair a PostToolUse stop with its PreToolUse start
   *  when the payload carries no `tool_use_id` (FIFO best-effort). */
  private openSubagentsByAgent = new Map<string, string[]>();

  constructor(
    private hive: HiveManager,
    private getWebContents: () => WebContents | null,
    private getConfig: () => HarnessConfig,
    /** #7C — operator control state. Optional so tests can omit it. */
    private control?: ControlRegistry,
    /** Circuit breaker (Lane A #6.6b) — fed the hook-derived signals (session id,
     *  repeated identical tool calls). Optional so the server still runs without it. */
    private breaker?: CircuitBreaker,
    /** Standing goal text for an agent (from the durable roster). Optional so
     *  tests can omit it; when set, injected on SessionStart / UserPromptSubmit. */
    private getStandingGoal?: (agentId: string) => string | null,
    /** Optional observer of every hook boundary (agentId, event, message). The
     *  worker inbox-wake watchdog (workerWake.ts) feeds on this to learn when an
     *  agent is parked on a permission/HITL prompt so it never types into it. */
    private onEvent?: (agentId: string | undefined, event: string, message: string | undefined) => void,
    /** Optional observer for when an agent enters rate-limit overage / extra usage. */
    private onOverage?: (agentId: string) => void
  ) {}

  start(): void {
    const sock = this.hive.sockPath();
    if (!sock || this.server) return;
    // Clear a stale socket file left by a previous run.
    try { if (existsSync(sock)) rmSync(sock); } catch { /* noop */ }

    this.server = createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl === -1) return; // wait for the full line
        let payload: HookPayload = {};
        try { payload = JSON.parse(buf.slice(0, nl)); } catch { /* ignore */ }
        let res: unknown = {};
        try { res = this.handle(payload); } catch { res = {}; }
        conn.end(JSON.stringify(res ?? {}));
      });
      conn.on('error', () => { /* shim hung up — ignore */ });
    });
    this.server.on('error', (e) => console.error('[hive] hook server error:', e));
    this.server.listen(sock);
  }

  stop(): void {
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    const sock = this.hive.sockPath();
    try { if (sock && existsSync(sock)) rmSync(sock); } catch { /* noop */ }
  }

  /** The transcript file of an agent's CURRENT session, if any hook has fired. */
  transcriptPath(agentId: string): string | undefined {
    return this.transcriptPaths.get(agentId);
  }

  /** The latest context-window accounting for an agent (current tokens + the real
   *  window size), or undefined if no statusLine tick has fired for it yet. */
  contextFor(agentId: string): { tokens: number; limit: number; ts: number } | undefined {
    return this.contextById.get(agentId);
  }

  touchedLedger(agentId: string): TouchedLedgerEntry[] {
    const list = this.loadTouchedLedger(agentId);
    return [...list].sort((a, b) => (a.ts < b.ts ? 1 : (a.ts > b.ts ? -1 : 0)));
  }

  /** All agents' most-recent rate-limit entries, keyed by agent id. */
  allRateLimits(): Record<string, { fiveHour: { pct: number; resetsAt: string } | null; sevenDay: { pct: number; resetsAt: string } | null; ts: number }> {
    return Object.fromEntries(this.rateLimitsById.entries());
  }

  /** Clear tool call counter for an agent (called on spawn/archive). */
  clearToolCallCount(agentId: string): void {
    this.toolCallCounts.delete(agentId);
    this.lastWarningAt.delete(agentId);
    this.lastModelById.delete(agentId);
  }

  private handle(p: HookPayload): unknown {
    const agentId = p.agent_id ?? undefined;
    const event = p.hook_event_name ?? 'Unknown';
    this.onEvent?.(agentId, event, p.message);
    if (agentId && typeof p.transcript_path === 'string' && p.transcript_path) {
      this.transcriptPaths.set(agentId, p.transcript_path);
    }

    // Subagents spawned via the Agent tool run inside the parent's own session
    // (no separate PTY/registry entry), so the roster's only signal that one
    // exists at all is this PreToolUse/PostToolUse pair. Tracked ahead of every
    // early-return branch below so a denied or steered turn never loses the
    // matching stop.
    if (agentId && p.tool_name === 'Agent') {
      if (event === 'PreToolUse') {
        const input = (p.tool_input && typeof p.tool_input === 'object' ? p.tool_input as Record<string, unknown> : {});
        const label = (typeof input.description === 'string' && input.description.trim())
          || (typeof input.subagent_type === 'string' && input.subagent_type.trim())
          || 'subagent';
        const id = typeof p.tool_use_id === 'string' && p.tool_use_id ? p.tool_use_id : `${agentId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const queue = this.openSubagentsByAgent.get(agentId) ?? [];
        queue.push(id);
        this.openSubagentsByAgent.set(agentId, queue);
        this.getWebContents()?.send('hive:subagentStart', { parentId: agentId, id, label });
      } else if (event === 'PostToolUse') {
        const queue = this.openSubagentsByAgent.get(agentId) ?? [];
        const id = (typeof p.tool_use_id === 'string' && p.tool_use_id && queue.includes(p.tool_use_id))
          ? p.tool_use_id
          : queue.shift();
        if (id !== undefined) {
          const idx = queue.indexOf(id);
          if (idx !== -1) queue.splice(idx, 1);
          this.openSubagentsByAgent.set(agentId, queue);
          this.getWebContents()?.send('hive:subagentStop', { parentId: agentId, id });
        }
      }
    }

    // Status-line payloads carry the session's EXACT context accounting —
    // current tokens AND the real window size (200k vs 1M, which nothing else
    // exposes). Forward to the renderer for the agent-card context gauge.
    // Handled FIRST and returned early: this is pure telemetry from the
    // statusLine shim, not a real hook boundary — it must never trip the
    // HALT gate or feed the breaker's loop detector below. The early return
    // also (deliberately) skips recordSession for status ticks: a statusLine
    // payload's session_id adds nothing the real hooks don't already record,
    // and telemetry should never write to the registry. transcript_path IS
    // still captured above, where every payload shape benefits from it.
    if (event === 'Status') {
      const cw = p.context_window;
      if (agentId && cw && typeof cw.total_input_tokens === 'number'
        && typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
        // Retain for main-side reads (voice get_agent_detail / list_agents) …
        this.contextById.set(agentId, {
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size,
          ts: Date.now()
        });
        // … and forward live to the renderer's agent-card context gauge.
        this.getWebContents()?.send('hive:contextUpdate', {
          agentId,
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size
        });
      }
      // Persist rate_limits for the 5h/7d pace meters in the status bar.
      // CC sends resets_at as a Unix epoch SECONDS integer (not an ISO string);
      // convert at the boundary so downstream renderer code stays string-typed.
      const rl = p.rate_limits;
      if (agentId && rl) {
        const toIso = (v: unknown): string | null => {
          if (typeof v === 'string' && v) return v;
          if (typeof v === 'number' && v > 0) return new Date(v * 1000).toISOString();
          return null;
        };
        const fhRaw = rl.five_hour;
        const fiveHour = fhRaw && typeof fhRaw.used_percentage === 'number'
          ? (() => { const iso = toIso(fhRaw.resets_at); return iso ? { pct: fhRaw.used_percentage as number, resetsAt: iso } : null; })()
          : null;
        const sdRaw = rl.seven_day;
        const sevenDay = sdRaw && typeof sdRaw.used_percentage === 'number'
          ? (() => { const iso = toIso(sdRaw.resets_at); return iso ? { pct: sdRaw.used_percentage as number, resetsAt: iso } : null; })()
          : null;
        const entry = { fiveHour, sevenDay, ts: Date.now() };
        this.rateLimitsById.set(agentId, entry);
        this.getWebContents()?.send('hive:rateLimitsUpdate', { agentId, ...entry });

        const isOverage = Boolean(
          (p as unknown as { is_overage?: boolean }).is_overage ||
          (typeof (p as unknown as { extra_usage?: unknown }).extra_usage === 'boolean' && (p as unknown as { extra_usage?: boolean }).extra_usage) ||
          (typeof (p as unknown as { extra_usage?: { is_active?: boolean } }).extra_usage === 'object' && (p as unknown as { extra_usage?: { is_active?: boolean } }).extra_usage?.is_active) ||
          (rl as unknown as { is_overage?: boolean })?.is_overage ||
          (rl as unknown as { extra_usage?: unknown })?.extra_usage === true ||
          (typeof (rl as unknown as { extra_usage?: { is_active?: boolean } })?.extra_usage === 'object' && (rl as unknown as { extra_usage?: { is_active?: boolean } })?.extra_usage?.is_active) ||
          (typeof fhRaw?.used_percentage === 'number' && fhRaw.used_percentage >= 100) ||
          (typeof sdRaw?.used_percentage === 'number' && sdRaw.used_percentage >= 100)
        );
        if (isOverage) {
          this.onOverage?.(agentId);
        }
      }
      // The live model id: the card shows the spawn-time model, but the statusline
      // reports the ACTUAL running model, so a manual /model change in the terminal
      // syncs to the roster. CC forwards its statusline model object; the qwen
      // sidecar sends a flat string. Deduped so we push only on a real change (the
      // statusline fires after every response).
      const rawModel = p.model;
      const modelId = typeof rawModel === 'string'
        ? rawModel
        : (rawModel && typeof rawModel === 'object' ? (rawModel.id ?? rawModel.display_name) : undefined);
      if (agentId && modelId && this.lastModelById.get(agentId) !== modelId) {
        this.lastModelById.set(agentId, modelId);
        this.getWebContents()?.send('hive:modelUpdate', { agentId, model: modelId });
      }
      return {};
    }

    // 7C.3 — a graceful operator HALT overrides everything (incl. the inbox
    // drain below): stop the agent CLEANLY at this hook boundary rather than
    // killing the PTY. session_id is in the payload for a later --resume.
    if (agentId && this.control?.shouldHalt(agentId)) {
      this.emit(agentId, event, p);
      return { continue: false, stopReason: 'Halted by the operator from the floor.' };
    }

    // Capture the Claude Code session id for idempotent --resume + cost dedup
    // (Lane A #6.6a). Cheap: recordSession writes only when it changes.
    if (agentId && p.session_id) this.hive.recordSession(agentId, p.session_id);

    // CostSample — synthesized by the proxy-bridge sidecar (qwen) on every
    // response with usage. Persist it to the SAME cost ledger as Claude's OTel
    // path, keyed by the synthesized session_id, then return early so cost stays
    // OUT of the Claude-only OTel/breaker/drain paths below. `usd` is the fallback
    // per-model estimate (a local model normally costs ~$0, but the row keeps the
    // accounting schema uniform). Pure telemetry — never feeds the loop detector.
    if (event === 'CostSample') {
      if (agentId && p.session_id) {
        const input = p.input ?? 0;
        const output = p.output ?? 0;
        const cacheRead = p.cache_read ?? 0;
        const cacheCreation = p.cache_creation ?? 0;
        const registry = this.hive.registry();
        const provider = (typeof p.provider === 'string' && p.provider.trim())
          ? p.provider.trim()
          : registry.agents[agentId]?.provider ?? null;
        const costModel = typeof p.model === 'string' ? p.model : '';
        this.hive.appendCostLedger({
          agentId,
          sessionId: p.session_id,
          ts: Date.now(),
          input,
          output,
          cacheRead,
          cacheCreation,
          model: costModel,
          provider,
          usd: estimateCostUsd(costModel, {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheCreation
          }, provider)
        });
      }
      return {};
    }

    // Feed the breaker its hook-derived loop signal: a tool that actually ran.
    // A repeated identical (name+input) PostToolUse is the runaway-loop tell.
    if (event === 'PostToolUse' && agentId) {
      if (p.tool_name) this.lastToolById.set(agentId, p.tool_name);
      this.breaker?.recordToolUse(agentId, p.tool_name, p.tool_input);
      this.captureTouched(agentId, typeof p.tool_name === 'string' ? p.tool_name : undefined, p.tool_input);

      // Tool call counter enforcement: track total tool calls per session and
      // enforce repeatedToolLimit to prevent runaway sessions (e.g. 21k+ tool calls).
      const count = (this.toolCallCounts.get(agentId) ?? 0) + 1;
      this.toolCallCounts.set(agentId, count);

      const cfg = this.getConfig();
      // Use a high default — the repeatedToolLimit config field is for *consecutive*
      // identical calls (handled by breaker.ts), not total session calls. Workers
      // need hundreds of calls to do real work; 8 tripped every session.
      const limit = cfg.circuitBreaker?.repeatedToolLimit ?? 2000;

      if (cfg.circuitBreaker?.enabled !== false && count >= limit) {
        const lastWarn = this.lastWarningAt.get(agentId) ?? 0;

        // Rate-limit warnings: only fire once per 100 calls after the limit
        if (count === limit || count - lastWarn >= 100) {
          this.lastWarningAt.set(agentId, count);

          // Send warning to agent inbox
          this.hive.send({
            from: 'system',
            to: agentId,
            act: 'warn',
            subject: 'Tool call limit reached',
            body: `You have made ${count} tool calls this session, hitting the repeatedToolLimit. Commit any pending work and wrap up immediately.`,
            priority: 'urgent'
          });

          // If hardStop is enabled, archive the agent
          if (cfg.circuitBreaker?.hardStop === true) {
            try {
              this.hive.setArchived(agentId, true);
              this.hive.appendLog({
                kind: 'breaker-stop',
                agentId,
                reason: `tool call limit (${count} >= ${limit})`
              });
            } catch (e) {
              console.error(`[hooks] failed to archive ${agentId} on tool limit:`, e);
            }
          }
        }
      }
    }

    // Compaction exemption (issue #109): PreCompact opens it so the compaction
    // token burst can't trip the Δoutput arms; PostCompact — or any SessionStart,
    // since a fresh session makes in-flight compaction state moot — closes it
    // down to the trailing grace (a no-op when nothing was compacting).
    if (event === 'PreCompact' && agentId) this.breaker?.recordCompactStart(agentId);
    if ((event === 'PostCompact' || event === 'SessionStart') && agentId) {
      this.breaker?.recordCompactEnd(agentId);
      // Reset tool call counter on new session
      if (event === 'SessionStart') {
        this.clearToolCallCount(agentId);
      }
    }

    if ((event === 'Stop' || event === 'SubagentStop') && agentId) {
      // Respect any upstream Stop hook that already re-entered this boundary.
      if (p.stop_hook_active) { this.emit(agentId, event, p); return {}; }
      // Never turn unread hive mail into a forced continuation at Stop. That old
      // path bypassed terminal-draft/HITL safety and could spend credits while a
      // user was answering a question. Inbox files remain durable; the renderer
      // wakes the agent later through its guarded idle-only delivery path.
      const name = this.getAgentName(agentId);
      const actionSummary = this.describeStopAction(agentId);
      this.notify(name, actionSummary);
      this.emit(agentId, event, p);
      return {};
    }

    // 7C.1 — HITL gate: deny a tool call at the PreToolUse boundary when the
    // agent is paused or this tool is gated. Race-free (immediate return, no
    // renderer round-trip → can't hit the shim timeout). Slow human APPROVAL is
    // deliberately left to Claude's native permission prompt.
    if (event === 'PreToolUse' && agentId && this.control) {
      const d = this.control.toolDecision(agentId, p.tool_name ?? '');
      if (d.deny) {
        this.emitControl(agentId, p.tool_name, d.reason);
        this.emit(agentId, event, p);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: d.reason ?? 'Denied by operator.'
          }
        };
      }
    }

    // 7C.2 — mid-run steering: inject queued operator guidance as context on the
    // next eligible hook (no fragile typing into the TUI). Delivered once.
    // Merged with the roster line below so the two injections never displace each
    // other (only ONE additionalContext can be returned per hook).
    let steer: string | null = null;
    if ((event === 'UserPromptSubmit' || event === 'PostToolUse') && agentId && this.control) {
      steer = this.control.takeSteer(agentId) ?? null;
    }

    // Keep god's roster CURRENT. fleet.json is always fresh on disk, but god's
    // context is not: after a restart it resumes a transcript describing the old
    // floor and messages agents that are long gone. Push the live roster in as
    // additionalContext at the start of each session and on every prompt, so god
    // knows the floor all the time instead of only when it remembers to Read.
    // God-only and one line — every other agent is unaffected.
    const wantsRoster = (event === 'SessionStart' || event === 'UserPromptSubmit')
      && !!agentId && this.hive.isOvermind(agentId);
    // Hand the roster the LIVE context-window occupancy (contextById) so each
    // agent line can carry a `ctx NN%` — god then sees whose context is nearly
    // full when it routes work, instead of guessing from cumulative token spend.
    const roster = wantsRoster
      ? this.hive.rosterContext((id) => this.contextFor(id))
      : null;

    // Standing goal (hire Briefing) — durable roster field, re-read every cycle so
    // an Edit Agent save is picked up on the next SessionStart / UserPromptSubmit
    // without restarting the worker. Kept out of --append-system-prompt (volatile-
    // free cache invariant); lives on the live hook channel instead.
    const wantsGoal = (event === 'SessionStart' || event === 'UserPromptSubmit') && !!agentId;
    const goalRaw = wantsGoal ? (this.getStandingGoal?.(agentId) ?? null) : null;
    const goal = goalRaw
      ? `<goal>\n${goalRaw}\n</goal>`
      : null;

    if (steer || roster || goal) {
      this.emit(agentId, event, p);
      return {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: [roster, goal, steer].filter(Boolean).join('\n\n')
        }
      };
    }

    if (event === 'Notification') {
      const lower = (p.message ?? '').toLowerCase();
      const isPermission = p.notification_type === 'permission_prompt' ||
        lower.includes('permission') ||
        lower.includes('approve') ||
        lower.includes('confirm') ||
        lower.includes('allow');
      const isIdle = p.notification_type === 'idle' || lower.includes('waiting for your input');

      if (agentId && (isPermission || isIdle)) {
        const promptLabel = p.message?.trim() || (isPermission ? 'Tool permission required' : 'Waiting for your input');
        try {
          this.getWebContents()?.send('agent:needsInput', { agentId, prompt: promptLabel });
        } catch { /* ignore */ }
      }

      if (isIdle || isPermission) {
        const name = this.getAgentName(agentId);
        const msg = (p.message ?? '').trim() || (isPermission ? 'Tool permission required' : 'Waiting for your input');
        this.notify(name, msg);
      }
    }

    if ((event === 'UserPromptSubmit' || event === 'PostToolUse' || event === 'SessionStart') && agentId) {
      try {
        this.getWebContents()?.send('agent:needsInput', { agentId, prompt: null });
      } catch { /* ignore */ }
    }

    // Forward everything else to the renderer so avatars reflect real activity.
    this.emit(agentId, event, p);
    return {};
  }

  private getAgentName(agentId?: string | null): string {
    if (!agentId) return 'Agent';
    try {
      const reg = this.hive.registry();
      if (agentId === 'god' || reg.godId === agentId) {
        return reg.agents[agentId]?.name ?? reg.agents[reg.godId ?? 'god']?.name ?? 'Overmind';
      }
      return reg.agents[agentId]?.name ?? agentId;
    } catch {
      return agentId;
    }
  }

  private describeStopAction(agentId: string): string {
    try {
      const raw = this.hive.tasks() as { tasks?: Array<{ id: string; title: string; assignee?: string; status?: string }> };
      const tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
      const reg = this.hive.registry();
      const isGod = agentId === 'god' || reg.godId === agentId;
      const activeTask = tasks.find((t) => (t.assignee === agentId || (isGod && (t.assignee === 'god' || t.assignee === reg.godId))) && (t.status === 'doing' || t.status === 'done'));
      if (activeTask?.title) {
        return `Finished task: "${activeTask.title}"`;
      }
    } catch { /* ignore */ }
    const lastTool = this.lastToolById.get(agentId);
    if (lastTool) {
      return `Finished turn (last action: ${lastTool})`;
    }
    return 'Finished turn and is now idle';
  }

  /** Fire a native desktop notification — gated on the user's `notifications`
   *  setting. Only the OS toast is gated; the hive:hookEvent emit is always sent
   *  so avatars/UI stay live regardless. Best-effort: never throw into the hook. */
  private notify(title: string, body: string): void {
    if (!this.getConfig().notifications) return;
    try {
      if (!Notification.isSupported()) return;
      showFocusNotification({ title, body });
    } catch { /* notifications unsupported on this platform — ignore */ }
  }

  /** Tell the renderer a tool call was gated/denied (#7C.1) so it can surface it
   *  (toast / control strip) — distinct from the avatar hook stream. */
  private emitControl(agentId: string, tool: string | undefined, reason: string | undefined): void {
    this.getWebContents()?.send('control:approvalRequest', { agentId, tool, reason });
  }

  private emit(agentId: string | undefined, event: string, p: HookPayload, blocked = false): void {
    this.getWebContents()?.send('hive:hookEvent', {
      agentId,
      event,
      tool: p.tool_name,
      notificationType: p.notification_type,
      source: p.source,
      message: p.message,
      blocked
    });
  }

  private recordTouchedEntries(agentId: string, entries: TouchedLedgerEntry[]): void {
    if (!entries.length) return;
    const list = this.loadTouchedLedger(agentId);
    list.push(...entries);
    if (list.length > MAX_TOUCHED_ENTRIES) {
      list.splice(0, list.length - MAX_TOUCHED_ENTRIES);
    }
    this.touchedLedgerById.set(agentId, list);
    this.appendTouchedFile(agentId, entries);
    this.getWebContents()?.send('hive:touchedUpdate', { agentId, entries });
  }

  private appendTouchedFile(agentId: string, entries: TouchedLedgerEntry[]): void {
    const file = this.touchedFilePath(agentId);
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const payload = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
      appendFileSync(file, payload, 'utf8');
    } catch (err) {
      console.error('[hooks] failed to append touched ledger for', agentId, err);
    }
  }

  private loadTouchedLedger(agentId: string): TouchedLedgerEntry[] {
    const existing = this.touchedLedgerById.get(agentId);
    if (this.touchedLoaded.has(agentId)) {
      return existing ?? [];
    }

    let entries: TouchedLedgerEntry[] = existing ?? [];
    const file = this.touchedFilePath(agentId);
    if (file && existsSync(file)) {
      try {
        const raw = readFileSync(file, 'utf8');
        if (raw) {
          const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
          const start = lines.length > MAX_TOUCHED_ENTRIES ? lines.length - MAX_TOUCHED_ENTRIES : 0;
          const parsed: TouchedLedgerEntry[] = [];
          for (let i = start; i < lines.length; i++) {
            try {
              const entry = JSON.parse(lines[i]) as TouchedLedgerEntry;
              if (entry && typeof entry.path === 'string' && typeof entry.verb === 'string' && typeof entry.ts === 'string' && typeof entry.insideRepo === 'boolean') {
                parsed.push(entry);
              }
            } catch { /* ignore malformed lines */ }
          }
          entries = parsed;
        }
      } catch (err) {
        console.error('[hooks] failed to read touched ledger for', agentId, err);
      }
    }

    this.touchedLedgerById.set(agentId, entries);
    this.touchedLoaded.add(agentId);
    return entries;
  }

  private touchedFilePath(agentId: string): string | null {
    const dir = this.hive.agentDirectory(agentId);
    return dir ? join(dir, 'touched.jsonl') : null;
  }

  private agentWorkspace(agentId: string): string | null {
    try {
      const reg = this.hive.registry();
      const agent = reg.agents?.[agentId] as { worktreePath?: string; cwd?: string } | undefined;
      if (!agent) return null;
      const root = agent.worktreePath || agent.cwd;
      return (typeof root === 'string' && root) ? root : null;
    } catch {
      return null;
    }
  }

  private computeInside(workspace: string, target: string): { inside: boolean; relative?: string } {
    const normWorkspace = normalize(workspace);
    const normTarget = normalize(target);
    const ensureSuffix = (value: string, sep: string): string => (value.endsWith(sep) ? value : `${value}${sep}`);

    if (process.platform === 'win32') {
      const base = normWorkspace.toLowerCase();
      const targetLower = normTarget.toLowerCase();
      if (targetLower === base) return { inside: true, relative: '.' };
      const baseWithSep = ensureSuffix(base, '\\');
      if (targetLower.startsWith(baseWithSep)) {
        const rel = normTarget.slice(baseWithSep.length).replace(/\\/g, '/');
        return { inside: true, relative: rel }; // rel never empty here
      }
      return { inside: false };
    }

    if (normTarget === normWorkspace) return { inside: true, relative: '.' };
    const baseWithSep = ensureSuffix(normWorkspace, '/');
    if (normTarget.startsWith(baseWithSep)) {
      const rel = normTarget.slice(baseWithSep.length).replace(/\\/g, '/');
      return { inside: true, relative: rel };
    }
    return { inside: false };
  }

  private resolveTouchedPath(agentId: string, candidate: string): (Omit<TouchedLedgerEntry, 'verb' | 'ts'>) | null {
    if (!candidate.trim()) return null;
    const workspace = this.agentWorkspace(agentId);
    let absolute: string;
    try {
      if (isAbsolute(candidate)) {
        absolute = normalize(candidate);
      } else if (workspace) {
        absolute = normalize(resolve(workspace, candidate));
      } else {
        return null;
      }
    } catch {
      return null;
    }

    if (!workspace) {
      return { path: absolute, insideRepo: false };
    }

    const { inside, relative: rel } = this.computeInside(workspace, absolute);
    if (inside) {
      return rel && rel !== '.'
        ? { path: absolute, insideRepo: true, relativePath: rel }
        : { path: absolute, insideRepo: true, relativePath: '.' };
    }
    return { path: absolute, insideRepo: false };
  }

  private extractFilePath(input: Record<string, unknown>): string | null {
    const paths = ['file_path', 'path', 'filepath'];
    for (const key of paths) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
  }

  private captureTouched(agentId: string, toolName: string | undefined, toolInput: unknown): void {
    if (!toolName) return;

    const name = toolName.toLowerCase();
    const now = new Date().toISOString();
    const entries: TouchedLedgerEntry[] = [];
    const input = (toolInput && typeof toolInput === 'object') ? toolInput as Record<string, unknown> : {};

    const WRITE_TOOLS = new Set([
      'write', 'writefile', 'write_file', 'writetofile', 'createfile', 'create_file',
      'appendfile', 'savefile', 'overwritefile', 'applyedit'
    ]);
    const EDIT_TOOLS = new Set([
      'edit', 'editfile', 'edit_file', 'updatefile', 'update_file', 'rewritefile',
      'replacefile', 'modifyfile', 'notebookedit'
    ]);
    const DELETE_TOOLS = new Set(['deletefile', 'delete_file', 'removefile', 'remove_file', 'rmfile']);
    const CREATE_TOOLS = new Set(['createfile', 'create_file', 'touchfile', 'touch_file']);

    const isApplyPatch = name === 'applypatch' || name === 'apply_patch' || name === 'patch';
    const isBash = name === 'bash' || name === 'shell';

    const collectFilePath = (verb: TouchedVerb) => {
      const path = this.extractFilePath(input);
      if (!path) return;
      const resolved = this.resolveTouchedPath(agentId, path);
      if (resolved) entries.push({ ...resolved, verb, ts: now });
    };

    if (WRITE_TOOLS.has(name) || CREATE_TOOLS.has(name)) {
      collectFilePath(name === 'createfile' || name === 'create_file' || CREATE_TOOLS.has(name) ? 'create' : 'write');
    } else if (EDIT_TOOLS.has(name)) {
      collectFilePath('edit');
    } else if (DELETE_TOOLS.has(name)) {
      collectFilePath('delete');
    } else if (isApplyPatch) {
      entries.push(...this.parsePatchTouched(agentId, input, now));
    } else if (isBash) {
      const command = typeof input.command === 'string' ? input.command : '';
      entries.push(...this.parseBashTouched(agentId, command, now));
    }

    if (entries.length > 0) {
      this.recordTouchedEntries(agentId, entries);
    }
  }

  private parsePatchTouched(agentId: string, input: Record<string, unknown>, ts: string): TouchedLedgerEntry[] {
    const entries: TouchedLedgerEntry[] = [];
    const addPath = (candidate: string) => {
      const resolved = this.resolveTouchedPath(agentId, candidate);
      if (resolved) entries.push({ ...resolved, verb: 'edit', ts });
    };

    const patchStrings: string[] = [];
    if (typeof input.patch === 'string') patchStrings.push(input.patch);
    if (Array.isArray(input.patches)) {
      for (const p of input.patches) {
        if (typeof p === 'string') patchStrings.push(p);
      }
    }

    for (const patch of patchStrings) {
      const lines = patch.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('+++ ')) {
          const path = line.slice(4).trim();
          if (!path || path === '/dev/null') continue;
          const normal = path.startsWith('b/') ? path.slice(2) : path;
          addPath(normal);
        }
      }
    }

    return entries;
  }

  private parseBashTouched(agentId: string, command: string, ts: string): TouchedLedgerEntry[] {
    if (!command || !command.trim()) return [];
    const entries: TouchedLedgerEntry[] = [];
    const pushPath = (candidate: string, verb: TouchedVerb): void => {
      const resolved = this.resolveTouchedPath(agentId, candidate);
      if (resolved) entries.push({ ...resolved, verb, ts });
    };

    const redirectRegex = /(?:^|\s)(?:\d*>|>>?)(?:\s*)('([^']+)'|"([^"]+)"|([^\s&|;<>]+))/g;
    let match: RegExpExecArray | null;
    while ((match = redirectRegex.exec(command)) !== null) {
      const candidate = (match[2] ?? match[3] ?? match[4] ?? '').trim();
      if (!candidate) continue;
      const lower = candidate.toLowerCase();
      if (lower === '/dev/null' || lower === 'nul') continue;
      if (candidate.startsWith('&')) continue;
      pushPath(candidate, 'write');
    }

    const tokens = this.tokenizeCommand(command);
    if (tokens.length === 0) return entries;
    const cmdRaw = tokens[0];
    const cmd = cmdRaw.toLowerCase();
    const rest = tokens.slice(1);

    const { positional, named } = this.parsePowerShellArgs(rest);
    const args = this.dropOptionArgs(rest);

    const firstNamed = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = named.get(key);
        if (value && value.length) return value[0];
      }
      return undefined;
    };

    switch (cmd) {
      case 'mv':
      case 'move':
      case 'move-item': {
        if (args.length >= 2) {
          const dest = args[args.length - 1];
          const sources = args.slice(0, -1);
          if (sources.length > 0) {
            pushPath(dest, 'write');
            for (const src of sources) pushPath(src, 'delete');
          }
        }
        if (cmd === 'move-item') {
          const src = firstNamed('path', 'literalpath', 'source', 'inputpath');
          const dest = firstNamed('destination', 'dest');
          if (dest) pushPath(dest, 'write');
          if (src) pushPath(src, 'delete');
        }
        break;
      }
      case 'cp':
      case 'copy':
      case 'copy-item': {
        if (args.length >= 2) {
          const dest = args[args.length - 1];
          pushPath(dest, 'write');
        }
        if (cmd === 'copy-item') {
          const dest = firstNamed('destination', 'dest');
          if (dest) pushPath(dest, 'write');
        }
        break;
      }
      case 'rm':
      case 'del':
      case 'erase':
      case 'remove-item': {
        if (cmd === 'remove-item') {
          const target = firstNamed('path', 'literalpath', 'inputobject');
          if (target) pushPath(target, 'delete');
        }
        for (const target of args) pushPath(target, 'delete');
        break;
      }
      case 'touch': {
        for (const target of args) pushPath(target, 'write');
        break;
      }
      case 'mkdir':
      case 'md':
      case 'new-item': {
        for (const target of args) pushPath(target, 'create');
        if (cmd === 'new-item') {
          const target = firstNamed('path', 'literalpath', 'name');
          if (target) pushPath(target, 'create');
        }
        break;
      }
      case 'tee': {
        for (const target of args) {
          if (target === '-' || target === '|') break;
          pushPath(target, 'write');
        }
        break;
      }
      case 'sed': {
        if (args.length > 0) {
          const candidate = args[args.length - 1];
          pushPath(candidate, 'edit');
        }
        break;
      }
      case 'set-content':
      case 'setcontent':
      case 'add-content':
      case 'addcontent':
      case 'clear-content':
      case 'clearcontent':
      case 'out-file':
      case 'outfile': {
        const target = firstNamed('path', 'literalpath', 'filepath', 'file', 'inputobject') ?? positional[0];
        if (target) {
          const verb: TouchedVerb = (cmd === 'clear-content' || cmd === 'clearcontent') ? 'edit' : 'write';
          pushPath(target, verb);
        }
        break;
      }
      default:
        break;
    }

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== 'tee') continue;
      if (i === 0) continue; // already handled above
      const teeArgs = this.dropOptionArgs(tokens.slice(i + 1));
      for (const target of teeArgs) {
        if (target === '-' || target === '|') break;
        pushPath(target, 'write');
      }
    }

    return entries;
  }

  private dropOptionArgs(args: string[]): string[] {
    const result: string[] = [];
    let acceptOptions = true;
    for (const arg of args) {
      if (acceptOptions && arg === '--') {
        acceptOptions = false;
        continue;
      }
      if (arg === '|' || arg === ';') break;
      if (acceptOptions && arg.startsWith('-')) continue;
      result.push(arg);
    }
    return result;
  }

  private parsePowerShellArgs(args: string[]): { positional: string[]; named: Map<string, string[]> } {
    const positional: string[] = [];
    const named = new Map<string, string[]>();
    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      if (token === '|' || token === ';') break;
      if (token.startsWith('-')) {
        const key = token.replace(/^-+/, '').toLowerCase();
        const next = args[i + 1];
        if (next && !next.startsWith('-') && next !== '|' && next !== ';') {
          const list = named.get(key) ?? [];
          list.push(next);
          named.set(key, list);
          i++;
        } else {
          named.set(key, named.get(key) ?? []);
        }
      } else {
        positional.push(token);
      }
    }
    return { positional, named };
  }

  private tokenizeCommand(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (quote) {
        if (ch === quote) {
          quote = null;
        } else {
          current += ch;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '|' || ch === ';') {
        if (current) {
          tokens.push(current);
          current = '';
        }
        tokens.push(ch);
        continue;
      }
      if (/\s/.test(ch)) {
        if (current) {
          tokens.push(current);
          current = '';
        }
        continue;
      }
      current += ch;
    }
    if (quote) {
      // unterminated quote — treat as literal
      tokens.push(current);
    } else if (current) {
      tokens.push(current);
    }
    return tokens;
  }
}
