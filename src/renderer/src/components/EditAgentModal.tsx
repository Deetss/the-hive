import { useEffect, useState, type CSSProperties } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { ProviderLogo } from './ProviderLogo';
import { acquireTerminal, resetTerminal } from './terminalPool';
import { useStore, type Agent } from '@/store/store';
import { OFFICE_CAST, type OfficeCharacterName } from '@/scene/office/cast';
import { type AccentColorName } from '@/design/tokens';
import {
  type AgentProvider,
  type HarnessConfig,
  type RuntimeProfile,
  AGENT_PROVIDER_PRESETS,
  buildSpawnCommand,
  tokenizeCommand,
  modelsForProvider,
  inferAgentProvider,
  providerPreset,
  isClaudeProvider
} from '@/store/config';
import { roleForHiveSpawn } from '@shared/agentRole';

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

export interface EditAgentModalProps {
  agent: Agent;
  onClose: () => void;
}

/**
 * Compact post-hire editor for Identity / Engine / Briefing. Mirrors the Add
 * Agent fields that matter after spawn; save patches the durable roster and
 * transparently restarts the engine when its profile/provider/model changes.
*/
export function EditAgentModal({ agent, onClose }: EditAgentModalProps) {
  const updateAgent = useStore((s) => s.updateAgent);
  const [config, setConfig] = useState<HarnessConfig | null>(null);

  const [name, setName] = useState(agent.name);
  const [character, setCharacter] = useState<OfficeCharacterName>(agent.character);
  const [accent, setAccent] = useState<AccentColorName>(agent.accent);
  const [provider, setProvider] = useState<AgentProvider>(
    inferAgentProvider(agent.command, agent.provider)
  );
  const [model, setModel] = useState<string | undefined>(agent.model);
  const [description, setDescription] = useState(agent.description);
  const [goal, setGoal] = useState(agent.goal ?? '');
  const [profileId, setProfileId] = useState<string | undefined>(agent.profileId ?? undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.cth.getConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  // Keep form in sync when the selected agent changes while the modal is open.
  useEffect(() => {
    setName(agent.name);
    setCharacter(agent.character);
    setAccent(agent.accent);
    setProvider(inferAgentProvider(agent.command, agent.provider));
    setModel(agent.model);
    setDescription(agent.description);
    setGoal(agent.goal ?? '');
    setProfileId(agent.profileId ?? undefined);
  }, [agent.id]);

  const pickProvider = (id: AgentProvider) => {
    setProvider(id);
    const profiles = config?.runtimeProfiles ?? [];
    const currentProfile = profileId ? profiles.find((p) => p.id === profileId) : undefined;
    const isCompatible = currentProfile && currentProfile.provider === id;
    if (!isCompatible) {
      setProfileId(undefined);
    }
    if (!config) {
      setModel(undefined);
      return;
    }
    const nextModel = (isCompatible && currentProfile?.model)
      ? currentProfile.model
      : (isClaudeProvider(id) ? config.defaultModel : config.providerDefaultModels?.[id]);
    setModel(nextModel);
  };

  const selectModel = (id?: string) => {
    setModel(id);
  };

  const applyProfile = (id: string) => {
    if (!id) {
      setProfileId(undefined);
      return;
    }
    const next = (config?.runtimeProfiles ?? []).find((p) => p.id === id);
    if (!next) {
      setProfileId(undefined);
      return;
    }
    setProfileId(next.id);
    setProvider(next.provider);
    const nextModel = next.model ?? (isClaudeProvider(next.provider)
      ? config?.defaultModel
      : config?.providerDefaultModels?.[next.provider]);
    setModel(nextModel);
  };

  const preset = providerPreset(provider);
  const runtimeProfiles = config?.runtimeProfiles ?? [];
  const providerProfiles = runtimeProfiles.filter((p) => p.provider === provider);
  const selectedProfile = profileId ? runtimeProfiles.find((p) => p.id === profileId) : undefined;

  const resolveConfig = async (): Promise<HarnessConfig | null> => {
    if (config) return config;
    try {
      const fresh = await window.cth.getConfig();
      setConfig(fresh);
      return fresh;
    } catch {
      return null;
    }
  };

  const restartAgent = async (
    commandStr: string,
    runtimeProfile: RuntimeProfile | undefined,
    trimmedName: string,
    trimmedDescription: string
  ) => {
    if (!agent.ptyId) return;
    const tokens = tokenizeCommand(commandStr);
    if (!tokens.length) throw new Error('Engine command is empty.');
    const [exe, ...args] = tokens;
    const entry = acquireTerminal(agent.ptyId);
    let cols = entry.term.cols || 100;
    let rows = entry.term.rows || 30;
    try {
      entry.fit.fit();
      cols = entry.term.cols;
      rows = entry.term.rows;
    } catch { /* layout unchanged */ }

    const killed = await window.cth.killPty(agent.ptyId);
    if (!killed.ok && !/^no pty:/i.test(killed.error ?? '')) {
      throw new Error(killed.error ?? 'Could not stop the current process.');
    }

    resetTerminal(agent.ptyId);

    const hiveMeta = {
      id: agent.id,
      name: trimmedName,
      cwd: agent.cwd,
      provider,
      isOvermind: agent.isOvermind,
      isAssistant: agent.isAssistant,
      profileId: runtimeProfile?.id,
      role: roleForHiveSpawn({ ...agent, description: trimmedDescription })
    };

    const res = await window.cth.spawnPty({
      id: agent.ptyId,
      cwd: agent.cwd,
      command: exe,
      args,
      provider,
      cols,
      rows,
      hive: hiveMeta
    });

    if (!res.ok) {
      throw new Error(res.error ?? 'Restart failed.');
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);

    try {
      const trimmedName = name.trim() || agent.name;
      const trimmedDescription = description.trim() || 'a fresh harness';
      const trimmedGoal = goal.trim();
      const cfg = await resolveConfig();
      const profiles = cfg?.runtimeProfiles ?? runtimeProfiles;
      const activeProfile = profileId ? profiles.find((p) => p.id === profileId) : undefined;

      let nextCommand = activeProfile?.command?.trim();
      if (!nextCommand || !nextCommand.length) {
        if (cfg) {
          nextCommand = buildSpawnCommand(cfg, model, provider);
        } else {
          nextCommand = agent.command ?? '';
        }
      }
      nextCommand = nextCommand.trim();
      if (!nextCommand) throw new Error('Could not build a command for this engine.');

      const originalProvider = inferAgentProvider(agent.command, agent.provider);
      const originalProfileId = agent.profileId ?? undefined;
      const providerChanged = provider !== originalProvider;
      const modelChanged = (agent.model ?? undefined) !== (model ?? undefined);
      const profileChanged = originalProfileId !== (profileId ?? undefined);
      const commandChanged = (agent.command?.trim() ?? '') !== nextCommand;
      const engineChanged = providerChanged || modelChanged || profileChanged || commandChanged;

      if (engineChanged && agent.ptyId) {
        await restartAgent(nextCommand, activeProfile, trimmedName, trimmedDescription);
      }

      if (engineChanged && window.cth.hivePatchAgentEngine) {
        const persist = await window.cth.hivePatchAgentEngine(agent.id, {
          provider,
          profileId: profileId ?? null
        });
        if (!persist?.ok) {
          throw new Error(persist?.error ?? 'Failed to persist engine changes to the hive registry.');
        }
      }

      updateAgent(agent.id, {
        name: trimmedName,
        character,
        accent,
        provider,
        model,
        command: nextCommand,
        profileId: profileId ?? undefined,
        description: trimmedDescription,
        goal: trimmedGoal || undefined
      });

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 500
      }}
    >
      {/* Same box as Add Agent (940 / 95vw / 86vh). They are the two halves of
          one job — describe an agent — and a tall narrow dialog next to a wide
          one reads as two unrelated screens. */}
      <div onClick={(e) => e.stopPropagation()} style={{ width: 940, maxWidth: '95vw' }}>
        <PixelPanel variant="dialog" title="EDIT AGENT" style={{ padding: 16 }} noPadding>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 14,
            padding: 16, maxHeight: '86vh', overflowY: 'auto'
          }}>
            {/* Two columns so the extra width is used rather than padded.
                Identity and Engine are short field lists; Briefing is free
                text and takes the taller side. minHeight keeps the dialog from
                collapsing into a wide thin strip on a small form. */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 16, alignItems: 'start', minHeight: 260
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
            <Section label="Identity" hint="name · character · color">
              <Row label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Stanley"
                  style={inputStyle}
                  autoFocus
                />
              </Row>

              <Row label="Character">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {OFFICE_CAST.map((c) => {
                    const active = character === c.name;
                    return (
                      <button
                        key={c.name}
                        type="button"
                        onClick={() => { setCharacter(c.name); setName(c.displayName); }}
                        title={c.blurb}
                        style={{
                          padding: 4,
                          background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                          boxShadow: active
                            ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                            : 'inset 0 0 0 1px var(--cth-ink-100)',
                          cursor: 'pointer', border: 'none', width: 52,
                          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2
                        }}
                      >
                        <div style={{
                          width: 40, height: 48,
                          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                          overflow: 'hidden'
                        }}>
                          <SpritePortrait character={c.name} scale={1.5} />
                        </div>
                        <span style={{ fontSize: 13, color: 'var(--cth-ink-700)' }}>{c.displayName}</span>
                      </button>
                    );
                  })}
                </div>
              </Row>

              <Row label="Color">
                <div style={{ display: 'flex', gap: 6 }}>
                  {ACCENTS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAccent(a)}
                      title={a}
                      style={{
                        width: 28, height: 28,
                        background: `var(--cth-${a})`,
                        boxShadow: accent === a
                          ? 'inset 0 0 0 1.5px var(--cth-ink-500), 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-300)',
                        cursor: 'pointer', border: 'none'
                      }}
                    />
                  ))}
                </div>
              </Row>
            </Section>

            <Section label="Engine" hint="provider · model · runtime profile">
              <Row label="Provider">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {AGENT_PROVIDER_PRESETS.map((p) => {
                    const active = provider === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => pickProvider(p.id)}
                        title={p.label}
                        disabled={saving}
                        style={{
                          padding: '3px 8px 1px',
                          background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                          boxShadow: active
                            ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                            : 'inset 0 0 0 1px var(--cth-ink-100)',
                          fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                          color: 'var(--cth-ink-900)', cursor: saving ? 'not-allowed' : 'pointer', border: 'none',
                          opacity: saving ? 0.7 : 1,
                          display: 'inline-flex', alignItems: 'center', gap: 6
                        }}
                      >
                        <ProviderLogo provider={p.id} size={14} />
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </Row>

              {runtimeProfiles.length > 0 && (
                <Row label="Account / profile">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <select
                      value={profileId ?? ''}
                      onChange={(e) => applyProfile(e.target.value)}
                      disabled={saving}
                      data-testid="profile-select"
                      title="Saved engine + account bundle. Default account clears the assignment."
                      style={{
                        padding: '4px 8px 2px', background: 'var(--cth-cream-100)', border: 'none',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
                        fontSize: 12, color: 'var(--cth-ink-900)', outline: 'none', cursor: saving ? 'not-allowed' : 'pointer',
                        maxWidth: 320, opacity: saving ? 0.7 : 1
                      }}
                    >
                      <option value="">Default account</option>
                      {providerProfiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    {selectedProfile?.model && (
                      <span style={{ fontSize: 13, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)' }}>
                        {selectedProfile.model}
                      </span>
                    )}
                  </div>
                </Row>
              )}

              {preset.supportsModel && (
                <Row label="Model">
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(() => {
                      const known = modelsForProvider(provider);
                      return model && !known.some((m) => m.id === model)
                        ? [...known, { id: model, label: `${model} (current)` }]
                        : known;
                    })().map((m) => {
                      const active = (model ?? '') === (m.id ?? '');
                      return (
                        <button
                          key={m.label}
                          type="button"
                          onClick={() => selectModel(m.id)}
                          disabled={saving}
                          title={m.id ?? 'CLI default model'}
                          style={{
                            padding: '3px 8px 1px',
                            background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                            boxShadow: active
                              ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                              : 'inset 0 0 0 1px var(--cth-ink-100)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                            color: 'var(--cth-ink-900)', cursor: saving ? 'not-allowed' : 'pointer', border: 'none',
                            opacity: saving ? 0.7 : 1
                          }}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                </Row>
              )}

              <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px' }}>
                Engine changes relaunch the agent immediately; no manual restart required.
              </span>
            </Section>

              </div>
              <div style={{ minWidth: 0 }}>
            <Section label="Briefing" hint="description · goal">
              <Row label="Description">
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="what is this agent for"
                  style={inputStyle}
                />
              </Row>

              <Row label="Goal (optional)">
                <div style={{ position: 'relative' }}>
                  <textarea
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder="long-running directive injected on every prompt"
                    rows={4}
                    style={{ ...inputStyle, fontFamily: 'var(--cth-font-ui)', resize: 'vertical', minHeight: 200 }}
                  />
                  <ImproveTextButton
                    text={goal}
                    context="agent goal"
                    onImproved={(improved) => setGoal(improved)}
                  />
                </div>
              </Row>
            </Section>
              </div>
            </div>

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 13,
                color: 'var(--cth-ink-900)'
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 4 }}>
              <PixelButton variant="ghost" size="md" onClick={onClose} disabled={saving}>cancel</PixelButton>
              <PixelButton variant="primary" size="md" onClick={save} disabled={saving}>
                {saving ? 'saving…' : 'save changes'}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 16,
  color: 'var(--cth-ink-900)',
  outline: 'none',
  boxSizing: 'border-box'
};

function ImproveTextButton({
  text,
  context,
  onImproved
}: {
  text: string;
  context: string;
  onImproved: (improved: string) => void;
}) {
  const [improving, setImproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originalText, setOriginalText] = useState<string | null>(null);
  const [undoVisible, setUndoVisible] = useState(false);

  const improve = async () => {
    if (!text.trim()) return;
    setImproving(true);
    setError(null);
    try {
      const result = await window.cth.improveText?.(text, context);
      if (result?.ok && result.result) {
        setOriginalText(text);
        onImproved(result.result);
        setUndoVisible(true);
        setTimeout(() => setUndoVisible(false), 5000);
      } else {
        setError(result?.error ?? 'Failed to improve text');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImproving(false);
    }
  };

  const undo = () => {
    if (originalText !== null) {
      onImproved(originalText);
      setOriginalText(null);
      setUndoVisible(false);
    }
  };

  if (!window.cth.improveText) {
    return (
      <button
        type="button"
        disabled
        title="Restart app to enable"
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          padding: '2px 6px',
          background: 'var(--cth-cream-100)',
          border: 'none',
          cursor: 'not-allowed',
          opacity: 0.5,
          fontSize: 14
        }}
      >
        ✨
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={improve}
        disabled={improving || !text.trim()}
        title="Improve with AI"
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          padding: '2px 6px',
          background: improving ? 'var(--cth-cream-100)' : 'var(--cth-cream-200)',
          border: 'none',
          cursor: improving || !text.trim() ? 'not-allowed' : 'pointer',
          opacity: improving || !text.trim() ? 0.5 : 1,
          fontSize: 14,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}
      >
        {improving ? '⏳' : '✨'}
      </button>
      {undoVisible && originalText && (
        <button
          type="button"
          onClick={undo}
          style={{
            position: 'absolute',
            top: 6,
            right: 40,
            padding: '2px 6px',
            background: 'var(--cth-lemon-light)',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'var(--cth-font-ui)',
            color: 'var(--cth-ink-900)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
          }}
        >
          undo
        </button>
      )}
      {error && (
        <div style={{
          marginTop: 4,
          fontSize: 12,
          color: 'var(--cth-coral)',
          fontFamily: 'var(--cth-font-ui)'
        }}>
          {error}
        </div>
      )}
    </>
  );
}

function Section({
  label,
  hint,
  children
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 13, lineHeight: '12px',
          color: 'var(--cth-ink-900)',
          textTransform: 'uppercase'
        }}>{label}</span>
        <span style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>{hint}</span>
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 13, lineHeight: '12px',
        color: 'var(--cth-ink-700)',
        textTransform: 'uppercase'
      }}>{label}</span>
      {children}
    </label>
  );
}
