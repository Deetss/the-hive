import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { AgentProvider, HarnessConfig, RuntimeProfile } from '@/store/config';
import { AGENT_PROVIDER_PRESETS, isClaudeProvider } from '@/store/config';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { ProviderLogo } from './ProviderLogo';

export interface ProfileWalkthroughProps {
  config: HarnessConfig;
  mandatory: boolean;
  onComplete: (config: HarnessConfig) => void;
  onCancel: () => void;
}

export interface ProfileDraftItem {
  id: string;
  enabled: boolean;
  provider: AgentProvider;
  name: string;
  claudeConfigDir?: string;
  model?: string;
  command?: string;
  extraArgs?: string[];
  baseUrl?: string;
  apiKeyRef?: string;
  allowPrivate?: boolean;
  createdAt?: number;
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(18, 15, 12, 0.72)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9000,
  padding: 24
};

const panelStyle: CSSProperties = {
  width: 'min(780px, calc(100vw - 48px))',
  maxHeight: 'calc(100vh - 72px)',
  overflowY: 'auto',
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 18
};

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  outline: 'none',
  boxSizing: 'border-box'
};

const blurbStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--cth-ink-700)'
};

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  color: 'var(--cth-ink-900)'
};

const sectionShellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 14,
  background: 'var(--cth-paper-100)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  transition: 'opacity 0.15s ease'
};

export function ProfileWalkthrough({ config, mandatory, onComplete, onCancel }: ProfileWalkthroughProps) {
  const existingProfiles = useMemo(() => config.runtimeProfiles ?? [], [config.runtimeProfiles]);

  const initialDrafts = useMemo<ProfileDraftItem[]>(() => {
    if (existingProfiles.length > 0) {
      return existingProfiles.map((p) => ({
        id: p.id,
        enabled: true,
        provider: p.provider,
        name: p.name,
        claudeConfigDir: p.claudeConfigDir,
        model: p.model,
        command: p.command,
        extraArgs: p.extraArgs ? [...p.extraArgs] : undefined,
        baseUrl: p.baseUrl,
        apiKeyRef: p.apiKeyRef,
        allowPrivate: p.allowPrivate,
        createdAt: p.createdAt
      }));
    }
    // Default starting suggestions (optional & customizable)
    return [
      {
        id: 'profile-work-claude',
        enabled: true,
        provider: 'claude',
        name: 'Claude · work account',
        claudeConfigDir: ''
      },
      {
        id: 'profile-personal-claude',
        enabled: false,
        provider: 'claude',
        name: 'Claude · personal account',
        claudeConfigDir: ''
      },
      {
        id: 'profile-codex',
        enabled: false,
        provider: 'codex',
        name: 'Codex · default agent'
      }
    ];
  }, [existingProfiles]);

  const [drafts, setDrafts] = useState<ProfileDraftItem[]>(initialDrafts);
  const [defaultChoice, setDefaultChoice] = useState<string>(() => {
    const fromConfig = config.defaultSpawnProfileId;
    if (fromConfig && initialDrafts.some((d) => d.id === fromConfig)) return fromConfig;
    return initialDrafts.find((d) => d.enabled)?.id ?? initialDrafts[0]?.id ?? '';
  });
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDrafts(initialDrafts);
  }, [initialDrafts]);

  // Keep defaultChoice pointing to a valid enabled profile
  useEffect(() => {
    const enabled = drafts.filter((d) => d.enabled);
    if (enabled.length > 0 && !enabled.some((d) => d.id === defaultChoice)) {
      setDefaultChoice(enabled[0].id);
    }
  }, [drafts, defaultChoice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!mandatory) onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mandatory, onCancel]);

  const toggleEnabled = useCallback((id: string) => {
    setError(undefined);
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, enabled: !d.enabled } : d)));
  }, []);

  const updateDraft = useCallback((id: string, patch: Partial<ProfileDraftItem>) => {
    setError(undefined);
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }, []);

  const removeDraft = useCallback((id: string) => {
    setError(undefined);
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }, []);

  const addDraft = useCallback(() => {
    setError(undefined);
    const newId = `profile-${crypto.randomUUID().slice(0, 8)}`;
    setDrafts((prev) => [
      ...prev,
      {
        id: newId,
        enabled: true,
        provider: 'claude',
        name: `Profile ${prev.length + 1}`
      }
    ]);
  }, []);

  const pickFolder = useCallback(async (id: string) => {
    setError(undefined);
    try {
      const res = await window.cth.chooseFolder();
      if (!res.ok) {
        if (res.error && res.error !== 'cancelled') setError(res.error);
        return;
      }
      if (res.path) {
        updateDraft(id, { claudeConfigDir: res.path });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [updateDraft]);

  const enabledDrafts = useMemo(() => drafts.filter((d) => d.enabled), [drafts]);

  const canSubmit = useMemo(() => {
    if (enabledDrafts.length === 0) return false;
    for (const d of enabledDrafts) {
      if (!d.name.trim()) return false;
    }
    return !busy;
  }, [enabledDrafts, busy]);

  const save = useCallback(async () => {
    if (busy) return;
    if (!canSubmit) {
      setError('Please include and name at least one profile.');
      return;
    }
    setBusy(true);
    setError(undefined);

    const runtimeProfiles: RuntimeProfile[] = enabledDrafts.map((d) => {
      const p: RuntimeProfile = {
        id: d.id,
        name: d.name.trim(),
        provider: d.provider,
        createdAt: d.createdAt ?? Date.now()
      };
      if (d.model?.trim()) p.model = d.model.trim();
      if (d.command?.trim()) p.command = d.command.trim();
      if (d.extraArgs && d.extraArgs.length > 0) p.extraArgs = [...d.extraArgs];
      if (isClaudeProvider(d.provider) && d.claudeConfigDir?.trim()) {
        p.claudeConfigDir = d.claudeConfigDir.trim();
      }
      if (d.baseUrl?.trim()) p.baseUrl = d.baseUrl.trim();
      if (d.apiKeyRef?.trim()) p.apiKeyRef = d.apiKeyRef.trim();
      if (d.allowPrivate) p.allowPrivate = true;
      return p;
    });

    const activeDefaultId = runtimeProfiles.some((p) => p.id === defaultChoice)
      ? defaultChoice
      : runtimeProfiles[0].id;

    try {
      const updated = await window.cth.updateConfig({
        runtimeProfiles,
        defaultSpawnProfileId: activeDefaultId,
        onboardingComplete: true
      });
      onComplete(updated);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Could not save runtime profiles.');
    }
  }, [busy, canSubmit, defaultChoice, enabledDrafts, onComplete]);

  return (
    <div style={overlayStyle}>
      <PixelPanel variant="dialog" style={panelStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 15, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
              Configure Runtime Profiles
            </div>
            <div style={blurbStyle}>
              Profiles pair an engine with an optional login directory or model. Toggle the ones you want, customize details, or add new ones.
            </div>
          </div>

          {mandatory && (
            <div style={{
              fontSize: 12,
              color: 'var(--cth-ink-900)',
              background: 'var(--cth-lemon-light)',
              boxShadow: 'inset 0 0 0 1px var(--cth-lemon)',
              padding: 10
            }}>
              Configure your profiles to complete first-run onboarding. You can edit them in Settings at any time.
            </div>
          )}

          {/* Profile Cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {drafts.map((d, index) => (
              <div
                key={d.id}
                style={{
                  ...sectionShellStyle,
                  opacity: d.enabled ? 1 : 0.65,
                  boxShadow: d.enabled
                    ? 'inset 0 0 0 1px var(--cth-ink-300)'
                    : 'inset 0 0 0 1px var(--cth-ink-100)'
                }}
              >
                {/* Header row: Checkbox toggle, engine picker, delete */}
                <div style={sectionHeaderStyle}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={d.enabled}
                      onChange={() => toggleEnabled(d.id)}
                    />
                    <ProviderLogo provider={d.provider} size={15} />
                    <span>{d.name.trim() || `Profile ${index + 1}`}</span>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 500,
                      padding: '1px 5px',
                      background: d.enabled ? 'var(--cth-mint-light)' : 'var(--cth-cream-200)',
                      color: d.enabled ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                    }}>
                      {d.enabled ? 'Active' : 'Skipped'}
                    </span>
                  </label>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <select
                      value={d.provider}
                      onChange={(e) => updateDraft(d.id, { provider: e.target.value as AgentProvider })}
                      style={{
                        padding: '3px 6px',
                        background: 'var(--cth-cream-100)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
                        border: 'none',
                        fontFamily: 'var(--cth-font-ui)',
                        fontSize: 12,
                        color: 'var(--cth-ink-900)',
                        cursor: 'pointer'
                      }}
                    >
                      {AGENT_PROVIDER_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>

                    <button
                      onClick={() => removeDraft(d.id)}
                      title="Delete this profile card"
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--cth-ink-400)',
                        cursor: 'pointer',
                        fontSize: 14,
                        padding: '0 4px',
                        lineHeight: 1
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>

                {/* Body inputs */}
                {d.enabled && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                    <div>
                      <input
                        value={d.name}
                        onChange={(e) => updateDraft(d.id, { name: e.target.value })}
                        placeholder="Profile label (e.g. Work Claude, Personal, Fast Reviewer)"
                        style={inputStyle}
                      />
                    </div>

                    {isClaudeProvider(d.provider) && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          value={d.claudeConfigDir ?? ''}
                          onChange={(e) => updateDraft(d.id, { claudeConfigDir: e.target.value })}
                          placeholder="CLAUDE_CONFIG_DIR path (leave empty for default ~/.claude)"
                          style={{ ...inputStyle, flex: 1 }}
                        />
                        <PixelButton variant="secondary" size="sm" onClick={() => void pickFolder(d.id)}>
                          Pick folder
                        </PixelButton>
                      </div>
                    )}

                    {d.provider === 'custom' && (
                      <div>
                        <input
                          value={d.command ?? ''}
                          onChange={(e) => updateDraft(d.id, { command: e.target.value })}
                          placeholder="Custom CLI command (e.g. edgentic, ollama run llama3)"
                          style={inputStyle}
                        />
                      </div>
                    )}

                    <div>
                      <input
                        value={d.model ?? ''}
                        onChange={(e) => updateDraft(d.id, { model: e.target.value })}
                        placeholder="Model override (optional — e.g. claude-3-7-sonnet, gpt-4o, gemini-2.0-flash)"
                        style={{ ...inputStyle, fontSize: 12 }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Add Profile Button */}
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <PixelButton variant="secondary" size="sm" onClick={addDraft}>
              + Add profile
            </PixelButton>
          </div>

          {/* Default profile picker (filtered to enabled) */}
          {enabledDrafts.length > 0 && (
            <div style={sectionShellStyle}>
              <div style={{ ...sectionHeaderStyle, fontWeight: 600 }}>Default profile for new agents</div>
              <div style={blurbStyle}>
                Pick which profile agents use by default when none is specified.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                {enabledDrafts.map((d) => (
                  <label key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="default-profile-choice"
                      value={d.id}
                      checked={defaultChoice === d.id}
                      onChange={() => setDefaultChoice(d.id)}
                    />
                    <ProviderLogo provider={d.provider} size={14} />
                    <span>{d.name.trim() || d.id}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div style={{
              fontSize: 12,
              color: 'var(--cth-coral-dark)',
              background: 'var(--cth-coral-light)',
              boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
              padding: 10
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
            {!mandatory && (
              <PixelButton variant="secondary" size="md" onClick={() => { setError(undefined); onCancel(); }}>
                Cancel
              </PixelButton>
            )}
            <PixelButton
              variant="primary"
              size="md"
              disabled={!canSubmit}
              onClick={() => { void save(); }}
            >
              {busy ? 'Saving…' : 'Save and continue'}
            </PixelButton>
          </div>
        </div>
      </PixelPanel>
    </div>
  );
}

