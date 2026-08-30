import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { AgentProvider, HarnessConfig, RuntimeProfile } from '@/store/config';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { ProviderLogo } from './ProviderLogo';

export interface ProfileWalkthroughProps {
  config: HarnessConfig;
  mandatory: boolean;
  onComplete: (config: HarnessConfig) => void;
  onCancel: () => void;
}

interface ProfileDraft {
  id: string;
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

const CLAUDE_WORK_DEFAULT = 'Claude · work account';
const CLAUDE_PERSONAL_DEFAULT = 'Claude · personal account';
const CODEX_DEFAULT = 'Codex · default agent';

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
  width: 'min(760px, calc(100vw - 48px))',
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
  outline: 'none'
};

const blurbStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--cth-ink-700)'
};

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontFamily: 'var(--cth-font-display)',
  fontSize: 12,
  color: 'var(--cth-ink-900)'
};

const sectionShellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 14,
  background: 'var(--cth-paper-100)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
};

export function ProfileWalkthrough({ config, mandatory, onComplete, onCancel }: ProfileWalkthroughProps) {
  const profiles = useMemo(() => config.runtimeProfiles ?? [], [config.runtimeProfiles]);
  const assignments = useMemo(() => pickClaudeAssignments(profiles), [profiles]);
  const codexExisting = useMemo(
    () => profiles.find((p) => p.provider === 'codex'),
    [profiles]
  );

  const seededWork = useMemo(
    () => draftFromProfile(assignments.work, 'claude', CLAUDE_WORK_DEFAULT),
    [assignments.work]
  );
  const seededPersonal = useMemo(
    () => draftFromProfile(assignments.personal, 'claude', CLAUDE_PERSONAL_DEFAULT),
    [assignments.personal]
  );
  const seededCodex = useMemo(
    () => draftFromProfile(codexExisting, 'codex', CODEX_DEFAULT),
    [codexExisting]
  );

  const initialDefaultId = useMemo(() => {
    const ids = [seededWork.id, seededPersonal.id, seededCodex.id];
    const fromConfig = config.defaultSpawnProfileId;
    if (fromConfig && ids.includes(fromConfig)) return fromConfig;
    return ids[0] ?? '';
  }, [config.defaultSpawnProfileId, seededCodex.id, seededPersonal.id, seededWork.id]);

  const [work, setWork] = useState<ProfileDraft>(seededWork);
  const [personal, setPersonal] = useState<ProfileDraft>(seededPersonal);
  const [codex, setCodex] = useState<ProfileDraft>(seededCodex);
  const [defaultChoice, setDefaultChoice] = useState<string>(initialDefaultId);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setWork(seededWork);
    setPersonal(seededPersonal);
    setCodex(seededCodex);
    setDefaultChoice((prev) => {
      const ids = [seededWork.id, seededPersonal.id, seededCodex.id];
      if (ids.includes(prev)) return prev;
      return initialDefaultId;
    });
    setError(undefined);
  }, [initialDefaultId, seededCodex, seededPersonal, seededWork]);

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

  const chooseDir = useCallback(async (slot: 'work' | 'personal') => {
    setError(undefined);
    try {
      const res = await window.cth.chooseFolder();
      if (!res.ok) {
        if (res.error && res.error !== 'cancelled') setError(res.error);
        return;
      }
      if (slot === 'work') setWork((prev) => ({ ...prev, claudeConfigDir: res.path }));
      else setPersonal((prev) => ({ ...prev, claudeConfigDir: res.path }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const workReady = work.name.trim().length > 0 && (work.claudeConfigDir?.trim().length ?? 0) > 0;
  const personalReady = personal.name.trim().length > 0 && (personal.claudeConfigDir?.trim().length ?? 0) > 0;
  const codexReady = codex.name.trim().length > 0;
  const canSubmit = workReady && personalReady && codexReady && defaultChoice.length > 0 && !busy;

  const save = useCallback(async () => {
    if (busy) return;
    if (!canSubmit) {
      setError('Fill in each profile before continuing.');
      return;
    }
    setBusy(true);
    setError(undefined);
    const nextWork = draftToRuntimeProfile(work);
    const nextPersonal = draftToRuntimeProfile(personal);
    const nextCodex = draftToRuntimeProfile(codex);
    const selectedId = [nextWork.id, nextPersonal.id, nextCodex.id].includes(defaultChoice)
      ? defaultChoice
      : nextWork.id;
    const replaceIds = new Set([nextWork.id, nextPersonal.id, nextCodex.id]);
    const preserved = profiles.filter((p) => !replaceIds.has(p.id));
    const runtimeProfiles = [...preserved, nextWork, nextPersonal, nextCodex];
    try {
      const updated = await window.cth.updateConfig({
        runtimeProfiles,
        defaultSpawnProfileId: selectedId,
        onboardingComplete: true
      });
      onComplete(updated);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Could not save your runtime profiles.');
    }
  }, [busy, canSubmit, codex, defaultChoice, onComplete, personal, profiles, work]);

  return (
    <div style={overlayStyle}>
      <PixelPanel variant="dialog" style={panelStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 14, color: 'var(--cth-ink-900)' }}>
              Finish setting up your accounts
            </div>
            <div style={blurbStyle}>
              The hive needs a separate Claude login for work and personal use, plus a Codex profile. These live outside the synced hive repo.
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
              Complete this walkthrough to finish first-run onboarding.
            </div>
          )}

          <div style={sectionShellStyle}>
            <div style={sectionHeaderStyle}>
              <ProviderLogo provider="claude" size={14} /> Work Claude profile
            </div>
            <div style={blurbStyle}>Point to the CLAUDE_CONFIG_DIR for your work account. The folder should live outside your hive repo.</div>
            <input
              value={work.name}
              onChange={(e) => { setWork((prev) => ({ ...prev, name: e.target.value })); setError(undefined); }}
              placeholder="Profile name"
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={work.claudeConfigDir ?? ''}
                onChange={(e) => { setWork((prev) => ({ ...prev, claudeConfigDir: e.target.value })); setError(undefined); }}
                placeholder="Claude config directory"
                style={{ ...inputStyle, flex: 1 }}
              />
              <PixelButton variant="secondary" size="sm" onClick={() => { void chooseDir('work'); }}>
                Pick folder
              </PixelButton>
            </div>
          </div>

          <div style={sectionShellStyle}>
            <div style={sectionHeaderStyle}>
              <ProviderLogo provider="claude" size={14} /> Personal Claude profile
            </div>
            <div style={blurbStyle}>Create a separate CLAUDE_CONFIG_DIR for personal work so agents can swap accounts safely.</div>
            <input
              value={personal.name}
              onChange={(e) => { setPersonal((prev) => ({ ...prev, name: e.target.value })); setError(undefined); }}
              placeholder="Profile name"
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={personal.claudeConfigDir ?? ''}
                onChange={(e) => { setPersonal((prev) => ({ ...prev, claudeConfigDir: e.target.value })); setError(undefined); }}
                placeholder="Claude config directory"
                style={{ ...inputStyle, flex: 1 }}
              />
              <PixelButton variant="secondary" size="sm" onClick={() => { void chooseDir('personal'); }}>
                Pick folder
              </PixelButton>
            </div>
          </div>

          <div style={sectionShellStyle}>
            <div style={sectionHeaderStyle}>
              <ProviderLogo provider="codex" size={14} /> Codex profile
            </div>
            <div style={blurbStyle}>Codex uses your OpenAI CLI login. Name the profile so it’s easy to recognize when spawning agents.</div>
            <input
              value={codex.name}
              onChange={(e) => { setCodex((prev) => ({ ...prev, name: e.target.value })); setError(undefined); }}
              placeholder="Profile name"
              style={inputStyle}
            />
          </div>

          <div style={sectionShellStyle}>
            <div style={sectionHeaderStyle}>Default profile for new agents</div>
            <div style={blurbStyle}>Pick which runtime profile new agents should use. You can override it per agent later.</div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
              <input
                type="radio"
                name="default-profile"
                value={work.id}
                checked={defaultChoice === work.id}
                onChange={() => { setDefaultChoice(work.id); setError(undefined); }}
              />
              {work.name}
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
              <input
                type="radio"
                name="default-profile"
                value={personal.id}
                checked={defaultChoice === personal.id}
                onChange={() => { setDefaultChoice(personal.id); setError(undefined); }}
              />
              {personal.name}
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
              <input
                type="radio"
                name="default-profile"
                value={codex.id}
                checked={defaultChoice === codex.id}
                onChange={() => { setDefaultChoice(codex.id); setError(undefined); }}
              />
              {codex.name}
            </label>
          </div>

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

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
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

function pickClaudeAssignments(list: RuntimeProfile[]): { work?: RuntimeProfile; personal?: RuntimeProfile } {
  const claudeProfiles = list.filter((p) => p.provider === 'claude');
  if (claudeProfiles.length === 0) return {};
  const pool = [...claudeProfiles];
  const take = (predicate: (p: RuntimeProfile) => boolean) => {
    const index = pool.findIndex(predicate);
    if (index === -1) return undefined;
    return pool.splice(index, 1)[0];
  };
  const work = take((p) => includesKeyword(p.name, 'work')) ?? pool.shift();
  const personal = take((p) => includesKeyword(p.name, 'personal')) ?? pool.shift();
  return { work: work ?? undefined, personal: personal ?? undefined };
}

function draftFromProfile(existing: RuntimeProfile | undefined, provider: AgentProvider, fallbackName: string): ProfileDraft {
  return {
    id: existing?.id ?? crypto.randomUUID(),
    provider: existing?.provider ?? provider,
    name: existing?.name ?? fallbackName,
    claudeConfigDir: provider === 'claude' ? existing?.claudeConfigDir : undefined,
    model: existing?.model,
    command: existing?.command,
    extraArgs: existing?.extraArgs ? [...existing.extraArgs] : undefined,
    baseUrl: existing?.baseUrl,
    apiKeyRef: existing?.apiKeyRef,
    allowPrivate: existing?.allowPrivate,
    createdAt: existing?.createdAt
  };
}

function draftToRuntimeProfile(draft: ProfileDraft): RuntimeProfile {
  const out: RuntimeProfile = {
    id: draft.id,
    name: draft.name.trim(),
    provider: draft.provider,
    createdAt: draft.createdAt ?? Date.now()
  };
  if (draft.model?.trim()) out.model = draft.model.trim();
  if (draft.command?.trim()) out.command = draft.command.trim();
  if (draft.extraArgs && draft.extraArgs.length > 0) out.extraArgs = [...draft.extraArgs];
  if (draft.provider === 'claude') {
    const dir = draft.claudeConfigDir?.trim();
    if (dir) out.claudeConfigDir = dir;
  }
  if (draft.baseUrl?.trim()) out.baseUrl = draft.baseUrl.trim();
  if (draft.apiKeyRef?.trim()) out.apiKeyRef = draft.apiKeyRef.trim();
  if (draft.allowPrivate) out.allowPrivate = true;
  return out;
}

function includesKeyword(name: string | undefined, keyword: string): boolean {
  if (!name) return false;
  return name.toLowerCase().includes(keyword);
}
