import { useCallback, useEffect, useState } from 'react';
import { useStore, selectedAgent } from '@/store/store';
import { startMockLoop, stopMockLoop } from '@/store/mockEvents';
import type { HarnessConfig } from '@/store/config';
import { DEFAULT_ORG_TRIGGER } from '@shared/triggers';
import { OfficeFloor } from '@/scene/office/OfficeFloor';
import { useHive } from '@/hooks/useHive';
import { MemoryPanel } from '@/components/MemoryPanel';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { AgentStrip } from '@/components/AgentStrip';
import { StatusBar } from '@/components/StatusBar';
import { AddAgentModal } from '@/components/AddAgentModal';
import { AbathurBooting } from '@/components/AbathurBooting';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { ProfileWalkthrough } from '@/components/ProfileWalkthrough';
import { HivePicker } from '@/components/HivePicker';
import { QuitWarningModal, type ClosingTimeState } from '@/components/QuitWarningModal';
import { CompletionToast } from '@/realtime/CompletionToast';
import { UpdateToast } from '@/components/UpdateToast';
import { SettingsModal, type Section as SettingsSection } from '@/components/SettingsModal';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import { SidebarSplitter } from '@/components/SidebarSplitter';
import { acquireTerminal } from '@/components/terminalPool';
import { FullscreenTerminal } from '@/components/FullscreenTerminal';
import { TaskDetailOverlay } from '@/components/TaskDetailOverlay';
import { IdePanel } from '@/ide/IdePanel';
import { useHoldOptionToTalk } from '@/freeflow/holdOption';
import brandLogo from '@brand/logo.png?url';
import { cancelQaTimer } from '@/components/QuickAskPanel';
import { useMediaQuery } from '@/hooks/useMediaQuery';

// Injected at build time from package.json (see electron.vite.config.ts).
declare const __APP_VERSION__: string;

export function App() {
  const agent = useStore(selectedAgent);
  const agents = useStore(s => s.agents);
  const agentCount = agents.length;
  const addAgentOpen = useStore(s => s.addAgentOpen);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const clearPendingHires = useStore(s => s.clearPendingHires);
  const godStatus = useStore(s => s.godStatus);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const sidebarWidth = useStore(s => s.sidebarWidth);
  const setSidebarWidth = useStore(s => s.setSidebarWidth);
  const ideOpen = useStore(s => s.ideOpen);
  const setIdeOpen = useStore(s => s.setIdeOpen);
  const pendingArtifacts = useStore(s => s.pendingArtifacts);
  const setPendingArtifacts = useStore(s => s.setPendingArtifacts);

  const isMobile = useMediaQuery('(max-width: 480px)');
  const [config, setConfig] = useState<HarnessConfig | null>(null);
  // Whether the user has passed the launch-time hive picker this session. Starts
  // true (skip the picker) right after a hive SWITCH — changeHome relaunches and
  // leaves a one-shot localStorage flag so we don't bounce back onto the picker for
  // the hive we just chose. Also set true on onboarding completion (below).
  const [hiveOpened, setHiveOpened] = useState<boolean>(() => {
    try {
      if (window.localStorage.getItem('cth.skipHivePickerOnce')) {
        window.localStorage.removeItem('cth.skipHivePickerOnce');
        return true;
      }
    } catch { /* localStorage unavailable — show the picker */ }
    return false;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Which tab Settings opens on. Set by a `cth:open-settings` deep link, reset
   *  to undefined (→ General) whenever the modal is opened the normal way. */
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [quitWarn, setQuitWarn] = useState<{ ptyCount: number } | null>(null);
  const [closing, setClosing] = useState<ClosingTimeState | null>(null);
  const [vpWidth, setVpWidth] = useState<number>(window.innerWidth);
  const [profileWalkthroughOpen, setProfileWalkthroughOpen] = useState(false);
  const [profileWalkthroughMandatory, setProfileWalkthroughMandatory] = useState(false);

  // Open Settings with a fresh config read so local state in SettingsModal
  // initializes from the current disk value, not the stale load-time snapshot.
  // Without this, a setting changed in SettingsModal would appear to reset the
  // next time Settings opened in the same session (the prop hadn't updated).
  const openSettings = useCallback((section?: SettingsSection) => {
    window.cth.getConfig().then(fresh => setConfig(fresh)).catch(() => {/* use stale on failure */});
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const handleProfileWalkthroughComplete = useCallback((next: HarnessConfig) => {
    setConfig(next);
    setProfileWalkthroughOpen(false);
    setProfileWalkthroughMandatory(false);
    setHiveOpened(true);
  }, []);

  const handleProfileWalkthroughCancel = useCallback(() => {
    setProfileWalkthroughOpen(false);
    setProfileWalkthroughMandatory(false);
  }, []);

  const openProfileWalkthroughFromSettings = useCallback(() => {
    setSettingsOpen(false);
    const fetchConfig = window.cth.getConfig?.();
    if (fetchConfig && typeof (fetchConfig as Promise<HarnessConfig>).then === 'function') {
      (fetchConfig as Promise<HarnessConfig>).then((fresh) => {
        setConfig(fresh);
        setProfileWalkthroughMandatory(false);
        setProfileWalkthroughOpen(true);
      }).catch(() => {
        setProfileWalkthroughMandatory(false);
        setProfileWalkthroughOpen(true);
      });
    } else {
      setProfileWalkthroughMandatory(false);
      setProfileWalkthroughOpen(true);
    }
  }, []);

  // Deep link into Settings from anywhere in the tree. Settings' open state is
  // local to App, so a nested control (e.g. "set it now" beside a disabled Talk
  // button) has no path to it without threading a prop through every layer
  // between; a window event keeps that plumbing out of the components in
  // between, matching the existing `cth:` CustomEvent convention.
  useEffect(() => {
    const onOpenSettings = (e: Event): void => {
      const section = (e as CustomEvent<{ section?: SettingsSection }>).detail?.section;
      openSettings(section);
    };
    window.addEventListener('cth:open-settings', onOpenSettings);
    return () => window.removeEventListener('cth:open-settings', onOpenSettings);
  }, [openSettings]);

  // Initial config load
  useEffect(() => {
    let cancelled = false;
    window.cth.getConfig().then(c => {
      if (cancelled) return;
      setConfig(c);
      // Mirror the Free Flow flag into the store so the composer mic button shows
      // only when enabled (Settings keeps this in sync on save).
      useStore.getState().setFreeflowEnabled(!!c.freeflowEnabled);
      // Mirror boolean key-presence ONLY (never the key value) so the composer can
      // show the voice button disabled-with-tooltip when Free Flow is on but no
      // Groq key is set (Settings keeps this in sync on save).
      useStore.getState().setHasGroqKey(!!c.groqApiKey);
      // Mirror the active office theme so OfficeFloor renders it (gated on the
      // tvShowOffices flag; off = always the office). Settings keeps this synced.
      useStore.getState().setOfficeTheme(c.tvShowOffices ? (c.officeTheme ?? 'office') : 'office');
      // Mirror the triggers so Settings → Connections and the Command Center's
      // Triggers tab read one list, not two copies that drift — whichever surface
      // saves calls these same setters and the other repaints. No extra IPC: main
      // deep-fills both fields on every config read (withTriggerDefaults), so
      // getConfig() already serves what listWebhooks()/getOrgTrigger() would.
      // `c` is typed as the PRELOAD's HarnessConfig, which hasn't picked the two
      // fields up yet (another lane's file); the renderer mirror type declares them.
      const withTriggers = c as HarnessConfig;
      useStore.getState().setWebhookTriggers(withTriggers.webhookTriggers ?? []);
      useStore.getState().setOrgTrigger(withTriggers.orgTrigger ?? DEFAULT_ORG_TRIGGER);
    }).catch((err: unknown) => { console.error('[app] getConfig failed:', err); });
    // Mirror BYOK OpenAI key presence (boolean only; the key never leaves main) so the
    // Realtime Abathur voice toggle can gate on it. Lives in the secret broker, not
    // config — so fetch it rather than derive from c.
    window.cth.realtimeHasOpenAiKey().then(has => {
      if (!cancelled) useStore.getState().setHasOpenAiKey(has);
    });
    return () => { cancelled = true; };
  }, []);

  // Free Flow entry point B — hold-Option (⌥) to talk. In-renderer push-to-talk
  // for whichever agent the user is viewing; gated on the flag, terminal-safe
  // (solo-hold threshold, aborts on any other key). See freeflow/holdOption.ts.
  useHoldOptionToTalk();

  useEffect(() => {
    if (!config) return;
    if (config.harnessHome && !config.onboardingComplete && !profileWalkthroughOpen) {
      setProfileWalkthroughMandatory(true);
      setProfileWalkthroughOpen(true);
    }
  }, [config?.harnessHome, config?.onboardingComplete, profileWalkthroughOpen]);

  // Single always-on hive message subscription — lives here (App root) so it
  // fires regardless of which agent or tab is selected. Serves two streams:
  //   1. Ask Me (needsHuman): all messages directed at the human, except Quick-Ask
  //      replies (identified by their conversation id being in quickAskConversations).
  //   2. Activity feed (surfaceActivity): stores entry in the store (survives tab
  //      switches) and bumps the unread badge.
  useEffect(() => {
    if (!window.cth?.onHiveMessage) return;
    return window.cth.onHiveMessage((e) => {
      const state = useStore.getState();
      // Ask Me stream: direct messages to the human. Quick-Ask replies are
      // routed to the Q&A store instead of the Ask Me inbox.
      if (e.needsHuman && e.body && e.id) {
        const actStr = e.act as string;
        const isQuickAsk = Boolean(
          (e.conversation && (state.quickAskConversations.includes(e.conversation) || e.conversation.startsWith('qa-'))) ||
          e.act === 'query' ||
          actStr === 'reply' ||
          (e.subject && /quick\s*ask/i.test(e.subject))
        );

        if (isQuickAsk) {
          if (e.act === 'query' || e.from === 'human') {
            const exists = state.quickAskEntries.some((q) => q.id === e.id || (e.conversation && q.currentConversation === e.conversation));
            if (!exists) {
              const convId = e.conversation || `qa-${e.id}`;
              state.addQuickAskEntry({
                id: e.id,
                question: e.body!,
                askedAt: Date.now(),
                currentConversation: convId,
                waiting: true,
                timedOut: false
              });
              state.trackQuickAskConversation(convId);
            }
          } else {
            let match = e.conversation
              ? state.quickAskEntries.find((q) => q.currentConversation === e.conversation || q.id === e.conversation)
              : undefined;
            if (!match && (/quick\s*ask/i.test(e.subject ?? '') || actStr === 'reply')) {
              match = [...state.quickAskEntries].reverse().find((q) => q.waiting || q.timedOut);
            }
            if (match) {
              cancelQaTimer(match.currentConversation);
              state.resolveQuickAskReply(match.currentConversation, e.body!);
            }
          }
        } else {
          state.addHumanMessage({
            id: e.id, from: e.from, subject: e.subject ?? '',
            body: e.body!, act: e.act,
            arrivedAt: Date.now(), resolved: false, replyDraft: '',
            conversation: e.conversation
          });
        }
      }
      // Activity feed stream: capture entry in store + bump badge.
      if (e.surfaceActivity && e.body && e.id) {
        state.addActivityEntry({
          id: e.id, from: e.from,
          headline: e.activityHeadline ?? e.subject,
          body: e.body!, badge: e.activityBadge ?? 'INFO',
          ts: Date.now()
        });
        state.bumpActivityUnread();
      }
    });
  }, []);

  // Quit warning subscription
  useEffect(() => window.cth.onCloseRequested((info) => setQuitWarn(info)), []);

  // Artifact review queue: load the pending list once, then refresh on every
  // `hive:artifactsChanged` push (a new drop, or an approve/reject). Lives at App
  // root so the title-bar Review badge is live regardless of the open panel.
  useEffect(() => {
    if (!window.cth?.artifactsList) return;
    let cancelled = false;
    const refresh = () => {
      window.cth.artifactsList()
        .then((items) => { if (!cancelled) setPendingArtifacts(items); })
        .catch((err: unknown) => console.error('[review] list failed:', err));
    };
    refresh();
    const unsub = window.cth.onArtifactsChanged?.(refresh);
    return () => { cancelled = true; unsub?.(); };
  }, [setPendingArtifacts]);

  // Open HumanQA / UAT checklist watcher: load open humanQA questions at App root,
  // and refresh on every onHumanQAChanged push or periodic poll.
  // Updates openHumanQAItems, askMePending, and assignedPending in the store so the
  // "for you" and "tasks" badges and UAT alert banner are live across all tabs.
  useEffect(() => {
    if (!window.cth?.openHumanQA) return;
    let cancelled = false;
    const refresh = () => {
      window.cth.openHumanQA()
        .then((items) => {
          if (!cancelled && Array.isArray(items)) {
            useStore.getState().setOpenHumanQA(items);
          }
        })
        .catch((err: unknown) => console.error('[humanQA] root list failed:', err));
    };
    refresh();
    const unsub = window.cth.onHumanQAChanged?.(refresh);
    const interval = setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      unsub?.();
      clearInterval(interval);
    };
  }, []);

  // Shareable hires: a validated manifest arriving via the thehive://
  // deep link (or file import) pre-fills the Add-Agent modal. Never spawns by itself.
  const enqueuePendingHires = useStore(s => s.enqueuePendingHires);
  const closeAddAgentReview = () => {
    clearPendingHires();
    setAddAgentOpen(false);
  };
  useEffect(() => {
    const unsub = window.cth.onHireImport?.((m) => {
      enqueuePendingHires([m]);
      setAddAgentOpen(true);
    });
    // Pull anything that arrived before this subscription existed (cold-start
    // deep links; packaged renderers load too fast for push-on-load).
    void window.cth.drainPendingHires?.().then((queued) => {
      if (queued && queued.length > 0) {
        enqueuePendingHires(queued);
        setAddAgentOpen(true);
      }
    });
    return unsub;
  }, [enqueuePendingHires, setAddAgentOpen]);
  useEffect(() => window.cth.onHireError?.((info) => {
    console.error('[hire] import failed:', info.error);
  }), []);

  // Closing-time progress: drives the quit dialog's "wrapping up" view. The
  // dialog stays up through the whole protocol; on 'complete' the main process
  // tears down and quits by itself moments later.
  useEffect(() => window.cth.onClosingTime?.((ev) => {
    if (ev.phase === 'cancelled') { setClosing(null); return; }
    setClosing({ phase: ev.phase, acked: ev.acked, total: ev.total });
    if (ev.phase === 'started' || ev.phase === 'progress') setQuitWarn((w) => w ?? { ptyCount: 0 });
  }), []);

  const startClosingTime = async () => {
    const res = await window.cth.startClosingTime();
    if (!res.ok) setClosing({ phase: 'error', acked: 0, total: 0, error: res.error });
  };
  const cancelClosingTime = () => {
    void window.cth.cancelClosingTime();
    setClosing(null);
  };

  // The hive: god-agent bootstrap, hook-driven avatars, idle-agent waking. Held
  // off until the user opens a hive in the launch picker (passing null no-ops the
  // hook) so Abathur doesn't boot against the current home while the user may be
  // about to switch to a different one.
  useHive(hiveOpened ? config : null);

  // Pre-warm a persistent terminal for every live agent so its output is
  // buffered from spawn. Switching agents then re-attaches an already-rendered
  // terminal instantly (with full history) instead of building a blank one.
  useEffect(() => {
    for (const a of agents) if (a.ptyId) acquireTerminal(a.ptyId);
  }, [agents]);

  // Synthetic demo loop — CAGED (#5B). It must never animate alongside a live
  // hive (it would fire fake envelope handoffs and step seeded agents). Run it
  // only as an explicit showcase (VITE_CTH_DEMO=1 in dev) or on a genuinely
  // empty floor, and stop it the instant the first real PTY agent appears
  // (Abathur always spawns, so in normal operation it effectively never runs).
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const DEMO = import.meta.env.DEV && import.meta.env.VITE_CTH_DEMO === '1';
    const evaluate = () => {
      const hasLive = useStore.getState().agents.some((a) => a.ptyId);
      if (DEMO || !hasLive) startMockLoop();
      else stopMockLoop();
    };
    evaluate();
    const unsub = useStore.subscribe(evaluate);
    return () => { unsub(); stopMockLoop(); };
  }, [config?.onboardingComplete]);

  // Reconcile restored agents against the PTYs still alive in the main process.
  // After a renderer reload (e.g. the laptop slept and Vite reloaded the page),
  // this keeps agents whose process survived and drops any that truly died.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    let cancelled = false;
    window.cth.listPtys().then((list) => {
      if (cancelled) return;
      useStore.getState().reconcileWithLivePtys(list.map((p) => p.id));
    }).catch(() => { /* ignore — keep restored agents as-is */ });
    return () => { cancelled = true; };
  }, [config?.onboardingComplete]);

  // Re-apply the persisted focus-mode preference as the roster fills in.
  //
  // Not a one-shot at store construction: at launch every restored agent still
  // carries the PREVIOUS session's PTY id, so the reconcile above prunes the lot
  // and correctly drops focus mode to null before god has respawned. The
  // preference therefore has to be re-checked once agents with live terminals
  // actually exist. `restoreFocusMode` is a no-op unless the preference is on and
  // focus mode is currently off, so re-running it on every roster change is safe
  // and pressing Esc stays sticky.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    useStore.getState().restoreFocusMode();
  }, [config?.onboardingComplete, agents]);

  // Track viewport width for splitter clamping
  useEffect(() => {
    const onResize = () => setVpWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!config) {
    return <div style={{ width: '100vw', height: '100vh', background: 'var(--cth-cream-100)' }} />;
  }

  if (!config.harnessHome) {
    // First run: collect harness home, repos, and base config before continuing.
    return <OnboardingWizard onComplete={(next) => { setConfig(next); setHiveOpened(true); }} />;
  }

  // Launch-time hive picker: on reopen, let the user open their current hive,
  // switch to a recent one, or open/create another. Skipped right after onboarding,
  // right after a switch-relaunch (see hiveOpened init), or when skipHarnessPickerOnLaunch is set.
  if (!hiveOpened && !config.skipHarnessPickerOnLaunch) {
    return <HivePicker config={config} onOpenCurrent={() => setHiveOpened(true)} />;
  }

  // skipHarnessPickerOnLaunch skips the picker but hiveOpened still needs to be true
  // so useHive() receives the config and the bootstrap runs.
  if (!hiveOpened) {
    setHiveOpened(true);
    return null;
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      width: '100vw', height: '100vh',
      overflow: 'hidden'
    }}>
      {/* rt-12: global fixed-overlay toast for voice-Abathur completions ("Oscar
          finished X"). Self-positions bottom-right; renders null until one arrives. */}
      <CompletionToast />
      {/* v0.3.4: background-update toast ("restart to update"); renders null until
          main's updater pushes a status. */}
      <UpdateToast />
      {/* Title bar — a thin logo drag-strip. The version / update control, theme,
          settings and focus-mode toggles moved to the always-on StatusBar
          (<AppChromeControls/>), which killed the dead gap this row used to
          carry. paddingLeft keeps the macOS traffic-light inset clear. */}
      <div
        className="cth-titlebar-drag"
        style={{
          height: 24, minHeight: 24,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '1px solid var(--cth-ink-300)',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 96,
          paddingRight: 12,
          userSelect: 'none'
        }}
      >
        <img
          src={brandLogo}
          alt="The Hive"
          style={{ height: 15, width: 'auto', display: 'block' }}
        />
      </div>

      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        padding: isMobile ? 12 : 16,
        gap: isMobile ? 12 : 0
      }}>
        <div style={{
          flex: 1,
          minHeight: isMobile ? 260 : 0,
          minWidth: 0,
          position: 'relative'
        }}>
          <OfficeFloor />
          <MemoryPanel />
          {agentCount === 0 && godStatus === 'booting' && <AbathurBooting />}
          {agentCount === 0 && godStatus !== 'booting' && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none'
            }}>
              <div style={{ pointerEvents: 'auto', width: 360 }}>
                {godStatus === 'failed' ? (
                  // Abathur's spawn hung or errored (watchdog in useHive). Give a
                  // real way out instead of a dead spinner: a reload re-runs the
                  // bootstrap, which re-attaches an already-live god PTY or respawns.
                  <PixelPanel variant="dialog" title="QUEEN DIDN'T CLOCK IN" noPadding>
                    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <p style={{ margin: 0, fontSize: 13, lineHeight: '20px' }}>
                        The Queen failed to start (the spawn timed out or errored). Retry to re-run the boot sequence.
                      </p>
                      <PixelButton variant="primary" size="md" onClick={() => window.location.reload()}>
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <Icon name="mcp" /> retry BeeYoncé
                        </span>
                      </PixelButton>
                      <PixelButton variant="secondary" size="md" onClick={() => setAddAgentOpen(true)}>
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <Icon name="plus" /> add agent instead
                        </span>
                      </PixelButton>
                    </div>
                  </PixelPanel>
                ) : (
                  <PixelPanel variant="dialog" title="EMPTY FLOOR" noPadding>
                    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <p style={{ margin: 0, fontSize: 13, lineHeight: '20px' }}>
                        No agents on the floor yet. Launch BeeYoncé or spawn any agent.
                      </p>
                      <PixelButton variant="primary" size="md" onClick={() => window.location.reload()}>
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <Icon name="mcp" /> launch BeeYoncé
                        </span>
                      </PixelButton>
                      <PixelButton variant="secondary" size="md" onClick={() => setAddAgentOpen(true)}>
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <Icon name="plus" /> add agent instead
                        </span>
                      </PixelButton>
                    </div>
                  </PixelPanel>
                )}
              </div>
            </div>
          )}
        </div>

        {!isMobile && (
          <SidebarSplitter
            width={sidebarWidth}
            onChange={setSidebarWidth}
            viewportWidth={vpWidth}
          />
        )}

        <div style={{
          width: isMobile ? '100%' : sidebarWidth,
          flexShrink: 0,
          minHeight: isMobile ? 'auto' : 0,
          display: 'flex',
          flexDirection: 'column'
        }}>
          {agent ? (
            <AgentDetailPanel agent={agent} isMobile={isMobile} />
          ) : godStatus === 'booting' ? (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>WAKING THE HIVE</div>
              <p style={{ margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                The Queen is clocking in.<br />
                The terminal will land here once she's seated.
              </p>
            </PixelPanel>
          ) : (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>NO AGENT SELECTED</div>
              <p style={{ margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                Spawn an agent from the strip below.<br />
                The terminal and command bar will land here.
              </p>
              <PixelButton variant="secondary" size="md" onClick={() => setAddAgentOpen(true)}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="plus" /> add agent
                </span>
              </PixelButton>
            </PixelPanel>
          )}
        </div>
      </div>

      <AgentStrip config={config} isMobile={isMobile} />

      {/* Only mount StatusBar in normal view — FullscreenTerminal mounts its own copy
          so we don't run two instances of useFleetTelemetry / useRateLimits
          / the gitBranch IPC in parallel when focus mode is open. */}
      {!fullscreenAgentId && <StatusBar />}

      {addAgentOpen && (
        <AddAgentModal
          onClose={closeAddAgentReview}
          config={config}
          onConfigChange={setConfig}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          config={config}
          onClose={() => { setSettingsOpen(false); setSettingsSection(undefined); }}
          onOpenProfileWalkthrough={openProfileWalkthroughFromSettings}
          initialSection={settingsSection}
        />
      )}

      {quitWarn && (
        <QuitWarningModal
          ptyCount={quitWarn.ptyCount}
          closing={closing}
          onCancel={() => {
            if (closing) cancelClosingTime();
            window.cth.cancelClose();
            setQuitWarn(null);
          }}
          onConfirm={async () => { await window.cth.confirmClose(); }}
          onClosingTime={startClosingTime}
        />
      )}

      {fullscreenAgentId && <FullscreenTerminal config={config} />}
      {ideOpen && <IdePanel />}
      <TaskDetailOverlay />
      {profileWalkthroughOpen && (
        <ProfileWalkthrough
          config={config}
          mandatory={profileWalkthroughMandatory}
          onComplete={handleProfileWalkthroughComplete}
          onCancel={handleProfileWalkthroughCancel}
        />
      )}
    </div>
  );
}

