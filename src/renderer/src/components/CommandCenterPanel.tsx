import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { PtyTerminalView } from './PtyTerminalView';
import { MessageQueueComposer } from './MessageQueueComposer';
import { TasksKanban } from './TasksKanban';
import { AskMeTab } from './AskMeTab';
import { QuickAskPanel } from './QuickAskPanel';
import { TriggersTab } from './triggers/TriggersTab';
import { TriggerHistoryTab } from './triggers/TriggerHistoryTab';
import { WorkersTab } from './WorkersTab';
import { DelegationsTab } from './DelegationsTab';
import { SkillsTab } from './SkillsTab';
import { ReviewPanel } from './ReviewPanel';
import { acquireTerminal, disposeTerminal, resetTerminal } from './terminalPool';
import { terminalInstanceKey } from './terminalRecovery';
import { Icon } from './Icon';
import QRCode from '@/lib/qrcodejs';
import { MemoryGraphPanel } from './MemoryGraphPanel';
import { useFleetTelemetry } from '@/hooks/useTelemetry';
import { COMMAND_GROUPS } from '@shared/claudeCommands';
import { roleForHiveSpawn } from '@shared/agentRole';
import { useStore, triggerHistoryVisible, type Agent } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';
import {
  buildSpawnCommand,
  decodeProviderModel,
  encodeProviderModel,
  inferAgentProvider,
  isClaudeProvider,
  modelProvidersForAgent,
  modelsForProvider,
  providerPreset,
  tokenizeCommand,
  AGENT_PROVIDER_PRESETS,
  type AgentProvider
} from '@/store/config';
import { canReceiveInbox } from '@shared/agentProvider';

/** Abathur's control surface. Shown instead of the plain terminal/files panel
 *  when the god agent is selected: terminal + queue, the floor roster (with
 *  per-agent model + dispatch + assistant access), a memory view, and a live
 *  activity feed / board / usage meter. */

// Both the AskMe (#human) tab and the Triggers tab live here. Triggers replaced
// the old Schedules tab: schedules are now one of four trigger types, and the
// whole surface lives in ./triggers (see src/shared/triggers.ts for the contract).
type CCTab = 'terminal' | 'floor' | 'tasks' | 'ask' | 'human' | 'triggers' | 'trigger-history'
  | 'memory' | 'graph' | 'activity' | 'skills' | 'workers' | 'delegations' | 'review';

/** Fallback denominator for the per-agent token meter when no floor token budget
 *  is configured — so the bar reads as a budget estimate (filled + remaining)
 *  rather than being pinned to 100% for whichever agent burns the most tokens. */
const DEFAULT_TOKEN_CAP = 1_000_000;

/** A GitHub issue as returned by `window.cth.githubIssues` (labels/assignees flattened). */
interface GHIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
}

/** Canonical tab order. Not every entry is always shown — see `visibleTabs`. */
const TABS: { key: CCTab; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { key: 'terminal', label: 'terminal', icon: 'terminal' },
  { key: 'floor', label: 'monitor', icon: 'mcp' },
  { key: 'tasks', label: 'tasks', icon: 'check' },
  { key: 'ask', label: 'ask', icon: 'sparkle' },
  { key: 'human', label: 'for you', icon: 'bell' },
  { key: 'triggers', label: 'triggers', icon: 'clock' },
  { key: 'trigger-history', label: 'history', icon: 'ledger' },
  { key: 'memory', label: 'memory', icon: 'sparkle' },
  { key: 'graph', label: 'graph', icon: 'web' },
  { key: 'activity', label: 'activity', icon: 'bell' },
  { key: 'skills', label: 'skills', icon: 'sparkle' },
  { key: 'workers', label: 'workers', icon: 'gear' },
  { key: 'delegations', label: 'delegations', icon: 'gear' },
  { key: 'review', label: 'review', icon: 'ledger' }
];

type TabDef = { key: CCTab; label: string; icon: Parameters<typeof Icon>[0]['name'] };

function TabButton({ t, active, accent, onClick }: { t: TabDef; active: boolean; accent: string; onClick: () => void }) {
  const msgPending = useStore((s) => s.humanMessages.filter((m) => !m.resolved).length);
  const activityUnread = useStore((s) => s.activityUnread);
  const assignedPending = useStore((s) => s.assignedPending);
  const pendingArtifacts = useStore((s) => s.pendingArtifacts);
  const badge = t.key === 'human' ? msgPending
    : t.key === 'activity' ? activityUnread
    : t.key === 'tasks' ? assignedPending
    : t.key === 'review' ? pendingArtifacts.length
    : 0;
  const showBadge = badge > 0 && !active;
  return (
    <button
      onClick={onClick}
      style={{
        whiteSpace: 'nowrap',
        flex: '1 0 auto',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        padding: '4px 8px 3px', border: 'none', cursor: 'pointer',
        background: active ? `var(--cth-${accent})` : 'var(--cth-cream-200)',
        color: active ? 'var(--cth-on-accent)' : 'var(--cth-ink-900)',
        boxShadow: active ? 'inset 0 0 0 1px var(--cth-ink-300)' : 'inset 0 0 0 1px var(--cth-ink-100)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 13,
        position: 'relative'
      }}
    >
      <Icon name={t.icon} /> {t.label}
      {showBadge && (
        <span style={{
          position: 'absolute', top: 2, right: 2,
          minWidth: 14, height: 14, borderRadius: 7,
          background: 'var(--cth-coral)', color: '#fff',
          fontFamily: 'var(--cth-font-ui)', fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '0 3px', boxSizing: 'border-box', lineHeight: 1
        }}>
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
}

/** Pixel QR glyph — three finder squares plus a few data modules, drawn in the
 *  same 16×16 crispEdges style as the Icon set (Icon.tsx has no phone/QR glyph
 *  and is out of scope to edit). Inherits currentColor like the real icons. */
function QrGlyph({ size = 1 }: { size?: number }) {
  const dim = 16 * size;
  const finder = (x: number, y: number) => (
    <>
      <rect x={x} y={y} width={5} height={1} />
      <rect x={x} y={y + 4} width={5} height={1} />
      <rect x={x} y={y + 1} width={1} height={3} />
      <rect x={x + 4} y={y + 1} width={1} height={3} />
      <rect x={x + 2} y={y + 2} width={1} height={1} />
    </>
  );
  return (
    <svg
      viewBox="0 0 16 16"
      width={dim}
      height={dim}
      shapeRendering="crispEdges"
      style={{ display: 'inline-block' }}
      fill="currentColor"
      aria-hidden
    >
      {finder(1, 1)}
      {finder(10, 1)}
      {finder(1, 10)}
      <rect x={10} y={10} width={1} height={1} />
      <rect x={12} y={10} width={1} height={1} />
      <rect x={14} y={10} width={1} height={1} />
      <rect x={11} y={11} width={1} height={1} />
      <rect x={13} y={11} width={1} height={1} />
      <rect x={10} y={12} width={1} height={1} />
      <rect x={12} y={12} width={1} height={1} />
      <rect x={14} y={12} width={1} height={1} />
      <rect x={11} y={13} width={1} height={1} />
      <rect x={13} y={13} width={1} height={1} />
      <rect x={10} y={14} width={1} height={1} />
      <rect x={12} y={14} width={1} height={1} />
      <rect x={14} y={14} width={1} height={1} />
    </svg>
  );
}

/** @param fullscreen this instance IS the fullscreen overlay, so it owns the pty
 *  and renders the real terminal. The docked instance renders the "open in
 *  fullscreen" placeholder instead — two live xterms on one pty fight over its
 *  cols/rows and corrupt the display. */
export function CommandCenterPanel({ agent, fullscreen = false, mobile = false }: { agent: Agent; fullscreen?: boolean; mobile?: boolean }) {
  const [tab, setTab] = useState<CCTab>('terminal');

  // The trigger-history ledger has nothing to say until an outside party can
  // reach us, so its tab appears only once an org key or a webhook exists. This
  // is the first config-gated tab in the panel: TABS stays the canonical order
  // and the gate is applied at render, so nothing else has to know about it.
  // The rule itself lives in the store (`triggerHistoryVisible`) beside the two
  // mirrors it reads — a second copy here would drift from Settings.
  const showHistory = useStore(triggerHistoryVisible);
  // Never leave the panel parked on a tab that has just been hidden.
  useEffect(() => {
    if (!showHistory && tab === 'trigger-history') setTab('terminal');
  }, [showHistory, tab]);
  const visibleTabs = TABS.filter((t) => t.key !== 'trigger-history' || showHistory);

  // External tab requests (the office task board → 'tasks', the boss-room
  // calendar → 'triggers'). seq-keyed so clicking again re-opens the tab even
  // if it was already requested.
  const ccTabRequest = useStore((s) => s.ccTabRequest);
  useEffect(() => {
    if (!ccTabRequest) return;
    const key = ccTabRequest.tab as CCTab;
    if (!TABS.some((t) => t.key === key)) return;
    // Read the gate live rather than depending on it — as a dependency it would
    // re-fire a stale request the moment the tab appeared.
    if (key === 'trigger-history' && !triggerHistoryVisible(useStore.getState())) return;
    setTab(key);
  }, [ccTabRequest]);
  // A task-detail "assign" pre-fills the Floor dispatch box and jumps to it.
  // Seeded via the store one-shot (the detail overlay lives app-wide now);
  // { seq } makes every assign distinct so identical text re-seeds.
  const [dispatchSeed, setDispatchSeed] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
  const dispatchSeedRequest = useStore((s) => s.dispatchSeedRequest);
  const clearDispatchSeedRequest = useStore((s) => s.clearDispatchSeedRequest);
  useEffect(() => {
    if (!dispatchSeedRequest) return;
    setDispatchSeed({ text: dispatchSeedRequest.text, seq: dispatchSeedRequest.seq });
    clearDispatchSeedRequest();
  }, [dispatchSeedRequest, clearDispatchSeedRequest]);
  // Reset once FloorTab has consumed the seed so a later remount (tab switch)
  // can't re-inject stale text into a field the user already dispatched + cleared.
  const resetDispatchSeed = useCallback(() => setDispatchSeed({ text: '', seq: 0 }), []);
  // Lifted so the memory-graph tab can jump to a specific agent's memory file.
  const [selectedMemoryAgent, setSelectedMemoryAgent] = useState<string | null>(null);
  const updateAgent = useStore((s) => s.updateAgent);
  const setFullscreen = useStore((s) => s.setFullscreen);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const onPtyStream = usePtyParser(agent.id);
  // True only for the DOCKED panel while the overlay holds this agent.
  const isFullscreenedHere = fullscreenAgentId === agent.id && !fullscreen;
  // v0.3.4: ONE floor-wide auto-delivery switch, moved off the per-agent
  // control strips — toggling applies to every live agent, god included.
  // Seeded from the god's own control state (the floor is kept in sync by
  // this single control, so any agent's state reflects the floor's).
  const [floorDeliveryPaused, setFloorDeliveryPaused] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [mobilePairing, setMobilePairing] = useState<{ secret: string; hostname: string; port: number } | null>(null);
  const [qrCopyNote, setQrCopyNote] = useState('');
  const qrRef = useRef<HTMLDivElement | null>(null);
  const mobileUrl = mobilePairing
    ? `http://${mobilePairing.hostname || window.location.hostname}:${mobilePairing.port}/mobile?token=${mobilePairing.secret}`
    : '';
  useEffect(() => {
    let alive = true;
    window.cth.controlSnapshot(agent.id)
      .then((s) => { if (alive && s) setFloorDeliveryPaused(s.autoDeliveryPaused); })
      .catch(() => { /* none */ });
    return () => { alive = false; };
  }, [agent.id]);
  const toggleFloorDelivery = async () => {
    const next = !floorDeliveryPaused;
    setFloorDeliveryPaused(next);
    const all = useStore.getState().agents;
    await Promise.all(all.map((a) => window.cth.controlAutoDelivery(a.id, next).catch(() => null)));
  };
  const openQr = useCallback(async () => {
    setQrOpen(true);
    if (mobilePairing) return;
    try {
      const info = await window.cth.getMobileApiSecret();
      setMobilePairing({ secret: info.secret, hostname: info.hostname, port: info.port });
    } catch (err) {
      console.error('[command-center] getMobileApiSecret error:', err);
    }
  }, [mobilePairing]);

  const copyQrLink = useCallback(() => {
    if (!mobileUrl) return;
    void window.cth.copyToClipboard(mobileUrl);
    setQrCopyNote('copied');
    setTimeout(() => setQrCopyNote(''), 1500);
  }, [mobileUrl]);

  useEffect(() => {
    if (!qrOpen || !mobileUrl || !qrRef.current) return;
    qrRef.current.innerHTML = '';
    new QRCode(qrRef.current, {
      text: mobileUrl,
      width: 168,
      height: 168,
      colorDark: '#1a1a1a',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  }, [qrOpen, mobileUrl]);

  useEffect(() => {
    if (!qrOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setQrOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [qrOpen]);

  return (
    <PixelPanel
      variant="default"
      noPadding
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: mobile && !fullscreen ? 'auto' : '100%',
        padding: 0,
        overflow: 'hidden'
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: mobile ? 6 : 8,
        flexWrap: mobile ? 'wrap' : 'nowrap',
        padding: '6px 8px', background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)', flexShrink: 0
      }}>
        <div style={{
          width: 32, height: 32, background: `var(--cth-${agent.accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
        }}>
          <SpritePortrait character={agent.character} scale={1} />
        </div>
        {/* Title + subtitle truncate; the control cluster never shrinks. At
            sidebar width the old header wrapped its 24-char display-font title
            onto three lines and "runs the floor" word-per-line under the two
            wide buttons — everything here is single-line by construction. */}
        <div style={{ flex: 1, minWidth: 0, order: mobile ? 1 : 0, marginTop: mobile ? 4 : 0 }}>
          <div style={{
            fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '14px', color: 'var(--cth-ink-900)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}>COMMAND CENTER</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 1, minWidth: 0 }}>
            <PixelBadge status={agent.status} />
            <span style={{
              fontSize: 12, color: 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}>Abathur runs the floor</span>
          </div>
        </div>
        {/* v0.3.4: floor-wide auto-delivery lives HERE (one switch for every
            agent's queue), and the IDE opens from agent level, not the toolbar.
            Short labels — the tooltips carry the full explanation. */}
        <div style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flexShrink: 0,
          flexWrap: mobile ? 'wrap' : 'nowrap',
          justifyContent: mobile ? 'flex-start' : 'flex-end',
          width: mobile ? '100%' : 'auto',
          order: mobile ? 2 : 0,
          rowGap: mobile ? 4 : undefined
        }}>
          <PixelButton
            variant={floorDeliveryPaused ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => { void toggleFloorDelivery(); }}
          >
            <span
              className="cth-tip cth-tip-wrap"
              data-tip={floorDeliveryPaused
                ? 'Queued messages are being held for EVERY agent on the floor. Nothing is lost; it is delivered when you switch this back on.'
                : 'Queued messages are delivered to every agent automatically. Click to hold the whole floor.'}
              aria-label={floorDeliveryPaused ? 'Resume automatic delivery for the whole floor' : 'Hold automatic delivery for the whole floor'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Icon name={floorDeliveryPaused ? 'pause' : 'play'} />
              {floorDeliveryPaused ? 'paused' : 'auto'}
            </span>
          </PixelButton>
          {/* Floor-level surface with no agent of its own: the honest target is
              whoever is selected, stated explicitly rather than left to the
              IDE's fallback so the intent is visible at the call site. */}
          <PixelButton variant="secondary" size="sm" onClick={() => {
            const s = useStore.getState();
            s.setIdeOpen(true, s.selectedId);
          }}>
            <span
              className="cth-tip cth-tip-wrap"
              data-tip="Open the IDE: browse and edit files in the selected agent's workspace, and see uncommitted changes as a diff."
              aria-label="Open the IDE"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Icon name="code" /> IDE
            </span>
          </PixelButton>
          <PixelButton
            variant="secondary"
            size="sm"
            onClick={() => { void openQr(); }}
          >
            <span
              className="cth-tip cth-tip-wrap"
              data-tip="Scan to pair your phone with the mobile remote."
              aria-label="Show the mobile-remote pairing QR code"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <QrGlyph /> mobile
            </span>
          </PixelButton>
        </div>
      </div>

      {qrOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Mobile remote pairing"
          onClick={() => setQrOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-700), 4px 4px 0 var(--cth-ink-700)',
              padding: 16, maxWidth: 320, width: 'calc(100% - 32px)',
              display: 'flex', flexDirection: 'column', gap: 10
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                flex: 1, fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                color: 'var(--cth-ink-900)', textTransform: 'uppercase'
              }}>Pair your phone</div>
              <PixelButton variant="secondary" size="sm" onClick={() => setQrOpen(false)}>
                <span aria-label="Close" style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <Icon name="x" />
                </span>
              </PixelButton>
            </div>
            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
              Point your phone's camera at the code to open the mobile remote — the link and token
              fill in automatically, no typing required.
            </span>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div
                ref={qrRef}
                style={{
                  width: 168, height: 168, flexShrink: 0,
                  background: '#ffffff', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                }}
              />
            </div>
            <input
              type="text"
              readOnly
              value={mobileUrl || 'starting mobile server…'}
              onFocus={(e) => e.target.select()}
              style={{
                fontFamily: 'var(--cth-font-mono)', fontSize: 11,
                padding: '6px 8px', background: 'var(--cth-cream-50)',
                border: '1px solid var(--cth-ink-300)', color: 'var(--cth-ink-900)',
                width: '100%', boxSizing: 'border-box'
              }}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <PixelButton variant="secondary" size="sm" onClick={copyQrLink} disabled={!mobileUrl}>
                copy link
              </PixelButton>
              {qrCopyNote && (
                <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{qrCopyNote}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab bar — ONE row, tabs at their natural width, scrolling only if the
          panel is genuinely too narrow for all of them.

          This was an auto-fit grid of equal-width cells, which had a failure mode
          the equal widths caused: every column is sized to the WIDEST tab, so the
          track count is set by the longest label rather than by the total width
          the labels actually need. Adding a 12th tab tipped it over at fullscreen
          width and dropped `setup` onto a second row with most of the first row's
          space still unused — the tabs need ~1320px of content and had ~1610px.

          Content-sized tabs fit all twelve on one line with room to spare, and the
          `.cth-tabbar` rules in global.css (scrollbar-width: none, ::-webkit-
          scrollbar { height: 0 }) already exist for exactly this: a single row that
          scrolls with the scrollbar hidden. The grid never scrolled, so those rules
          have been dead code since it landed.

          Trade-off, deliberate: in the NARROW docked panel the far-right tabs now
          scroll out of view instead of wrapping to a visible second row. One row
          that sometimes needs a scroll beats two rows where one is nearly empty —
          and the grid's own reason for existing (keeping wrapped rows aligned)
          stops applying the moment there is only ever one row. */}
      <div className="cth-tabbar" style={{
        display: 'flex', gap: 4,
        flexWrap: mobile ? 'nowrap' : (fullscreen ? 'nowrap' : 'wrap'),
        overflowX: mobile || fullscreen ? 'auto' : 'visible',
        padding: '6px 8px', background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)', flexShrink: 0
      }}>
        {visibleTabs.map((t) => (
          <TabButton key={t.key} t={t} active={tab === t.key} accent={agent.accent} onClick={() => setTab(t.key)} />
        ))}
      </div>

      {/* Body */}
      <div style={{
        flex: 1,
        minHeight: mobile && !fullscreen ? 'auto' : 0,
        display: 'flex',
        flexDirection: 'column'
      }}>
        {tab === 'terminal' && (
          isFullscreenedHere ? (
            <Centered>Terminal is open in fullscreen. Press Esc to bring it back.</Centered>
          ) : agent.ptyId ? (
            <>
              <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <PtyTerminalView
                  key={terminalInstanceKey(agent.ptyId, agent.terminalGeneration)}
                  ptyId={agent.ptyId}
                  onStreamData={onPtyStream}
                  onUserPrompt={(t) => {
                    updateAgent(agent.id, { lastPrompt: t });
                    if (t.trim().toLowerCase() === '/clear') {
                      updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                    }
                    void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text: t });
                  }}
                  onToggleFullscreen={() => setFullscreen(fullscreen ? null : agent.id)}
                  fullscreen={fullscreen}
                  embedded={!fullscreen}
                />
              </div>
              <MessageQueueComposer agent={agent} />
            </>
          ) : (
            <Centered>Abathur has no live terminal.</Centered>
          )
        )}
        {tab === 'floor' && <FloorTab seed={dispatchSeed} onSeedConsumed={resetDispatchSeed} />}
        {tab === 'tasks' && <TasksKanban mobile={mobile} />}
        {tab === 'ask' && <QuickAskPanel />}
        {tab === 'human' && <AskMeTab />}
        {tab === 'triggers' && <TriggersTab />}
        {tab === 'trigger-history' && <TriggerHistoryTab />}
        {tab === 'memory' && (
          <MemoryTab godId={agent.id} who={selectedMemoryAgent ?? undefined} onWho={setSelectedMemoryAgent} />
        )}
        {tab === 'graph' && (
          <MemoryGraphPanel
            godId={agent.id}
            onJumpToMemory={(id) => { setSelectedMemoryAgent(id); setTab('memory'); }}
          />
        )}
        {tab === 'activity' && <ActivityTab />}
        {tab === 'skills' && <SkillsTab agentCwd={agent.cwd} />}
        {tab === 'workers' && <WorkersTab />}
        {tab === 'delegations' && <DelegationsTab />}
        {tab === 'review' && <ReviewPanel onClose={() => setTab('floor')} />}
      </div>
    </PixelPanel>
  );
}

// ─── Floor tab — roster, model, dispatch, dirs, assistant ────────────────────

function FloorTab({ seed, onSeedConsumed }: { seed: { text: string; seq: number }; onSeedConsumed: () => void }) {
  const agents = useStore((s) => s.agents);
  const select = useStore((s) => s.select);
  const updateAgent = useStore((s) => s.updateAgent);
  const toolCounts = useStore((s) => s.toolCounts);
  // Live OpenTelemetry per agent — merged into each agent card below (the old
  // standalone Fleet tab folded in here so the roster shows identity + controls
  // AND live cost/usage in one place).
  const { samples, spark, rate, lastTool, breakers } = useFleetTelemetry();
  const [repos, setRepos] = useState<string[]>([]);
  // Floor-wide token budget (drives the breaker); also the token-meter denominator.
  const [tokenCap, setTokenCap] = useState<number | undefined>(undefined);
  // Per-agent token limit (overrides the floor budget for that agent), keyed by id.
  const [agentTokenCaps, setAgentTokenCaps] = useState<Record<string, number>>({});
  const [restarting, setRestarting] = useState<string | null>(null);
  const [engineProvider, setEngineProvider] = useState<AgentProvider>('claude');
  const [engineModel, setEngineModel] = useState<string | undefined>(undefined);
  const [restartErrors, setRestartErrors] = useState<Record<string, string>>({});
  // The harness's own default model (Settings → default model). Abathur and every
  // new agent spawn on this, so the picker marks it — otherwise the only entry
  // reading "default" was the CLI's, which is a different thing entirely.
  const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
  const [dispatchTo, setDispatchTo] = useState<string>(''); // '' = Abathur decides
  const [dispatchAct, setDispatchAct] = useState<'request' | 'query' | 'inform'>('request');
  const [dispatchSubject, setDispatchSubject] = useState('');
  const [dispatchText, setDispatchText] = useState('');
  const [dispatchPriority, setDispatchPriority] = useState<'urgent' | 'normal' | 'backlog'>('normal');
  const [dispatchMsg, setDispatchMsg] = useState<string | null>(null);
  const [localSkills, setLocalSkills] = useState<Array<{ name: string; description: string }>>([]);
  const [suggestIdx, setSuggestIdx] = useState(-1);
  // ── ISSUES section state ──
  const [issueRepo, setIssueRepo] = useState<string>('');
  const [issues, setIssues] = useState<GHIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);

  useEffect(() => {
    window.cth.getConfig().then((c) => {
      setRepos(c.registeredRepos ?? []);
      setTokenCap(c.costCapTokens);
      setAgentTokenCaps(c.agentTokenCaps ?? {});
      setEngineProvider(c.overmindProvider ?? 'claude');
      setEngineModel(c.overmindModel);
      setDefaultModel(c.defaultModel);
    }).catch(() => { /* noop */ });
  }, []);

  // Seed the dispatch box from a task-card "assign" (keyed on seq so repeat
  // assigns re-prefill). seq === 0 is the untouched initial state — skip it.
  useEffect(() => {
    if (seed.seq > 0) {
      setDispatchText(seed.text);
      onSeedConsumed(); // clear the parent seed so a remount won't re-seed after dispatch
    }
  }, [seed.seq, seed.text, onSeedConsumed]);

  // Load local skills lazily when user types '/' in the dispatch box.
  useEffect(() => {
    if (dispatchText.startsWith('/') && localSkills.length === 0) {
      void window.cth.skillsLocal()
        .then((skills) => setLocalSkills((skills ?? []).map((s) => ({ name: s.name, description: s.description ?? '' }))))
        .catch(() => {});
    }
  }, [dispatchText, localSkills.length]);

  // Restart an agent's PTY in place. `resume:true` reattaches its prior Claude
  // conversation (`--resume <sessionId>`, resolved in the main process from the
  // hive registry by agent id) — this is "Restart & Continue": a clean re-draw
  // of the TUI in a fresh process WITHOUT losing the thread, which is the escape
  // hatch for a corrupted/garbled terminal (e.g. xterm reflow after dragging the
  // window between displays of different sizes). With `resume` unset it's the
  // old behavior: a model change that starts a fresh session.
  const restartWithModel = async (
    a: Agent,
    model: string | undefined,
    opts: {
      resume?: boolean;
      provider?: AgentProvider;
      /** Resume if we can, start fresh if we can't, instead of refusing.
       *  "Restart & Continue" wants the hard failure — continuing is the entire
       *  point, so silently starting a blank session would be worse than an
       *  error. A model change wants the soft one: the user asked to change
       *  model, and an agent with no recorded session still has to get one. */
      resumeOptional?: boolean;
    } = {}
  ) => {
    if (!a.ptyId) return;
    setRestarting(a.id);
    setRestartErrors((errors) => ({ ...errors, [a.id]: '' }));
    try {
      const cfg = await window.cth.getConfig();
      // Respawn on the same CLI this agent already runs on (inferred from its
      // command if not explicitly tagged) so an Antigravity/Codex worker stays
      // on its own binary. tokenizeCommand keeps quoted model labels one arg.
      // opts.provider overrides the inferred provider — used when changing GOD's engine.
      const previousProvider = inferAgentProvider(a.command, a.provider);
      const provider = opts.provider ?? previousProvider;
      let resume = opts.resume === true && provider === previousProvider;
      if (opts.resume && !resume && !opts.resumeOptional) {
        throw new Error('Cannot resume a session through a different provider.');
      }
      let resumeSessionId: string | undefined;
      if (resume) {
        // A precondition miss is fatal for an explicit "continue", and merely
        // means "start fresh" for an opportunistic one (see resumeOptional).
        const giveUpOnResume = (reason: string) => {
          if (!opts.resumeOptional) throw new Error(reason);
          resume = false;
          resumeSessionId = undefined;
        };
        const registry = await window.cth.hiveRegistry();
        resumeSessionId = registry.agents[a.id]?.sessionId;
        if (!resumeSessionId) {
          giveUpOnResume('No recorded session ID; current process was left running.');
        } else if (provider === 'claude' && !(await window.cth.resolveSessionCwd(resumeSessionId))) {
          giveUpOnResume('Session transcript not found; current process was left running.');
        }
      }
      // Capture the live grid before replacing anything. Restart & Continue
      // recreates only this agent's xterm; model changes retain the old
      // in-place reset behavior.
      const oldEntry = acquireTerminal(a.ptyId);
      let cols = oldEntry.term.cols || 100;
      let rows = oldEntry.term.rows || 30;
      try {
        oldEntry.fit.fit();
        cols = oldEntry.term.cols;
        rows = oldEntry.term.rows;
      } catch { /* host not sized yet */ }

      const killed = await window.cth.killPty(a.ptyId);
      // A pty that is ALREADY gone is the state this kill was trying to reach, so
      // it is not a failure. This is the single most common way to arrive at
      // "Restart & Continue": the session died on its own — a crash, or Ctrl-C
      // twice — main dropped it from the session map, and kill then answers
      // `no pty: <id>`. Treating that as fatal aborted before the respawn and
      // turned the one situation the button exists for into a dead end.
      if (!killed.ok && !/^no pty:/.test(killed.error ?? '')) {
        throw new Error(killed.error ?? 'Could not stop the current process.');
      }
      if (resume) {
        // A blank xterm can retain corrupt renderer/DOM/subscription state even
        // after its PTY is healthy. Throw that one terminal away, acquire its
        // replacement BEFORE spawning (so startup output has a listener), then
        // bump the key so React remounts only this agent's terminal card.
        disposeTerminal(a.ptyId);
        acquireTerminal(a.ptyId);
        updateAgent(a.id, {
          terminalGeneration: (a.terminalGeneration ?? 0) + 1,
          status: 'idle',
          action: 'recreating terminal…'
        });
      } else {
        resetTerminal(a.ptyId);
      }
      const command = buildSpawnCommand(cfg, model, provider);
      const [exe, ...args] = tokenizeCommand(command.trim());
      const hive = {
        id: a.id,
        name: a.name,
        cwd: a.cwd,
        provider,
        isOvermind: a.isOvermind,
        isAssistant: a.isAssistant,
        role: roleForHiveSpawn(a)
      };
      const res = await window.cth.spawnPty({
        id: a.ptyId,
        cwd: a.cwd,
        command: exe,
        args,
        provider,
        cols,
        rows,
        hive,
        resume,
        resumeSessionId,
        requireResume: resume
      });
      if (!res.ok) throw new Error(res.error ?? 'Restart failed.');
      if (resume && res.resumed !== true) {
        throw new Error('Resume was refused; no replacement session was accepted.');
      }
      if (res.ok) {
        // Record the model even on a resume. A same-provider model change now
        // RESUMES the session (that is the point — you keep the conversation and
        // just swap the model), so "resume ⇒ the model is unchanged" stopped
        // being true. Skipping the patch left the live process on the new model
        // while the selector and the persisted agent kept the old one, and the
        // next restore relaunched the old command. `command` is rebuilt from the
        // selected model above, so on a genuine no-change restart this is a no-op.
        const patch = resume
          ? {
              command: command.trim(),
              provider,
              model,
              status: 'idle' as const,
              action: 'continuing…'
            }
          : {
              command: command.trim(),
              provider,
              model,
              status: 'idle' as const,
              action: provider === previousProvider ? 'restarting…' : `switching to ${providerPreset(provider).label}…`
            };
        updateAgent(a.id, patch);
      }
    } catch (error) {
      setRestartErrors((errors) => ({
        ...errors,
        [a.id]: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setRestarting(null);
    }
  };

  const handleDispatchPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const hasImage = Array.from(e.clipboardData.items).some((item) => item.type.startsWith('image/'));
    if (!hasImage) return;
    e.preventDefault();
    // Capture caret position before the async save — the textarea DOM element
    // holds the live positions; stale closure on dispatchText would overwrite
    // any keystrokes typed while saveClipboardImage() is in flight.
    const ta = e.currentTarget;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const res = await window.cth.saveClipboardImage();
    if (res.ok) {
      const ref = `[image: ${res.file.path}]`;
      setDispatchText((prev) => prev.slice(0, start) + ref + prev.slice(end));
    } else {
      setDispatchText((prev) => prev + ` [image paste failed: ${res.error}]`);
    }
  };

  // ALL human dispatch flows through the god — never directly into a worker's
  // inbox. Direct dispatch bypassed the orchestrator's whole job: no 4-part
  // contract, no card in tasks.json, no board awareness — and the old
  // 'broadcast' DEFAULT sent the same task to every worker at once. A worker
  // picked in the dropdown is forwarded as a SUGGESTION the god may follow.
  const dispatch = async () => {
    const body = dispatchText.trim();
    const subject = dispatchSubject.trim();
    if (!body || !subject) return;
    const suggested = dispatchTo ? agents.find((a) => a.id === dispatchTo) : undefined;
    const full = suggested
      ? `${body}\n\n(The human suggests ${suggested.name} (${suggested.id}) for this — your call as orchestrator.)`
      : body;
    const res = await window.cth.hiveSend(
      {
        to: 'god',
        act: dispatchAct,
        subject,
        body: full,
        priority: dispatchPriority
      },
      'human'
    );
    if (res.ok) {
      setDispatchText('');
      setDispatchSubject('');
    }
    setDispatchMsg(res.ok
      ? `sent to Abathur${suggested ? ` (suggesting ${suggested.name})` : ''}`
      : `failed: ${res.error ?? '?'}`);
    setTimeout(() => setDispatchMsg(null), 4000);
  };

  const fetchIssues = async () => {
    const repo = issueRepo || repos[0];
    if (!repo) { setIssuesError('No repo selected.'); return; }
    setIssuesLoading(true);
    setIssuesError(null);
    try {
      const res = await window.cth.githubIssues(repo);
      if (res.ok) {
        setIssues((res.issues ?? []).slice(0, 10));
      } else {
        setIssues([]);
        setIssuesError(res.error ?? 'Failed to fetch issues.');
      }
    } catch (e) {
      setIssues([]);
      setIssuesError(e instanceof Error ? e.message : String(e));
    } finally {
      setIssuesLoading(false);
    }
  };

  const assignIssue = (issue: GHIssue) => {
    const body = (issue.body ?? '').slice(0, 200);
    setDispatchText(`GitHub Issue #${issue.number}: ${issue.title}\n\n${body}\n\nURL: ${issue.url}`);
    setDispatchTo(''); // Abathur decomposes and assigns — no more broadcast blasts
  };

  // Set/clear one agent's token limit atomically in main. Renderer config objects
  // are snapshots, so persisting this whole map could clobber a cap added by the
  // hire flow after this panel loaded.
  const setAgentCap = (id: string, tokens: number | undefined) => {
    setAgentTokenCaps((current) => {
      const optimistic = { ...current };
      if (tokens && tokens > 0) optimistic[id] = tokens;
      else delete optimistic[id];
      return optimistic;
    });
    void window.cth.setAgentTokenCap(id, tokens).then((updated) => {
      setAgentTokenCaps(updated.agentTokenCaps ?? {});
    }).catch(() => {
      // Reconcile a failed optimistic edit with the persisted source of truth.
      void window.cth.getConfig().then((current) => {
        setAgentTokenCaps(current.agentTokenCaps ?? {});
      }).catch(() => { /* noop */ });
    });
  };

  // The token meter is scaled to the agent's own limit when set, else the floor
  // token budget — so each bar reads as "tokens used vs budget" with the remaining
  // headroom visible, never pinned to a useless 100%.
  const floorCap = tokenCap && tokenCap > 0 ? tokenCap : DEFAULT_TOKEN_CAP;
  // Fleet totals across the roster (for the AGENTS summary band).
  let sumTokens = 0, sumInput = 0, sumCacheRead = 0, sumRate = 0;
  for (const a of agents) {
    const s = samples[a.id];
    if (s) {
      sumTokens += s.input + s.output + s.cacheRead + s.cacheCreation;
      sumInput += s.input + s.cacheRead + s.cacheCreation;
      sumCacheRead += s.cacheRead;
    }
    sumRate += rate[a.id] ?? 0;
  }
  const fleetCachePct = sumInput > 0 ? Math.round((sumCacheRead / sumInput) * 100) : 0;

  return (
    <Scroll>
      <Section title="DISPATCH — VIA ABATHUR">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', flexShrink: 0 }}>
            SUGGESTED OWNER
          </span>
          <Select value={dispatchTo} onChange={setDispatchTo}>
            <option value="">Abathur decides</option>
            {agents.filter((a) => !a.isOvermind).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </Select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', flexShrink: 0 }}>
            ACT
          </span>
          <Select value={dispatchAct} onChange={(v) => setDispatchAct(v as 'request' | 'query' | 'inform')}>
            <option value="request">Request</option>
            <option value="query">Query</option>
            <option value="inform">Inform</option>
          </Select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>
            SUBJECT
          </span>
          <input
            type="text"
            className="cth-input"
            value={dispatchSubject}
            onChange={(e) => setDispatchSubject(e.target.value)}
            placeholder="Brief subject line"
            style={{
              width: '100%',
              padding: '6px 8px',
              fontFamily: 'var(--cth-font-ui)',
              fontSize: 13,
              background: 'var(--cth-paper-100)',
              color: 'var(--cth-ink-900)',
              border: 'none',
              outline: 'none',
              boxSizing: 'border-box'
            }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)', flexShrink: 0 }}>priority</span>
          {(['urgent', 'normal', 'backlog'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setDispatchPriority(p)}
              style={{
                padding: '2px 8px',
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                border: 'none',
                borderRadius: 2,
                cursor: 'pointer',
                background: dispatchPriority === p ? 'var(--cth-ink-900)' : 'transparent',
                color: dispatchPriority === p ? 'var(--cth-paper-100)' : 'var(--cth-ink-500)',
                boxShadow: dispatchPriority === p ? 'none' : 'inset 0 0 0 1px var(--cth-ink-300)',
                transition: 'background 0.1s, color 0.1s'
              }}
            >{p}</button>
          ))}
        </div>
        {(() => {
          const slashQ = dispatchText.startsWith('/') ? dispatchText.slice(1).toLowerCase() : null;
          const suggestions = slashQ !== null ? [
            ...COMMAND_GROUPS.flatMap((g) => g.items)
              .filter((c) => c.kind === 'slash' && (slashQ === '' || c.cmd.toLowerCase().includes(slashQ)))
              .map((c) => ({ cmd: c.cmd, hint: c.desc })),
            ...localSkills
              .filter((s) => slashQ === '' || s.name.toLowerCase().includes(slashQ) || s.description.toLowerCase().includes(slashQ))
              .map((s) => ({ cmd: `/${s.name}`, hint: s.description }))
          ].slice(0, 12) : [];
          const pickSuggestion = (cmd: string) => {
            setDispatchText(cmd + ' ');
            setSuggestIdx(-1);
          };
          return (
            <div style={{ position: 'relative' }}>
              {suggestions.length > 0 && (
                <div style={{
                  position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 200,
                  background: 'var(--cth-paper-100)',
                  boxShadow: '0 0 0 1.5px var(--cth-ink-700), 0 -3px 0 var(--cth-ink-900)',
                  maxHeight: 220, overflowY: 'auto'
                }}>
                  {suggestions.map(({ cmd, hint }, i) => (
                    <button
                      key={cmd}
                      onMouseDown={(e) => { e.preventDefault(); pickSuggestion(cmd); }}
                      style={{
                        width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                        padding: '5px 8px',
                        background: i === suggestIdx ? 'var(--cth-cream-200)' : 'transparent',
                        display: 'flex', alignItems: 'baseline', gap: 8,
                        boxShadow: 'inset 0 -1px 0 var(--cth-ink-100)'
                      }}
                      onMouseEnter={() => setSuggestIdx(i)}
                      onMouseLeave={() => setSuggestIdx(-1)}
                    >
                      <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)', flexShrink: 0 }}>{cmd}</span>
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{hint}</span>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                value={dispatchText}
                onChange={(e) => { setDispatchText(e.target.value); setSuggestIdx(-1); }}
                onPaste={handleDispatchPaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    dispatch();
                    return;
                  }
                  if (suggestions.length === 0) return;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSuggestIdx((i) => Math.min(i + 1, suggestions.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSuggestIdx((i) => Math.max(i - 1, -1));
                  } else if ((e.key === 'Enter' || e.key === 'Tab') && suggestIdx >= 0) {
                    e.preventDefault();
                    pickSuggestion(suggestions[suggestIdx].cmd);
                  } else if (e.key === 'Escape') {
                    setSuggestIdx(-1);
                    setDispatchText('');
                  }
                }}
                rows={2}
                placeholder="Describe the task… or / for skills & commands"
                style={textareaStyle}
              />
            </div>
          );
        })()}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <PixelButton variant="primary" size="sm" onClick={dispatch} disabled={!dispatchText.trim() || !dispatchSubject.trim()}>
            dispatch
          </PixelButton>
          {dispatchMsg && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{dispatchMsg}</span>}
        </div>
      </Section>

      <Section title="AGENTS">
        {agents.map((a) => {
          const agentProvider = inferAgentProvider(a.command, a.provider);
          const agentPreset = providerPreset(agentProvider);
          const sample = samples[a.id];
          const breaker = breakers[a.id];
          const armed = !!breaker && (breaker.level === 'constrained' || breaker.level === 'stopped');
          const tokens = sample ? sample.input + sample.output + sample.cacheRead + sample.cacheCreation : 0;
          const agentCap = agentTokenCaps[a.id]; // per-agent limit, if set
          const denom = agentCap && agentCap > 0 ? agentCap : floorCap;
          const pct = Math.min(100, Math.round((tokens / denom) * 100));
          const meterColor = armed || pct >= 90 ? 'var(--cth-coral)' : pct >= 60 ? 'var(--cth-lemon)' : 'var(--cth-mint)';
          // Sparkline only when the agent is actually burning tokens; otherwise the
          // flat baseline is just a mystery line. Label it with the live rate.
          const sparkSeries = spark[a.id] ?? [];
          const hasSpark = sparkSeries.some((v) => v > 0);
          const rateVal = Math.round(rate[a.id] ?? 0);
          const rateLabel = rateVal > 0 ? `${fmtTokens(rateVal)}/m` : 'rate';
          const currentModelKnown = modelsForProvider(agentProvider)
            .some((model) => model.id === a.model);
          return (
          <div key={a.id} style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            padding: 6, marginBottom: 6,
            background: armed ? 'var(--cth-coral-light)' : 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 24, height: 24, background: `var(--cth-${a.accent}-light)`,
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
              }}>
                <SpritePortrait character={a.character} scale={1} />
              </div>
              <button
                onClick={() => select(a.id)}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)',
                  display: 'inline-flex', alignItems: 'center', gap: 6
                }}
              >
                <span>{a.name}{a.isOvermind ? ' (Overmind)' : ''}</span>
                {agentProvider !== 'claude' && (
                  <span title={`Engine: ${agentPreset.label}`} style={{
                    fontSize: 8, lineHeight: '11px', padding: '1px 4px 0',
                    background: 'var(--cth-sky-light)', color: 'var(--cth-ink-900)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-sky)', textTransform: 'uppercase',
                    fontWeight: 600
                  }}>{agentProvider === 'antigravity' ? 'AGY' : agentPreset.label}</span>
                )}
              </button>
              <PixelBadge status={armed ? 'looping' : a.status} />
              {armed && <span title={breaker?.reason} style={{ color: 'var(--cth-coral)', fontSize: 12 }}>⚠</span>}
              <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--cth-ink-500)' }}>
                {(toolCounts[a.id] ?? 0)} tool calls
              </span>
              <TokenLimitEditor value={agentCap} onSet={(t) => setAgentCap(a.id, t)} />
            </div>
            <div style={{ fontSize: 13, color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>{a.cwd}</div>
            {/* Live telemetry (folded in from the old Fleet tab) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {hasSpark ? (
                <span style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', flexShrink: 0 }}>{rateLabel}</span>
                  <Sparkline series={sparkSeries} />
                </span>
              ) : (
                <span style={{ flex: 1 }} />
              )}
              {lastTool[a.id] && (
                <span style={{
                  fontSize: 13, lineHeight: '14px', padding: '0 5px', flexShrink: 0,
                  background: 'var(--cth-paper-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', color: 'var(--cth-ink-700)'
                }}>{lastTool[a.id]}</span>
              )}
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-300)', flexShrink: 0 }}>budget</span>
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', width: 56, textAlign: 'right' }}>{fmtTokens(tokens)}</span>
              <div
                title={`CUMULATIVE session usage: ${tokens.toLocaleString()} of ${denom.toLocaleString()} tokens${agentCap ? ' (agent limit)' : ' (floor budget)'} — not the context window`}
                style={{ width: 96, height: 8, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }}
              >
                <div style={{ width: `${pct}%`, height: '100%', background: meterColor }} />
              </div>
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', width: 30, textAlign: 'right' }}>{pct}%</span>
            </div>
            {/* Context window — the SAME exact statusLine-fed numbers as the
                avatar-card gauge (tokens currently in the window vs the real
                200k/1M size). Distinct from the cumulative budget meter above,
                which keeps growing forever and pins at 100% — that one is
                spend, this one is headroom before compaction. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-300)', flexShrink: 0 }}>ctx</span>
              {a.contextTokens !== undefined && a.contextLimit ? (() => {
                const cpct = Math.min(100, Math.round((a.contextTokens! / a.contextLimit!) * 100));
                const ccolor = cpct >= 88 ? 'var(--cth-coral)' : cpct >= 75 ? 'var(--cth-lemon)' : `var(--cth-${a.accent})`;
                return (
                  <>
                    <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', width: 56, textAlign: 'right' }}>
                      {fmtTokens(a.contextTokens!)}
                    </span>
                    <div
                      title={`Context window: ${a.contextTokens!.toLocaleString()} of ${a.contextLimit!.toLocaleString()} tokens (${cpct}%)`}
                      style={{ width: 96, height: 8, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }}
                    >
                      <div style={{ width: `${cpct}%`, height: '100%', background: ccolor }} />
                    </div>
                    <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', width: 30, textAlign: 'right' }}>{cpct}%</span>
                  </>
                );
              })() : (
                <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-300)' }}>
                  no status tick yet
                </span>
              )}
            </div>
            {/* Non-god agents get the cross-provider model picker + restart controls
                here. The GOD agent's model lives in the engine row below
                (provider+model+apply), so we DON'T render this second selector for
                it — one model picker, not two. */}
            {!a.isOvermind && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Select
                value={encodeProviderModel(agentProvider, a.model)}
                disabled={restarting === a.id}
                onChange={(value) => {
                  const choice = decodeProviderModel(value);
                  if (!choice) return;
                  // Switching model within the SAME provider continues the
                  // conversation — that's the whole point of switching mid-task
                  // ("this got hard, go up a tier"), and starting fresh threw
                  // away the context that made the switch necessary.
                  // `resume` is best-effort: restartWithModel already refuses it
                  // across providers, and falls back to a fresh session when no
                  // session id or transcript is recorded.
                  void restartWithModel(a, choice.model, {
                    provider: choice.provider,
                    resume: choice.provider === agentProvider,
                    resumeOptional: true
                  });
                }}
              >
                {(!agentPreset.supportsModel || !currentModelKnown) && (
                  <option value={encodeProviderModel(agentProvider, a.model)}>
                    {agentPreset.label} · {a.model ?? 'current'}
                  </option>
                )}
                {modelProvidersForAgent(a.isOvermind).map((preset) => (
                  <optgroup key={preset.id} label={preset.label}>
                    {modelsForProvider(preset.id).map((model) => {
                      // `defaultModel` is a Claude model id, so it can only mark
                      // an entry in the Claude group.
                      const isHarnessDefault = preset.id === 'claude'
                        && !!defaultModel && model.id === defaultModel;
                      return (
                        <option
                          key={`${preset.id}:${model.id ?? 'cli-default'}`}
                          value={encodeProviderModel(preset.id, model.id)}
                        >
                          {model.label}{isHarnessDefault ? ' · default' : ''}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </Select>
              <span style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>
                {restarting === a.id
                  ? 'restarting…'
                  : `${agentPreset.label} model (restarts agent)`}
              </span>
              {/* Restart & Continue — kill + respawn keeping the SAME model and
                  resuming the prior conversation (--resume). Use this to redraw a
                  garbled TUI (e.g. after dragging the window across displays)
                  without losing the thread. */}
              {(agentProvider === 'claude' || agentPreset.resumeFlag || agentPreset.resumeSubcommand) && <>
                <span style={{ flex: 1 }} />
                <PixelButton
                  variant="secondary"
                  size="sm"
                  disabled={restarting === a.id}
                  onClick={() => restartWithModel(a, a.model, { resume: true })}
                >
                  <span title="Kill and respawn this agent, resuming its current conversation — fixes a corrupted/garbled terminal without losing context">
                    restart &amp; continue
                  </span>
                </PixelButton>
              </>}
            </div>
            )}
            {restartErrors[a.id] && (
              <div style={{ fontSize: 13, color: 'var(--cth-coral)' }}>
                {restartErrors[a.id]}
              </div>
            )}
            {a.isOvermind && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--cth-ink-500)', flexShrink: 0 }}>engine:</span>
                <Select
                  value={engineProvider}
                  disabled={restarting === a.id}
                  onChange={(v) => {
                    const p = v as AgentProvider;
                    setEngineProvider(p);
                    const preset = AGENT_PROVIDER_PRESETS.find((x) => x.id === p);
                    setEngineModel(preset?.recommendedOrchestratorModel);
                  }}
                >
                  {AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id)).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}{p.id === 'claude' ? ' ★' : ''}
                    </option>
                  ))}
                </Select>
                <Select
                  value={engineModel ?? ''}
                  disabled={restarting === a.id}
                  onChange={(v) => setEngineModel(v || undefined)}
                >
                  {modelsForProvider(engineProvider).map((m) => (
                    <option key={m.label} value={m.id ?? ''}>{m.label}</option>
                  ))}
                </Select>
                <PixelButton
                  variant="secondary"
                  size="sm"
                  disabled={restarting === a.id}
                  onClick={async () => {
                    const currentProvider = inferAgentProvider(a.command, a.provider);
                    if (engineProvider !== currentProvider) {
                      if (!window.confirm("This restarts Abathur; a conversation on a different engine can't be resumed.")) return;
                    }
                    await window.cth.updateConfig({ overmindProvider: engineProvider, overmindModel: engineModel });
                    await restartWithModel(a, engineModel, { provider: engineProvider, resume: false });
                  }}
                >
                  {restarting === a.id ? 'restarting…' : 'apply'}
                </PixelButton>
                {/* Redraw a garbled terminal without losing the thread (resume the
                    SAME engine+model). Kept here since the god has no per-agent row above. */}
                <PixelButton
                  variant="secondary"
                  size="sm"
                  disabled={restarting === a.id}
                  onClick={() => restartWithModel(a, a.model, { resume: true })}
                >
                  <span title="Kill and respawn Abathur, resuming the current conversation — fixes a corrupted/garbled terminal without losing context">
                    restart &amp; continue
                  </span>
                </PixelButton>
              </div>
            )}
          </div>
          );
        })}
        {/* Fleet summary band */}
        <div style={{
          display: 'flex', gap: 14, marginTop: 2, padding: '6px 8px',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', flexWrap: 'wrap'
        }}>
          <span>Σ <strong>{fmtTokens(sumTokens)}</strong> tok</span>
          <span style={{ color: 'var(--cth-ink-700)' }}>inputs {fmtTokens(sumInput)} (cache {fleetCachePct}%)</span>
          <span style={{ color: 'var(--cth-ink-700)' }}>{Math.round(sumRate).toLocaleString()} tok/min</span>
        </div>
        <div style={{ marginTop: 6 }}>
          <Muted>
            live from each agent&apos;s OpenTelemetry · bars show tokens used vs each agent&apos;s limit, else the {fmtTokens(floorCap)} floor budget
            {tokenCap && tokenCap > 0 ? '' : ' (default — set a floor token budget in Settings)'}
          </Muted>
        </div>
      </Section>

      <ArchivedSection />


      <Section title="DIRECTORIES">
        {repos.length === 0 && <Muted>No registered repos.</Muted>}
        {repos.map((r) => (
          <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--cth-ink-700)', wordBreak: 'break-all' }}>{r}</span>
            <button
              onClick={() => window.cth.openTerminalAt(r)}
              title="Open in Terminal.app"
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cth-ink-500)' }}
            ><Icon name="terminal" /></button>
          </div>
        ))}
      </Section>

      <Section title="ISSUES">
        {repos.length === 0 && <Muted>No registered repos.</Muted>}
        {repos.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <Select value={issueRepo || repos[0]} onChange={setIssueRepo}>
                {repos.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </Select>
              <PixelButton variant="primary" size="sm" onClick={fetchIssues} disabled={issuesLoading}>
                {issuesLoading ? 'fetching…' : 'Fetch issues'}
              </PixelButton>
            </div>
            {issuesError && (
              <div style={{
                fontSize: 12, color: 'var(--cth-ink-700)', marginBottom: 6,
                padding: 6, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                wordBreak: 'break-word'
              }}>{issuesError}</div>
            )}
            {!issuesError && !issuesLoading && issues.length === 0 && <Muted>No issues fetched yet.</Muted>}
            {issues.map((issue) => (
              <div key={issue.number} style={{
                display: 'flex', flexDirection: 'column', gap: 4,
                padding: 6, marginBottom: 6,
                background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-900)', flex: 1, wordBreak: 'break-word' }}>
                    <strong>#{issue.number}</strong> {issue.title}
                  </span>
                  <PixelButton variant="secondary" size="sm" onClick={() => assignIssue(issue)}>
                    Assign
                  </PixelButton>
                </div>
                {issue.labels.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {issue.labels.map((label) => (
                      <span key={label} style={{
                        fontSize: 13, lineHeight: '14px', padding: '0 5px',
                        background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        color: 'var(--cth-ink-700)'
                      }}>{label}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </Section>
    </Scroll>
  );
}

// ─── Archived agents — retained + flagged, kept off the floor ────────────────

function ArchivedSection() {
  const archivedAgents = useStore((s) => s.archivedAgents);
  const removeArchivedAgent = useStore((s) => s.removeArchivedAgent);
  const [open, setOpen] = useState(false);
  if (archivedAgents.length === 0) return null;
  return (
    <Section title={`ARCHIVED (${archivedAgents.length})`}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
          marginBottom: open ? 6 : 0
        }}
      >{open ? '▾' : '▸'} {open ? 'hide' : 'show'} closed agents</button>
      {open && archivedAgents.map((a) => (
        <div key={a.id} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: 6, marginBottom: 6, opacity: 0.7,
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}>
          <div style={{
            width: 24, height: 24, background: `var(--cth-${a.accent}-light)`,
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
          }}>
            <SpritePortrait character={a.character} scale={1} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)' }}>{a.name}</div>
            <div style={{ fontSize: 13, color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>{a.cwd}</div>
          </div>
          <button
            onClick={() => removeArchivedAgent(a.id)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cth-ink-500)', flexShrink: 0 }}
          ><Icon name="x" /></button>
        </div>
      ))}
    </Section>
  );
}

// ─── Memory tab ──────────────────────────────────────────────────────────────

interface MemoryTextResult {
  source: string;
  excerpt: string;
}

const MemoryTextResultRow = memo(function MemoryTextResultRow({ source, excerpt }: MemoryTextResult) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>{source}</div>
      <Pre>{excerpt}</Pre>
    </div>
  );
}, (prev, next) => prev.source === next.source && prev.excerpt === next.excerpt);

function MemoryTab({ godId, who: controlledWho, onWho }: { godId: string; who?: string; onWho?: (id: string) => void }) {
  const agents = useStore((s) => s.agents);
  // Selection is controllable from the graph tab; falls back to local state.
  const [internalWho, setInternalWho] = useState<string>(godId);
  const who = controlledWho ?? internalWho;
  const setWho = onWho ?? setInternalWho;
  const [mem, setMem] = useState('');
  const [query, setQuery] = useState('');
  const [searchOut, setSearchOut] = useState('');
  const [busy, setBusy] = useState(false);
  // Full-text search across hive files (board, tasks, memory) — additive.
  const [textQuery, setTextQuery] = useState('');
  const [textResults, setTextResults] = useState<Array<{ source: string; excerpt: string }>>([]);
  const [textSearched, setTextSearched] = useState(false);
  const [textBusy, setTextBusy] = useState(false);

  const agentOptions = useMemo(() => agents.map((a) => (
    <option key={a.id} value={a.id}>{a.name}</option>
  )), [agents]);

  const textResultItems = useMemo(() => textResults.map((entry, index) => (
    <MemoryTextResultRow key={`${entry.source}:${index}`} source={entry.source} excerpt={entry.excerpt} />
  )), [textResults]);

  useEffect(() => {
    window.cth.hiveMemory(who).then(setMem).catch(() => setMem(''));
  }, [who]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const res = await window.cth.searchMemory(query.trim());
      setSearchOut(res.ok ? (res.output || 'Nothing matched yet.') : `Couldn't search: ${res.error}`);
    } finally { setBusy(false); }
  };

  const textSearch = async () => {
    if (!textQuery.trim()) return;
    setTextBusy(true);
    try {
      const res = await window.cth.textSearch(textQuery.trim());
      setTextResults(res.ok ? res.results.slice(0, 10) : []);
    } catch { setTextResults([]); }
    finally { setTextBusy(false); setTextSearched(true); }
  };

  return (
    <Scroll>
      <Section title="TEXT SEARCH (board, tasks, memory)">
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={textQuery}
            onChange={(e) => setTextQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') textSearch(); }}
            placeholder="Find exact text across hive files…"
            style={{ ...textareaStyle, height: 30 }}
          />
          <PixelButton variant="primary" size="sm" onClick={textSearch} disabled={textBusy || !textQuery.trim()}>
            {textBusy ? '…' : 'search'}
          </PixelButton>
        </div>
        {textResults.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {textResultItems}
          </div>
        )}
        {textSearched && textResults.length === 0 && <Muted>Nothing matched.</Muted>}
      </Section>

      <Section title="SEMANTIC SEARCH (MemPalace)">
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
            placeholder="What does the hive know about…"
            style={{ ...textareaStyle, height: 30 }}
          />
          <PixelButton variant="primary" size="sm" onClick={search} disabled={busy || !query.trim()}>
            {busy ? '…' : 'search'}
          </PixelButton>
        </div>
        {searchOut && <Pre>{searchOut}</Pre>}
      </Section>

      <Section title="MEMORY FILE">
        <Select value={who} onChange={setWho}>
          {agentOptions}
        </Select>
        <Pre>{mem || 'No memory recorded yet.'}</Pre>
      </Section>
    </Scroll>
  );
}

// ─── Fleet telemetry bits (folded into the Floor AGENTS cards) ───────────────

/** Block-character sparkline of recent token deltas — neo-brutalist mono. */
function Sparkline({ series }: { series: number[] }) {
  const blocks = '▁▂▃▄▅▆▇█';
  const max = Math.max(1, ...series);
  const text = series.length
    ? series.map((v) => blocks[Math.min(blocks.length - 1, Math.round((v / max) * (blocks.length - 1)))]).join('')
    : '▁▁▁▁▁▁';
  return (
    <span style={{ flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '12px', color: 'var(--cth-sky)', whiteSpace: 'nowrap', overflow: 'hidden', minWidth: 0 }}>
      {text}
    </span>
  );
}

/** Compact token count: 1K / 10K / 100K / 1M / 100M / 1B (trailing .0 trimmed). */
function fmtTokens(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
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
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
          fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
        }}
      />
      <button
        onMouseDown={(e) => e.preventDefault()} onClick={commit} title="Save limit"
        style={{ flexShrink: 0, padding: '1px 5px', border: 'none', cursor: 'pointer', background: 'var(--cth-mint)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontSize: 13, color: 'var(--cth-ink-900)' }}
      >✓</button>
    </span>
  );
}

// ─── Activity feed — friendly insights + raw log ─────────────────────────────

import { type ActivityEntry } from '@/store/store';

const BADGE_COLORS: Record<ActivityEntry['badge'], string> = {
  INFO: 'var(--cth-sky)',
  PASS: 'var(--cth-mint)',
  SHIPPED: 'var(--cth-mint)',
  FINDING: 'var(--cth-lemon)',
  FAIL: 'var(--cth-coral)',
  BLOCK: 'var(--cth-coral)'
};

interface LogEntry { ts?: number; kind?: string; [k: string]: unknown }

function ActivityTab() {
  const feed = useStore((s) => s.activityFeed);
  const agents = useStore((s) => s.agents);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showRaw, setShowRaw] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const clearActivityUnread = useStore((s) => s.clearActivityUnread);

  const nameFor = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clear unread badge when this tab mounts.
  useEffect(() => { clearActivityUnread(); }, [clearActivityUnread]);

  // Raw log (lazy — only polls when the toggle is open).
  useEffect(() => {
    if (!showRaw) return;
    const refresh = async () => {
      try { setLog((await window.cth.hiveLog(60)) as LogEntry[]); } catch { /* noop */ }
    };
    refresh();
    timer.current = setInterval(refresh, 3000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [showRaw]);

  const fmtRaw = (e: LogEntry): string => {
    switch (e.kind) {
      case 'spawn': return `spawned ${String(e.name ?? e.agentId ?? '')}`;
      case 'message': return `${nameFor(String(e.from ?? ''))} → ${nameFor(String(e.to ?? ''))}: ${String(e.subject || e.act || '')}`;
      case 'drain': return `${String(e.agentId ?? '')} drained ${String(e.count ?? '')} msg(s)`;
      case 'escalate': return `escalated to human: ${String(e.subject ?? '')}`;
      case 'approval': return `approval ${e.approve ? 'granted' : 'denied'}`;
      default: return JSON.stringify(e);
    }
  };

  const reversedFeed = [...feed].reverse();

  return (
    <Scroll>
      <Section title="UPDATES">
        {reversedFeed.length === 0 && (
          <Muted>No tagged updates yet. The Overmind and agents surface insights here when they flag a message with surface_activity=true.</Muted>
        )}
        {reversedFeed.map((entry) => {
          const expanded = expandedIds.has(entry.id);
          return (
            <div key={entry.id} style={{ marginBottom: 8, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', cursor: 'pointer' }}
                onClick={() => setExpandedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
                  return next;
                })}>
                <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, padding: '1px 4px', background: BADGE_COLORS[entry.badge], color: 'var(--cth-ink-900)', flexShrink: 0 }}>
                  {entry.badge}
                </span>
                <span style={{ flex: 1, fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--cth-ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.headline}
                </span>
                <span style={{ fontSize: 13, color: 'var(--cth-ink-300)', flexShrink: 0 }}>
                  {nameFor(entry.from)} · {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              {expanded && (
                <div style={{ padding: '0 8px 8px' }}>
                  <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)', whiteSpace: 'pre-wrap', lineHeight: '17px' }}>
                    {entry.body}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Section>

      <div style={{ padding: '0 8px 4px' }}>
        <button onClick={() => setShowRaw((v) => !v)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-400)', padding: 0 }}>
          {showRaw ? '▼ RAW LOG' : '▶ RAW LOG'}
        </button>
      </div>
      {showRaw && (
        <Section title="RAW EVENT LOG">
          {log.length === 0 && <Muted>Nothing yet.</Muted>}
          {[...log].reverse().map((e, i) => (
            <div key={i} style={{ fontSize: 13, color: 'var(--cth-ink-500)', padding: '1px 0', display: 'flex', gap: 6 }}>
              <span style={{ color: 'var(--cth-ink-300)', flexShrink: 0 }}>{String(e.kind ?? '·')}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtRaw(e)}</span>
            </div>
          ))}
        </Section>
      )}
    </Scroll>
  );
}


// ─── small shared bits ───────────────────────────────────────────────────────

function Scroll({ children }: { children: React.ReactNode }) {
  // minWidth:0 + overflowX:hidden keep wide children (native selects, long paths,
  // budget rows) from forcing a horizontal scrollbar in the narrow sidebar — they
  // wrap/shrink instead. Vertical scroll stays.
  return <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 10, background: 'var(--cth-paper-200)' }}>{children}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '12px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center', color: 'var(--cth-ink-700)', fontSize: 13, background: 'var(--cth-paper-200)' }}>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{children}</div>;
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre style={{
      margin: '6px 0 0', padding: 8, maxHeight: 200, overflow: 'auto',
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
      fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
      color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
    }}>{children}</pre>
  );
}

const textareaStyle: React.CSSProperties = {
  flex: 1, width: '100%', resize: 'none', padding: '6px 8px',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '17px',
  color: 'var(--cth-ink-900)', outline: 'none', boxSizing: 'border-box'
};

function Select({ value, onChange, disabled, children }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '3px 6px', background: 'var(--cth-paper-100)',
        border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer',
        // Never let a long option name push the sidebar wider than it is.
        minWidth: 0, maxWidth: '100%'
      }}
    >{children}</select>
  );
}
