/**
 * Nearby Hives — other The Hive instances discovered on the local network.
 *
 * Presence only (MVP): the list is fed by the main-process UDP-multicast beacon
 * (see main/hiveDiscovery). "open" launches the peer's read-only web/PWA fleet
 * view in the OS browser — the peer IS the API server on its advertised port.
 * Absorbing or transferring agents between hives is a separate feature and is
 * not offered here.
 */
import { useEffect, useState } from 'react';
import type { DiscoveredHive } from '../../../preload';
import { PixelButton } from './PixelButton';

const sectionLabel: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase',
  display: 'block',
  marginBottom: 8
};

function ageLabel(lastSeen: number): string {
  const s = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

export function NearbyHivesPanel() {
  const [peers, setPeers] = useState<DiscoveredHive[]>([]);

  useEffect(() => {
    let alive = true;
    void window.cth.discoveryPeers().then((p) => { if (alive) setPeers(p); }).catch(() => { /* discovery off */ });
    const off = window.cth.onDiscoveryPeers((p) => { if (alive) setPeers(p); });
    // Re-tick the "seen Xs ago" labels without waiting on a beacon.
    const tick = setInterval(() => { if (alive) setPeers((prev) => [...prev]); }, 5000);
    return () => { alive = false; off(); clearInterval(tick); };
  }, []);

  return (
    <div>
      <span style={sectionLabel}>Nearby hives</span>
      {peers.length === 0 ? (
        <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
          No other The Hive instances seen on this network. Instances announce themselves over
          LAN multicast; a peer appears here within a few seconds of starting.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {peers.map((p) => (
            <div
              key={p.hiveId}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 0', borderBottom: '1px solid var(--cth-ink-200)'
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 13, color: 'var(--cth-ink-900)' }}>
                  {p.name}
                  <span style={{ color: 'var(--cth-ink-500)', marginLeft: 8 }}>
                    v{p.version.replace(/^v/, '')} · {p.agentCount} agent{p.agentCount === 1 ? '' : 's'}
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}
                  title={p.home || undefined}
                >
                  {p.address}:{p.apiPort}{p.home ? ` · ${p.home}` : ''} · seen {ageLabel(p.lastSeen)}
                </span>
              </div>
              <PixelButton
                variant="secondary"
                size="sm"
                onClick={() => void window.cth.openExternal(`http://${p.address}:${p.apiPort}`)}
                title="Open this hive's read-only fleet view in your browser"
              >
                open
              </PixelButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
