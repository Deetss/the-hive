import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PixelBadge, type StatusKind } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { PtyTerminalView } from './PtyTerminalView';
import { terminalInstanceKey } from './terminalRecovery';
import { MessageQueueComposer } from './MessageQueueComposer';
import { AgentControlStrip } from './AgentControlStrip';
import { CommandCenterPanel } from './CommandCenterPanel';
import { EditAgentModal } from './EditAgentModal';
import { Icon } from './Icon';
import { SpritePortrait } from './SpritePortrait';
import { PORTRAIT_W } from '@/scene/office/portraitArt';
import { RealtimeAbathurToggle } from './RealtimeAbathurToggle';
import { CostHud } from '@/realtime/CostHud';
import { useStore, type Agent } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useTerminalFontSize } from './terminalFontSize';
import { useHasTerminalDraft, disposeTerminal, reflowTerminal, notifyThemeChangeAll } from './terminalPool';
import { StatusBar } from './StatusBar';
import { AppChromeControls } from './AppChromeControls';
import { GitTab } from './GitTab';
import { FilesTab } from './FilesTab';
import { useAppTheme, toggleAppTheme } from '@/design/theme';
import { UpdateBadge } from './UpdateBadge';
import { AgentRosterItem } from './AgentRosterItem';
import { inferAgentProvider, providerPreset, type HarnessConfig } from '@/store/config';

/** Roster rail width. A fixed 232px is right on a 14" laptop but reads as a
 *  sliver on a 27" display, where names truncate for no reason — so it tracks
 *  the viewport between those two ends. */
const SIDEBAR_WIDTH = 'clamp(232px, 14vw, 340px)';
/** Remembers the roster collapse across fullscreen sessions and app restarts. */
const ROSTER_COLLAPSED_KEY = 'cth.fullscreen.rosterCollapsed';
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** Roster type scale, derived from the shared terminal zoom so Cmd +/- resizes
 *  the whole roster along with the terminal — one knob for the whole view
 *  instead of a size that only looked right on the display it was tuned on.
 *  Each is clamped: names are a pixel display face that turns to mush when it
 *  strays too far from its native size, and the bullets have to stay subordinate
 *  to the name however far the terminal is zoomed. */
function rosterScale(zoom: number) {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
  // The portrait is sized in SPRITE steps, not free pixels. The art is an 18×28
  // pixel stamp: widening the tile alone just pads it (which is what the old
  // `clamp(zoom * 1.2, 18, 40)` did past 18px — a bigger frame around the same
  // small figure), and a scale like 1.37× renders some pixel rows one device
  // pixel tall and others two. Half-steps double every other row cleanly, so
  // that is the grid the size moves on. Floor is 1.5× — 1× was too small to
  // tell two hires apart at a glance, which is the tile's whole job.
  const portraitScale = Math.min(2.5, Math.max(1.5, Math.round(zoom * 0.11 * 2) / 2));
  return {
    name: clamp(zoom * 0.9, 12, 16),
    group: clamp(zoom * 0.85, 11, 14),
    note: clamp(zoom * 0.85, 11, 15),
    portraitScale,
    portrait: Math.round(PORTRAIT_W * portraitScale)
  };
}

function basename(path: string): string {
  // Split on BOTH separators: `git:mainRepo` hands back whatever the platform
  // uses, and a Windows `C:\work\repo` contains no '/' at all — so a '/'-only
  // split returned the whole absolute path as the group's "name".
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** cwd → main-repo basename, resolved once per path and shared by every mount.
 *  An isolated agent's cwd is its own git worktree (`…/worktrees/<agent-id>`),
 *  so naming the group after that path buckets each such agent under its own id
 *  instead of the repository the user actually picked. `git:mainRepo` follows a
 *  linked worktree back to its main checkout. */
const repoRootByCwd = new Map<string, string | null>();
/** cwds with a lookup in flight, so a re-render can't start a second one. */
const repoLookupsInFlight = new Set<string>();

/** Which repository an agent belongs to — the ABSOLUTE root, so it is a real
 *  identity. Two unrelated checkouts can share a basename (`~/client-a/app` and
 *  `~/client-b/app`); keying groups on the name merged them into one section and
 *  let agents be dragged between two different repositories.
 *
 *  Falls back to the cwd itself until the async resolution lands, and for
 *  directories that aren't git repos at all. */
function repoKeyOf(agent: Agent): string {
  return repoRootByCwd.get(agent.cwd) || agent.cwd || 'unknown';
}

/** What that group is CALLED — the basename, or the project the user picked. */
function repoLabelOf(agent: Agent): string {
  const root = repoRootByCwd.get(agent.cwd);
  if (root) return basename(root);
  const project = agent.project?.trim();
  if (project) return project;
  return basename(agent.cwd) || 'unknown';
}

/** Resolve every distinct cwd's repository root, then re-render. Exactly one git
 *  call per distinct path, ever. */
function useResolvedRepoNames(agents: Agent[]): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const pending = [...new Set(agents.map(a => a.cwd).filter(Boolean))]
      // `has` (not a truthiness check) so a resolved-to-null path — a cwd that
      // is not a git repo — counts as answered. Caching only successes meant
      // every agent outside a repo re-asked on each pass, and this effect
      // depends on `agents`, which the pty parser replaces on every chunk of
      // terminal output: one such agent spawned `git rev-parse` continuously
      // for as long as it was talking. In-flight paths are skipped too, so a
      // re-render mid-lookup doesn't stack a second round of subprocesses.
      .filter(cwd => !repoRootByCwd.has(cwd) && !repoLookupsInFlight.has(cwd));
    if (pending.length === 0) return;
    pending.forEach(cwd => repoLookupsInFlight.add(cwd));
    void Promise.all(pending.map(async (cwd) => {
      try {
        repoRootByCwd.set(cwd, (await window.cth.gitMainRepo(cwd)) || null);
      } catch {
        // Record the failure as answered as well — retrying a path that throws
        // is what the unbounded-subprocess bug was made of.
        repoRootByCwd.set(cwd, null);
      } finally {
        repoLookupsInFlight.delete(cwd);
      }
    })).then(() => { if (!cancelled) setVersion(v => v + 1); });
    return () => { cancelled = true; };
  }, [agents]);
  return version;
}

/** The roster section an agent lives in — god agents share one ungrouped
 *  section, everyone else groups by repository. */
function groupKey(agent: Agent): string {
  return agent.isOvermind ? '__god__' : repoKeyOf(agent);
}

/** Drag-reorder wiring handed down to each row. */
interface RowDrag {
  dragId: string | null;
  overId: string | null;
  start: (id: string) => void;
  over: (id: string) => void;
  leave: (id: string) => void;
  drop: (id: string) => void;
  end: () => void;
}

export interface FullscreenTerminalProps {
  /** Only needed to rebuild a spawn command for a restorable agent saved before
   *  the `command` field existed — same role as in AgentStrip. */
  config?: HarnessConfig | null;
}

export function FullscreenTerminal({ config }: FullscreenTerminalProps) {
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const setFullscreen = useStore(s => s.setFullscreen);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const addAgentOpen = useStore(s => s.addAgentOpen);
  // Owned HERE, not in Header, purely so the Esc handler below can see it:
  // Esc closing the dialog must not also throw you out of focus mode.
  const [editAgentOpen, setEditAgentOpen] = useState(false);
  const [contentTab, setContentTab] = useState<'terminal' | 'git' | 'files'>('terminal');
  const setAgentNote = useStore(s => s.setAgentNote);
  const updateAgent = useStore(s => s.updateAgent);
  // The floor strip (and with it the restore button) is hidden behind the
  // overlay, so the roster carries restore too.
  const { restoring, autoRestoring, restoreTeam } = useRestoreTeam(config);
  const appThemeNow = useAppTheme();

  const agent = agents.find(a => a.id === fullscreenAgentId);
  const parser = usePtyParser(agent?.id ?? '__none__');

  const repoVersion = useResolvedRepoNames(agents);
  const scale = rosterScale(useTerminalFontSize());

  // Drag-to-reorder, same as the floor strip (native HTML5 DnD, no dep). A plain
  // click still selects — a drag only starts on movement. Drops are confined to
  // the dragged agent's OWN group: the repo header comes from its cwd, so a
  // cross-group drop would reorder the array and then snap the row straight back
  // under its own header, which just reads as "reordering is broken".
  const reorderAgents = useStore(s => s.reorderAgents);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // Roster parity with the floor strip (AgentStrip → AgentCard): the QUOTA chip
  // is fed by the PTY-parsed fleet snapshot, the profile chip by the runtime
  // profile list. Same sources AgentStrip uses.
  const [quotaById, setQuotaById] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!window.cth.onFleetTokens) return;
    return window.cth.onFleetTokens((data) => {
      const next: Record<string, boolean> = {};
      for (const [id, v] of Object.entries(data)) if (v?.quotaLimited) next[id] = true;
      setQuotaById(next);
    });
  }, []);
  const [needsInputById, setNeedsInputById] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!window.cth.onAgentNeedsInput) return;
    return window.cth.onAgentNeedsInput(({ agentId, prompt }) => {
      setNeedsInputById((prev) => {
        if (prompt) return { ...prev, [agentId]: prompt };
        if (!(agentId in prev)) return prev;
        const next = { ...prev }; delete next[agentId]; return next;
      });
    });
  }, []);
  const profileNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of config?.runtimeProfiles ?? []) {
      m[p.id] = p.name.includes('·') ? p.name.split('·').pop()!.trim() : p.name;
    }
    return m;
  }, [config?.runtimeProfiles]);
  // Roster collapse. Persisted because it is a working preference, not a mode:
  // someone who hides the rail to read wide terminal output wants it still hidden
  // the next time they go fullscreen, not to re-hide it every single time.
  const [rosterCollapsed, setRosterCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(ROSTER_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggleRoster = (): void => {
    setRosterCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(ROSTER_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  };
  const drag: RowDrag = {
    dragId,
    overId,
    start: (id) => setDragId(id),
    over: (id) => setOverId((prev) => (prev === id ? prev : id)),
    leave: (id) => setOverId((prev) => (prev === id ? null : prev)),
    drop: (id) => {
      if (dragId && dragId !== id) {
        const from = agents.find(a => a.id === dragId);
        const to = agents.find(a => a.id === id);
        if (from && to && groupKey(from) === groupKey(to)) reorderAgents(dragId, id);
      }
      setDragId(null);
      setOverId(null);
    },
    end: () => { setDragId(null); setOverId(null); }
  };

  // Roster: god agents first and ungrouped, everyone else bucketed by repo.
  // Insertion order is preserved inside each bucket (it's the user's own
  // drag-reorder from the floor strip) and buckets appear in first-seen order,
  // so the list doesn't reshuffle as statuses change.
  const { gods, groups } = useMemo(() => {
    const godList: Agent[] = [];
    // Keyed by absolute repo root (identity); the label is carried alongside so
    // two same-named repos stay two groups but still read by name.
    const byRepo = new Map<string, { label: string; members: Agent[] }>();
    for (const a of agents) {
      if (a.isOvermind) { godList.push(a); continue; }
      const key = repoKeyOf(a);
      const bucket = byRepo.get(key);
      if (bucket) bucket.members.push(a);
      else byRepo.set(key, { label: repoLabelOf(a), members: [a] });
    }
    return { gods: godList, groups: [...byRepo.entries()] };
    // repoVersion: rebucket once the async main-repo lookups land.
  }, [agents, repoVersion]);

  // Focus mode: adding (or removing) an agent changes the layout around the
  // focused terminal, but nothing re-fits it, so the grid stays wrong until the
  // user switches agent and back (a remount, hence a fresh fit). Re-fit on
  // every roster change. reflowTerminal only pokes the pty when cols/rows
  // actually moved and never scrolls, so a no-op roster change costs nothing.
  // Two passes: one after layout settles, one after the roster row has painted.
  const rosterKey = agents.map(a => a.id).join('\n');
  const focusedPtyId = agent?.ptyId;
  useEffect(() => {
    if (!focusedPtyId) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => reflowTerminal(focusedPtyId)));
    const late = setTimeout(() => reflowTerminal(focusedPtyId), 240);
    return () => { cancelAnimationFrame(raf); clearTimeout(late); };
  }, [rosterKey, focusedPtyId]);

  // Esc exits fullscreen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A modal above fullscreen owns the interaction until it closes. Without
        // this guard, Esc from the Add Agent form unexpectedly exits fullscreen.
        if (addAgentOpen || editAgentOpen) return;
        e.preventDefault();
        setFullscreen(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addAgentOpen, editAgentOpen, setFullscreen]);

  // Focus mode is pointing at something we cannot render. Re-home to another live
  // agent rather than dropping the user out; leave only when nothing is left.
  // In an effect, not in render: setState during render is a React anti-pattern,
  // and hard-nulling here defeated the store's re-homing the same way onKill did.
  // `refocusFullscreen`, NOT `setFullscreen`: this is the app following the user,
  // not the user telling the app what they want. Going through the explicit
  // toggle here wrote `prefersFocusMode = false` every time an agent went away,
  // which is the same "fix the store, then overwrite it from a call site" trap
  // that broke closing an agent in focus mode.
  useEffect(() => {
    if (agent && agent.ptyId) return;
    const s = useStore.getState();
    const next = s.agents.find((a) => a.id !== agent?.id && a.ptyId);
    s.refocusFullscreen(next?.id ?? null);
  }, [agent]);

  if (!agent || !agent.ptyId) return null;

  // No kill button here on purpose. Killing an agent is a destructive action
  // that belongs with the rest of its lifecycle controls in the docked panel;
  // sitting inches from the tab you click to switch agents, it was only ever a
  // mis-click waiting to happen. Exiting fullscreen is likewise already covered
  // twice over (Esc, and the terminal toolbar's own fullscreen toggle).
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-100)',
      zIndex: 250,
      display: 'flex',
      flexDirection: 'column',
      paddingTop: 28  // leave room for titlebar / drag region
    }}>
      {/* Title bar drag region (so the user can still move the window) */}
      <div
        className="cth-titlebar-drag"
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 28,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '1px solid var(--cth-ink-300)',
          display: 'flex', alignItems: 'center',
          paddingLeft: isMac ? 96 : 14, paddingRight: 10, gap: 8,
          userSelect: 'none'
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: agent.status === 'blocked' ? 'var(--cth-coral)'
              : agent.status === 'working' ? 'var(--cth-lemon)'
              : 'var(--cth-mint)'
          }}
        />
        <span style={{
          fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-700)',
          whiteSpace: 'nowrap', overflow: 'hidden'
        }}>
          The Hive — Focus Mode · <strong style={{ color: 'var(--cth-ink-900)' }}>{agent.name}</strong>
        </span>
        <div className="cth-titlebar-nodrag" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={toggleRoster}
            title={rosterCollapsed ? 'Show the agent list' : 'Hide the agent list — full-width terminal'}
            aria-label={rosterCollapsed ? 'Show the agent list' : 'Hide the agent list'}
            aria-pressed={rosterCollapsed}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 20, padding: 0,
              background: rosterCollapsed ? 'var(--cth-lemon)' : 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              border: 'none', borderRadius: 2, cursor: 'pointer',
              color: 'var(--cth-ink-900)', lineHeight: 1
            }}
          >
            <Icon name="sidebar" size={1} style={{ width: 14, height: 14 }} />
          </button>
          <AppChromeControls />
        </div>
      </div>

      {/* Body — roster on the left, the focused agent's terminal on the right.
          A vertical list scales past the handful of agents a horizontal tab bar
          could show, and grouping by repository is how the user actually thinks
          about the fleet. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* Unmounted rather than width:0 when collapsed — the roster renders a row
            per agent with live status, and keeping a hidden copy mounted would go
            on doing that work for a rail nobody can see. Remounting is cheap; the
            terminals live in the pool and are untouched by this. */}
        {!rosterCollapsed && (
        <aside style={{
          width: SIDEBAR_WIDTH, flexShrink: 0,
          display: 'flex', flexDirection: 'column',
          background: 'var(--cth-cream-200)',
          borderRight: '1px solid var(--cth-ink-300)'
        }}>
          {/* Roster header with add agent button */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 2,
            padding: '4px 6px', borderBottom: '1px solid var(--cth-ink-300)',
            background: 'var(--cth-cream-200)', flexShrink: 0
          }}>
            <span style={{
              fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '14px', textTransform: 'uppercase',
              color: 'var(--cth-ink-700)'
            }}>ROSTER</span>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => setAddAgentOpen(true)}
              title="Add agent"
              style={{
                width: 24, height: 24, padding: 0, border: 'none', cursor: 'pointer',
                background: 'var(--cth-cream-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--cth-ink-900)'
              }}
            >
              <Icon name="plus" />
            </button>
          </div>

          <>
          <div className="cth-scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0' }}>
            {/* The god agent runs the floor rather than a checkout, so it gets no
                repository header — it sits alone at the top of the roster. */}
            {gods.map(a => (
              <div key={a.id}>
                <SidebarRow
                  agent={a}
                  active={a.id === agent.id}
                  onClick={() => { select(a.id); setFullscreen(a.id); }}
                  onNoteChange={(note) => setAgentNote(a.id, note)}
                  drag={drag}
                  scale={scale}
                  quotaLimited={quotaById[a.id]}
                  needsInput={needsInputById[a.id]}
                  profileLabel={a.profileId ? profileNameById[a.profileId] : undefined}
                />
              </div>
            ))}
            {groups.map(([repoKey, { label, members }]) => (
              // Repos are the roster's real structure, so they get real
              // separation — a hairline plus air above, not just a label.
              <div key={repoKey} style={{ marginTop: 16, paddingTop: 10, borderTop: '1px solid var(--cth-ink-300)' }}>
                <div
                  title={repoKey}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '0 10px 6px',
                    fontFamily: 'var(--cth-font-ui)',
                    fontSize: scale.group, lineHeight: 1.5,
                    color: 'var(--cth-ink-500)'
                  }}
                >
                  {/* Native 16px, never a fraction of it: this is pixel art on
                      a 16-unit grid, so squeezing it to match a 7px label
                      merged the outline into mush. Dimmed instead of shrunk. */}
                  <span style={{ flexShrink: 0, display: 'inline-flex', opacity: 0.7 }}>
                    <Icon name="folder" size={scale.group >= 13 ? 2 : 1} />
                  </span>
                  <span style={{
                    minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>{label.toUpperCase()}</span>
                </div>
                {members.map(a => (
                  <SidebarRow
                    key={a.id}
                    agent={a}
                    active={a.id === agent.id}
                    onClick={() => { select(a.id); setFullscreen(a.id); }}
                    onNoteChange={(note) => setAgentNote(a.id, note)}
                    drag={drag}
                    scale={scale}
                    quotaLimited={quotaById[a.id]}
                    needsInput={needsInputById[a.id]}
                    profileLabel={a.profileId ? profileNameById[a.profileId] : undefined}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* Last session's team, same as the floor strip — pinned to the bottom
              so it can't be scrolled out of reach behind a long roster. */}
          {(restorableAgents.length > 0 || autoRestoring) && (
            <div style={{
              flexShrink: 0, padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
              borderTop: '1px solid var(--cth-ink-300)'
            }}>
              {autoRestoring && (
                // Same banner as the floor strip: terminals that open by
                // themselves need to say why.
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 8px',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                  color: 'var(--cth-ink-900)',
                  background: 'var(--cth-status-working)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}>
                  <Icon name="play" /> restoring your team…
                </div>
              )}
              {!autoRestoring && restorableAgents.length > 0 && (
                <PixelButton
                  variant="primary"
                  size="sm"
                  onClick={restoreTeam}
                  disabled={restoring}
                  style={{ width: '100%' }}
                  title={`Respawn from last session: ${restorableAgents.map((a: Agent) => a.name).join(', ')} — same ids, memory and inboxes reattach automatically`}
                >
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <Icon name="play" /> {restoring ? 'restoring…' : `restore team (${restorableAgents.length})`}
                  </span>
                </PixelButton>
              )}
              {!autoRestoring && restorableAgents.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {restorableAgents.map((a: Agent) => (
                    <span
                      key={a.id}
                      title={`${a.name} — restorable from last session`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 2,
                        height: 20, padding: '0 2px 0 6px',
                        fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                        color: 'var(--cth-ink-700)', background: 'var(--cth-paper-100)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                      }}
                    >
                      {a.name}
                      <button
                        onClick={() => useStore.getState().removeRestorableAgent(a.id)}
                        title={`Dismiss ${a.name} — remove permanently from the restore list`}
                        aria-label={`Dismiss ${a.name}`}
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 14, height: 14, padding: 0, lineHeight: 1,
                          fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                          color: 'var(--cth-ink-500)', background: 'transparent',
                          border: 'none', cursor: 'pointer'
                        }}
                      >✕</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          </>
        </aside>
        )}

        <div style={{
          flex: 1, minWidth: 0, minHeight: 0,
          display: 'flex', flexDirection: 'column'
        }}>
          {agent.isOvermind ? (
            // Abathur: full command center with all floor tabs
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <CommandCenterPanel agent={agent} fullscreen />
            </div>
          ) : (
            // Workers: header + controls + simple terminal / git / files tabs
            <>
              <div style={{ padding: '12px 12px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Header agent={agent} onEdit={() => setEditAgentOpen(true)} />
                {editAgentOpen && (
                  <EditAgentModal agent={agent} onClose={() => setEditAgentOpen(false)} />
                )}
                <AgentControlStrip key={agent.id} agentId={agent.id} />
              </div>

              {/* Tab bar */}
              <div style={{
                display: 'flex', gap: 2, padding: '4px 8px', flexShrink: 0,
                borderBottom: '1px solid var(--cth-ink-300)',
                background: 'var(--cth-cream-200)'
              }}>
                {(['terminal', 'git', 'files'] as const).map((t) => (
                  <button key={t} onClick={() => setContentTab(t)} style={{
                    padding: '3px 10px', border: 'none', cursor: 'pointer',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 13, textTransform: 'uppercase',
                    color: 'var(--cth-ink-700)',
                    background: contentTab === t ? 'var(--cth-sky-light)' : 'transparent',
                    boxShadow: contentTab === t ? 'inset 0 0 0 1px var(--cth-ink-300)' : 'none'
                  }}>{t}</button>
                ))}
              </div>

              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: contentTab === 'terminal' ? 0 : 12 }}>
                {contentTab === 'terminal' ? (
                  <>
                    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                      <PtyTerminalView
                        key={terminalInstanceKey(agent.ptyId, agent.terminalGeneration)}
                        ptyId={agent.ptyId}
                        onStreamData={parser}
                        onUserPrompt={(t) => {
                          updateAgent(agent.id, { lastPrompt: t });
                          if (t.trim().toLowerCase() === '/clear') {
                            updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                          }
                          void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text: t });
                        }}
                        onToggleFullscreen={() => setFullscreen(null)}
                        fullscreen
                      />
                    </div>
                    <MessageQueueComposer agent={agent} />
                  </>
                ) : contentTab === 'git' ? (
                  <GitTab cwd={agent.worktreePath ?? agent.cwd} />
                ) : (
                  <FilesTab cwd={agent.worktreePath ?? agent.cwd} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <StatusBar />
    </div>
  );
}

/** Model ids are long and mostly boilerplate ("claude-opus-4-8[1m]",
 *  "anthropic/claude-sonnet-4-5"). The roster has ~120px, so show the part that
 *  distinguishes one agent from another and keep the full id in the tooltip. */
function shortModel(model?: string): string | null {
  if (!model || !model.trim()) return null;
  const tail = model.split('/').pop() ?? model;
  return tail
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/, '')          // trailing date stamps
    .replace(/\[(\d+)m\]/i, ' $1m') // [1m] → 1m
    .replace(/-/g, ' ')
    .trim();
}

function SidebarRow({
  agent,
  active,
  onClick,
  onNoteChange,
  drag,
  scale,
  quotaLimited,
  profileLabel,
  needsInput
}: {
  agent: Agent;
  active: boolean;
  onClick: () => void;
  onNoteChange: (note: string) => void;
  drag: RowDrag;
  scale: ReturnType<typeof rosterScale>;
  quotaLimited?: boolean;
  profileLabel?: string;
  needsInput?: string;
}) {
  return (
    <AgentRosterItem
      variant="rail"
      agent={agent}
      active={active}
      onClick={onClick}
      onNoteChange={onNoteChange}
      drag={drag}
      scale={scale}
      quotaLimited={quotaLimited}
      profileLabel={profileLabel}
      needsInput={needsInput}
    />
  );
}

function Header({ agent, onEdit }: { agent: Agent; onEdit: () => void }) {
  const typing = useHasTerminalDraft(agent.ptyId);
  const archiveAgent = useStore((st) => st.archiveAgent);
  const [openState, setOpenState] = useState<'idle' | 'opening' | 'ok' | 'error'>('idle');

  /** Same action as the docked panel: open the OS terminal in this agent's
   *  working directory. Fullscreen had no way to do it, which is backwards —
   *  this is the mode where you are most likely to want a shell beside it. */
  const openTerminal = async () => {
    setOpenState('opening');
    try {
      const res = await window.cth.openTerminalAt(agent.worktreePath || agent.cwd);
      setOpenState(res.ok ? 'ok' : 'error');
    } catch { setOpenState('error'); }
    setTimeout(() => setOpenState('idle'), 1500);
  };

  /** Kill + archive, mirroring AgentDetailPanel. Confirmed, because it ends a
   *  running process. God is exempt: the floor respawns it immediately, so the
   *  button would read as "restart Abathur" while looking like "close". */
  const onKill = async () => {
    if (!agent.ptyId) return;
    if (!confirm(`Close ${agent.name}? The PTY process will terminate and the agent is archived (kept in history, off the floor).`)) return;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    // archiveAgent re-homes focus mode to the next agent, and only leaves it when
    // the last one is gone. Hard-nulling here threw that away, which is why
    // closing an agent from inside focus mode still dropped you to the sidebar
    // even after the store was fixed.
    archiveAgent(agent.id);
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '6px 10px',
      background: 'var(--cth-cream-50)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      <span style={{
        fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '16px',
        color: 'var(--cth-ink-900)'
      }}>{agent.name.toUpperCase()}</span>
      {/* Edit belongs with the NAME, not with the action cluster on the right:
          it changes who this agent is, and the right-hand group is things you do
          with the agent. Icon-only because it sits inside the identity line —
          the word "edit" there would push the path off. God is excluded, as
          everywhere else: his identity is the hive's, not the roster's. */}
      {!agent.isOvermind && (
        <PixelButton variant="secondary" size="sm" onClick={onEdit}>
          <span
            className="cth-tip cth-tip-left cth-tip-wrap"
            data-tip={`Edit ${agent.name}: their name and face, which engine they run on, and the briefing that tells them what they are for.`}
            aria-label={`Edit ${agent.name}`}
            style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}
          >
            <Icon name="edit" />
          </span>
        </PixelButton>
      )}
      <span style={{
        fontSize: 12, color: 'var(--cth-ink-500)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        maxWidth: 300
      }}>{agent.cwd}</span>
      <span style={{
        fontSize: 12, color: 'var(--cth-ink-700)',
        fontStyle: 'italic'
      }}>“{agent.description}”</span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* v0.3.4: the IDE opens from agent level — full Monaco editor + git
            diff over this agent's workspace. The id is passed EXPLICITLY:
            fullscreen does not change the selection, so leaving the IDE to infer
            its agent would open whichever agent happens to be selected in the
            sidebar rather than the one filling the screen. */}
        <PixelButton variant="secondary" size="sm" onClick={() => useStore.getState().setIdeOpen(true, agent.id)}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={`Open the IDE: browse and edit files in ${agent.name}'s workspace, and see their uncommitted changes as a diff.`}
            aria-label="Open the IDE"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="code" /> IDE
          </span>
        </PixelButton>
        {/* Voice toggle is ALWAYS reachable in fullscreen — it controls Abathur (the
            god orchestrator) globally, not the agent in view, so users can start a
            voice session even while a worker's terminal fills the screen. The cost
            HUD stays Abathur-only (it belongs to his card). */}
        <RealtimeAbathurToggle />
        {agent.isOvermind && <CostHud compact />}
        <PixelButton variant="secondary" size="sm" onClick={openTerminal} disabled={openState === 'opening'}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={`Open your system terminal app in ${agent.worktreePath || agent.cwd} — a normal shell in this agent's folder, separate from the agent's own terminal.`}
            aria-label="Open a system terminal in this agent's folder"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="terminal" />
            {openState === 'opening' ? '...' : openState === 'ok' ? 'ok' : openState === 'error' ? 'err' : 'terminal'}
          </span>
        </PixelButton>
        {/* The badge is a STATUS, not a button, but it sits in a row of them.
            Its own box is 20px (lineHeight 18 + 2px padding) against the 24px
            every size="sm" PixelButton is fixed at, so the row read as ragged.
            Sized through the badge's own style prop rather than a wrapper: a
            wrapper only centres the 20px box inside 24px, it does not make the
            visible border match. */}
        <PixelBadge
          status={typing ? 'typing' : agent.status}
          style={{ height: 24, padding: '0 8px', lineHeight: '24px' }}
        />
        {!agent.isOvermind && (
          <PixelButton variant="destructive" size="sm" onClick={onKill}>
            {/* inline-flex + center: the other buttons hold TEXT, whose line box
                the button centres for free. A bare <Icon> is replaced-content
                sitting on the text baseline, so it rode low and overhung the
                24px box — the button measured the same as its neighbours while
                reading taller than them. */}
            <span
              title={`Close ${agent.name} — ends the process and archives the agent`}
              style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}
            >
              <Icon name="x" />
            </span>
          </PixelButton>
        )}
      </div>
    </div>
  );
}
