import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PixelPanel } from './PixelPanel';
import { PixelBadge, type StatusKind } from './PixelBadge';
import { SpritePortrait } from './SpritePortrait';
import { RealtimeAbathurToggle } from './RealtimeAbathurToggle';
import { CostHud } from '@/realtime/CostHud';
import { AgentNameEditor } from './AgentNameEditor';
import { Icon } from './Icon';
import { useHasTerminalDraft } from './terminalPool';
import { inferAgentProvider, providerPreset, type AgentProvider } from '@/store/config';
import { AccentColorName } from '@/design/tokens';
import { OfficeCharacterName } from '@/scene/office/cast';
import { type Agent } from '@/store/store';
import { useTerminalFontSize } from './terminalFontSize';

/** Block-character sparkline of recent token deltas — neo-brutalist mono. */
function Sparkline({ series }: { series: number[] }) {
  const blocks = ' ▂▃▄▅▆▇█';
  const max = Math.max(1, ...series);
  const text = series.length
    ? series.map((v) => blocks[Math.min(blocks.length - 1, Math.round((v / max) * (blocks.length - 1)))]).join('')
    : '      ';
  return (
    <span style={{ flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '12px', color: 'var(--cth-sky)', whiteSpace: 'nowrap', overflow: 'hidden', minWidth: 0 }}>
      {text}
    </span>
  );
}

/** Per-agent token-limit control (top-right of each agent card). Shows the
 *  current limit as a lemon chip, or "set limit"; click to edit a token number.
 *  Enter / ✓ / blur commit; Escape cancels. */
function TokenLimitEditor({ value, onSet }: { value?: number; onSet: (tokens: number | undefined) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value != null ? String(value) : '');
  const skipBlur = useRef(false);
  const commit = () => {
    const raw = text.trim();
    const n = raw === '' ? undefined : Number(raw);
    onSet(typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
    setEditing(false);
  };
  if (!editing) {
    return (
      <button
        onClick={() => { setText(value != null ? String(value) : ''); setEditing(true); }}
        title="Set this agent's total token limit"
        style={{
          flexShrink: 0, padding: '1px 6px', border: 'none', cursor: 'pointer',
          background: value && value > 0 ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
          boxShadow: `inset 0 0 0 1px ${value && value > 0 ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)'
        }}
      >{value && value > 0
        ? <>limit <span style={{ fontFamily: 'var(--cth-font-ui)' }}>{fmtTokens(value)}</span></>
        : 'set limit'}</button>
    );
  }
  return (
    <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <input
        type="number" min="0" step="100000" value={text} autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') { skipBlur.current = true; setEditing(false); }
        }}
        onBlur={() => { if (skipBlur.current) { skipBlur.current = false; return; } commit(); }}
        placeholder="tokens"
        style={{
          width: 84, padding: '2px 4px', background: 'var(--cth-paper-100)', border: 'none',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)',
          fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
        }}
      />
      <button
        onClick={commit}
        style={{
          border: 'none', background: 'var(--cth-green)', color: 'var(--cth-paper-100)',
          cursor: 'pointer', padding: '2px 6px', fontSize: 13, lineHeight: '13px'
        }}
      >✓</button>
    </span>
  );
}

export type RosterVariant = 'card' | 'rail' | 'command-center';

export interface RowDragHandlers {
  dragId: string | null;
  overId: string | null;
  start: (id: string) => void;
  over: (id: string) => void;
  leave: (id: string) => void;
  drop: (id: string) => void;
  end: () => void;
}

export interface AgentRosterItemProps {
  /** Visual presentation variant:
   *  - 'card' (default): bottom dock 2-row card with gauge and lift
   *  - 'rail': fullscreen/focus mode left rail sidebar row
   *  - 'command-center': detailed fleet list row with spend & telemetry
   */
  variant?: RosterVariant;
  agent?: Agent;

  // Explicit fields (overrides or standalone usage)
  agentId?: string;
  name?: string;
  character?: OfficeCharacterName;
  accent?: AccentColorName;
  status?: StatusKind;
  ptyId?: string;
  project?: string;
  cwd?: string;
  worktreePath?: string;
  action?: string;
  progress?: number;
  contextTokens?: number;
  contextLimit?: number;
  selected?: boolean;
  active?: boolean;
  isOvermind?: boolean;
  note?: string;
  onHold?: boolean;
  command?: string;
  provider?: AgentProvider;
  model?: string;
  profileId?: string;
  profileLabel?: string;
  recentTextTs?: number | null;

  // Badges & Telemetry
  quotaLimited?: boolean;
  needsInput?: string;
  lastTool?: string;
  lastActivityTs?: number | null;
  doingCount?: number;
  armed?: boolean;
  breaker?: { level?: string; reason?: string };

  // Callbacks
  onClick?: () => void;
  onRename?: (name: string) => Promise<{ ok: boolean; error?: string }>;
  onTaskNoteClick?: () => void;
  onEditNote?: () => void;
  onNoteChange?: (note: string) => void;
  onRespawn?: (agentId: string) => void;
  draggable?: boolean;

  // Rail variant options
  scale?: { portrait: number; portraitScale: number; name: number; note: number; group?: number };
  drag?: RowDragHandlers;

  // Command-center variant options
  toolCount?: number;
  agentCap?: number;
  onSetAgentCap?: (cap: number | undefined) => void;
  floorCap?: number;
  sparkSeries?: number[];
  rateVal?: number;
  tokens?: number;
  currentModelKnown?: boolean;
  onSelectModel?: (modelId: string) => void;
  children?: ReactNode;
}

const fmtK = (n: number): string => `${Math.round(n / 1000)}k`;

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function shortModel(model: string | undefined): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, '').replace(/\[[^\]]*\]$/, '').trim() || null;
}

const IDLE_STALE_MS = 2 * 60 * 60 * 1000;

function formatAgo(ts: number | null | undefined, now: number): string | null {
  if (!ts) return null;
  const diff = Math.max(0, now - ts);
  if (diff < 45_000) return 'just now';
  if (diff < 90_000) return '1 min ago';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 48) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(diff / 86_400_000);
  return `${days} d ago`;
}

function basename(p: string | undefined): string {
  if (!p) return '';
  return p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? p;
}

export function AgentRosterItem({
  variant = 'card',
  agent,
  agentId: explicitAgentId,
  name: explicitName,
  character: explicitCharacter,
  accent: explicitAccent,
  status: explicitStatus,
  ptyId: explicitPtyId,
  project: explicitProject,
  cwd: explicitCwd,
  worktreePath: explicitWorktreePath,
  action: explicitAction,
  progress: explicitProgress,
  contextTokens: explicitContextTokens,
  contextLimit: explicitContextLimit,
  selected: explicitSelected,
  active: explicitActive,
  isOvermind: explicitIsOvermind,
  note: explicitNote,
  onHold: explicitOnHold,
  command: explicitCommand,
  provider: explicitProvider,
  model: explicitModel,
  profileId: explicitProfileId,
  profileLabel,
  recentTextTs: explicitRecentTextTs,
  quotaLimited,
  needsInput,
  lastTool,
  lastActivityTs: explicitLastActivityTs,
  doingCount = 0,
  armed: explicitArmed,
  breaker,
  onClick,
  onRename,
  onTaskNoteClick,
  onEditNote,
  onNoteChange,
  onRespawn,
  draggable,
  scale,
  drag,
  toolCount = 0,
  agentCap,
  onSetAgentCap,
  floorCap = 100_000,
  sparkSeries,
  rateVal,
  tokens: explicitTokens,
  currentModelKnown,
  onSelectModel,
  children
}: AgentRosterItemProps) {
  // Resolve props between explicit fields and passed agent object
  const agentId = explicitAgentId ?? agent?.id ?? '';
  const name = explicitName ?? agent?.name ?? '';
  const character = explicitCharacter ?? agent?.character ?? 'meredith';
  const accent = explicitAccent ?? agent?.accent ?? 'honey';
  const rawStatus = explicitStatus ?? agent?.status ?? 'idle';
  const ptyId = explicitPtyId ?? agent?.ptyId;
  const project = explicitProject ?? agent?.project ?? '';
  const cwd = explicitCwd ?? agent?.cwd ?? '';
  const worktreePath = explicitWorktreePath ?? agent?.worktreePath;
  const action = explicitAction ?? agent?.action;
  const progress = explicitProgress ?? agent?.progress ?? 0;
  const contextTokens = explicitContextTokens ?? agent?.contextTokens;
  const contextLimit = explicitContextLimit ?? agent?.contextLimit;
  const isSelected = explicitSelected ?? explicitActive ?? false;
  const isOvermind = explicitIsOvermind ?? agent?.isOvermind ?? false;
  const note = explicitNote ?? agent?.note ?? '';
  const onHold = explicitOnHold ?? agent?.onHold ?? false;
  const command = explicitCommand ?? agent?.command;
  const provider = explicitProvider ?? agent?.provider;
  const model = explicitModel ?? agent?.model;
  const profileId = explicitProfileId ?? agent?.profileId;
  const recentTextTs = explicitRecentTextTs ?? agent?.recentTextTs;

  const [hover, setHover] = useState(false);
  const typing = useHasTerminalDraft(ptyId);
  const prov = inferAgentProvider(command, provider);
  const isNonClaude = prov !== 'claude';
  const preset = providerPreset(prov);

  // Compacting & badge status resolution
  const compacting = rawStatus === 'compacting'
    || ((rawStatus === 'working' || rawStatus === 'thinking')
        && /compact/i.test(`${action ?? ''} ${lastTool ?? ''}`));
  const isArmed = explicitArmed || (!!breaker && (breaker.level === 'constrained' || breaker.level === 'stopped'));
  const badgeStatus: StatusKind = typing ? 'typing' : compacting ? 'compacting' : isArmed ? 'looping' : rawStatus;

  // Stale idle calculation
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const lastActivityTs = explicitLastActivityTs ?? recentTextTs ?? null;
  const activityLabel = formatAgo(lastActivityTs, now);
  const idleMs = rawStatus === 'idle' && !isOvermind && doingCount === 0 && lastActivityTs
    ? Math.max(0, now - lastActivityTs)
    : 0;
  const idleStaleLabel = idleMs >= IDLE_STALE_MS ? `idle ${Math.floor(idleMs / 3_600_000)}h` : null;
  const modelLabel = shortModel(model);

  // Common respawn handler
  const doRespawn = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!window.confirm(`Respawn ${name}? This will archive the current session and start a fresh one. It will resume from memory.md.`)) return;
    if (onRespawn && agentId) {
      onRespawn(agentId);
      return;
    }
    if (!agentId) return;
    try {
      const res = await window.cth.respawnAgent(agentId);
      if (res && !res.ok) console.error('[respawn] failed:', res.error);
    } catch (err) {
      console.error('[respawn] error:', err);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // VARIANT 1: CARD (Bottom bar horizontal dock / mobile stack)
  // ─────────────────────────────────────────────────────────────────────────────
  if (variant === 'card') {
    const width = 248;
    const height = isOvermind ? 82 : 72;
    const lift = (isOvermind ? -2 : 0) - (hover ? 1 : 0) - (isSelected ? 1 : 0);
    const selectionRing = isSelected ? '0 0 0 2px var(--cth-ink-900)' : '';
    const godSurface: CSSProperties = isOvermind
      ? {
          background: `var(--cth-${accent}-light)`,
          boxShadow: `inset 0 0 0 1px var(--cth-${accent})`
        }
      : {};
    const dropShadow = isOvermind
      ? `2px 3px 0 0 rgba(26,19,32,${hover ? 0.2 : 0.14})`
      : (hover ? '1px 2px 0 0 rgba(26,19,32,0.12)' : 'none');
    const outerShadow = [selectionRing, dropShadow === 'none' ? '' : dropShadow]
      .filter(Boolean).join(', ') || 'none';

    const infoLine = (rawStatus !== 'idle' && action) ? action : project;
    const noteFirstLine = (note ?? '').split('\n').find((l) => l.trim()) ?? '';

    const pct = Math.min(8, Math.max(0, progress)) / 8 * 100;
    const gaugeColor = progress >= 7 ? 'var(--cth-coral)'
      : progress >= 6 ? 'var(--cth-lemon)'
      : `var(--cth-${accent})`;
    const gaugeTitle = contextTokens !== undefined && contextLimit
      ? `Context: ${fmtK(contextTokens)} / ${fmtK(contextLimit)} tokens (${Math.round((contextTokens / contextLimit) * 100)}%)`
      : 'Context gauge — fills once the agent reports activity';

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onClick?.();
          }
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        draggable={draggable}
        aria-current={isSelected ? 'true' : undefined}
        className="cth-titlebar-nodrag"
        style={{
          width, minWidth: width, height,
          padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
          position: 'relative',
          transform: lift ? `translateY(${lift}px)` : 'none',
          boxShadow: outerShadow,
          transition: 'transform 90ms steps(2, end), box-shadow 90ms steps(2, end)'
        }}
      >
        {doingCount > 0 && (
          <span
            title={`actively working ${doingCount} task${doingCount === 1 ? '' : 's'} — click to open`}
            onClick={(e) => { e.stopPropagation(); onTaskNoteClick?.(); }}
            style={{
              position: 'absolute', right: -4, bottom: -5, zIndex: 2,
              width: 20, height: 18,
              background: 'var(--cth-sky)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300), 1px 2px 0 rgba(26,19,32,0.18)',
              transform: 'rotate(4deg)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)',
              cursor: 'pointer'
            }}
          >
            {doingCount > 1 ? doingCount : '✎'}
          </span>
        )}
        <PixelPanel
          variant="default"
          style={{ height: '100%', padding: '6px 8px', ...godSurface }}
          noPadding
        >
          <div style={{ display: 'flex', gap: 8, height: '100%' }}>
            <div style={{
              width: 36, height: isOvermind ? 50 : 46, alignSelf: 'center',
              background: isOvermind ? 'var(--cth-paper-100)' : `var(--cth-${accent}-light)`,
              boxShadow: `inset 0 0 0 1px var(--cth-ink-${isOvermind ? '300' : '100'})`,
              display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'hidden',
              flexShrink: 0
            }}>
              <SpritePortrait character={character} agentId={agentId} isGod={isOvermind} scale={2} />
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              {/* Identity row: name (+ BOSS tag) + status + badges */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between', minWidth: 0 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1 }}>
                  {onRename ? (
                    <span style={{ flex: 1, minWidth: 64, display: 'flex' }}>
                      <AgentNameEditor name={name} onCommit={onRename} uppercase />
                    </span>
                  ) : (
                    <span style={{
                      fontFamily: 'var(--cth-font-ui)',
                      fontSize: 'var(--cth-text-display-sm)',
                      lineHeight: 'var(--cth-lh-display-sm)',
                      color: 'var(--cth-ink-900)',
                      flex: 1, minWidth: 0,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                    }}>{name.toUpperCase()}</span>
                  )}
                  {isOvermind && (
                    <span style={{
                      fontFamily: 'var(--cth-font-ui)', fontSize: 7, lineHeight: '11px',
                      background: `var(--cth-${accent})`, color: 'var(--cth-ink-900)',
                      padding: '1px 4px 0', flexShrink: 0
                    }}>BOSS</span>
                  )}
                  {isNonClaude && (
                    <span title={`Engine: ${preset.label}`} style={{
                      fontFamily: 'var(--cth-font-ui)', fontSize: 8, lineHeight: '11px',
                      background: 'var(--cth-sky-light)', color: 'var(--cth-ink-900)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-sky)',
                      padding: '1px 4px 0', flexShrink: 0, textTransform: 'uppercase',
                      fontWeight: 600
                    }}>{prov === 'antigravity' ? 'AGY' : preset.label}</span>
                  )}
                </span>
                <PixelBadge status={badgeStatus} style={{ flexShrink: 0 }} />
                {needsInput && (
                  <span title={`Blocked on an interactive prompt — click the card to answer: ${needsInput}`} style={{
                    flexShrink: 0,
                    fontFamily: 'var(--cth-font-ui)', fontSize: 7, lineHeight: '11px',
                    padding: '1px 4px 0', textTransform: 'uppercase', fontWeight: 600,
                    background: 'var(--cth-salmon, #f47d55)', color: 'var(--cth-ink-900)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
                  }}>⌨ needs input</span>
                )}
                {quotaLimited && (
                  <span title="Hit provider quota / rate limit — re-route or respawn on another profile" style={{
                    flexShrink: 0,
                    fontFamily: 'var(--cth-font-ui)', fontSize: 7, lineHeight: '11px',
                    padding: '1px 4px 0', textTransform: 'uppercase', fontWeight: 600,
                    background: 'var(--cth-coral)', color: 'var(--cth-paper-100)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
                  }}>⊘ quota</span>
                )}
                {idleStaleLabel && (
                  <span title={`Idle with no active task for ${idleStaleLabel.replace('idle ', '')} — reaping candidate (send home to save tokens)`} style={{
                    flexShrink: 0,
                    fontFamily: 'var(--cth-font-ui)', fontSize: 7, lineHeight: '11px',
                    padding: '1px 4px 0', textTransform: 'uppercase',
                    background: 'var(--cth-coral-light)', color: 'var(--cth-ink-900)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-coral)'
                  }}>{idleStaleLabel}</span>
                )}
                {onHold && (
                  <span title="Human has this agent 1:1 — floor automation paused" style={{
                    flexShrink: 0,
                    fontFamily: 'var(--cth-font-ui)', fontSize: 7, lineHeight: '11px',
                    padding: '1px 4px 0',
                    background: 'var(--cth-lemon)', color: 'var(--cth-ink-900)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                  }}>1:1</span>
                )}
                {agentId && (
                  <button
                    type="button"
                    title={`Respawn ${name} (archive session & start fresh from memory.md)`}
                    aria-label={`Respawn ${name}`}
                    onClick={doRespawn}
                    style={{
                      flexShrink: 0,
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontFamily: 'var(--cth-font-ui)',
                      fontSize: 12,
                      lineHeight: '12px',
                      color: 'var(--cth-ink-500)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >↺</button>
                )}
              </div>

              {/* Status row: action/project + model chip + activity */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
                fontSize: 12, lineHeight: '15px', color: 'var(--cth-ink-500)'
              }}>
                <span
                  title={`${project}${action && rawStatus !== 'idle' ? ` — ${action}` : ''}${isNonClaude ? ` · Engine: ${preset.label}` : ''}`}
                  style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >{infoLine}</span>
                {modelLabel && (
                  <span title={`Model: ${model}`} style={{
                    flexShrink: 0, maxWidth: 92,
                    fontFamily: 'var(--cth-font-ui)', fontSize: 8, lineHeight: '11px',
                    padding: '1px 4px 0',
                    background: 'var(--cth-cream-200)', color: 'var(--cth-ink-700)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>{modelLabel}</span>
                )}
                {activityLabel && (
                  <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }} title={lastActivityTs ? new Date(lastActivityTs).toLocaleString() : undefined}>
                    <Icon name="clock" size={1} style={{ color: 'var(--cth-ink-500)' }} />
                    {activityLabel}
                  </span>
                )}
              </div>

              {/* Interactive row: God voice toggle OR Note row */}
              {isOvermind ? (
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    minWidth: 0, overflow: 'hidden'
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <RealtimeAbathurToggle />
                  <CostHud compact />
                </div>
              ) : (noteFirstLine || (onEditNote && hover)) ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                  {noteFirstLine ? (
                    <span
                      title={note}
                      style={{
                        flex: 1, minWidth: 0, fontSize: 12, lineHeight: '16px',
                        color: 'var(--cth-ink-500)', fontStyle: 'italic',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                      }}
                    >{noteFirstLine}</span>
                  ) : <span style={{ flex: 1 }} />}
                  {onEditNote && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); onEditNote(); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onEditNote(); }
                      }}
                      title={note ? 'Edit private note' : 'Add private note'}
                      aria-label={`Edit note for ${name}`}
                      style={{
                        flexShrink: 0, width: 15, height: 14,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 13, lineHeight: 1, cursor: 'pointer',
                        color: 'var(--cth-ink-500)'
                      }}
                    >✎</span>
                  )}
                </div>
              ) : null}

              {/* Context gauge */}
              <div style={{ marginTop: 'auto' }} title={gaugeTitle}>
                <div style={{
                  height: 4, width: '100%',
                  background: 'var(--cth-cream-200)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  overflow: 'hidden'
                }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: gaugeColor }} />
                </div>
              </div>
            </div>
          </div>
        </PixelPanel>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // VARIANT 2: RAIL (Fullscreen / Focus mode left sidebar row)
  // ─────────────────────────────────────────────────────────────────────────────
  if (variant === 'rail') {
    const buttonRef = useRef<HTMLButtonElement>(null);
    const noteRef = useRef<HTMLDivElement>(null);
    const [notePosition, setNotePosition] = useState<{ left: number; top: number } | null>(null);

    const termFontSize = useTerminalFontSize();
    const noteFontSize = Math.min(termFontSize, 14);
    const noteLabelSize = Math.max(8, Math.round(noteFontSize * 0.6));
    const noteWidth = Math.min(300, Math.round(noteFontSize * 20));
    const noteHeight = Math.round(noteFontSize * 9);
    const popoverHeight = noteHeight + noteLabelSize * 2 + 40;

    const bullets = (note ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    const activeScale = scale ?? { portrait: 28, portraitScale: 1.75, name: 13, note: 13, group: 11 };

    const toggleEditor = () => {
      if (notePosition) { setNotePosition(null); return; }
      if (drag?.dragId) return;
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setNotePosition({
        left: Math.min(rect.right + 6, window.innerWidth - noteWidth - 8),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - popoverHeight - 8))
      });
    };

    const isClaude = !isNonClaude;
    const modelDisplayText = model ? shortModel(model) : (isClaude ? 'CLI default' : preset.label);
    const engineTooltip = model
      ? `Model: ${model} (${preset.label})`
      : (isClaude ? 'Runs the CLI default model' : `Engine: ${preset.label}`);

    const tokensCount = contextTokens ?? 0;
    const limitCount = contextLimit ?? 200_000;
    const ctxPct = Math.min(100, Math.round((tokensCount / limitCount) * 100));
    const ctxColor = ctxPct >= 88 ? 'var(--cth-coral)' : ctxPct >= 75 ? 'var(--cth-lemon)' : `var(--cth-${accent})`;

    return (
      <>
        <button
          ref={buttonRef}
          draggable
          onDragStart={(e) => { if (drag) { drag.start(agentId); e.dataTransfer.effectAllowed = 'move'; } }}
          onDragOver={(e) => {
            if (!drag?.dragId || drag.dragId === agentId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            drag.over(agentId);
          }}
          onDragLeave={() => drag?.leave(agentId)}
          onDrop={(e) => { e.preventDefault(); drag?.drop(agentId); }}
          onDragEnd={drag?.end}
          onClick={onClick}
          aria-label={`${name} · ${project}`}
          aria-current={isSelected ? 'true' : undefined}
          style={{
            width: '100%',
            padding: '6px 8px',
            background: isSelected ? 'var(--cth-cream-100)' : 'transparent',
            border: 'none',
            boxShadow: isSelected
              ? 'inset 3px 0 0 var(--cth-ink-900), inset 0 0 0 1px var(--cth-ink-100)'
              : drag?.overId === agentId && drag?.dragId && drag.dragId !== agentId
              ? 'inset 0 2px 0 var(--cth-ink-900)'
              : 'none',
            opacity: drag?.dragId === agentId ? 0.4 : 1,
            display: 'flex', alignItems: 'flex-start', gap: 8,
            cursor: drag?.dragId ? 'grabbing' : 'grab',
            position: 'relative',
            textAlign: 'left',
            fontFamily: 'var(--cth-font-ui)', fontSize: 13,
            color: 'var(--cth-ink-900)',
            transition: 'opacity 120ms ease'
          }}
        >
          <div style={{
            width: activeScale.portrait, height: Math.round(activeScale.portrait * 1.3), flexShrink: 0,
            background: `var(--cth-${accent}-light)`,
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            overflow: 'hidden'
          }}>
            <SpritePortrait character={character} scale={activeScale.portraitScale} />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{
                flex: 1, minWidth: 0,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                fontFamily: 'var(--cth-font-ui)',
                fontSize: activeScale.name, lineHeight: 1.5
              }}>{name.toUpperCase()}</span>
              {isOvermind && (
                <span style={{
                  flexShrink: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 7, lineHeight: '11px',
                  background: `var(--cth-${accent})`, color: 'var(--cth-ink-900)',
                  padding: '1px 4px 0'
                }}>BOSS</span>
              )}
              {isNonClaude && (
                <span title={`Engine: ${preset.label}`} style={{
                  flexShrink: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 8, lineHeight: '11px',
                  background: 'var(--cth-sky-light)', color: 'var(--cth-ink-900)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-sky)',
                  padding: '1px 4px 0', textTransform: 'uppercase', fontWeight: 600
                }}>{prov === 'antigravity' ? 'AGY' : preset.label}</span>
              )}
              <PixelBadge status={badgeStatus} />
              {needsInput && (
                <span title={`Blocked on an interactive prompt — click the card to answer: ${needsInput}`} style={{
                  flexShrink: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 7, lineHeight: '11px',
                  padding: '1px 4px 0', textTransform: 'uppercase', fontWeight: 600,
                  background: 'var(--cth-salmon, #f47d55)', color: 'var(--cth-ink-900)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
                }}>⌨ needs input</span>
              )}
              {quotaLimited && (
                <span title="Hit provider quota / rate limit — re-route or respawn on another profile" style={{
                  flexShrink: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 7, lineHeight: '11px',
                  padding: '1px 4px 0', textTransform: 'uppercase', fontWeight: 600,
                  background: 'var(--cth-coral)', color: 'var(--cth-paper-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
                }}>⊘ quota</span>
              )}
              {idleStaleLabel && (
                <span title={`Idle with no active task for ${idleStaleLabel.replace('idle ', '')} — reaping candidate (send home to save tokens)`} style={{
                  flexShrink: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 7, lineHeight: '11px',
                  padding: '1px 4px 0', textTransform: 'uppercase',
                  background: 'var(--cth-coral-light)', color: 'var(--cth-ink-900)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-coral)'
                }}>{idleStaleLabel}</span>
              )}
              {onHold && (
                <span title="Human has this agent 1:1 — floor automation paused" style={{
                  flexShrink: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 7, lineHeight: '11px',
                  padding: '1px 4px 0',
                  background: 'var(--cth-lemon)', color: 'var(--cth-ink-900)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}>1:1</span>
              )}
              {!isOvermind && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); void doRespawn(e); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); void doRespawn(); }
                  }}
                  title={`Respawn ${name} (archive session & start fresh from memory.md)`}
                  aria-label={`Respawn ${name}`}
                  style={{
                    flexShrink: 0, width: 20, height: 20,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, lineHeight: 1, color: 'var(--cth-ink-500)',
                    background: 'var(--cth-paper-100)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                    cursor: 'pointer'
                  }}
                >↺</span>
              )}
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); toggleEditor(); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); toggleEditor(); }
                }}
                title={note ? 'Edit private note' : 'Add private note'}
                aria-label={`Edit note for ${name}`}
                style={{
                  flexShrink: 0, width: 20, height: 20,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, lineHeight: 1, color: 'var(--cth-ink-500)',
                  background: notePosition ? 'var(--cth-cream-200)' : 'var(--cth-paper-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  cursor: 'pointer'
                }}
              >✎</span>
            </div>

            {/* Profile · Model · Repo line */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
              fontSize: Math.max(11, activeScale.name - 2), lineHeight: 1.4,
              color: 'var(--cth-ink-500)'
            }}>
              {profileLabel && (
                <span title={`Profile: ${profileLabel}`} style={{
                  flexShrink: 0, maxWidth: '46%',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 8, lineHeight: '11px',
                  padding: '1px 4px 0', textTransform: 'uppercase', fontWeight: 600,
                  background: 'var(--cth-sky-light)', color: 'var(--cth-ink-900)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-sky)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}>{profileLabel}</span>
              )}
              <span style={{
                flexShrink: 0, maxWidth: '52%',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                color: !isClaude ? 'var(--cth-ink-700)' : undefined,
                fontWeight: !isClaude ? 500 : undefined
              }} title={engineTooltip}>
                {modelDisplayText}
              </span>
              <span style={{ flexShrink: 0, opacity: 0.5 }}>·</span>
              <span style={{
                flex: 1, minWidth: 0,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }} title={worktreePath || cwd}>
                {basename(worktreePath || cwd) || project}
              </span>
            </div>

            {/* Active action text */}
            {(rawStatus === 'working' || rawStatus === 'thinking') && action && (
              <span
                title={action}
                style={{
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: Math.max(8, activeScale.name - 4), lineHeight: 1.35,
                  color: 'var(--cth-ink-400, var(--cth-ink-500))',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  minWidth: 0
                }}
              >{action}</span>
            )}

            {/* Context gauge */}
            <div
              title={`Context: ${fmtK(tokensCount)} / ${fmtK(limitCount)} tokens (${ctxPct}%)`}
              style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}
            >
              <span style={{
                flex: 1, minWidth: 0, height: 3,
                background: 'var(--cth-ink-100)', overflow: 'hidden'
              }}>
                <span style={{ display: 'block', width: `${ctxPct}%`, height: '100%', background: ctxColor }} />
              </span>
              <span style={{ flexShrink: 0, fontSize: 13, color: 'var(--cth-ink-500)' }}>{ctxPct}%</span>
            </div>

            {/* Bullets / Notes */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {bullets.map((line, i) => (
                <span
                  key={i}
                  title={line}
                  style={{
                    display: 'flex', gap: 5, alignItems: 'baseline',
                    fontSize: activeScale.note, lineHeight: 1.35,
                    color: 'var(--cth-ink-500)'
                  }}
                >
                  <span style={{ flexShrink: 0, color: 'var(--cth-ink-300)' }}>•</span>
                  <span style={{
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>{line}</span>
                </span>
              ))}
              {bullets.length === 0 && (
                <span style={{
                  fontSize: activeScale.note, lineHeight: 1.35,
                  color: 'var(--cth-ink-300)', fontStyle: 'italic'
                }}>no note</span>
              )}
            </div>
          </div>
        </button>

        {notePosition && createPortal(
          <>
            <div
              onClick={() => setNotePosition(null)}
              style={{ position: 'fixed', inset: 0, zIndex: 449, background: 'transparent' }}
            />
            <div
              ref={noteRef}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: notePosition.left,
                top: notePosition.top,
                width: noteWidth,
                zIndex: 450,
                padding: 8,
                background: 'var(--cth-paper-100)',
                boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500), 4px 4px 0 rgba(26,19,32,0.25)',
                boxSizing: 'border-box'
              }}
            >
              <div style={{
                marginBottom: 6,
                fontFamily: 'var(--cth-font-ui)',
                fontSize: noteLabelSize,
                lineHeight: `${Math.round(noteLabelSize * 1.5)}px`,
                color: 'var(--cth-ink-700)'
              }}>PRIVATE NOTE</div>
              <textarea
                autoFocus
                value={note}
                onChange={(e) => onNoteChange?.(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape') {
                    setNotePosition(null);
                    buttonRef.current?.focus();
                  }
                }}
                placeholder="one line per bullet…"
                aria-label={`Note for ${name}`}
                style={{
                  width: '100%',
                  height: noteHeight,
                  padding: '5px 7px',
                  border: 'none',
                  outline: 'none',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                  background: 'var(--cth-cream-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: noteFontSize,
                  lineHeight: `${Math.round(noteFontSize * 1.6)}px`,
                  color: 'var(--cth-ink-900)'
                }}
              />
              <div style={{
                marginTop: 5, fontSize: 13, color: 'var(--cth-ink-500)'
              }}>one line = one bullet · esc to close</div>
            </div>
          </>,
          document.body
        )}
      </>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // VARIANT 3: COMMAND-CENTER (Detailed Fleet section in CommandCenterPanel)
  // ─────────────────────────────────────────────────────────────────────────────
  const totalTokens = explicitTokens ?? 0;
  const denom = agentCap && agentCap > 0 ? agentCap : floorCap;
  const budgetPct = Math.min(100, Math.round((totalTokens / denom) * 100));
  const meterColor = isArmed || budgetPct >= 90 ? 'var(--cth-coral)' : budgetPct >= 60 ? 'var(--cth-lemon)' : 'var(--cth-mint)';
  const hasSpark = (sparkSeries ?? []).some((v) => v > 0);
  const rateLabel = (rateVal ?? 0) > 0 ? `${fmtTokens(rateVal!)}/m` : 'rate';

  const ctxTokens = contextTokens ?? 0;
  const ctxLimit = contextLimit ?? 200_000;
  const cpct = Math.min(100, Math.round((ctxTokens / ctxLimit) * 100));
  const ccolor = cpct >= 88 ? 'var(--cth-coral)' : cpct >= 75 ? 'var(--cth-lemon)' : `var(--cth-${accent})`;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: 6, marginBottom: 6,
      background: isArmed ? 'var(--cth-coral-light)' : 'var(--cth-paper-100)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
    }}>
      {/* Top line: Portrait, Name, Engine, Badge, Breaker, NeedsInput, Quota, IdleStale, 1:1, Respawn, ToolCount, TokenLimit */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 24, height: 24, background: `var(--cth-${accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
        }}>
          <SpritePortrait character={character} agentId={agentId} isGod={isOvermind} scale={1} />
        </div>
        <button
          onClick={onClick}
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
            fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)',
            display: 'inline-flex', alignItems: 'center', gap: 6
          }}
        >
          <span>{name}{isOvermind ? ' (Overmind)' : ''}</span>
          {isNonClaude && (
            <span title={`Engine: ${preset.label}`} style={{
              fontSize: 8, lineHeight: '11px', padding: '1px 4px 0',
              background: 'var(--cth-sky-light)', color: 'var(--cth-ink-900)',
              boxShadow: 'inset 0 0 0 1px var(--cth-sky)', textTransform: 'uppercase',
              fontWeight: 600
            }}>{prov === 'antigravity' ? 'AGY' : preset.label}</span>
          )}
        </button>
        <PixelBadge status={badgeStatus} />
        {isArmed && <span title={breaker?.reason} style={{ color: 'var(--cth-coral)', fontSize: 12 }}>⚠</span>}
        {needsInput && (
          <span title={`Blocked on an interactive prompt: ${needsInput}`} style={{
            fontSize: 8, lineHeight: '11px', padding: '1px 4px 0',
            background: 'var(--cth-salmon, #f47d55)', color: 'var(--cth-ink-900)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', textTransform: 'uppercase', fontWeight: 600
          }}>⌨ needs input</span>
        )}
        {quotaLimited && (
          <span title="Hit provider quota / rate limit" style={{
            fontSize: 8, lineHeight: '11px', padding: '1px 4px 0',
            background: 'var(--cth-coral)', color: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', textTransform: 'uppercase', fontWeight: 600
          }}>⊘ quota</span>
        )}
        {idleStaleLabel && (
          <span title={`Idle with no active task for ${idleStaleLabel.replace('idle ', '')}`} style={{
            fontSize: 8, lineHeight: '11px', padding: '1px 4px 0',
            background: 'var(--cth-coral-light)', color: 'var(--cth-ink-900)',
            boxShadow: 'inset 0 0 0 1px var(--cth-coral)', textTransform: 'uppercase'
          }}>{idleStaleLabel}</span>
        )}
        {onHold && (
          <span title="Human has this agent 1:1" style={{
            fontSize: 8, lineHeight: '11px', padding: '1px 4px 0',
            background: 'var(--cth-lemon)', color: 'var(--cth-ink-900)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>1:1</span>
        )}
        <button
          type="button"
          title={`Archive ${name}'s current session and spawn a fresh one (respawn)`}
          onClick={doRespawn}
          style={{
            border: 'none', cursor: 'pointer', padding: '1px 4px',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12,
            color: 'var(--cth-ink-500)', background: 'transparent',
            display: 'inline-flex', alignItems: 'center'
          }}
        >↺</button>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--cth-ink-500)' }}>
          {toolCount} tool calls
        </span>
        {onSetAgentCap && (
          <TokenLimitEditor value={agentCap} onSet={onSetAgentCap} />
        )}
      </div>

      {/* Cwd line */}
      <div style={{ fontSize: 13, color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>{cwd}</div>

      {/* Live telemetry row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {hasSpark ? (
          <span style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', flexShrink: 0 }}>{rateLabel}</span>
            <Sparkline series={sparkSeries ?? []} />
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}
        {lastTool && (
          <span style={{
            fontSize: 13, lineHeight: '14px', padding: '0 5px', flexShrink: 0,
            background: 'var(--cth-paper-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', color: 'var(--cth-ink-700)'
          }}>{lastTool}</span>
        )}
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-300)', flexShrink: 0 }}>budget</span>
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', width: 56, textAlign: 'right' }}>{fmtTokens(totalTokens)}</span>
        <div
          title={`CUMULATIVE session usage: ${totalTokens.toLocaleString()} of ${denom.toLocaleString()} tokens${agentCap ? ' (agent limit)' : ' (floor budget)'} — not the context window`}
          style={{ width: 96, height: 8, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }}
        >
          <div style={{ width: `${budgetPct}%`, height: '100%', background: meterColor }} />
        </div>
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', width: 30, textAlign: 'right' }}>{budgetPct}%</span>
      </div>

      {/* Context window row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-300)', flexShrink: 0 }}>ctx</span>
        {contextTokens !== undefined && contextLimit ? (
          <>
            <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', width: 56, textAlign: 'right' }}>
              {fmtK(contextTokens)}
            </span>
            <div
              title={`Context window: ${contextTokens.toLocaleString()} of ${contextLimit.toLocaleString()} tokens (${cpct}%)`}
              style={{ width: 96, height: 8, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }}
            >
              <div style={{ width: `${cpct}%`, height: '100%', background: ccolor }} />
            </div>
            <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', width: 30, textAlign: 'right' }}>
              {cpct}%
            </span>
          </>
        ) : (
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-300)' }}>—</span>
        )}
      </div>
      {children}
    </div>
  );
}
