import { useState, useEffect, type CSSProperties } from 'react';
import type { HarnessConfig, AgentProvider, RuntimeProfile } from '@/store/config';
import { AGENT_PROVIDER_PRESETS, isClaudeProvider } from '@/store/config';
import { normalizeRuntimeProfile } from '@shared/runtimeProfile';
import { PixelButton } from './PixelButton';
import { ProviderLogo } from './ProviderLogo';
import { OSS_BLOG_LINKS } from '@shared/ossModels';
import { useStore } from '@/store/store';
import { CopyButton } from './CopyButton';

/** Portable subset of a RuntimeProfile — what the row's copy button puts on the
 *  clipboard and what "Import from clipboard" expects back. Excludes `id`,
 *  `createdAt` and `apiKeyRef` (a per-profile safeStorage pointer, meaningless
 *  once copied elsewhere) so a copy/paste always lands as a genuinely new profile. */
function toPortableProfile(p: RuntimeProfile) {
  return {
    name: p.name,
    provider: p.provider,
    model: p.model,
    command: p.command,
    extraArgs: p.extraArgs,
    claudeConfigDir: p.claudeConfigDir,
    baseUrl: p.baseUrl,
    allowPrivate: p.allowPrivate
  };
}

/** Parse clipboard text into one or more new profiles. Accepts a single
 *  portable-profile object or an array of them; silently skips entries that
 *  don't normalize (unknown shape, missing name/provider). */
function parseProfilesFromClipboard(text: string): RuntimeProfile[] {
  const parsed: unknown = JSON.parse(text);
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const out: RuntimeProfile[] = [];
  for (const c of candidates) {
    const normalized = normalizeRuntimeProfile({ ...(c as Record<string, unknown>), id: crypto.randomUUID() });
    if (!normalized) continue;
    out.push({ ...normalized, createdAt: Date.now(), apiKeyRef: undefined });
  }
  return out;
}

/**
 * AiEnginesSettings — the v0.3.1 per-provider config surface for the BYOK CLI
 * engines (OpenCode · Crush · pi.dev · Qwen). Two stores by what the datum is:
 *  - API keys → WRITE-ONLY in the secret broker (`providerKey:*` IPC). Keyed by the
 *    BACKEND model-provider (anthropic/openai/…). The field shows only set/not-set;
 *    the plaintext is never read back to the renderer (materialized MAIN-only at spawn).
 *  - Local base-URL + default model → HarnessConfig (`providerBaseUrls` /
 *    `providerDefaultModels`), keyed by CLI provider. Non-secret; normal config save.
 * See hive/shared/cli-agents/settings-ui-schema.md.
 */

/** Backend model-providers whose keys the CLIs read from standard env vars. Must
 *  match BACKEND_KEY_ENV in src/main/index.ts. */
const BACKENDS: Array<{ id: string; label: string; envVar: string }> = [
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  { id: 'google', label: 'Google · Gemini', envVar: 'GEMINI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY' },
  { id: 'groq', label: 'Groq', envVar: 'GROQ_API_KEY' }
];

/** CLI engines that take a per-provider local base-URL + default model. */
const CLIS: Array<{ id: AgentProvider; label: string; hint: string }> = [
  { id: 'opencode', label: 'OpenCode', hint: 'http://localhost:11434/v1 (Ollama) — injected as a local provider' },
  { id: 'crush', label: 'Crush', hint: 'OpenAI-compatible endpoint — used as the proxy upstream' },
  { id: 'pi', label: 'Pi', hint: 'local models are file-based (models.json); base-URL reserved' },
  { id: 'qwen', label: 'Qwen', hint: 'OpenAI-compatible endpoint — used as the proxy upstream' }
];

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
const labelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase'
};
const headStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
};
const linkStyle: CSSProperties = { color: 'var(--cth-ink-900)', textDecoration: 'underline', cursor: 'pointer' };

export function AiEnginesSettings({
  config,
  onOpenProfileWalkthrough,
  onProfilesChanged
}: {
  config: HarnessConfig;
  onOpenProfileWalkthrough?: () => void;
  onProfilesChanged?: (profiles: RuntimeProfile[]) => void;
}) {
  // Keep the global "OpenAI key present" signal (boolean only) live so the Talk
  // button's missing-key warning clears the instant the user saves their OpenAI key
  // here — without it the gate only refreshes on next app start. apikey:openai is
  // the same key the Realtime mint reads; saving/clearing it flips the gate.
  const setHasOpenAiKey = useStore((s) => s.setHasOpenAiKey);
  // Which backends already have a key stored (boolean only — never the value).
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  const [draftKey, setDraftKey] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  // Base-URL + default-model drafts, seeded from config.
  const [baseUrls, setBaseUrls] = useState<Partial<Record<AgentProvider, string>>>(
    config.providerBaseUrls ?? {}
  );
  const [models, setModels] = useState<Partial<Record<AgentProvider, string>>>(
    config.providerDefaultModels ?? {}
  );
  // Runtime profiles (v1) — reusable engine+account+model bundles. Non-secret
  // metadata; persisted to config.json via the same updateConfig path as above.
  const [profiles, setProfiles] = useState<RuntimeProfile[]>(config.runtimeProfiles ?? []);
  const [draftName, setDraftName] = useState('');
  const [draftProvider, setDraftProvider] = useState<AgentProvider>('claude');
  const [draftModel, setDraftModel] = useState('');
  const [draftConfigDir, setDraftConfigDir] = useState('');
  const [draftBaseUrl, setDraftBaseUrl] = useState('');
  const [baseUrlError, setBaseUrlError] = useState('');
  const [importNote, setImportNote] = useState('');
  // Cloud-endpoint API keys are per-profile, write-only (safeStorage via
  // profile:setApiKey) — same discipline as the BACKENDS keys above.
  const [cloudHasKey, setCloudHasKey] = useState<Record<string, boolean>>({});
  const [cloudDraftKey, setCloudDraftKey] = useState<Record<string, string>>({});
  const [cloudNote, setCloudNote] = useState<Record<string, string>>({});

  // Reseed set/not-set flags on mount (write-only — only the boolean is fetched).
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, boolean> = {};
      for (const b of BACKENDS) {
        try { out[b.id] = await window.cth.providerKeyHas(b.id); } catch { out[b.id] = false; }
      }
      if (alive) setHasKey(out);
    })();
    return () => { alive = false; };
  }, []);

  // Reseed per-profile cloud-endpoint key flags whenever the profile list changes.
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, boolean> = {};
      for (const p of profiles) {
        try { out[p.id] = (await window.cth.profileHasApiKey(p.id)).hasKey; } catch { out[p.id] = false; }
      }
      if (alive) setCloudHasKey(out);
    })();
    return () => { alive = false; };
  }, [profiles]);

  const saveKey = async (backend: string) => {
    const key = (draftKey[backend] ?? '').trim();
    if (!key) return;
    try {
      const r = await window.cth.providerKeySet({ backend, key });
      if (r.ok) {
        setHasKey((s) => ({ ...s, [backend]: true }));
        setDraftKey((s) => ({ ...s, [backend]: '' }));
        setNote((s) => ({ ...s, [backend]: 'saved' }));
        // OpenAI key gates Talk — mirror presence to the store so the warning clears now.
        if (backend === 'openai') setHasOpenAiKey(true);
      } else setNote((s) => ({ ...s, [backend]: r.error ?? 'failed' }));
    } catch (e) { setNote((s) => ({ ...s, [backend]: e instanceof Error ? e.message : String(e) })); }
  };
  const clearKey = async (backend: string) => {
    try {
      await window.cth.providerKeyClear(backend);
      setHasKey((s) => ({ ...s, [backend]: false }));
      setNote((s) => ({ ...s, [backend]: 'cleared' }));
      // OpenAI key gates Talk — clearing it disables Talk; reflect that immediately.
      if (backend === 'openai') setHasOpenAiKey(false);
    } catch { /* noop */ }
  };

  const saveBaseUrl = async (id: AgentProvider, value: string) => {
    const next = { ...baseUrls, [id]: value.trim() || undefined };
    setBaseUrls(next);
    try { await window.cth.updateConfig({ providerBaseUrls: next }); } catch { /* noop */ }
  };
  const saveModel = async (id: AgentProvider, value: string) => {
    const next = { ...models, [id]: value.trim() || undefined };
    setModels(next);
    try { await window.cth.updateConfig({ providerDefaultModels: next }); } catch { /* noop */ }
  };

  const persistProfiles = async (next: RuntimeProfile[]) => {
    setProfiles(next);
    try {
      await window.cth.updateConfig({ runtimeProfiles: next });
      onProfilesChanged?.(next);
    } catch { /* noop */ }
  };
  const addProfile = async () => {
    const name = draftName.trim();
    if (!name) return;
    const baseUrl = draftBaseUrl.trim();
    if (baseUrl) {
      const safe = await window.cth.profileIsSafeUrl(baseUrl);
      if (!safe) { setBaseUrlError('Unsafe or invalid URL — must be a public http/https endpoint.'); return; }
    }
    setBaseUrlError('');
    const profile: RuntimeProfile = {
      id: crypto.randomUUID(),
      name,
      provider: draftProvider,
      model: draftModel.trim() || undefined,
      claudeConfigDir: isClaudeProvider(draftProvider) ? (draftConfigDir.trim() || undefined) : undefined,
      baseUrl: baseUrl || undefined,
      createdAt: Date.now()
    };
    await persistProfiles([...profiles, profile]);
    setDraftName(''); setDraftModel(''); setDraftConfigDir(''); setDraftBaseUrl('');
  };
  const removeProfileById = async (id: string) => {
    await persistProfiles(profiles.filter((p) => p.id !== id));
  };

  const importProfilesFromClipboard = async () => {
    let text = '';
    try { text = await window.cth.readClipboard(); } catch { /* noop */ }
    if (!text.trim()) { setImportNote('Clipboard is empty.'); return; }
    let imported: RuntimeProfile[];
    try {
      imported = parseProfilesFromClipboard(text);
    } catch {
      setImportNote('Clipboard is not valid profile JSON.');
      return;
    }
    if (!imported.length) { setImportNote('No valid profile found in clipboard.'); return; }
    await persistProfiles([...profiles, ...imported]);
    setImportNote(`Imported ${imported.length} profile${imported.length > 1 ? 's' : ''}.`);
  };

  const saveCloudKey = async (profileId: string) => {
    const key = (cloudDraftKey[profileId] ?? '').trim();
    if (!key) return;
    try {
      const r = await window.cth.profileSetApiKey(profileId, key);
      if (r.ok) {
        setCloudHasKey((s) => ({ ...s, [profileId]: true }));
        setCloudDraftKey((s) => ({ ...s, [profileId]: '' }));
        setCloudNote((s) => ({ ...s, [profileId]: 'saved' }));
      } else setCloudNote((s) => ({ ...s, [profileId]: r.error ?? 'failed' }));
    } catch (e) { setCloudNote((s) => ({ ...s, [profileId]: e instanceof Error ? e.message : String(e) })); }
  };
  const clearCloudKey = async (profileId: string) => {
    try {
      await window.cth.profileRemoveApiKey(profileId);
      setCloudHasKey((s) => ({ ...s, [profileId]: false }));
      setCloudNote((s) => ({ ...s, [profileId]: 'cleared' }));
    } catch { /* noop */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={headStyle}>AI ENGINE PROVIDERS (BYOK)</div>
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
          API keys + local endpoints for the OpenCode, Crush, pi.dev and Qwen engines.
          Keys are stored <strong>write-only</strong> (encrypted at rest; never shown again)
          and used only when those engines spawn. Claude Code and Codex use their own login.
        </div>
      </div>

      {/* Backend API keys (write-only) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={headStyle}>API KEYS</div>
        {BACKENDS.map((b) => (
          <div key={b.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={labelStyle}>
              {b.label} {hasKey[b.id] ? '· set ✓' : ''} <span style={{ opacity: 0.6 }}>({b.envVar})</span>
            </label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="password"
                autoComplete="off"
                placeholder={hasKey[b.id] ? '•••••••• (stored — type to replace)' : `paste ${b.label} key`}
                value={draftKey[b.id] ?? ''}
                onChange={(e) => setDraftKey((s) => ({ ...s, [b.id]: e.target.value }))}
                style={inputStyle}
              />
              <PixelButton variant="secondary" size="sm" onClick={() => saveKey(b.id)}>Save</PixelButton>
              {hasKey[b.id] && (
                <PixelButton variant="secondary" size="sm" onClick={() => clearKey(b.id)}>Clear</PixelButton>
              )}
            </div>
            {note[b.id] && <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>{note[b.id]}</div>}
          </div>
        ))}
      </div>

      {/* Per-CLI local endpoint + default model */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={headStyle}>LOCAL ENDPOINT · DEFAULT MODEL (PER ENGINE)</div>
        {CLIS.map((c) => (
          <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
              <ProviderLogo provider={c.id} size={12} /> {c.label}
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ display: 'flex', flex: 1, gap: 4, alignItems: 'center' }}>
                <input
                  placeholder={`base-URL — ${c.hint}`}
                  defaultValue={baseUrls[c.id] ?? ''}
                  onBlur={(e) => saveBaseUrl(c.id, e.target.value)}
                  style={inputStyle}
                />
                {(baseUrls[c.id] ?? '').trim() && (
                  <CopyButton value={baseUrls[c.id] ?? ''} title="Copy base URL" />
                )}
              </div>
              <div style={{ display: 'flex', maxWidth: 220, gap: 4, alignItems: 'center' }}>
                <input
                  placeholder="default model (provider/model)"
                  defaultValue={models[c.id] ?? ''}
                  onBlur={(e) => saveModel(c.id, e.target.value)}
                  style={{ ...inputStyle }}
                />
                {(models[c.id] ?? '').trim() && (
                  <CopyButton value={models[c.id] ?? ''} title="Copy model name" />
                )}
              </div>
            </div>
          </div>
        ))}

        {/* Local-setup guides (ondev-c part-3) — link the two how-to blogs. */}
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>
          Running open models? Step-by-step guides:{' '}
          <a
            href={OSS_BLOG_LINKS.openModels}
            onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.openModels); }}
            style={linkStyle}
          >run The Hive on open models</a>
          {' '}·{' '}
          <a
            href={OSS_BLOG_LINKS.macMini}
            onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.macMini); }}
            style={linkStyle}
          >set it up on a Mac Mini</a>.
        </div>
      </div>

      {/* Runtime profiles (v1) — reusable engine + account + model bundles */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={headStyle}>RUNTIME PROFILES</div>
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>
          Reusable engine + account + model bundles you can pick when adding an agent.
          For a <strong>Claude</strong> profile, set a <strong>config dir</strong> — its own
          <code> ~/.claude</code> login — so that agent runs under a separate account. Log into it
          once with <code>CLAUDE_CONFIG_DIR=&lt;dir&gt; claude</code>. The dir is a path only; no
          key is stored here, and it must live outside the synced hive repo.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, marginTop: 6 }}>
          {importNote && <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>{importNote}</div>}
          <PixelButton
            variant="secondary"
            size="sm"
            onClick={importProfilesFromClipboard}
            title="Paste a profile copied with the 📋 button on another profile"
          >
            📋 Import from clipboard
          </PixelButton>
          {onOpenProfileWalkthrough && (
            <PixelButton variant="secondary" size="sm" onClick={onOpenProfileWalkthrough}>
              Re-run account walkthrough
            </PixelButton>
          )}
        </div>

        {profiles.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {profiles.map((p) => {
              const profileStr = `${p.provider}${p.model ? ` · ${p.model}` : ''}${p.claudeConfigDir ? ` · ${p.claudeConfigDir}` : ''}${p.baseUrl ? ` · ${p.baseUrl}` : ''}`;
              return (
                <div key={p.id} style={{
                  display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 8px',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', background: 'var(--cth-paper-100)'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ProviderLogo provider={p.provider} size={14} />
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)' }}>{p.name}</span>
                      <span style={{ fontSize: 13, color: 'var(--cth-ink-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {profileStr}
                      </span>
                    </div>
                    <CopyButton value={JSON.stringify(toPortableProfile(p))} title="Copy profile (paste with Import from clipboard)" />
                    <PixelButton variant="secondary" size="sm" onClick={() => removeProfileById(p.id)}>Delete</PixelButton>
                  </div>
                  {p.baseUrl && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 22 }}>
                      <label style={labelStyle}>
                        Cloud endpoint API key {cloudHasKey[p.id] ? '· set ✓' : ''}
                      </label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="password"
                          autoComplete="off"
                          placeholder={cloudHasKey[p.id] ? '•••••••• (stored — type to replace)' : 'paste the endpoint API key'}
                          value={cloudDraftKey[p.id] ?? ''}
                          onChange={(e) => setCloudDraftKey((s) => ({ ...s, [p.id]: e.target.value }))}
                          style={inputStyle}
                        />
                        <PixelButton variant="secondary" size="sm" onClick={() => saveCloudKey(p.id)}>Save</PixelButton>
                        {cloudHasKey[p.id] && (
                          <PixelButton variant="secondary" size="sm" onClick={() => clearCloudKey(p.id)}>Clear</PixelButton>
                        )}
                      </div>
                      {cloudNote[p.id] && <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>{cloudNote[p.id]}</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}


        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input
              placeholder="profile name (e.g. Claude · work account)"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              style={{ ...inputStyle, flex: 1, minWidth: 160 }}
            />
            <select
              value={draftProvider}
              onChange={(e) => setDraftProvider(e.target.value as AgentProvider)}
              style={{ ...inputStyle, maxWidth: 150, cursor: 'pointer' }}
            >
              {AGENT_PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input
              placeholder="model (optional — provider default)"
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              style={{ ...inputStyle, flex: 1, minWidth: 160 }}
            />
            {isClaudeProvider(draftProvider) && (
              <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 160 }}>
                <input
                  placeholder="Claude config dir (account login path)"
                  value={draftConfigDir}
                  onChange={(e) => setDraftConfigDir(e.target.value)}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <PixelButton
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    const result = await window.cth.chooseFolder();
                    if (result.ok) setDraftConfigDir(result.path);
                  }}
                  style={{ padding: '6px 10px' }}
                >
                  ...
                </PixelButton>
              </div>
            )}
            <PixelButton variant="secondary" size="sm" onClick={addProfile}>Add profile</PixelButton>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <input
              placeholder="Base URL (optional — e.g. https://your-endpoint.openai.azure.com/openai/v1/...)"
              value={draftBaseUrl}
              onChange={(e) => { setDraftBaseUrl(e.target.value); setBaseUrlError(''); }}
              style={inputStyle}
            />
            <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '16px' }}>
              Routes this profile's agent through a custom OpenAI-compatible endpoint (Azure
              OpenAI, GitHub Models, etc.) instead of the provider default. Add the profile,
              then set its API key below — the key is stored write-only and never shown again.
            </div>
            {baseUrlError && <div style={{ fontSize: 13, color: 'var(--cth-danger, #6E1423)' }}>{baseUrlError}</div>}
          </div>
        </div>
      </div>

      {/* Unsandboxed-in-auto caveat (Pam guardrail #6) */}
      <div style={{
        fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px',
        padding: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', background: 'var(--cth-paper-100)'
      }}>
        ⚠ In <strong>auto mode</strong> these engines run with full filesystem + shell access
        (no sandbox) — like Claude's bypass mode. Turn auto mode off (General) to make them
        ask first. Live end-to-end verification with real model calls is pending your keys / a
        local LLM.
      </div>
    </div>
  );
}
