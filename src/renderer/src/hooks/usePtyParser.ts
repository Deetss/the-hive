import { useCallback, useEffect, useRef } from 'react';
import { useStore, type ToolKind, type StationKind } from '@/store/store';
import { createAnsiStripper } from '@/components/ansiText';

// Tool call lines look like: `● Read SPEC.md`, `● Bash npm test`, `● Edit src/foo.ts`
const TOOL_RE = /●\s+([A-Za-z][A-Za-z_]*)(?:\s+(.+))?/g;

const TOOL_TO_STATION: Record<string, StationKind> = {
  Read: 'shelf', Edit: 'shelf', Write: 'shelf', MultiEdit: 'shelf',
  Grep: 'shelf', Glob: 'shelf',
  Bash: 'terminal', BashOutput: 'terminal',
  WebFetch: 'web', WebSearch: 'web',
  TodoWrite: 'board', TaskCreate: 'board', TaskUpdate: 'board'
};

const TOOLKIND_BY_NAME: Record<string, ToolKind> = {
  Read: 'Read', Edit: 'Edit', Write: 'Write',
  Bash: 'Bash',
  WebFetch: 'WebFetch', WebSearch: 'WebSearch',
  Grep: 'Grep', Glob: 'Glob',
  TodoWrite: 'TodoWrite'
};

// "Blocked" = Claude is genuinely waiting on the user. Match only real prompts
// (the approval menu / a yes-no question). Do NOT match the bare word
// "permission": the TUI footer always shows "bypass permissions on (shift+tab
// to cycle)", which would otherwise flag a busy agent as blocked on every
// repaint — making it flip-flop between working and blocked.
const BLOCK_HINTS = [
  /Do you want to proceed/i,
  /Do you want to (run|execute|proceed|allow)/i,
  /Allow\s+([A-Za-z0-9_-]+)\s+to\s+run/i,
  /Allow\s+this\s+(command|tool)/i,
  /Allow\s+(once|always)\b/i,
  /❯\s*\d+\.\s*(Yes|Allow|Proceed)/i,
  /^\s*\d+\.\s*(Yes|Allow|Proceed)\b/im,
  /Yes, and don't ask again/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\[y\/n\/[a-z]\]/i,
  /\(y\/n\/[a-z]\)/i,
  /\b(y)es\b.*\b(n)o\b/i,
];

// Interactive terminal prompts that only a human can answer: codex trust dialogs,
// sandbox setup wizards, and generic "press enter to confirm" gates. When a
// sub-agent is stuck here the human needs to open the terminal and respond.
const INTERACTIVE_PROMPT_HINTS = [
  /Press enter to confirm/i,
  /Do you trust the (contents|files|authors) of this directory/i,
  /Do you trust the (files|contents|authors)/i,
  /trust (this|the) (workspace|folder|directory)/i,
  /Set up the Codex agent sandbox/i,
  /continue\?.*\[y\/n\]/i,
  /paste (the|your) (code|url|token|key)/i,
  /https?:\/\/\S*(oauth|\/auth|login|callback|authorize)/i,
];

// The /context output prints "235.3k/1m tokens (24%)" — sniff the DENOMINATOR
// to learn the session's true context-window size. This is the only reliable
// source for sessions on the CLI-default model: the "[1m]" alias exists only
// inside Claude Code; the API model id in the transcript is plain.
const CONTEXT_LIMIT_RE = /[\d.,]+k\s*\/\s*([\d.]+)([km])\s+tokens/i;

/**
 * Subscribe to a pty stream and update the agent's avatar state based on what
 * scrolls past. This is a stopgap until we wire real Claude Code hooks — it
 * inspects the visible terminal output and infers status / station / carrying.
 *
 * Returns a function suitable for `<PtyTerminalView onStreamData={...} />`.
 */
export function usePtyParser(agentId: string) {
  const updateAgent = useStore(s => s.updateAgent);
  const pushFeed = useStore(s => s.pushFeed);
  const idleTimerRef = useRef<number | null>(null);
  // Tracks whether we've raised an ASK-ME entry for an interactive prompt; used
  // to avoid duplicate entries and to resolve the entry when the prompt clears.
  const promptBlockedRef = useRef(false);
  // One stripper per agent: it carries an escape split across pty chunks.
  const stripRef = useRef(createAnsiStripper());

  const scheduleIdle = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = window.setTimeout(() => {
      // No new tool calls for ~4 s → assume the model went idle. Also clear
      // blockReason here: it's set when a prompt/permission hint is spotted
      // but nothing ever resets it once the agent moves past that prompt, so
      // the WAITING FOR APPROVAL banner (driven off blockReason) would stay
      // up forever even after the agent is confirmed idle.
      updateAgent(agentId, {
        status: 'idle',
        action: 'awaiting',
        carrying: undefined,
        currentStation: 'desk',
        blockReason: undefined
      });
    }, 4000) as unknown as number;
  }, [agentId, updateAgent]);

  const cancelIdle = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
    };
  }, []);

  return useCallback((chunk: string) => {
    const text = stripRef.current(chunk);
    if (!text.trim()) return;

    // Passive context-limit sniffing from /context output (the gauge poll
    // sends one probe per session; a manual /context works too). The limit
    // only ever ratchets up — contextLimit is volatile across respawns.
    const lim = CONTEXT_LIMIT_RE.exec(text);
    if (lim) {
      const value = parseFloat(lim[1]) * (lim[2].toLowerCase() === 'm' ? 1_000_000 : 1_000);
      if (value >= 100_000) {
        const agent = useStore.getState().agents.find((a) => a.id === agentId);
        if (agent && value > (agent.contextLimit ?? 0)) {
          updateAgent(agentId, { contextLimit: value });
        }
      }
    }

    // The "esc to interrupt" footer is only shown while a turn is in progress.
    const running = /esc to interrupt/i.test(text);

    let lastTool: string | null = null;
    let lastArg: string | null = null;

    TOOL_RE.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = TOOL_RE.exec(text)) !== null; ) {
      lastTool = m[1];
      lastArg = (m[2] ?? '').trim();
    }

    if (lastTool) {
      const station = TOOL_TO_STATION[lastTool] ?? 'desk';
      const carrying = TOOLKIND_BY_NAME[lastTool] ?? undefined;
      // Collapse space runs: translated cursor-forwards (see ansiText) can
      // stand for several columns, and the bubble shouldn't show the gaps.
      const summary = (lastArg ? `${lastTool.toLowerCase()} ${lastArg}` : lastTool.toLowerCase())
        .replace(/\s+/g, ' ');
      // NOTE: `progress` deliberately untouched — it's the context gauge now
      // (filled by the useHive context poll), not a per-task meter.
      updateAgent(agentId, {
        status: 'working',
        action: summary,
        currentStation: station,
        carrying
      });
      // Mirror into the in-app feed so the mock terminal view shows it too if
      // ever toggled — harmless for real ptys.
      pushFeed(agentId, `\x1b[36m● ${lastTool}\x1b[0m ${lastArg ?? ''}`);
      // Keep working while the spinner is up; otherwise allow the idle drift.
      if (running) cancelIdle(); else scheduleIdle();
      return;
    }

    // Actively running but no fresh tool line (model is thinking / streaming
    // prose) → keep the agent working at its desk, don't let it drift to idle.
    if (running) {
      cancelIdle();
      if (promptBlockedRef.current) {
        promptBlockedRef.current = false;
        useStore.getState().resolveHumanMessage(`prompt:${agentId}`);
      }
      updateAgent(agentId, { status: 'working' });
      return;
    }

    // Not running → check for interactive prompts or approval menus.
    const recent = text.slice(-400);
    const isInteractive = INTERACTIVE_PROMPT_HINTS.some(re => re.test(recent));
    const isBlocked = isInteractive || BLOCK_HINTS.some(re => re.test(recent));

    if (isBlocked) {
      const storeState = useStore.getState();
      const isOvermind = !!storeState.agents.find((a) => a.id === agentId)?.isOvermind;
      const promptText = recent.trim().split('\n').filter(l => l.trim()).slice(-6).join('\n');
      const agentName = storeState.agents.find((a) => a.id === agentId)?.name ?? agentId;

      if (isOvermind) {
        updateAgent(agentId, {
          status: 'blocked',
          action: 'waiting on you',
          currentStation: 'mailbox',
          blockReason: {
            summary: 'Waiting for your reply',
            detail: promptText || 'Claude is waiting for input. Check the terminal for the exact prompt.',
            actions: [
              { label: 'Approve', kind: 'approve', send: 'y\r' },
              { label: 'Deny',    kind: 'deny',    send: 'n\r' }
            ]
          }
        });
      } else {
        // Worker agent stuck on an interactive terminal or tool permission prompt
        updateAgent(agentId, {
          status: 'prompt',
          action: isInteractive ? 'needs input' : 'needs permission',
          currentStation: 'terminal',
          blockReason: {
            kind: isInteractive ? 'prompt' : 'circuit',
            summary: isInteractive ? 'Waiting for terminal input' : 'Tool permission needed',
            detail: promptText,
            actions: [
              { label: 'Approve (y)', kind: 'approve', send: 'y\r' },
              { label: 'Deny (n)',    kind: 'deny',    send: 'n\r' }
            ]
          }
        });

        if (!promptBlockedRef.current) {
          promptBlockedRef.current = true;
          storeState.addHumanMessage({
            id: `prompt:${agentId}`,
            from: agentId,
            subject: `${agentName} needs ${isInteractive ? 'terminal input' : 'tool approval'}`,
            body: promptText,
            act: 'prompt',
            arrivedAt: Date.now(),
            resolved: false,
            replyDraft: '',
          });
        }
      }
      return;
    }

    // Turn finished, no prompt on screen → resolve any prompt-blocked entry and drift to idle.
    if (promptBlockedRef.current) {
      promptBlockedRef.current = false;
      useStore.getState().resolveHumanMessage(`prompt:${agentId}`);
    }
    scheduleIdle();
  }, [agentId, updateAgent, pushFeed, scheduleIdle, cancelIdle]);
}
