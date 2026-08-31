import { useState } from 'react';
import type { HarnessConfig } from '@/store/config';
import { useStore } from '@/store/store';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import type { ThemeId } from '@/scene/office/themeRegistry';

// TV-show office themes (Phase 1 = the switch flow infra). Only `office` has a
// real map+cast today; the five shows render via the loader's office fallback
// until their content lands (Phase 2). `built: false` shows a "soon" tag and a
// fallback note on switch, but the destructive switch flow still runs so the
// whole pipeline (modal → delete cast → persist → re-seat) is exercisable now.
interface ThemeMeta { id: ThemeId; label: string; blurb: string; built: boolean; swatch: string; }
const THEME_META: ThemeMeta[] = [
  { id: 'office',        label: 'The Office',         blurb: 'Dunder Mifflin — the original floor', built: true,  swatch: '#6b5a4a' },
  { id: 'friends',       label: 'Friends',            blurb: 'Central Perk coffee house',           built: false, swatch: '#9a5a32' },
  { id: 'brooklyn99',    label: 'Brooklyn Nine-Nine', blurb: 'The 99th precinct bullpen',           built: true,  swatch: '#3a5a7a' },
  { id: 'siliconvalley', label: 'Silicon Valley',     blurb: 'The Hacker Hostel',                   built: false, swatch: '#4a6a4a' },
  { id: 'got',           label: 'Game of Thrones',    blurb: 'The Red Keep throne room',            built: false, swatch: '#6a2630' },
  { id: 'hogwarts',      label: 'Harry Potter',       blurb: 'Hogwarts great hall',                 built: false, swatch: '#39305a' },
  { id: 'zerg',          label: 'The Swarm',          blurb: 'Zerg brood (legacy reskin)',          built: true,  swatch: '#6a2f7a' },
  { id: 'hive',          label: 'The Hive',           blurb: "BeeYoncé's bee colony",               built: true,  swatch: '#d4a02a' },
];

/** Settings "Office Theme" section: an experimental flag toggle + a 6-card
 *  theme picker with the destructive switch flow (report §E). Self-contained so
 *  it stays out of SettingsModal's bulk. */
export function OfficeThemePicker({ config }: { config: HarnessConfig }) {
  const [enabled, setEnabled] = useState(!!config.tvShowOffices);
  const [current, setCurrent] = useState<ThemeId>((config.officeTheme as ThemeId) ?? 'office');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const setOfficeTheme = useStore((s) => s.setOfficeTheme);

  const toggleFlag = async () => {
    const next = !enabled;
    setEnabled(next);
    setNote('');
    try {
      await window.cth.updateConfig({ tvShowOffices: next });
      // Flag off → the office renders regardless of the saved theme; flag on →
      // restore the persisted theme.
      setOfficeTheme(next ? current : 'office');
    } catch {
      setEnabled(!next); // revert optimistic toggle on failure
    }
  };

  const onSelect = (id: ThemeId) => {
    setNote('');
    if (busy || id === current) return;
    void applyTheme(id);
  };

  const applyTheme = async (id: ThemeId) => {
    setBusy(true);
    try {
      // Only change the visual theme — agents keep running.
      await window.cth.updateConfig({ officeTheme: id });
      setCurrent(id);
      setOfficeTheme(id);
      const meta = THEME_META.find((t) => t.id === id);
      if (meta && !meta.built) setNote(`${meta.label} isn't built yet — showing the office for now.`);
    } catch (e) {
      setNote(`Switch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{
        fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
      }}>
        Office Theme
      </div>

      {/* Experimental feature flag */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
            TV-show office themes <span style={{ color: 'var(--cth-ink-500)' }}>(experimental)</span>
          </span>
          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
            Re-skin the pixel office as a TV show. Your agents keep running.
          </span>
        </div>
        <PixelButton variant={enabled ? 'primary' : 'secondary'} size="sm" onClick={toggleFlag}>
          {enabled ? 'on' : 'off'}
        </PixelButton>
      </div>

      {/* Theme picker grid (only when the flag is on) */}
      {enabled && (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {THEME_META.map((t) => {
            const isCurrent = t.id === current;
            return (
              <button
                key={t.id}
                onClick={() => onSelect(t.id)}
                disabled={busy}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                  padding: 8, cursor: busy ? 'default' : 'pointer',
                  background: isCurrent ? 'var(--cth-paper-100)' : 'transparent',
                  boxShadow: isCurrent
                    ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                    : 'inset 0 0 0 1px var(--cth-ink-300)',
                  opacity: busy && !isCurrent ? 0.6 : 1,
                }}
              >
                <span style={{
                  width: 28, height: 28, flexShrink: 0, background: t.swatch,
                  boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.label}
                    </span>
                    {isCurrent && (
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 7, color: 'var(--cth-mint)', textTransform: 'uppercase' }}>
                        current
                      </span>
                    )}
                    {!t.built && !isCurrent && (
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 7, color: 'var(--cth-ink-500)', textTransform: 'uppercase' }}>
                        soon
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 13, lineHeight: '14px', color: 'var(--cth-ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.blurb}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {enabled && note && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--cth-ink-500)' }}>{note}</div>
      )}

    </div>
  );
}
