/**
 * Hive network discovery — find other running The Hive instances on the LAN.
 *
 * Zero-dependency: a small UDP-multicast beacon rather than a full DNS-SD /
 * Bonjour stack (no `mdns`/`bonjour` package is bundled). Every instance sends a
 * JSON presence datagram to a fixed multicast group every few seconds and keeps
 * a table of the beacons it hears; entries expire when a peer stops announcing.
 *
 * This reaches peers on the same LAN segment. Tailscale carries it only where the
 * tailnet is configured to forward multicast (Magic-DNS alone does not) — a
 * follow-up could swap the transport for `_hive._tcp` DNS-SD without changing the
 * `HivePeer` shape the renderer consumes.
 *
 * MVP scope: discovery + presence only. Absorbing / transferring agents between
 * hives is a separate feature (agent-transfer-phaseb) and lives nowhere here.
 *
 * Electron-free (only `node:dgram`) so it is unit-testable in isolation.
 */
import { createSocket, type Socket } from 'node:dgram';

/** Administratively-scoped IPv4 multicast group + port. Dev and packaged builds
 *  share them so a dev instance and an installed one can still see each other;
 *  `reuseAddr` lets two hives on one machine both bind. */
const MCAST_ADDR = '239.255.113.7';
const MCAST_PORT = 48099;
const ANNOUNCE_MS = 5_000;
/** A peer unheard for this long is dropped (3 missed beacons + slack). */
const PEER_TTL_MS = 18_000;
/** Rejects a foreign process spraying the group with unrelated datagrams. */
const MAGIC = 'cth-hive-disco-1';

/** What this instance advertises about itself. */
export interface HivePresence {
  /** Stable id for this hive install (distinct HARNESS_HOME ⇒ distinct id). */
  hiveId: string;
  /** Human label — the machine hostname. */
  name: string;
  /** The hive-home path, so two hives on one host are still tellable apart. */
  home: string;
  /** Port of this hive's REST/PWA server — the read-only fleet view. */
  apiPort: number;
  /** Non-archived agents currently registered. */
  agentCount: number;
  /** App version. */
  version: string;
}

/** A discovered peer: its presence plus how it reached us. */
export interface HivePeer extends HivePresence {
  /** Sender IP as seen on the wire. */
  address: string;
  /** epoch ms of the last beacon heard. */
  lastSeen: number;
}

/** Validate + normalise an inbound presence payload. Returns null for anything
 *  malformed so a hostile or buggy sender can't inject junk into the table. */
export function parsePresence(v: unknown): HivePresence | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const hiveId = str('hiveId').trim();
  if (!hiveId) return null;
  const apiPort = Number(o.apiPort);
  if (!Number.isInteger(apiPort) || apiPort <= 0 || apiPort > 65535) return null;
  const rawCount = Number(o.agentCount);
  const agentCount = Number.isFinite(rawCount) ? Math.max(0, Math.min(9999, Math.floor(rawCount))) : 0;
  return {
    hiveId: hiveId.slice(0, 64),
    name: (str('name').trim() || 'hive').slice(0, 80),
    home: str('home').slice(0, 400),
    apiPort,
    agentCount,
    version: (str('version').trim() || '?').slice(0, 32)
  };
}

export class HiveDiscovery {
  private sock: Socket | null = null;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private reapTimer: ReturnType<typeof setInterval> | null = null;
  private readonly peers = new Map<string, HivePeer>();
  private readonly listeners = new Set<(peers: HivePeer[]) => void>();

  /** `getSelf` is read on every announce so version / agentCount stay live. It
   *  may throw before the hive is ready — that just skips one beacon. */
  constructor(private readonly getSelf: () => HivePresence) {}

  start(): void {
    if (this.sock) return;
    let sock: Socket;
    try {
      sock = createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      return; // no UDP — discovery is simply unavailable
    }
    this.sock = sock;
    sock.on('error', () => this.stop());
    sock.on('message', (buf, rinfo) => this.onMessage(buf, rinfo.address));
    try {
      sock.bind(MCAST_PORT, () => {
        try {
          sock.addMembership(MCAST_ADDR);
          sock.setMulticastTTL(1);
          sock.setMulticastLoopback(true); // so co-located hives hear each other
        } catch {
          /* an interface without multicast — announces still go out */
        }
        this.announce();
      });
    } catch {
      this.stop();
      return;
    }
    this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_MS);
    this.reapTimer = setInterval(() => this.reap(), ANNOUNCE_MS);
  }

  stop(): void {
    if (this.announceTimer) { clearInterval(this.announceTimer); this.announceTimer = null; }
    if (this.reapTimer) { clearInterval(this.reapTimer); this.reapTimer = null; }
    if (this.sock) {
      try { this.sock.dropMembership(MCAST_ADDR); } catch { /* never joined */ }
      try { this.sock.close(); } catch { /* already closed */ }
      this.sock = null;
    }
  }

  /** Current peers (stale entries pruned first), newest-seen-name order. */
  list(): HivePeer[] {
    this.pruneStale();
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name) || a.hiveId.localeCompare(b.hiveId));
  }

  /** Subscribe to table changes. Returns an unsubscribe fn. */
  onChange(cb: (peers: HivePeer[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private announce(): void {
    if (!this.sock) return;
    let self: HivePresence;
    try { self = this.getSelf(); } catch { return; }
    if (!self || !self.hiveId) return;
    let payload: Buffer;
    try { payload = Buffer.from(JSON.stringify({ magic: MAGIC, ...self })); } catch { return; }
    try { this.sock.send(payload, MCAST_PORT, MCAST_ADDR); } catch { /* transient send error */ }
  }

  private onMessage(buf: Buffer, address: string): void {
    let raw: unknown;
    try { raw = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).magic !== MAGIC) return;
    const presence = parsePresence(raw);
    if (!presence) return;
    let selfId = '';
    try { selfId = this.getSelf().hiveId; } catch { /* ignore */ }
    if (presence.hiveId === selfId) return; // our own beacon looping back

    const prev = this.peers.get(presence.hiveId);
    this.peers.set(presence.hiveId, { ...presence, address, lastSeen: Date.now() });
    const material =
      !prev ||
      prev.agentCount !== presence.agentCount ||
      prev.version !== presence.version ||
      prev.name !== presence.name ||
      prev.address !== address;
    if (material) this.emit();
  }

  private reap(): void {
    if (this.pruneStale()) this.emit();
  }

  /** Drop expired peers. Returns true if anything was removed. */
  private pruneStale(): boolean {
    const cutoff = Date.now() - PEER_TTL_MS;
    let changed = false;
    for (const [id, p] of this.peers) {
      if (p.lastSeen < cutoff) { this.peers.delete(id); changed = true; }
    }
    return changed;
  }

  private emit(): void {
    const snapshot = [...this.peers.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.hiveId.localeCompare(b.hiveId)
    );
    for (const cb of this.listeners) {
      try { cb(snapshot); } catch { /* a listener throwing must not stop the others */ }
    }
  }
}
