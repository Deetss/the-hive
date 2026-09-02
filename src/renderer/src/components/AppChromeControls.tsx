/**
 * App-level chrome — version/update control, auto-mode indicator, theme toggle,
 * settings, and focus-mode toggle.
 *
 * These used to live in the 36px OS titlebar, which left a large dead gap
 * between the left cluster and the right buttons. They now ride the always-on
 * bottom StatusBar (its own copy is mounted in fullscreen too), so the titlebar
 * is just a thin logo drag-strip. Settings opens through the existing
 * `cth:open-settings` window event, so no callback threading is needed.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { UpdateBadge } from './UpdateBadge';
import { useAppTheme, toggleAppTheme } from '@/design/theme';
import { notifyThemeChangeAll } from './terminalPool';
import { useStore } from '@/store/store';

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="15" height="15" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={1.4}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >{children}</svg>
  );
}

/** Four outward corner brackets — enter focus mode. */
function ExpandGlyph() {
  return <Glyph><path d="M6.2 3H3v3.2M9.8 3H13v3.2M6.2 13H3V9.8M9.8 13H13V9.8" /></Glyph>;
}

/** The same brackets turned inward — leave focus mode. */
function CollapseGlyph() {
  return <Glyph><path d="M3 6.2h3.2V3M13 6.2H9.8V3M3 9.8h3.2V13M13 9.8H9.8V13" /></Glyph>;
}

/** A wrench — reads as "settings" without competing with the sun/moon beside it. */
function GearGlyph() {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M15.5 3.5a5 5 0 0 0-6.1 6.1l-5.6 5.6a2.3 2.3 0 1 0 3.2 3.2l5.6-5.6a5 5 0 0 0 6.1-6.1l-3 3-2.2-.6-.6-2.2z" />
    </svg>
  );
}

const btn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 20, padding: 0,
  background: 'var(--cth-paper-100)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  border: 'none', borderRadius: 2, cursor: 'pointer',
  color: 'var(--cth-ink-900)', lineHeight: 1
};

export function AppChromeControls() {
  const appThemeNow = useAppTheme();
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const [autoMode, setAutoMode] = useState<boolean | null>(null);

  useEffect(() => {
    const read = () => { void window.cth?.getConfig?.().then((c) => setAutoMode(!!c.autoMode)).catch(() => {}); };
    read();
    // No config-change push channel; auto-mode changes rarely, so a re-read on
    // window focus keeps it honest after a Settings edit without polling.
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, []);

  const onTheme = () => {
    const next = toggleAppTheme();
    notifyThemeChangeAll(next === 'dark' ? 'dark' : 'light');
    void window.cth.updateConfig({ terminalTheme: next });
  };

  const onFullscreen = () => {
    if (fullscreenAgentId) { useStore.getState().setFullscreen(null); return; }
    const all = useStore.getState().agents;
    const target = all.find((x) => x.id === useStore.getState().selectedId && x.ptyId)
      ?? all.find((x) => x.isOvermind && x.ptyId)
      ?? all.find((x) => x.ptyId);
    if (target) useStore.getState().setFullscreen(target.id);
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <UpdateBadge placement="down" />
      {autoMode !== null && (
        <span
          title={autoMode ? 'Auto-delivery is on for the floor' : 'Auto-delivery is off'}
          style={{ color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}
        >
          {autoMode ? 'auto on' : 'auto off'}
        </span>
      )}
      <button
        className="cth-tip"
        onClick={onTheme}
        data-tip={appThemeNow === 'dark' ? 'Light theme' : 'Dark theme'}
        aria-label="Toggle dark mode"
        style={{ ...btn, fontSize: 12 }}
      >
        {appThemeNow === 'dark' ? '☀' : '☾'}
      </button>
      <button
        className="cth-settings-btn cth-tip"
        onClick={() => window.dispatchEvent(new CustomEvent('cth:open-settings'))}
        data-tip="Settings"
        aria-label="Settings"
        style={btn}
      >
        <GearGlyph />
      </button>
      <button
        className="cth-tip"
        onClick={onFullscreen}
        data-tip={fullscreenAgentId ? 'Exit focus mode (Esc)' : 'Focus mode'}
        aria-label="Toggle focus mode"
        style={btn}
      >
        {fullscreenAgentId ? <CollapseGlyph /> : <ExpandGlyph />}
      </button>
    </span>
  );
}
