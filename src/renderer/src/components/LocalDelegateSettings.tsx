import { useEffect, useState } from 'react';
import type {
  LocalDelegateConfig, LdaCapability, LdaApiCapability,
  LdaProviderKind, LdaTransport
} from '../../../shared/localDelegate';

const ALL_SCRIPT_CAPS: LdaCapability[] = ['find', 'map', 'run', 'check', 'task', 'loop'];
const ALL_API_CAPS: LdaApiCapability[] = ['complete', 'embed'];

const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const HOST_RE = /^[A-Za-z0-9._-]+$/;
const URL_RE = /^https?:\/\/.+/;

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase' as const
};

const sectionLabel: React.CSSProperties = {
  ...labelStyle,
  color: 'var(--cth-ink-700)',
  paddingBottom: 4,
  borderBottom: '1px solid var(--cth-ink-200)',
  display: 'block',
  marginBottom: 8
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 0',
  borderBottom: '1px solid var(--cth-ink-200)'
};

const EMPTY_FORM: LocalDelegateConfig = {
  id: '',
  label: '',
  transport: { kind: 'wsl-exec', distro: 'Ubuntu', scriptPrefix: '/home/deetss/.local/scripts' },
  providerKind: 'edgentic-script',
  model: '',
  capabilities: ['find', 'map', 'run', 'check'],
  apiCapabilities: ['complete'],
  enabled: true
};

function transportLabel(t: LdaTransport, model?: string): string {
  switch (t.kind) {
    case 'wsl-exec': return `wsl-exec · ${t.distro}${model ? ` · ${model}` : ''}`;
    case 'ssh': return `ssh · ${t.user}@${t.host}:${t.port}${model ? ` · ${model}` : ''}`;
    case 'http': return `http · ${t.baseUrl}${model ? ` · ${model}` : ''}`;
  }
}

export function LocalDelegateSettings() {
  const [delegates, setDelegates] = useState<LocalDelegateConfig[]>([]);
  const [health, setHealth] = useState<Record<string, { ok: boolean; latencyMs: number; checking: boolean }>>({});
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<LocalDelegateConfig>(EMPTY_FORM);
  const [note, setNote] = useState('');
  // API key UI state — local only, never persisted
  const [keyDraft, setKeyDraft] = useState('');
  const [keyStatus, setKeyStatus] = useState<'none' | 'set' | 'setting' | 'working'>('none');
  // Connection test
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = async () => {
    try {
      const list = await window.cth.ldaList() as LocalDelegateConfig[];
      setDelegates(list ?? []);
    } catch { /* ignore */ }
  };

  useEffect(() => { void load(); }, []);

  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(''), 2400); };

  const openForm = (d?: LocalDelegateConfig) => {
    const base = d ? { ...d } : EMPTY_FORM;
    setForm(base);
    setKeyDraft('');
    setKeyStatus('none');
    setTestResult(null);
    setShowForm(true);
    // Use lda:hasApiKey to confirm actual key presence (secretRef pointer alone
    // doesn't guarantee the safeStorage entry exists after a reinstall/migration).
    if (d?.id && d.secretRef) {
      window.cth.ldaHasApiKey(d.id).then((r) => {
        setKeyStatus(r.hasKey ? 'set' : 'none');
      }).catch(() => { /* noop — start as none */ });
    }
  };

  const closeForm = () => {
    setShowForm(false);
    setForm(EMPTY_FORM);
    setKeyDraft('');
    setKeyStatus('none');
    setTestResult(null);
  };

  const checkHealth = async (id: string) => {
    setHealth((h) => ({ ...h, [id]: { ok: false, latencyMs: 0, checking: true } }));
    try {
      const r = await window.cth.ldaHealth(id);
      setHealth((h) => ({ ...h, [id]: { ok: r.ok, latencyMs: r.latencyMs, checking: false } }));
    } catch {
      setHealth((h) => ({ ...h, [id]: { ok: false, latencyMs: 0, checking: false } }));
    }
  };

  const testConnection = async () => {
    if (!form.id) { flash('save first, then test'); return; }
    setTestResult(null);
    try {
      const r = await window.cth.ldaHealth(form.id);
      setTestResult({ ok: r.ok, msg: r.ok ? `OK ${r.latencyMs}ms` : (r.error ?? 'failed') });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    }
  };

  const toggleEnabled = async (d: LocalDelegateConfig) => {
    try { await window.cth.ldaUpsert({ ...d, enabled: !d.enabled }); await load(); }
    catch { flash('save failed'); }
  };

  const remove = async (id: string) => {
    try { await window.cth.ldaRemove(id); await load(); }
    catch { flash('remove failed'); }
  };

  const validate = (): string | null => {
    if (!form.id.trim()) return 'ID required';
    if (!SLUG_RE.test(form.id)) return 'ID: only letters, digits, . _ - allowed';
    if (!form.label.trim()) return 'Label required';
    const t = form.transport;
    if (t.kind === 'wsl-exec') {
      if (!t.scriptPrefix.trim()) return 'Script prefix required';
    } else if (t.kind === 'ssh') {
      if (!t.host || !HOST_RE.test(t.host)) return 'SSH host: only letters, digits, . _ - allowed';
      if (!t.user || !HOST_RE.test(t.user)) return 'SSH user: only letters, digits, . _ - allowed';
      if (t.port < 1 || t.port > 65535) return 'SSH port must be 1–65535';
      if (!t.scriptPrefix.trim()) return 'Script prefix required';
      if (t.identityFile && !/^[/\\]/.test(t.identityFile)) return 'Identity file must be an absolute path';
    } else if (t.kind === 'http') {
      if (!t.baseUrl || !URL_RE.test(t.baseUrl)) return 'Base URL must start with http:// or https://';
    }
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) { flash(err); return; }
    try {
      await window.cth.ldaUpsert(form);
      await load();
      flash('saved');
      closeForm();
    } catch (e) { flash(String(e)); }
  };

  const setApiKey = async () => {
    const key = keyDraft.trim();
    if (!key || !form.id.trim()) return;
    setKeyStatus('working');
    try {
      const r = await window.cth.ldaSetApiKey(form.id, key);
      if (r.ok) {
        setForm((f) => ({ ...f, secretRef: r.ref ?? `lda:${f.id}:apikey` }));
        setKeyDraft('');
        setKeyStatus('set');
        flash('key stored');
      } else {
        flash(r.error ?? 'failed to store key');
        setKeyStatus('none');
      }
    } catch (e) { flash(String(e)); setKeyStatus('none'); }
  };

  const clearApiKey = async () => {
    if (!form.id.trim()) { setForm((f) => ({ ...f, secretRef: undefined })); setKeyStatus('none'); return; }
    try {
      await window.cth.ldaRemoveApiKey(form.id);
      setForm((f) => ({ ...f, secretRef: undefined }));
      setKeyStatus('none');
      flash('key cleared');
    } catch (e) { flash(String(e)); }
  };

  const setTransportKind = (kind: 'wsl-exec' | 'ssh' | 'http') => {
    setForm((f) => {
      let transport: LdaTransport;
      if (kind === 'wsl-exec') {
        transport = { kind: 'wsl-exec', distro: 'Ubuntu', scriptPrefix: '/home/deetss/.local/scripts' };
      } else if (kind === 'ssh') {
        transport = { kind: 'ssh', host: '', port: 22, user: '', scriptPrefix: '/home/user/.local/scripts' };
      } else {
        transport = { kind: 'http', baseUrl: 'http://localhost:11434' };
      }
      const isHttp = kind === 'http';
      return {
        ...f,
        transport,
        // HTTP: only API capabilities; wsl-exec/ssh: only script capabilities
        capabilities: isHttp ? [] : (f.capabilities.length ? f.capabilities : ['find', 'map', 'run', 'check']),
        apiCapabilities: isHttp ? (f.apiCapabilities.length ? f.apiCapabilities : ['complete']) : [],
      };
    });
  };

  const toggleCap = (cap: LdaCapability) => {
    setForm((f) => ({
      ...f,
      capabilities: f.capabilities.includes(cap)
        ? f.capabilities.filter((c) => c !== cap)
        : [...f.capabilities, cap]
    }));
  };

  const toggleApiCap = (cap: LdaApiCapability) => {
    setForm((f) => ({
      ...f,
      apiCapabilities: f.apiCapabilities.includes(cap)
        ? f.apiCapabilities.filter((c) => c !== cap)
        : [...f.apiCapabilities, cap]
    }));
  };

  const inp = (extra?: React.CSSProperties): React.CSSProperties => ({
    fontFamily: 'var(--cth-font-ui)',
    fontSize: 12,
    padding: '4px 8px',
    background: 'var(--cth-ink-100)',
    border: '1px solid var(--cth-ink-300)',
    borderRadius: 4,
    color: 'var(--cth-ink-900)',
    width: '100%',
    boxSizing: 'border-box',
    ...extra
  });

  const sel = inp;

  const isHttp = form.transport.kind === 'http';
  const isScript = !isHttp;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ ...labelStyle, marginBottom: 6 }}>Local delegate agents</div>
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
          Ephemeral per-request capability boxes (a Jetson, DGX, or local model server)
          that the orchestrator can delegate bulk read / summarize / draft work to natively.
          Supports WSL-exec, SSH, and HTTP transports.
        </span>
      </div>

      {delegates.length === 0 && !showForm && (
        <span style={{ fontSize: 12, color: 'var(--cth-ink-400)' }}>No local delegates configured.</span>
      )}

      {delegates.map((d) => {
        const h = health[d.id];
        return (
          <div key={d.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={rowStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)' }}>
                  {d.label}{' '}
                  <span style={{ fontSize: 13, color: 'var(--cth-ink-400)' }}>{d.id}</span>
                  {d.secretRef && <span style={{ fontSize: 13, color: '#3d8c3d', marginLeft: 4 }}>● key</span>}
                </div>
                <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>
                  {transportLabel(d.transport, d.model)} · {d.providerKind}
                </div>
                <div style={{ fontSize: 13, color: 'var(--cth-ink-400)', marginTop: 2 }}>
                  {[...d.capabilities, ...d.apiCapabilities].join('  ') || '—'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {h && (
                  <span style={{ fontSize: 13, fontFamily: 'var(--cth-font-ui)', color: h.checking ? 'var(--cth-ink-400)' : h.ok ? '#3d8c3d' : '#c0392b' }}>
                    {h.checking ? 'pinging…' : h.ok ? `OK ${h.latencyMs}ms` : 'OFFLINE'}
                  </span>
                )}
                <button style={{ fontSize: 13, padding: '2px 6px', cursor: 'pointer', background: 'var(--cth-ink-100)', border: '1px solid var(--cth-ink-300)', borderRadius: 3, color: 'var(--cth-ink-600)' }}
                  onClick={() => checkHealth(d.id)}>ping</button>
                <button style={{ fontSize: 13, padding: '2px 6px', cursor: 'pointer', background: 'var(--cth-ink-100)', border: '1px solid var(--cth-ink-300)', borderRadius: 3, color: 'var(--cth-ink-600)' }}
                  onClick={() => openForm(d)}>edit</button>
                <button style={{ fontSize: 13, padding: '2px 6px', cursor: 'pointer', background: d.enabled ? 'var(--cth-ink-100)' : 'var(--cth-ink-200)', border: '1px solid var(--cth-ink-300)', borderRadius: 3, color: 'var(--cth-ink-600)' }}
                  onClick={() => toggleEnabled(d)}>{d.enabled ? 'enabled' : 'disabled'}</button>
                <button style={{ fontSize: 13, padding: '2px 6px', cursor: 'pointer', background: 'transparent', border: '1px solid #c0392b', borderRadius: 3, color: '#c0392b' }}
                  onClick={() => remove(d.id)}>remove</button>
              </div>
            </div>
          </div>
        );
      })}

      {!showForm && (
        <div>
          <button style={{ fontSize: 13, padding: '4px 10px', cursor: 'pointer', background: 'var(--cth-ink-100)', border: '1px solid var(--cth-ink-300)', borderRadius: 4, color: 'var(--cth-ink-700)' }}
            onClick={() => openForm()}>+ add delegate</button>
        </div>
      )}

      {showForm && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14, background: 'var(--cth-ink-100)', borderRadius: 6, border: '1px solid var(--cth-ink-300)' }}>

          {/* ─── Identity ─────────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>ID (slug)</label>
              <input style={inp()} value={form.id} placeholder="edgentic1"
                onChange={(e) => setForm((f) => ({ ...f, id: e.target.value.replace(/[^A-Za-z0-9._-]/g, '-') }))} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>Label</label>
              <input style={inp()} value={form.label} placeholder="Jetson Thor (edgentic)"
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </div>
          </div>

          {/* ─── Transport ───────────────────────────────────────────── */}
          <div>
            <span style={sectionLabel}>Transport</span>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {(['wsl-exec', 'ssh', 'http'] as const).map((k) => (
                <button key={k}
                  onClick={() => setTransportKind(k)}
                  style={{ fontSize: 13, padding: '3px 10px', cursor: 'pointer', borderRadius: 4, border: '1px solid var(--cth-ink-300)', fontFamily: 'var(--cth-font-ui)', background: form.transport.kind === k ? 'var(--cth-ink-900)' : 'var(--cth-ink-100)', color: form.transport.kind === k ? 'var(--cth-bg)' : 'var(--cth-ink-700)' }}>
                  {k}
                </button>
              ))}
            </div>

            {form.transport.kind === 'wsl-exec' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>WSL distro</label>
                  <input style={inp()} value={form.transport.distro} placeholder="Ubuntu"
                    onChange={(e) => setForm((f) => f.transport.kind === 'wsl-exec' ? { ...f, transport: { ...f.transport, distro: e.target.value } } : f)} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>Script prefix (inside WSL)</label>
                  <input style={inp()} value={form.transport.scriptPrefix} placeholder="/home/user/.local/scripts"
                    onChange={(e) => setForm((f) => f.transport.kind === 'wsl-exec' ? { ...f, transport: { ...f.transport, scriptPrefix: e.target.value } } : f)} />
                </div>
              </div>
            )}

            {form.transport.kind === 'ssh' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>Host</label>
                    <input style={inp()} value={form.transport.host} placeholder="edgentic1.local"
                      onChange={(e) => setForm((f) => f.transport.kind === 'ssh' ? { ...f, transport: { ...f.transport, host: e.target.value } } : f)} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>Port</label>
                    <input style={inp()} type="number" min={1} max={65535} value={form.transport.port}
                      onChange={(e) => setForm((f) => f.transport.kind === 'ssh' ? { ...f, transport: { ...f.transport, port: parseInt(e.target.value) || 22 } } : f)} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>User</label>
                    <input style={inp()} value={form.transport.user} placeholder="deetss"
                      onChange={(e) => setForm((f) => f.transport.kind === 'ssh' ? { ...f, transport: { ...f.transport, user: e.target.value } } : f)} />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>Identity file (absolute path, optional)</label>
                  <input style={inp()} value={form.transport.identityFile ?? ''} placeholder="/home/deetss/.ssh/id_ed25519"
                    onChange={(e) => setForm((f) => f.transport.kind === 'ssh' ? { ...f, transport: { ...f.transport, identityFile: e.target.value || undefined } } : f)} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>Script prefix (on remote)</label>
                  <input style={inp()} value={form.transport.scriptPrefix} placeholder="/home/user/.local/scripts"
                    onChange={(e) => setForm((f) => f.transport.kind === 'ssh' ? { ...f, transport: { ...f.transport, scriptPrefix: e.target.value } } : f)} />
                </div>
              </div>
            )}

            {form.transport.kind === 'http' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>Base URL</label>
                  <input style={inp()} value={form.transport.baseUrl} placeholder="http://localhost:11434"
                    onChange={(e) => setForm((f) => f.transport.kind === 'http' ? { ...f, transport: { ...f.transport, baseUrl: e.target.value } } : f)} />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: 'var(--cth-ink-700)' }}>
                  <input type="checkbox" checked={!!form.transport.allowPrivate}
                    onChange={(e) => setForm((f) => f.transport.kind === 'http' ? { ...f, transport: { ...f.transport, allowPrivate: e.target.checked } } : f)} />
                  Allow private / LAN IP ranges (needed for local Jetson/DGX)
                </label>
              </div>
            )}
          </div>

          {/* ─── Model ───────────────────────────────────────────────── */}
          <div>
            <span style={sectionLabel}>Model</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>Provider kind</label>
                <select style={sel()} value={form.providerKind}
                  onChange={(e) => setForm((f) => ({ ...f, providerKind: e.target.value as LdaProviderKind }))}>
                  <option value="edgentic-script">edgentic-script</option>
                  <option value="openai-compat">openai-compat</option>
                  <option value="anthropic-compat">anthropic-compat</option>
                  <option value="ollama">ollama</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>Model</label>
                <input style={inp()} value={form.model} placeholder="llama-3.2-8b"
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
              </div>
            </div>
          </div>

          {/* ─── Authentication ───────────────────────────────────────── */}
          <div>
            <span style={sectionLabel}>Authentication</span>
            {keyStatus === 'set' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, fontFamily: 'var(--cth-font-ui)', color: '#3d8c3d' }}>● key set (encrypted)</span>
                <button onClick={clearApiKey}
                  style={{ fontSize: 13, padding: '2px 8px', cursor: 'pointer', background: 'transparent', border: '1px solid #c0392b', borderRadius: 3, color: '#c0392b' }}>
                  clear key
                </button>
              </div>
            ) : keyStatus === 'setting' ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="password" style={inp({ flex: 1 })} value={keyDraft} placeholder="paste API key…"
                  autoFocus
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void setApiKey(); if (e.key === 'Escape') setKeyStatus('none'); }} />
                <button onClick={() => void setApiKey()} disabled={!keyDraft.trim()}
                  style={{ fontSize: 13, padding: '4px 10px', cursor: 'pointer', background: 'var(--cth-ink-900)', border: 'none', borderRadius: 4, color: 'var(--cth-bg)', opacity: keyDraft.trim() ? 1 : 0.5 }}>
                  store
                </button>
                <button onClick={() => { setKeyDraft(''); setKeyStatus('none'); }}
                  style={{ fontSize: 13, padding: '4px 8px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--cth-ink-300)', borderRadius: 4, color: 'var(--cth-ink-600)' }}>
                  cancel
                </button>
              </div>
            ) : keyStatus === 'working' ? (
              <span style={{ fontSize: 12, color: 'var(--cth-ink-400)' }}>storing key…</span>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-400)' }}>no key set</span>
                <button onClick={() => setKeyStatus('setting')}
                  style={{ fontSize: 13, padding: '2px 8px', cursor: 'pointer', background: 'var(--cth-ink-100)', border: '1px solid var(--cth-ink-300)', borderRadius: 3, color: 'var(--cth-ink-700)' }}>
                  set key
                </button>
              </div>
            )}
            <div style={{ fontSize: 13, color: 'var(--cth-ink-400)', marginTop: 4 }}>
              Keys are encrypted by the OS keychain. The key is never stored in plain text or sent over IPC.
            </div>
          </div>

          {/* ─── Capabilities ────────────────────────────────────────── */}
          <div>
            <span style={sectionLabel}>Capabilities</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div>
                <div style={{ fontSize: 13, color: isScript ? 'var(--cth-ink-500)' : 'var(--cth-ink-300)', marginBottom: 4 }}>
                  Script verbs (wsl-exec / ssh)
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {ALL_SCRIPT_CAPS.map((cap) => (
                    <label key={cap} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: isScript ? 'pointer' : 'not-allowed', color: isScript ? 'var(--cth-ink-700)' : 'var(--cth-ink-300)', opacity: isScript ? 1 : 0.5 }}>
                      <input type="checkbox" disabled={!isScript} checked={form.capabilities.includes(cap)}
                        onChange={() => toggleCap(cap)} />
                      {cap}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, color: isHttp ? 'var(--cth-ink-500)' : 'var(--cth-ink-300)', marginBottom: 4 }}>
                  Model API (http)
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {ALL_API_CAPS.map((cap) => (
                    <label key={cap} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: isHttp ? 'pointer' : 'not-allowed', color: isHttp ? 'var(--cth-ink-700)' : 'var(--cth-ink-300)', opacity: isHttp ? 1 : 0.5 }}>
                      <input type="checkbox" disabled={!isHttp} checked={form.apiCapabilities.includes(cap)}
                        onChange={() => toggleApiCap(cap)} />
                      {cap}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ─── Actions ─────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <button onClick={save}
              style={{ fontSize: 13, padding: '4px 14px', cursor: 'pointer', background: 'var(--cth-ink-900)', border: 'none', borderRadius: 4, color: 'var(--cth-bg)' }}>
              save
            </button>
            <button onClick={() => void testConnection()}
              style={{ fontSize: 13, padding: '4px 10px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--cth-ink-300)', borderRadius: 4, color: 'var(--cth-ink-700)' }}>
              test connection
            </button>
            {testResult && (
              <span style={{ fontSize: 13, fontFamily: 'var(--cth-font-ui)', color: testResult.ok ? '#3d8c3d' : '#c0392b' }}>
                {testResult.ok ? `✓ ${testResult.msg}` : `✗ ${testResult.msg}`}
              </span>
            )}
            <button onClick={closeForm}
              style={{ fontSize: 13, padding: '4px 10px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--cth-ink-300)', borderRadius: 4, color: 'var(--cth-ink-500)', marginLeft: 'auto' }}>
              cancel
            </button>
          </div>
        </div>
      )}

      {note && <span style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>{note}</span>}
    </div>
  );
}
