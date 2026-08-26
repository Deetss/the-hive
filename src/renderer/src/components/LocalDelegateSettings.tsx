import { useEffect, useState } from 'react';
import type { LocalDelegateConfig, LdaCapability } from '../../../shared/localDelegate';

const ALL_CAPS: LdaCapability[] = ['find', 'map', 'run', 'check', 'task', 'loop'];

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-500)',
  textTransform: 'uppercase' as const
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
  model: '',
  capabilities: ['find', 'map', 'run', 'check'],
  enabled: true
};

export function LocalDelegateSettings() {
  const [delegates, setDelegates] = useState<LocalDelegateConfig[]>([]);
  const [health, setHealth] = useState<Record<string, { ok: boolean; latencyMs: number; checking: boolean }>>({});
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<LocalDelegateConfig>(EMPTY_FORM);
  const [note, setNote] = useState('');

  const load = async () => {
    try {
      const list = await window.cth.ldaList() as LocalDelegateConfig[];
      setDelegates(list ?? []);
    } catch { /* ignore */ }
  };

  useEffect(() => { void load(); }, []);

  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(''), 2200); };

  const checkHealth = async (id: string) => {
    setHealth((h) => ({ ...h, [id]: { ok: false, latencyMs: 0, checking: true } }));
    try {
      const r = await window.cth.ldaHealth(id);
      setHealth((h) => ({ ...h, [id]: { ok: r.ok, latencyMs: r.latencyMs, checking: false } }));
    } catch {
      setHealth((h) => ({ ...h, [id]: { ok: false, latencyMs: 0, checking: false } }));
    }
  };

  const toggleEnabled = async (d: LocalDelegateConfig) => {
    try {
      await window.cth.ldaUpsert({ ...d, enabled: !d.enabled });
      await load();
    } catch { flash('save failed'); }
  };

  const remove = async (id: string) => {
    try { await window.cth.ldaRemove(id); await load(); }
    catch { flash('remove failed'); }
  };

  const save = async () => {
    if (!form.id.trim() || !form.label.trim()) { flash('id and label required'); return; }
    if (form.transport.kind === 'wsl-exec' && !form.transport.scriptPrefix.trim()) {
      flash('script prefix required'); return;
    }
    try {
      await window.cth.ldaUpsert(form);
      await load();
      setShowForm(false);
      setForm(EMPTY_FORM);
      flash('saved');
    } catch (e) { flash(String(e)); }
  };

  const toggleCap = (cap: LdaCapability) => {
    setForm((f) => ({
      ...f,
      capabilities: f.capabilities.includes(cap)
        ? f.capabilities.filter((c) => c !== cap)
        : [...f.capabilities, cap]
    }));
  };

  const inp = (style?: React.CSSProperties): React.CSSProperties => ({
    fontFamily: 'var(--cth-font-mono)',
    fontSize: 12,
    padding: '4px 8px',
    background: 'var(--cth-ink-100)',
    border: '1px solid var(--cth-ink-300)',
    borderRadius: 4,
    color: 'var(--cth-ink-900)',
    width: '100%',
    ...style
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ ...labelStyle, marginBottom: 6 }}>Local delegate agents</div>
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
          Ephemeral per-request capability boxes (e.g. a Jetson or DGX running a local model)
          that the orchestrator can delegate bulk read / summarize / draft work to natively.
          Phase 1: WSL-exec transport only. Changes take effect immediately.
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
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, color: 'var(--cth-ink-900)' }}>
                  {d.label}
                  {' '}
                  <span style={{ fontSize: 9, color: 'var(--cth-ink-400)' }}>{d.id}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                  {d.transport.kind === 'wsl-exec'
                    ? `wsl-exec · ${d.transport.distro} · ${d.transport.scriptPrefix}`
                    : d.transport.kind}
                  {d.model ? ` · ${d.model}` : ''}
                </div>
                <div style={{ fontSize: 10, color: 'var(--cth-ink-400)', marginTop: 2 }}>
                  {d.capabilities.join('  ')}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {h && (
                  <span style={{
                    fontSize: 10, fontFamily: 'var(--cth-font-mono)',
                    color: h.checking ? 'var(--cth-ink-400)' : h.ok ? '#3d8c3d' : '#c0392b'
                  }}>
                    {h.checking ? 'pinging…' : h.ok ? `OK ${h.latencyMs}ms` : 'OFFLINE'}
                  </span>
                )}
                <button
                  style={{ fontSize: 10, padding: '2px 6px', cursor: 'pointer', background: 'var(--cth-ink-100)', border: '1px solid var(--cth-ink-300)', borderRadius: 3, color: 'var(--cth-ink-600)' }}
                  onClick={() => checkHealth(d.id)}
                >ping</button>
                <button
                  style={{ fontSize: 10, padding: '2px 6px', cursor: 'pointer', background: d.enabled ? 'var(--cth-ink-100)' : 'var(--cth-ink-200)', border: '1px solid var(--cth-ink-300)', borderRadius: 3, color: 'var(--cth-ink-600)' }}
                  onClick={() => toggleEnabled(d)}
                >{d.enabled ? 'enabled' : 'disabled'}</button>
                <button
                  style={{ fontSize: 10, padding: '2px 6px', cursor: 'pointer', background: 'transparent', border: '1px solid #c0392b', borderRadius: 3, color: '#c0392b' }}
                  onClick={() => remove(d.id)}
                >remove</button>
              </div>
            </div>
          </div>
        );
      })}

      {!showForm && (
        <div>
          <button
            style={{ fontSize: 11, padding: '4px 10px', cursor: 'pointer', background: 'var(--cth-ink-100)', border: '1px solid var(--cth-ink-400)', borderRadius: 4, color: 'var(--cth-ink-700)' }}
            onClick={() => setShowForm(true)}
          >+ add delegate</button>
        </div>
      )}

      {showForm && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, background: 'var(--cth-ink-100)', borderRadius: 6, border: '1px solid var(--cth-ink-300)' }}>
          <div style={{ ...labelStyle }}>New delegate</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>ID (slug)</label>
              <input style={inp()} value={form.id} placeholder="edgentic1"
                onChange={(e) => setForm((f) => ({ ...f, id: e.target.value.replace(/\s/g, '-') }))} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>Label</label>
              <input style={inp()} value={form.label} placeholder="Jetson Thor (edgentic)"
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>WSL distro</label>
              <input style={inp()} value={form.transport.kind === 'wsl-exec' ? form.transport.distro : ''} placeholder="Ubuntu"
                onChange={(e) => setForm((f) => ({ ...f, transport: { kind: 'wsl-exec', distro: e.target.value, scriptPrefix: f.transport.kind === 'wsl-exec' ? f.transport.scriptPrefix : '/home/deetss/.local/scripts' } }))} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>Script prefix (inside WSL)</label>
              <input style={inp()} value={form.transport.kind === 'wsl-exec' ? form.transport.scriptPrefix : ''} placeholder="/home/user/.local/scripts"
                onChange={(e) => setForm((f) => ({ ...f, transport: { kind: 'wsl-exec', distro: f.transport.kind === 'wsl-exec' ? f.transport.distro : 'Ubuntu', scriptPrefix: e.target.value } }))} />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>Model (informational)</label>
            <input style={inp()} value={form.model} placeholder="llama-3.2-8b"
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>Capabilities</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {ALL_CAPS.map((cap) => (
                <label key={cap} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer', color: 'var(--cth-ink-700)' }}>
                  <input type="checkbox" checked={form.capabilities.includes(cap)}
                    onChange={() => toggleCap(cap)} />
                  {cap}
                </label>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              style={{ fontSize: 11, padding: '4px 12px', cursor: 'pointer', background: 'var(--cth-ink-900)', border: 'none', borderRadius: 4, color: 'var(--cth-bg)' }}
              onClick={save}
            >save</button>
            <button
              style={{ fontSize: 11, padding: '4px 10px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--cth-ink-400)', borderRadius: 4, color: 'var(--cth-ink-600)' }}
              onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}
            >cancel</button>
          </div>
        </div>
      )}

      {note && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{note}</span>}
    </div>
  );
}
