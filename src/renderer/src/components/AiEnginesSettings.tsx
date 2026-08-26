import { useState, useEffect, type CSSProperties } from 'react';
import type { HarnessConfig, AgentProvider, RuntimeProfile } from '@/store/config';
import { AGENT_PROVIDER_PRESETS, isClaudeProvider } from '@/store/config';
import { PixelButton } from './PixelButton';
import { ProviderLogo } from './ProviderLogo';
import { OSS_BLOG_LINKS } from '@shared/ossModels';
import { useStore } from '@/store/store';

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
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase'
};
const headStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
};
const linkStyle: CSSProperties = { color: 'var(--cth-ink-900)', textDecoration: 'underline', cursor: 'pointer' };

export function AiEnginesSettings({ config }: { config: HarnessConfig }) {
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
    try { await window.cth.updateConfig({ runtimeProfiles: next }); } catch { /* noop */ }
  };
  const addProfile = async () => {
    const name = draftName.trim();
    if (!name) return;
    const profile: RuntimeProfile = {
      id: crypto.randomUUID(),
      name,
      provider: draftProvider,
      model: draftModel.trim() || undefined,
      claudeConfigDir: isClaudeProvider(draftProvider) ? (draftConfigDir.trim() || undefined) : undefined,
      createdAt: Date.now()
    };
    await persistProfiles([...profiles, profile]);
    setDraftName(''); setDraftModel(''); setDraftConfigDir('');
  };
  const removeProfileById = async (id: string) => {
    await persistProfiles(profiles.filter((p) => p.id !== id));
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
            {note[b.id] && <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{note[b.id]}</div>}
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
              <input
                placeholder={`base-URL — ${c.hint}`}
                defaultValue={baseUrls[c.id] ?? ''}
                onBlur={(e) => saveBaseUrl(c.id, e.target.value)}
                style={inputStyle}
              />
              <input
                placeholder="default model (provider/model)"
                defaultValue={models[c.id] ?? ''}
                onBlur={(e) => saveModel(c.id, e.target.value)}
                style={{ ...inputStyle, maxWidth: 220 }}
              />
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

        {profiles.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {profiles.map((p) => (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', background: 'var(--cth-paper-100)'
              }}>
                <ProviderLogo provider={p.provider} size={14} />
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)' }}>{p.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.provider}{p.model ? ` · ${p.model}` : ''}{p.claudeConfigDir ? ` · ${p.claudeConfigDir}` : ''}
                  </span>
                </div>
                <PixelButton variant="secondary" size="sm" onClick={() => removeProfileById(p.id)}>Delete</PixelButton>
              </div>
            ))}
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
              <input
                placeholder="Claude config dir (account login path)"
                value={draftConfigDir}
                onChange={(e) => setDraftConfigDir(e.target.value)}
                style={{ ...inputStyle, flex: 1, minWidth: 160 }}
              />
            )}
            <PixelButton variant="secondary" size="sm" onClick={addProfile}>Add profile</PixelButton>
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
