import { useEffect, useState, type CSSProperties } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';

/** Renderer-local mirror of main's HiveProfile (main types can't cross the web
 *  tsconfig boundary; the preload returns these as `unknown`). */
interface Profile {
  id: string;
  name: string;
  harnessHome: string;
  userData: string;
  remote?: string;
  createdAt: number;
}

// Shared with HivePicker: set before a same-instance SWITCH so App skips the
// picker once after the changeHome relaunch lands.
const SKIP_KEY = 'cth.skipHivePickerOnce';

function folderName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

const inputStyle: CSSProperties = {
  flex: 1, padding: '6px 8px 4px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-mono)',
  fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none', minWidth: 0
};
const labelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', marginBottom: 4
};

/**
 * HiveProfiles — manage NAMED isolated hives (a profile = {harnessHome, userData}).
 * Unlike the "recent configs" list (which switches THIS window to another home,
 * sharing userData), a profile can be LAUNCHED as a separate concurrent instance
 * with its own userData, or JOINED from another device by cloning its git remote.
 * Backed entirely by the profiles IPC (list/current/create/launch/delete + join).
 */
export function HiveProfiles() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [current, setCurrent] = useState<Profile | null>(null);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [mode, setMode] = useState<'none' | 'create' | 'join'>('none');
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>();

  const [cName, setCName] = useState('');
  const [cHome, setCHome] = useState('');

  const [jName, setJName] = useState('');
  const [jHome, setJHome] = useState('');
  const [jUrl, setJUrl] = useState('');
  const [jUrlOk, setJUrlOk] = useState<boolean | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const list = (await window.cth.listProfiles()) as Profile[] | null;
      const cur = (await window.cth.currentProfile()) as Profile | null;
      setProfiles(Array.isArray(list) ? list : []);
      setCurrent(cur ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => { void refresh(); }, []);

  // Validate the join URL through the SAME backend guard (isSafeGitUrl), so a
  // command-executing transport (ext::) or a flag-shaped URL can never reach git.
  useEffect(() => {
    let alive = true;
    const u = jUrl.trim();
    if (!u) { setJUrlOk(null); return; }
    window.cth.isSafeRemoteUrl(u).then((ok) => { if (alive) setJUrlOk(ok); }).catch(() => { if (alive) setJUrlOk(false); });
    return () => { alive = false; };
  }, [jUrl]);

  const pick = async (set: (p: string) => void): Promise<void> => {
    const res = await window.cth.chooseFolder();
    if (res.ok) set(res.path);
    else if (res.error && res.error !== 'cancelled') setError(res.error);
  };

  const doCreate = async (): Promise<void> => {
    if (!cName.trim() || !cHome.trim()) { setError('Name and folder are both required.'); return; }
    setBusy('create'); setError(undefined); setNotice(undefined);
    const res = await window.cth.createProfile({ name: cName.trim(), harnessHome: cHome.trim() });
    setBusy(undefined);
    if (!res.ok) { setError(res.error ?? 'Could not create the profile.'); return; }
    setMode('none'); setCName(''); setCHome(''); void refresh();
  };

  const doJoin = async (): Promise<void> => {
    if (!jUrl.trim() || !jHome.trim()) { setError('A remote URL and a target folder are required.'); return; }
    if (jUrlOk === false) { setError('That remote URL is not an allowed git URL.'); return; }
    setBusy('join'); setError(undefined); setNotice('Cloning the hive — this can take a moment…');
    const res = await window.cth.joinHive({ remoteUrl: jUrl.trim(), name: jName.trim() || 'joined hive', harnessHome: jHome.trim() });
    setBusy(undefined); setNotice(undefined);
    if (!res.ok) { setError(res.error ?? 'Join failed.'); return; }
    setMode('none'); setJUrl(''); setJName(''); setJHome(''); void refresh();
  };

  const doLaunch = async (p: Profile): Promise<void> => {
    setBusy(p.id); setError(undefined); setNotice(undefined);
    const res = await window.cth.launchProfile(p.id);
    setBusy(undefined);
    if (!res.ok) setError(res.error ?? 'Launch failed.');
    else setNotice(`Launched “${p.name}” in a separate window.`);
  };

  const doSwitch = async (p: Profile): Promise<void> => {
    setBusy(p.id); setError(undefined); setNotice(undefined);
    try {
      window.localStorage.setItem(SKIP_KEY, '1');
      const res = await window.cth.changeHome(p.harnessHome, 'fresh');
      // On success the process relaunches and never returns here.
      if (!res.ok) { window.localStorage.removeItem(SKIP_KEY); setError(res.error ?? 'Switch failed.'); setBusy(undefined); }
    } catch (e) {
      window.localStorage.removeItem(SKIP_KEY);
      setError(e instanceof Error ? e.message : String(e));
      setBusy(undefined);
    }
  };

  const doDelete = async (p: Profile): Promise<void> => {
    setBusy(p.id); setConfirmDelete(undefined);
    const res = await window.cth.deleteProfile(p.id);
    setBusy(undefined);
    if (!res.ok) setError(res.error ?? 'Delete failed.');
    else void refresh();
  };

  return (
    <PixelPanel variant="dialog" title="ISOLATED HIVES" noPadding>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 12, lineHeight: '19px', color: 'var(--cth-ink-700)' }}>
          A <strong>hive profile</strong> is a fully self-contained office — its own home folder and its own
          app data — so several can run <strong>at the same time</strong> without colliding. Launch one in a new
          window, or <strong>join</strong> a hive from another device by its git remote.
        </p>

        {/* One-instance-per-machine advisory (Q2). */}
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px',
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}>
          <Icon name="info" />
          <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
            Only <strong>one</strong> instance per machine runs Slack and webhooks. A launched hive won’t own
            those ports — that’s expected, not an error.
          </div>
        </div>

        {/* PROFILE LIST */}
        {profiles.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
            {profiles.map((p) => {
              const isCurrent = current?.id === p.id;
              return (
                <div key={p.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  background: isCurrent ? 'var(--cth-mint-light)' : 'var(--cth-paper-100)',
                  boxShadow: `inset 0 0 0 ${isCurrent ? 2 : 1}px ${isCurrent ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`
                }}>
                  <Icon name={p.remote ? 'git' : 'folder'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                        {p.name}
                      </span>
                      {isCurrent && (
                        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-mint-dark, var(--cth-ink-700))' }}>
                          YOU ARE HERE
                        </span>
                      )}
                      {p.remote && !isCurrent && (
                        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>JOINED</span>
                      )}
                    </div>
                    <div style={{
                      fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left'
                    }}>{p.harnessHome}</div>
                  </div>
                  {confirmDelete === p.id ? (
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <PixelButton variant="destructive" size="sm" onClick={() => doDelete(p)} disabled={busy === p.id}>
                        delete
                      </PixelButton>
                      <PixelButton variant="ghost" size="sm" onClick={() => setConfirmDelete(undefined)}>
                        cancel
                      </PixelButton>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      {!isCurrent && (
                        <PixelButton variant="secondary" size="sm" onClick={() => doSwitch(p)} disabled={!!busy}
                          title="Open this hive in THIS window (reloads the app)">
                          switch
                        </PixelButton>
                      )}
                      <PixelButton variant="primary" size="sm" onClick={() => doLaunch(p)} disabled={!!busy}
                        title="Open this hive in a SEPARATE window, running alongside this one">
                        {busy === p.id ? '…' : 'launch'}
                      </PixelButton>
                      <PixelButton variant="ghost" size="sm" onClick={() => setConfirmDelete(p.id)} disabled={!!busy}
                        title="Forget this profile (its files are left on disk)">
                        <Icon name="minimize" />
                      </PixelButton>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>No saved profiles yet.</div>
        )}

        {/* CREATE FORM */}
        {mode === 'create' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
            <div style={labelStyle}>NEW ISOLATED HIVE</div>
            <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="name (e.g. Client A)" style={inputStyle} />
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={cHome} onChange={(e) => setCHome(e.target.value)} placeholder="/path/to/HarnessAgents-clientA" style={inputStyle} />
              <PixelButton variant="secondary" size="md" onClick={() => pick(setCHome)}><Icon name="folder" /></PixelButton>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <PixelButton variant="ghost" size="md" onClick={() => setMode('none')}>cancel</PixelButton>
              <PixelButton variant="primary" size="md" onClick={doCreate} disabled={busy === 'create'}>
                {busy === 'create' ? 'creating…' : 'create'}
              </PixelButton>
            </div>
          </div>
        )}

        {/* JOIN FORM */}
        {mode === 'join' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
            <div style={labelStyle}>JOIN A HIVE FROM ANOTHER DEVICE</div>
            <input value={jUrl} onChange={(e) => setJUrl(e.target.value)} placeholder="git remote URL (https:// or git@…)" style={{
              ...inputStyle, boxShadow: `inset 0 0 0 1px ${jUrlOk === false ? 'var(--cth-coral)' : 'var(--cth-ink-100)'}`
            }} />
            {jUrlOk === false && (
              <div style={{ fontSize: 11, color: 'var(--cth-coral, var(--cth-ink-700))' }}>
                Not an allowed git URL — use https://, ssh://, git://, git@host:path, or a local path.
              </div>
            )}
            <input value={jName} onChange={(e) => setJName(e.target.value)} placeholder="name for this hive (optional)" style={inputStyle} />
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={jHome} onChange={(e) => setJHome(e.target.value)} placeholder="target folder to clone into" style={inputStyle} />
              <PixelButton variant="secondary" size="md" onClick={() => pick(setJHome)}><Icon name="folder" /></PixelButton>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <PixelButton variant="ghost" size="md" onClick={() => setMode('none')}>cancel</PixelButton>
              <PixelButton variant="primary" size="md" onClick={doJoin} disabled={busy === 'join' || jUrlOk === false || !jUrl.trim() || !jHome.trim()}>
                {busy === 'join' ? 'cloning…' : 'join'}
              </PixelButton>
            </div>
          </div>
        )}

        {error && (
          <div style={{ padding: '6px 10px', background: 'var(--cth-coral-light)', boxShadow: 'inset 0 0 0 1px var(--cth-coral)', fontSize: 12, color: 'var(--cth-ink-900)' }}>{error}</div>
        )}
        {notice && (
          <div style={{ padding: '6px 10px', background: 'var(--cth-mint-light)', boxShadow: 'inset 0 0 0 1px var(--cth-mint)', fontSize: 12, color: 'var(--cth-ink-900)' }}>{notice}</div>
        )}

        {/* CREATE / JOIN entry points */}
        {mode === 'none' && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <PixelButton variant="secondary" size="md" onClick={() => { setMode('join'); setError(undefined); }}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Icon name="git" /> join from device…</span>
            </PixelButton>
            <PixelButton variant="secondary" size="md" onClick={() => { setMode('create'); setError(undefined); }}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Icon name="plus" /> new isolated hive…</span>
            </PixelButton>
          </div>
        )}
      </div>
    </PixelPanel>
  );
}
