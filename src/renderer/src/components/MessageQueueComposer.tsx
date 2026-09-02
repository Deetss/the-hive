import { ClipboardEvent, DragEvent, KeyboardEvent, type MouseEvent as ReactMouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent, type QueuedMessage } from '@/store/store';
import { clearTerminalDraft, dismissTerminalPicker, terminalAutomationBlockFor } from './terminalPool';
import type { TerminalAutomationBlock } from './terminalAutomation';
import { freeflowRecorder, useFreeflow } from '@/freeflow/recorder';
import { useTerminalFontSize } from './terminalFontSize';

const EMPTY_QUEUE: QueuedMessage[] = [];

/** A file of ANY type attached to the draft. Travels to the agent as a PATH it
 *  Reads (never inlined — the agent has a Read tool and inlining would bloat the
 *  prompt). `size` is bytes when known, for the chip label. */
interface Attachment {
  path: string;
  name: string;
  size?: number;
}

/** Human-readable byte size for an attachment chip. */
function formatBytes(n?: number): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Prepended (only to the enqueued value, never the visible draft) when the

export interface MessageQueueComposerProps {
  agent: Agent;
}

/**
 * Lets the user keep messaging an agent whose terminal is mid-run. Typed
 * messages park in a per-agent queue and are submitted to the agent's Claude
 * TUI one-by-one as soon as it goes idle (see useHive's flush loop).
 */
export function MessageQueueComposer({ agent }: MessageQueueComposerProps) {
  const queue = useStore((s) => s.messageQueues[agent.id]) ?? EMPTY_QUEUE;
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);
  const updateQueuedMessage = useStore((s) => s.updateQueuedMessage);
  const releaseQueuedMessage = useStore((s) => s.releaseQueuedMessage);
  const clearQueue = useStore((s) => s.clearQueue);
  // ux-unified-input: one composer, two destinations. Blank target keeps the
  // per-agent queue (the terminal-input model); picking BeeYoncé or another
  // agent turns this into the structured dispatch the Floor tab used to own.
  const agents = useStore((s) => s.agents);
  const archivedAgents = useStore((s) => s.archivedAgents);
  const restorableAgents = useStore((s) => s.restorableAgents);
  const selectedId = useStore((s) => s.selectedId);
  const dispatchSeedRequest = useStore((s) => s.dispatchSeedRequest);
  const clearDispatchSeedRequest = useStore((s) => s.clearDispatchSeedRequest);

  // Draft lives in the store, keyed by agent — switching agents remounts this
  // component, and component-local state would silently eat the typed text.
  const text = useStore((s) => s.drafts[agent.id] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const setText = (t: string) => setDraft(agent.id, t);

  // Free Flow voice dictation (entry point A). The mic button shows only when the
  // feature is enabled in Settings; a transcript is appended to this draft for
  // review before sending (never auto-sent). When enabled but no Groq key is set,
  // the button stays VISIBLE but DISABLED with a tooltip pointing to Settings
  // (hasGroqKey is boolean presence only — the key value never reaches the store).
  const freeflowEnabled = useStore((s) => s.freeflowEnabled);
  const hasGroqKey = useStore((s) => s.hasGroqKey);
  const ff = useFreeflow();
  const ffMine = ff.targetAgentId === agent.id;
  const ffHint = !freeflowEnabled
    ? null
    : ffMine && ff.status === 'recording'
    ? '● recording — click stop to transcribe'
    : ffMine && ff.status === 'transcribing'
    ? 'transcribing…'
    : ff.error && (ffMine || ff.targetAgentId === null)
    ? `voice: ${ff.error}`
    : null;

  // The draft box is the terminal's twin — it should read at the same size the
  // agent's output does, at every zoom level.
  const composerFontSize = useTerminalFontSize();
  const composerLineHeight = Math.round(composerFontSize * 1.4);

  const idle = agent.status === 'idle';

  // Only the god/Abathur agent gets the delegation toggle. Default OFF.

  // Files/images staged for the next message. Component-local: switching agents
  // remounts this component, so attachments are cleared on tab switch (drafts
  // persist in the store, attachments deliberately don't carry over).
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);

  // The composer always dispatches through BeeYoncé now; "send later" is the one
  // exception — it parks the message in this agent's own queue instead. The
  // act / project controls only apply to a real dispatch, so they hide when
  // "send later" is on; priority still matters for a queued message.
  const [target, setTarget] = useState('god');
  const [sendLater, setSendLater] = useState(false);
  const [dispAct, setDispAct] = useState<'request' | 'query' | 'inform'>('request');
  const [dispProject, setDispProject] = useState('');
  const [dispPriority, setDispPriority] = useState<'urgent' | 'normal' | 'backlog'>('normal');
  // Projects the user has dispatched against before — persisted so the dropdown
  // remembers them across sessions, on top of the ones read from the agent roster.
  const PROJECTS_LS_KEY = 'cth.dispatch.projects';
  const [usedProjects, setUsedProjects] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROJECTS_LS_KEY) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  });
  const [dispMsg, setDispMsg] = useState<string | null>(null);
  const [harnessHome, setHarnessHome] = useState<string | null>(null);
  useEffect(() => {
    window.cth.getConfig().then((c) => setHarnessHome(c.harnessHome ?? null)).catch(() => { /* main not ready */ });
  }, []);

  const selectStyle = {
    padding: '4px 6px', fontFamily: 'var(--cth-font-ui)', fontSize: 12,
    background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
    border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', outline: 'none'
  } as const;

  // A task-card / setup / GitHub-issue "assign" seeds a dispatch (shared store
  // action, previously consumed by the Floor form). The composer for the FOCUSED
  // agent picks it up and prefills the body from the task.
  useEffect(() => {
    if (!dispatchSeedRequest) return;
    if (selectedId && agent.id !== selectedId) return;
    // Always land in dispatch mode (TO = "BeeYoncé decides"), even if the user
    // had switched the target or turned on "send later".
    setSendLater(false);
    setTarget('god');
    // An empty seed just focuses the composer in dispatch mode — don't clobber
    // whatever the user has already typed.
    if (dispatchSeedRequest.text) {
      setDraft(agent.id, dispatchSeedRequest.text);
    }
    clearDispatchSeedRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatchSeedRequest?.seq]);

  const addAttachments = (incoming: Attachment[]) =>
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.path));
      const fresh = incoming.filter((a) => a.path && !seen.has(a.path));
      return fresh.length ? [...prev, ...fresh] : prev;
    });

  const removeAttachment = (path: string) =>
    setAttachments((prev) => prev.filter((a) => a.path !== path));

  // '+' button → OS picker (images group + all files).
  const pickFiles = async () => {
    const res = await window.cth.attachFiles();
    if (res.ok) addAttachments(res.files);
  };

  // Drop files onto the composer → resolve each to its absolute path.
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (!dropped.length) return;
    const atts = dropped
      .map((f) => ({ path: window.cth.pathForFile(f), name: f.name, size: f.size }))
      .filter((a) => a.path);
    if (atts.length) addAttachments(atts);
  };

  // Paste a screenshot (no path → persist the native clipboard image to a temp
  // file) or paste files copied from the OS file manager (carry a real path).
  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const hasImage = items.some((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (hasImage) {
      e.preventDefault();
      const res = await window.cth.saveClipboardImage();
      if (res.ok) addAttachments([res.file]);
      return;
    }
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      const atts = files
        .map((f) => ({ path: window.cth.pathForFile(f), name: f.name, size: f.size }))
        .filter((a) => a.path);
      if (atts.length) {
        e.preventDefault();
        addAttachments(atts);
      }
    }
  };

  const canSend = !!text.trim() || attachments.length > 0;

  // Prepend an "Attached files:" block using the same path-based convention as
  // the Slack inbound path (useHive.ts) so agents Read the files directly.
  const buildBody = () =>
    attachments.length
      ? (text.trim() ? `${text}\n\nAttached files:\n` : 'Attached files:\n') +
        attachments.map((a) => `- ${a.path} (${a.name})`).join('\n')
      : text;

  // Return the composer to a blank state after a message leaves it, so the next
  // one is not pre-filled with the last body, project, or attachments.
  const resetComposer = () => {
    setText('');
    setDispProject('');
    setAttachments([]);
  };

  // Every project name we can suggest: the roster (active + archived + restorable
  // agents' cwd names) plus the persisted "used before" list, deduped + sorted.
  const knownProjects = [...new Set(
    [...agents, ...archivedAgents, ...restorableAgents]
      .map((a) => a.project)
      .concat(usedProjects)
      .map((p) => (p ?? '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  // Persist a project name once it has actually been used, so it is offered next
  // session. Bounded so the list can't grow without limit.
  const rememberProject = (name: string) => {
    const p = name.trim();
    if (!p) return;
    setUsedProjects((prev) => {
      if (prev.includes(p)) return prev;
      const next = [p, ...prev].slice(0, 40);
      try { localStorage.setItem(PROJECTS_LS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  };

  // There is no message-payload field for project, so both paths carry it as a
  // leading body tag the recipient can read to route / prioritise by project.
  const withProject = (b: string) => {
    const project = dispProject.trim();
    return project ? `[PROJECT: ${project}]\n\n${b}` : b;
  };

  const queueIt = () => {
    if (!canSend) return;
    enqueueMessage(agent.id, withProject(buildBody()), { userDraft: true });
    rememberProject(dispProject);
    resetComposer();
  };

  // Structured dispatch — mirrors the old Floor form: ALL human dispatch flows
  // through the Overmind (never straight into a worker's inbox); a picked agent
  // rides along as a suggestion, and the priority directive tells god how to
  // triage it.
  const dispatchIt = async () => {
    if (!canSend) return;
    const raw = buildBody().trim();
    if (!raw) return;
    const body = withProject(raw);
    const subject = raw.split('\n')[0].slice(0, 60);
    const suggested = target !== 'god' ? agents.find((a) => a.id === target) : undefined;
    const tasksPath = harnessHome ? `${harnessHome}\\hive\\tasks.json` : 'hive/tasks.json';
    const priorityDirective =
      dispPriority === 'urgent'
        ? `\n\n[PRIORITY: URGENT] Step 1: Write a task card to ${tasksPath} (id, title, status:"doing", assignee). Step 2: Delegate to the right worker NOW — spawn one if needed. Step 3: Do nothing else. You orchestrate; never implement.`
        : dispPriority === 'backlog'
        ? `\n\n[PRIORITY: BACKLOG] Write a task card to ${tasksPath} (id, title, status:"todo") and stop. No delegation, no dispatch, no reply.`
        : `\n\n[PRIORITY: NORMAL] Step 1: Write a task card to ${tasksPath} (id, title, status:"doing", assignee). Step 2: Delegate to an available worker. Step 3: Do nothing else. You orchestrate; never implement.`;
    const full = suggested
      ? `${body}${priorityDirective}\n\n(The human suggests ${suggested.name} (${suggested.id}) for this — your call as orchestrator.)`
      : `${body}${priorityDirective}`;
    let ok = false;
    let err: string | undefined;
    try {
      const res = await window.cth.hiveSend(
        { to: 'god', act: dispAct, subject, body: full, priority: dispPriority },
        'human'
      );
      ok = res.ok;
      err = res.error;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    if (ok) { rememberProject(dispProject); resetComposer(); }
    setDispMsg(ok
      ? `sent to BeeYoncé${suggested ? ` (suggesting ${suggested.name})` : ''}`
      : `failed: ${err ?? '?'}`);
    setTimeout(() => setDispMsg(null), 4000);
  };

  const handleSend = () => { if (sendLater) queueIt(); else void dispatchIt(); };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Delivery can be held back by the agent's own terminal (a half-typed draft or
  // an open slash-command picker owns the prompt). That used to be invisible —
  // the hint claimed it was sending while nothing moved — so poll it and say so.
  const block = useTerminalBlock(agent.ptyId, queue.length > 0 && idle);

  // Floor-wide auto-delivery pause (Command Center switch) also holds the queue.
  // Without saying so — and without the per-row "send now" override — messages
  // look permanently stuck with no explanation and no escape hatch.
  const deliveryPaused = useDeliveryPaused(agent.id, queue.length > 0);

  const statusHint = queue.length === 0
    ? null
    : !idle
    ? `${agent.name} is busy — ${queue.length} queued`
    : deliveryPaused && !queue[0]?.manual
    ? 'held — delivery paused floor-wide'
    : block === 'draft'
    ? `held — ${agent.name}'s terminal has unsent text on its prompt`
    : block === 'picker'
    ? `held — a slash-command picker is open in ${agent.name}'s terminal`
    : block === 'exited'
    ? `held — ${agent.name}'s terminal has exited`
    : `sending to ${agent.name} one-by-one…`;

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={(e) => {
        // Only clear when the cursor actually leaves the composer, not on child enter.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={onDrop}
      style={{
        // Dispatch mode adds the TO / act / project / priority row, which can
        // push the composer past the terminal pane's height. It sits in a
        // column flex next to a `flex:1` xterm (basis 0), so the xterm yields
        // its space first; only if the composer STILL can't fit does it cap at
        // the pane height and scroll — instead of the old `flexShrink:0` that
        // let an `overflow:hidden` ancestor clip the extra fields.
        flexShrink: 1,
        minHeight: 0,
        overflowY: 'auto',
        borderTop: '1px solid var(--cth-ink-700)',
        background: 'var(--cth-cream-100)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        boxShadow: dragOver ? 'inset 0 0 0 2px var(--cth-lilac)' : undefined
      }}>
      {dragOver && (
        <span style={{
          fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '12px',
          color: 'var(--cth-ink-700)', textAlign: 'center'
        }}>DROP TO ATTACH</span>
      )}
      {/* Header: label, count, status, clear-all */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 13, lineHeight: '12px',
          color: 'var(--cth-ink-700)'
        }}>MESSAGE {agent.name.toUpperCase()}</span>
        {queue.length > 0 && (
          <span style={{
            fontSize: 13, padding: '1px 6px 0',
            background: 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)'
          }}>{queue.length}</span>
        )}
        {statusHint && (
          <span
            title={deliveryPaused && !queue[0]?.manual
              ? 'Auto-delivery is paused for the whole floor. Resume it in the Command Center, or use "send now" on a message below.'
              : statusHint}
            style={{
              fontSize: 12,
              color: idle ? 'var(--cth-ink-700)' : 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}
          >{statusHint}</span>
        )}
        {(block === 'draft' || block === 'picker') && agent.ptyId && (
          <button
            onClick={() => {
              // A picker and a draft are unblocked by different keys: Escape
              // closes the picker, Ctrl-U kills the input line. Sending Ctrl-U
              // at a picker leaves it open while telling automation the prompt
              // is free, which is how a queued message ends up typed into a
              // menu and marked delivered.
              if (block === 'picker') { dismissTerminalPicker(agent.ptyId!); return; }
              // Keep whatever was on the prompt — it lands in this composer so
              // the user can send it properly instead of losing it to Ctrl-U.
              const discarded = clearTerminalDraft(agent.ptyId!);
              if (discarded.trim()) setText(text ? `${text}\n${discarded}` : discarded);
            }}
            title={block === 'picker'
              ? "Close the picker this agent has open so queued messages can be delivered"
              : "Move the leftover text on this agent's prompt into this box so queued messages can be delivered"}
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
              color: 'var(--cth-ink-900)', textDecoration: 'underline'
            }}
          >{block === 'picker' ? 'close picker' : 'recover prompt'}</button>
        )}
        {queue.length > 1 && (
          <button
            onClick={() => clearQueue(agent.id)}
            title="Clear all queued messages"
            style={{
              marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap',
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
              color: 'var(--cth-ink-500)'
            }}
          >clear all</button>
        )}
      </div>

      {/* Structured dispatch routed through BeeYoncé (ux-unified-input — the Floor
          form, folded in). "send later" parks the message in this agent's queue
          instead. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)', flexShrink: 0 }}>TO</span>
        <select className="cth-input" value={target} onChange={(e) => setTarget(e.target.value)} style={selectStyle}>
          <option value="god">Dispatch · BeeYoncé decides</option>
          {agents.filter((a) => !a.isOvermind && a.id !== 'god' && a.id !== agent.id).map((a) => (
            <option key={a.id} value={a.id}>Dispatch · suggest {a.name}</option>
          ))}
        </select>
        {/* Type + project apply to a queued message too (routing / context), so
            they stay visible in "send later" mode. */}
        <select className="cth-input" value={dispAct} onChange={(e) => setDispAct(e.target.value as 'request' | 'query' | 'inform')} style={selectStyle}>
          <option value="request">Request</option>
          <option value="query">Query</option>
          <option value="inform">Inform</option>
        </select>
        <input
          className="cth-input"
          list="cth-dispatch-projects"
          value={dispProject}
          onChange={(e) => setDispProject(e.target.value)}
          placeholder="Project (optional)"
          title="Pick a known project or type a new one"
          style={{ ...selectStyle, width: 130 }}
        />
        <datalist id="cth-dispatch-projects">
          {knownProjects.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        {/* Priority still matters for a queued message (an urgent one delivers
            ahead of others), so these stay active in "send later" mode too. */}
        {(['urgent', 'normal', 'backlog'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setDispPriority(p)}
            title={`Priority: ${p}`}
            style={{
              padding: '3px 8px', fontFamily: 'var(--cth-font-ui)', fontSize: 11,
              textTransform: 'uppercase', letterSpacing: 0.5, border: 'none', borderRadius: 2, cursor: 'pointer',
              background: dispPriority === p ? 'var(--cth-ink-900)' : 'transparent',
              color: dispPriority === p ? 'var(--cth-paper-100)' : 'var(--cth-ink-500)',
              boxShadow: dispPriority === p ? 'none' : 'inset 0 0 0 1px var(--cth-ink-300)'
            }}
          >{p}</button>
        ))}
        <button
          type="button"
          onClick={() => setSendLater((v) => !v)}
          title="Queue this message for the agent instead of dispatching it now"
          style={{
            padding: '3px 8px', fontFamily: 'var(--cth-font-ui)', fontSize: 11,
            textTransform: 'uppercase', letterSpacing: 0.5, border: 'none', borderRadius: 2, cursor: 'pointer',
            background: sendLater ? 'var(--cth-ink-900)' : 'transparent',
            color: sendLater ? 'var(--cth-paper-100)' : 'var(--cth-ink-500)',
            boxShadow: sendLater ? 'none' : 'inset 0 0 0 1px var(--cth-ink-300)'
          }}
        >send later</button>
        {dispMsg && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{dispMsg}</span>}
      </div>

      {/* Pending list */}
      {queue.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          maxHeight: 280, overflowY: 'auto'
        }}>
          {queue.map((m, i) => (
            <QueuedMessageRow
              key={m.id}
              index={i}
              message={m}
              paused={deliveryPaused}
              onSendNow={() => releaseQueuedMessage(agent.id, m.id)}
              onRemove={() => removeQueuedMessage(agent.id, m.id)}
              onEdit={(text) => updateQueuedMessage(agent.id, m.id, text)}
            />
          ))}
        </div>
      )}

      {/* Free Flow recording / transcription status (entry point A) */}
      {ffHint && (
        <span style={{
          fontSize: 12, lineHeight: '16px',
          color: ff.error && !(ffMine && ff.status !== 'idle') ? 'var(--cth-coral)' : 'var(--cth-ink-500)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        }}>{ffHint}</span>
      )}

      {/* Attached files/images — chips with a remove 'x', above the textarea. */}
      {attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {attachments.map((a) => (
            <span
              key={a.path}
              title={a.path}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                maxWidth: '100%',
                padding: '2px 4px 2px 6px',
                background: 'var(--cth-cream-200)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
                color: 'var(--cth-ink-900)'
              }}
            >
              <Icon name="folder" />
              <span style={{
                overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: 180
              }}>{a.name}</span>
              {formatBytes(a.size) && (
                <span style={{ flexShrink: 0, color: 'var(--cth-ink-500)', fontSize: 11 }}>{formatBytes(a.size)}</span>
              )}
              <button
                onClick={() => removeAttachment(a.path)}
                title="Remove attachment"
                style={{
                  flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer',
                  color: 'var(--cth-ink-500)', padding: 0,
                  display: 'inline-flex', alignItems: 'center'
                }}
              >
                <Icon name="x" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Composer — full-width input above a single tidy control bar (cc-ui-polish),
          with file/image attachment chips + paste-to-attach (rich-composer). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea
          className="cth-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={5}
          placeholder={
            sendLater
              ? `Message ${agent.name}… (queued — delivers when ready)`
              : 'Describe the task for BeeYoncé… (Enter to dispatch)'
          }
          style={{
            width: '100%',
            resize: 'vertical',
            // Track the terminal's zoom (Cmd +/- or the terminal's own zoom
            // buttons) instead of a hardcoded 13px. On a large display the
            // terminal text scaled up while this box stayed tiny; box height is
            // derived from the same size so the visible line count is stable.
            minHeight: composerLineHeight * 5 + 14,
            maxHeight: composerLineHeight * 18,
            padding: '6px 8px',
            background: 'var(--cth-paper-100)',
            border: 'none',
            // Border lives in .cth-input so :focus can change it — an inline
            // boxShadow here would outrank the stylesheet and the focus state
            // would silently never apply.
            fontFamily: 'var(--cth-font-ui)',
            fontSize: composerFontSize, lineHeight: `${composerLineHeight}px`,
            color: 'var(--cth-ink-900)',
            outline: 'none',
            boxSizing: 'border-box'
          }}
        />
        {/* Control bar: Attach + voice + Send aligned right. flexWrap so a
            narrow sidebar wraps the buttons onto a second row instead of
            pushing Send off-screen. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, rowGap: 6, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ flex: 1 }} />
          <PixelButton variant="secondary" size="sm" onClick={pickFiles}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Icon name="plus" /> files
            </span>
          </PixelButton>
          {freeflowEnabled && <FreeFlowButton agentId={agent.id} hasGroqKey={hasGroqKey} />}
          <PixelButton variant="primary" size="sm" onClick={handleSend} disabled={!canSend}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {sendLater ? 'send later' : 'dispatch'} <Icon name="arrow-right" />
            </span>
          </PixelButton>
        </div>
      </div>
    </div>
  );
}

/** Poll the pty's automation block while there is something waiting on it. The
 * flag lives in the terminal pool (a plain module map, not the store), so there
 * is nothing to subscribe to — a 1s tick while the queue is pending is enough. */
function useTerminalBlock(ptyId: string | undefined, active: boolean): TerminalAutomationBlock {
  const [block, setBlock] = useState<TerminalAutomationBlock>(null);
  useEffect(() => {
    if (!ptyId || !active) { setBlock(null); return; }
    const read = () => setBlock(terminalAutomationBlockFor(ptyId));
    read();
    const iv = setInterval(read, 1000);
    return () => clearInterval(iv);
  }, [ptyId, active]);
  // 'settling' is a sub-second gap between writes — not worth telling anyone.
  return block === 'settling' ? null : block;
}

/** Poll the floor-wide auto-delivery pause (main-process control state) while
 * this agent has messages waiting. 2s is plenty — the pause flips on human
 * timescales, and the drain re-reads the live snapshot before every send. */
function useDeliveryPaused(agentId: string, active: boolean): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!active) { setPaused(false); return; }
    let alive = true;
    const read = () => {
      window.cth.controlSnapshot(agentId)
        .then((s) => { if (alive) setPaused(!!s?.autoDeliveryPaused); })
        .catch(() => { /* main not ready — assume not paused */ });
    };
    read();
    const iv = setInterval(read, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, [agentId, active]);
  return paused;
}

/**
 * One pending queue row. Collapsed it clamps to 2 lines; "see more" expands it
 * in place so a long message can be read without hovering for the tooltip. The
 * toggle only renders when the text actually clips, so short messages stay tidy.
 */
function QueuedMessageRow(
  { index, message, paused, onSendNow, onRemove, onEdit }: {
    index: number;
    message: QueuedMessage;
    /** Floor-wide auto-delivery is paused — offer the per-message override. */
    paused: boolean;
    onSendNow: () => void;
    onRemove: () => void;
    onEdit: (text: string) => void;
  }
) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  // Measure against the CLAMPED box, so the toggle survives being expanded (the
  // expanded box never overflows and would otherwise report clipped = false).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      if (expanded) return;
      setClipped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    // The panel is resizable — re-measure on width changes, not just text ones.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [message.text, expanded]);

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 6,
      padding: '4px 6px',
      background: 'var(--cth-paper-100)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
    }}>
      <span style={{
        fontFamily: 'var(--cth-font-ui)', fontSize: 12,
        color: 'var(--cth-ink-500)', lineHeight: '18px', flexShrink: 0
      }}>{`${index + 1}.`}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <textarea
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              style={{
                fontSize: 12, lineHeight: '18px', resize: 'vertical',
                minHeight: 60, width: '100%', boxSizing: 'border-box',
                border: '1px solid var(--cth-sky)', borderRadius: 2,
                background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
                fontFamily: 'var(--cth-font-ui)', padding: 4
              }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => { onEdit(editText.trim() || message.text); setEditing(false); }}
                style={{ border: 'none', background: 'var(--cth-sky)', cursor: 'pointer', padding: '2px 8px', fontSize: 11, borderRadius: 2, color: '#fff' }}>
                save
              </button>
              <button onClick={() => setEditing(false)}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            ref={bodyRef}
            title={expanded ? undefined : message.text}
            style={{
              fontSize: 12, lineHeight: '18px',
              color: 'var(--cth-ink-900)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              ...(expanded
                ? { maxHeight: 220, overflowY: 'auto' as const }
                : {
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  })
            }}
          >{message.text}</div>
        )}
        {!editing && (clipped || expanded || paused) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {(clipped || expanded) && (
              <button
                onClick={() => setExpanded((e) => !e)}
                title={expanded ? 'Collapse this message' : 'Show the full message'}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
                  color: 'var(--cth-ink-500)', textDecoration: 'underline'
                }}
              >{expanded ? 'see less' : 'see more'}</button>
            )}
            {paused && !message.manual && (
              <button
                onClick={onSendNow}
                title="Deliver this message even though auto-delivery is paused. It moves to the front of the queue and types in as soon as the terminal is free."
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
                  color: 'var(--cth-ink-900)', textDecoration: 'underline'
                }}
              >send now</button>
            )}
            {paused && message.manual && (
              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                sending when free…
              </span>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
        <button
          onClick={() => { setEditText(message.text); setEditing((e) => !e); }}
          title={editing ? 'Cancel edit' : 'Edit this queued message'}
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer',
            color: editing ? 'var(--cth-sky)' : 'var(--cth-ink-500)', padding: 0,
            display: 'inline-flex', alignItems: 'center'
          }}
        >
          <Icon name="edit" />
        </button>
        <button
          onClick={onRemove}
          title="Remove from queue"
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer',
            color: 'var(--cth-ink-500)', padding: 0,
            display: 'inline-flex', alignItems: 'center'
          }}
        >
          <Icon name="x" />
        </button>
      </div>
    </div>
  );
}


/**
 * Push-to-talk button for the queue composer. Click to start recording, click
 * again to stop → transcribe → the text is appended to this agent's draft. While
 * another agent is mid-dictation it's disabled (one shared recorder). The actual
 * capture + Groq call live in the freeflow recorder singleton.
 *
 * When no Groq key is configured the button stays visible but disabled, with a
 * tooltip pointing to Settings — it never starts a recording, so getUserMedia and
 * the Groq STT call are never reached (preserving the zero-call-when-unavailable
 * guarantee). `hasGroqKey` is boolean presence only; the key value never gets here.
 */
function FreeFlowButton({ agentId, hasGroqKey }: { agentId: string; hasGroqKey: boolean }) {
  const ff = useFreeflow();
  const mine = ff.targetAgentId === agentId;
  const recording = ff.status === 'recording' && mine;
  const transcribing = ff.status === 'transcribing' && mine;
  // Block while another agent's clip is recording/uploading (single recorder).
  const busyElsewhere = ff.status !== 'idle' && !mine;
  const noKey = !hasGroqKey;

  const hintRef = useRef<HTMLSpanElement | null>(null);
  const iconRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState<{ left: number; top: number } | null>(null);
  const hintOpen = hint !== null;

  const HINT_W = 244;
  const HINT_GAP = 8;
  const EST_H = 188;

  const title = noKey
    ? 'Dictation needs a free Groq API key. Click the info mark for the steps.'
    : recording ? 'Stop & transcribe'
    : transcribing ? 'Transcribing…'
    : 'Free Flow — dictate into the queue. Click, or hold Option (⌥).';

  /** Same placement rule as RealtimeAbathurToggle's hint: prefer above (the
   *  composer sits low in the panel), flip below only when there is no room, and
   *  clamp both axes so it can never hang off an edge. */
  const toggleHint = (e: ReactMouseEvent): void => {
    e.stopPropagation();
    if (hint) { setHint(null); return; }
    const r = iconRef.current?.getBoundingClientRect();
    if (!r) return;
    const above = r.top - HINT_GAP - EST_H;
    const top = above >= 8 ? above : Math.min(r.bottom + HINT_GAP, window.innerHeight - EST_H - 8);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - HINT_W - 8));
    setHint({ left, top: Math.max(8, top) });
  };

  useEffect(() => {
    if (!hintOpen) return;
    const onDown = (ev: globalThis.MouseEvent): void => {
      const t = ev.target as Node;
      // Portalled, so an inside-click has to be tested against BOTH nodes.
      if (hintRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setHint(null);
    };
    const onKey = (ev: globalThis.KeyboardEvent): void => { if (ev.key === 'Escape') setHint(null); };
    const onReflow = (): void => setHint(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [hintOpen]);

  const openKeySettings = (e: ReactMouseEvent): void => {
    e.stopPropagation();
    setHint(null);
    window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'Voice' } }));
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: noKey ? 4 : 0, minWidth: 0 }}>
      {/* Wrap in a (non-disabled) span so the native tooltip still shows on hover
          even when the inner button is disabled — Chromium suppresses tooltips on
          a disabled <button> itself. */}
      <span title={title} style={{ display: 'inline-flex' }}>
        <PixelButton
          variant={recording ? 'destructive' : 'secondary'}
          size="sm"
          onClick={() => { if (noKey) return; freeflowRecorder.toggle(agentId); }}
          disabled={noKey || transcribing || busyElsewhere}
        >
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Icon name="mic" />
            {transcribing ? '…' : recording ? 'stop' : 'voice'}
          </span>
        </PixelButton>
      </span>

      {/* A missing key is a SETUP STATE, not a failure — the same treatment Talk
          already gets. Without this the button is simply dead on click, and the
          two facts that would make someone act (it is FREE, and there is a
          hold-to-talk shortcut) were written down nowhere in the UI. */}
      {noKey && (
        <span ref={hintRef} style={{ display: 'inline-flex', flexShrink: 0 }}>
          <button
            ref={iconRef}
            type="button"
            aria-label="How do I enable dictation?"
            aria-expanded={hintOpen}
            onClick={toggleHint}
            style={{
              border: 'none', background: 'none', padding: 0, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center',
              color: 'var(--cth-ink-500)',
              opacity: hintOpen ? 1 : 0.75
            }}
          >
            <Icon name="info" />
          </button>

          {hint && createPortal(
            <div
              ref={panelRef}
              role="dialog"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed', left: hint.left, top: hint.top, zIndex: 460,
                width: HINT_W, padding: '10px 12px', boxSizing: 'border-box',
                display: 'flex', flexDirection: 'column', gap: 7,
                background: 'var(--cth-paper-100)',
                boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500), 4px 4px 0 rgba(26,19,32,0.25)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '15px',
                color: 'var(--cth-ink-900)', textAlign: 'left', whiteSpace: 'normal'
              }}
            >
              <span style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 13, letterSpacing: 0.5,
                textTransform: 'uppercase', color: 'var(--cth-ink-500)'
              }}>Set up dictation</span>

              {/* Lead with the cost, because "add an API key" reads as "this will
                  bill me" and that assumption is what stops people here. */}
              <span>
                Speak instead of typing. Groq transcribes it, and their free tier
                covers this — <strong>no card, no cost</strong>.
              </span>

              <ol style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <li>
                  Create a free key at{' '}
                  <a
                    href="https://console.groq.com/keys"
                    onClick={(e) => { e.preventDefault(); void window.cth.openExternal('https://console.groq.com/keys'); }}
                    style={{ color: 'var(--cth-ink-900)' }}
                  >console.groq.com/keys</a>
                </li>
                <li>Paste it into Settings → Voice → Groq API key</li>
                <li>Click <strong>voice</strong>, or hold the <strong>right Option</strong> key to talk</li>
              </ol>

              <span style={{ color: 'var(--cth-ink-500)' }}>
                Hold it ALONE for a moment to start; release to transcribe into
                the composer, where you can edit before sending. Either Option key
                works, and Option+key combos still reach the terminal untouched.
              </span>

              <button
                type="button"
                onClick={openKeySettings}
                style={{
                  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                  alignSelf: 'flex-start',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '15px',
                  color: 'var(--cth-ink-900)', textDecoration: 'underline'
                }}
              >set it up now</button>
            </div>,
            document.body
          )}
        </span>
      )}
    </span>
  );
}
